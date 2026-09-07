-- Run AFTER supabase-schema.sql and admin-features.sql. Back up first.
-- Unused legacy QR codes are rotated. Re-send those tickets after deployment.
begin;

create table if not exists public.event_settings (
  event_day text primary key check (event_day ~ '^\d{4}-\d{2}-\d{2}$'),
  name text not null,
  active boolean not null default true,
  vip_limit integer not null default 48 check (vip_limit >= 0),
  regular_limit integer not null default 10000 check (regular_limit >= 0),
  vip_price integer not null default 2000 check (vip_price >= 0),
  regular_prices integer[] not null default array[150,180],
  ticket_color text not null default '#0f766e' check (ticket_color ~ '^#[0-9A-Fa-f]{6}$')
);
insert into public.event_settings(event_day,name)
select distinct event_day, 'คอนเสิร์ต ' || event_day from public.tickets on conflict do nothing;
insert into public.event_settings(event_day,name)
select d, 'คอนเสิร์ต ' || d from unnest(array['2026-08-27','2026-08-28','2026-08-30','2026-09-06']) d on conflict do nothing;
alter table public.tickets drop constraint if exists tickets_event_day_check;
alter table public.tickets add column if not exists access_token uuid not null default gen_random_uuid();
create unique index if not exists tickets_access_token_key on public.tickets(access_token);
alter table public.tickets add column if not exists payment_status text not null default 'unverified'
  check (payment_status in ('unverified','pending','paid','refunded'));
alter table public.tickets add column if not exists payment_reference text not null default '';
alter table public.tickets add column if not exists paid_amount integer not null default 0 check (paid_amount >= 0);
alter table public.tickets add column if not exists payment_confirmed_by text;
alter table public.tickets add column if not exists payment_confirmed_at timestamptz;
alter table public.admin_users add column if not exists failed_attempts integer not null default 0;
alter table public.admin_users add column if not exists locked_until timestamptz;

create table if not exists public.issue_requests (
  request_id uuid primary key,
  user_id uuid not null references public.admin_users(id),
  payload jsonb not null,
  result jsonb,
  created_at timestamptz not null default now()
);
create table if not exists public.line_deliveries (
  ticket_id text primary key references public.tickets(id),
  retry_key uuid not null default gen_random_uuid(),
  status text not null default 'pending' check (status in ('pending','sent','failed')),
  attempts integer not null default 0,
  last_error text,
  first_attempt_at timestamptz,
  sent_at timestamptz
);

-- Rotate only unused predictable codes. Consumed codes stay for audit integrity.
update public.ticket_codes set code = upper(replace(gen_random_uuid()::text,'-',''))
where checked_in_at is null and code ~ '^(REG[0-9]+|VIP[0-9]+-[0-9]+)$';

-- No direct browser reads/writes; every read RPC validates its session and role.
do $$ declare t text; begin
  foreach t in array array['tickets','ticket_codes','checkins','line_customers','ticket_counters',
    'admin_users','admin_sessions','ticket_audit_logs','event_settings','issue_requests','line_deliveries'] loop
    execute format('alter table public.%I enable row level security',t);
    execute format('revoke all on public.%I from public, anon, authenticated',t);
  end loop;
end $$;
drop policy if exists "Public read tickets" on public.tickets;
drop policy if exists "Public read ticket codes" on public.ticket_codes;
drop policy if exists "Public read checkins" on public.checkins;
drop policy if exists "Public read line customers" on public.line_customers;
drop policy if exists "Public read ticket audit logs" on public.ticket_audit_logs;

create or replace function public.require_admin_session(p_session_token text,p_permission text)
returns public.admin_users language plpgsql security definer set search_path=public as $$
declare u public.admin_users;
begin
  select a.* into u from public.admin_users a join public.admin_sessions s on s.user_id=a.id
  where s.token::text=p_session_token and s.expires_at>now() and a.active;
  if not found then raise exception 'กรุณาเข้าสู่ระบบใหม่' using errcode='28000'; end if;
  if p_permission='read' or p_permission='self' or u.role='admin'
    or (u.role='issuer' and p_permission in ('issue','manage_ticket','export'))
    or (u.role='checkin' and p_permission='checkin') then return u; end if;
  raise exception 'บัญชีนี้ไม่มีสิทธิ์ทำรายการนี้' using errcode='42501';
end $$;

create or replace function public.admin_login(p_username text,p_password text)
returns jsonb language plpgsql security definer set search_path=public as $$
declare u public.admin_users; tok uuid;
begin
  if nullif(trim(p_username),'') is null or nullif(p_password,'') is null or octet_length(p_password)>72 then
    return jsonb_build_object('error','Username หรือ Password ไม่ถูกต้อง');
  end if;
  select * into u from public.admin_users where lower(username)=lower(trim(p_username)) and active for update;
  if not found then return jsonb_build_object('error','Username หรือ Password ไม่ถูกต้อง'); end if;
  if u.locked_until>now() then return jsonb_build_object('error','ลองเข้าสู่ระบบมากเกินไป กรุณารอ 15 นาที'); end if;
  if u.password_hash is distinct from extensions.crypt(p_password,u.password_hash) then
    update public.admin_users set failed_attempts=case when locked_until<=now() then 1 else failed_attempts+1 end,
      locked_until=case when locked_until<=now() then null when failed_attempts>=4 then now()+interval '15 minutes' else locked_until end
    where id=u.id;
    -- Return instead of RAISE so the failed-attempt counter commits.
    return jsonb_build_object('error','Username หรือ Password ไม่ถูกต้อง');
  end if;
  update public.admin_users set failed_attempts=0,locked_until=null where id=u.id;
  delete from public.admin_sessions where expires_at<=now();
  insert into public.admin_sessions(user_id,expires_at) values(u.id,now()+interval '8 hours') returning token into tok;
  return jsonb_build_object('token',tok,'username',u.username,'display_name',u.display_name,'role',u.role,'expires_at',now()+interval '8 hours');
end $$;

-- Disable only known seed passwords; preserve accounts already secured by the operator.
update public.admin_users set active=false where
  (username='admin' and password_hash=extensions.crypt('Admin@1234',password_hash)) or
  (username='issuer' and password_hash=extensions.crypt('Issuer@1234',password_hash)) or
  (username='checkin' and password_hash=extensions.crypt('Checkin@1234',password_hash));
delete from public.admin_sessions;

create or replace function public.change_password(p_session_token text,p_old_password text,p_new_password text)
returns void language plpgsql security definer set search_path=public as $$
declare u public.admin_users;
begin
  u:=public.require_admin_session(p_session_token,'self');
  if p_old_password is null or u.password_hash is distinct from extensions.crypt(p_old_password,u.password_hash) then raise exception 'รหัสผ่านเดิมไม่ถูกต้อง'; end if;
  if p_new_password is null or octet_length(p_new_password) not between 12 and 72 then raise exception 'รหัสผ่านใหม่ต้องมี 12–72 ไบต์'; end if;
  update public.admin_users set password_hash=extensions.crypt(p_new_password,extensions.gen_salt('bf',10)) where id=u.id;
  delete from public.admin_sessions where user_id=u.id;
end $$;

create or replace function public.manage_user(p_session_token text,p_username text,p_display_name text,p_role text,p_active boolean,p_password text default null)
returns void language plpgsql security definer set search_path=public as $$
declare u public.admin_users; target public.admin_users;
begin
  u:=public.require_admin_session(p_session_token,'admin');
  if p_username is null or p_username !~ '^[a-zA-Z0-9_.-]{3,50}$' or p_role is null or p_role not in ('admin','issuer','checkin') or p_active is null then raise exception 'ข้อมูลบัญชีไม่ถูกต้อง'; end if;
  select * into target from public.admin_users where lower(username)=lower(p_username) for update;
  if target.id=u.id and (not p_active or p_role<>'admin') then raise exception 'ไม่สามารถปิดบัญชีหรือลดสิทธิ์ตนเอง'; end if;
  if (target.id is null or nullif(p_password,'') is not null) and (p_password is null or octet_length(p_password) not between 12 and 72) then raise exception 'รหัสผ่านต้องมี 12–72 ไบต์'; end if;
  if target.id is null then
    insert into public.admin_users(username,display_name,role,active,password_hash) values(lower(p_username),coalesce(nullif(trim(p_display_name),''),p_username),p_role,p_active,extensions.crypt(p_password,extensions.gen_salt('bf',10)));
  else
    update public.admin_users set display_name=coalesce(nullif(trim(p_display_name),''),p_username),role=p_role,active=p_active,
      password_hash=case when nullif(p_password,'') is null then password_hash else extensions.crypt(p_password,extensions.gen_salt('bf',10)) end,
      failed_attempts=0,locked_until=null where id=target.id;
    delete from public.admin_sessions where user_id=target.id;
  end if;
  insert into public.ticket_audit_logs(action,actor_username,actor_role,details) values('manage_user',u.username,u.role,jsonb_build_object('username',p_username,'role',p_role,'active',p_active));
end $$;

create or replace function public.revoke_user_sessions(p_session_token text,p_username text)
returns void language plpgsql security definer set search_path=public as $$
declare u public.admin_users;
begin
  u:=public.require_admin_session(p_session_token,'admin');
  delete from public.admin_sessions where user_id in(select id from public.admin_users where username=p_username);
  insert into public.ticket_audit_logs(action,actor_username,actor_role,details) values('revoke_sessions',u.username,u.role,jsonb_build_object('username',p_username));
end $$;

drop function if exists public.save_event(text,text,text,boolean,integer,integer,integer,integer[]);
create or replace function public.save_event(p_session_token text,p_event_day text,p_name text,p_active boolean,p_vip_limit integer,p_regular_limit integer,p_vip_price integer,p_regular_prices integer[],p_ticket_color text)
returns void language plpgsql security definer set search_path=public as $$
declare u public.admin_users;
begin
  u:=public.require_admin_session(p_session_token,'admin');
  if p_event_day is null or p_event_day<>to_char(p_event_day::date,'YYYY-MM-DD') or nullif(trim(p_name),'') is null
    or p_active is null or p_vip_limit is null or p_regular_limit is null or p_vip_price is null
    or p_vip_limit<0 or p_regular_limit<0 or p_vip_price<0
    or coalesce(cardinality(p_regular_prices),0)=0 or exists(select 1 from unnest(p_regular_prices) x where x is null or x<0)
    or p_ticket_color is null or p_ticket_color !~ '^#[0-9A-Fa-f]{6}$' then raise exception 'ข้อมูลงานไม่ถูกต้อง'; end if;
  insert into public.event_settings(event_day,name,active,vip_limit,regular_limit,vip_price,regular_prices,ticket_color)
  values(p_event_day,trim(p_name),p_active,p_vip_limit,p_regular_limit,p_vip_price,p_regular_prices,lower(p_ticket_color))
  on conflict(event_day) do update set name=excluded.name,active=excluded.active,vip_limit=excluded.vip_limit,regular_limit=excluded.regular_limit,vip_price=excluded.vip_price,regular_prices=excluded.regular_prices,ticket_color=excluded.ticket_color;
  insert into public.ticket_audit_logs(action,actor_username,actor_role,details) values('save_event',u.username,u.role,jsonb_build_object('event_day',p_event_day));
end $$;

-- Replace ALL legacy issuance entry points with one transactional, idempotent batch.
drop function if exists public.issue_ticket(text,text,text,text);
drop function if exists public.issue_ticket(text,text,text,text,integer);
drop function if exists public.issue_ticket(text,text,text,text,integer,text);
create or replace function public.issue_ticket_batch(p_session_token text,p_request_id uuid,p_ticket_type text,p_event_day text,p_buyer_name text,p_line_user_id text,p_ticket_price integer,p_quantity integer)
returns jsonb language plpgsql security definer set search_path=public as $$
declare u public.admin_users; e public.event_settings; req public.issue_requests; payload jsonb; v_result jsonb:='[]';
  n integer; tid text; price integer; cap integer; lim integer; sold integer; codes text[]; access uuid; i integer;
begin
  u:=public.require_admin_session(p_session_token,'issue');
  if p_request_id is null or p_ticket_type is null or p_ticket_type not in ('VIP','Regular') or p_quantity is null or p_quantity not between 1 and 50 or (p_ticket_type='VIP' and p_quantity<>1) then raise exception 'ประเภทหรือจำนวนบัตรไม่ถูกต้อง'; end if;
  if length(coalesce(p_buyer_name,''))>200 or (nullif(p_line_user_id,'') is not null and p_line_user_id !~ '^U[0-9a-fA-F]{32}$') then raise exception 'ชื่อหรือ LINE userId ไม่ถูกต้อง'; end if;
  payload:=jsonb_build_array(p_ticket_type,p_event_day,p_buyer_name,p_line_user_id,p_ticket_price,p_quantity);
  insert into public.issue_requests(request_id,user_id,payload) values(p_request_id,u.id,payload) on conflict do nothing;
  select * into req from public.issue_requests where request_id=p_request_id for update;
  if req.user_id<>u.id or req.payload<>payload then raise exception 'รหัสคำขอนี้ใช้กับรายการอื่นแล้ว'; end if;
  if req.result is not null then return req.result; end if;
  select * into e from public.event_settings where event_day=p_event_day for update;
  if not found or not e.active then raise exception 'งานนี้ปิดขายอยู่'; end if;
  price:=case when p_ticket_type='VIP' then e.vip_price else p_ticket_price end;
  if price is null or (p_ticket_type='Regular' and not(price=any(e.regular_prices))) then raise exception 'ราคาไม่ถูกต้อง'; end if;
  cap:=case when p_ticket_type='VIP' then 4 else 1 end;
  lim:=case when p_ticket_type='VIP' then e.vip_limit else e.regular_limit end;
  select count(*) into sold from public.tickets where event_day=p_event_day and ticket_type=p_ticket_type and canceled_at is null;
  if sold+p_quantity>lim then raise exception 'บัตรคงเหลือไม่เพียงพอ'; end if;
  select next_number into n from public.ticket_counters where ticket_type=p_ticket_type for update;
  if not found then raise exception 'ไม่พบตัวนับบัตร'; end if;
  for i in 1..p_quantity loop
    tid:=case when p_ticket_type='VIP' then 'VIP'||lpad(n::text,greatest(3,length(n::text)),'0') else 'REG'||lpad(n::text,greatest(4,length(n::text)),'0') end;
    access:=gen_random_uuid();
    insert into public.tickets(id,ticket_type,event_day,buyer_name,line_user_id,price,capacity,perks,access_token,payment_status)
    values(tid,p_ticket_type,p_event_day,coalesce(nullif(trim(p_buyer_name),''),'-'),nullif(p_line_user_id,''),price,cap,case when cap=4 then 'พร้อมเครื่องดื่ม' else '' end,access,'pending');
    select array_agg(upper(replace(gen_random_uuid()::text,'-',''))) into codes from generate_series(1,cap);
    insert into public.ticket_codes(code,ticket_id,seat_no) select code,tid,ord from unnest(codes) with ordinality c(code,ord);
    insert into public.ticket_audit_logs(ticket_id,action,actor_username,actor_role,details) values(tid,'issue',u.username,u.role,jsonb_build_object('price',price,'request_id',p_request_id));
    v_result:=v_result||jsonb_build_array(jsonb_build_object('ticket_id',tid));
    n:=n+1;
  end loop;
  update public.ticket_counters set next_number=n where ticket_type=p_ticket_type;
  update public.issue_requests r set result=v_result where r.request_id=p_request_id;
  return v_result;
end $$;

create or replace function public.get_customer_ticket(p_token text)
returns jsonb language sql security definer set search_path=public as $$
  select jsonb_build_object('id',t.id,'ticket_type',t.ticket_type,'event_day',t.event_day,'buyer_name',t.buyer_name,
    'price',t.price,'capacity',t.capacity,'perks',t.perks,'ticket_color',coalesce(e.ticket_color,'#0f766e'),'canceled_at',t.canceled_at,'cancel_reason',t.cancel_reason,
    'ticket_codes',case when t.canceled_at is not null then '[]'::jsonb else coalesce((select jsonb_agg(jsonb_build_object('code',c.code,'seat_no',c.seat_no,'checked_in_at',c.checked_in_at) order by c.seat_no) from public.ticket_codes c where c.ticket_id=t.id),'[]') end)
  from public.tickets t left join public.event_settings e on e.event_day=t.event_day where t.access_token::text=p_token;
$$;

create or replace function public.get_dashboard(p_session_token text,p_event_day text,p_page integer default 0,p_checkin_page integer default 0)
returns jsonb language plpgsql security definer set search_path=public as $$
declare u public.admin_users; result jsonb;
begin
  u:=public.require_admin_session(p_session_token,'read');
  if p_page is null or p_checkin_page is null or p_page<0 or p_checkin_page<0 then raise exception 'หน้าไม่ถูกต้อง'; end if;
  result:=jsonb_build_object('user',jsonb_build_object('username',u.username,'display_name',u.display_name,'role',u.role),
    'events',(select coalesce(jsonb_agg(e order by event_day),'[]') from public.event_settings e),
    'metrics',jsonb_build_object(
      'today_checkins',(select count(*) from public.checkins where event_day=p_event_day),
      'total_checkins',(select count(*) from public.checkins where event_day=p_event_day),
      'total_codes',(select coalesce(sum(capacity),0) from public.tickets where event_day=p_event_day and canceled_at is null),
      'regular_sold',(select count(*) from public.tickets where event_day=p_event_day and ticket_type='Regular' and canceled_at is null),
      'canceled',(select count(*) from public.tickets where event_day=p_event_day and canceled_at is not null),
      'received',case when u.role='checkin' then null else (select coalesce(sum(paid_amount),0) from public.tickets where event_day=p_event_day and payment_status='paid') end,
      'daily',(select coalesce(jsonb_agg(x),'[]') from (select e.event_day,e.vip_limit,
        (select count(*) from public.tickets t where t.event_day=e.event_day and ticket_type='VIP' and canceled_at is null) vip_sold,
        (select count(*) from public.tickets t where t.event_day=e.event_day and ticket_type='Regular' and canceled_at is null) regular_sold from public.event_settings e) x)),
    'ticket_count',case when u.role='checkin' then 0 else (select count(*) from public.tickets where event_day=p_event_day) end,
    'tickets',case when u.role='checkin' then '[]'::jsonb else (select coalesce(jsonb_agg(x order by x.issued_at desc,x.id),'[]') from
      (select t.*,coalesce((select jsonb_agg(c order by seat_no) from public.ticket_codes c where c.ticket_id=t.id),'[]') ticket_codes,
        (select status from public.line_deliveries d where d.ticket_id=t.id) line_status
        from public.tickets t where event_day=p_event_day order by issued_at desc,id limit 50 offset p_page*50) x) end,
    'checkins',(select coalesce(jsonb_agg(x order by checked_in_at desc,id desc),'[]') from
      (select * from public.checkins where event_day=p_event_day order by checked_in_at desc,id desc limit 50 offset p_checkin_page*50) x),
    'line_customers',case when u.role='checkin' then '[]'::jsonb else (select coalesce(jsonb_agg(x),'[]') from
      (select line_user_id,display_name from public.line_customers order by last_seen_at desc limit 300) x) end,
    'audit_logs',case when u.role='admin' then (select coalesce(jsonb_agg(x),'[]') from (select * from public.ticket_audit_logs order by created_at desc,id desc limit 100) x) else '[]'::jsonb end,
    'users',case when u.role='admin' then (select coalesce(jsonb_agg(x),'[]') from (select username,display_name,role,active from public.admin_users order by username) x) else '[]'::jsonb end);
  return result;
end $$;

create or replace function public.get_sales_report(p_session_token text,p_page integer default 0,p_as_of timestamptz default now())
returns jsonb language plpgsql security definer set search_path=public as $$
begin
  perform public.require_admin_session(p_session_token,'export');
  if p_page is null or p_page<0 or p_as_of is null then raise exception 'หน้าไม่ถูกต้อง'; end if;
  return (select coalesce(jsonb_agg(x order by issued_at,id),'[]') from (select id,ticket_type,event_day,buyer_name,price,capacity,issued_at,canceled_at,cancel_reason,
    payment_status,payment_reference,paid_amount,payment_confirmed_by,payment_confirmed_at from public.tickets where issued_at<=p_as_of order by issued_at,id limit 500 offset p_page*500) x);
end $$;

create or replace function public.set_ticket_payment(p_session_token text,p_ticket_id text,p_status text,p_reference text,p_amount integer)
returns void language plpgsql security definer set search_path=public as $$
declare u public.admin_users; t public.tickets;
begin
  u:=public.require_admin_session(p_session_token,'manage_ticket');
  select * into t from public.tickets where id=p_ticket_id for update;
  if not found then raise exception 'ไม่พบบัตร'; end if;
  if p_status is null or p_status not in ('pending','paid','refunded') or p_amount is null or p_amount<0 then raise exception 'ข้อมูลชำระเงินไม่ถูกต้อง'; end if;
  if p_status='paid' and (t.canceled_at is not null or p_amount<>t.price or nullif(trim(p_reference),'') is null) then raise exception 'ยอดชำระต้องตรงราคาบัตรและระบุเลขอ้างอิง'; end if;
  if p_status<>'paid' and p_amount<>0 then raise exception 'สถานะนี้ต้องมียอดรับสุทธิเป็นศูนย์'; end if;
  if t.payment_status='paid' and p_status='pending' then raise exception 'รายการรับเงินแล้วให้ใช้คืนเงิน'; end if;
  if p_status='refunded' and (t.payment_status<>'paid' or nullif(trim(p_reference),'') is null) then raise exception 'คืนเงินได้เฉพาะรายการชำระแล้วและต้องมีเลขอ้างอิง'; end if;
  update public.tickets set payment_status=p_status,payment_reference=coalesce(p_reference,''),paid_amount=p_amount,payment_confirmed_by=u.username,payment_confirmed_at=now() where id=t.id;
  insert into public.ticket_audit_logs(ticket_id,action,actor_username,actor_role,details) values(t.id,'payment',u.username,u.role,jsonb_build_object('old_status',t.payment_status,'old_amount',t.paid_amount,'status',p_status,'amount',p_amount,'reference',p_reference));
end $$;

-- Server-only delivery authorization. Persist retry keys before contacting LINE.
create or replace function public.prepare_line_delivery(p_session_token text,p_ticket_id text)
returns jsonb language plpgsql security definer set search_path=public as $$
declare u public.admin_users; t public.tickets; d public.line_deliveries;
begin
  u:=public.require_admin_session(p_session_token,'issue');
  select * into t from public.tickets where id=p_ticket_id for update;
  if not found or t.canceled_at is not null or nullif(t.line_user_id,'') is null then raise exception 'บัตรไม่มีอยู่ ถูกยกเลิก หรือไม่มี LINE userId'; end if;
  insert into public.line_deliveries(ticket_id) values(t.id) on conflict do nothing;
  select * into d from public.line_deliveries where ticket_id=t.id for update;
  if d.status<>'sent' and d.first_attempt_at<now()-interval '23 hours' then raise exception 'คำขอส่งเก่าเกิน 23 ชั่วโมง โปรดตรวจประวัติ LINE ก่อนดำเนินการ'; end if;
  if d.status<>'sent' then update public.line_deliveries set attempts=attempts+1,first_attempt_at=coalesce(first_attempt_at,now()) where ticket_id=t.id; end if;
  return jsonb_build_object('ticket',to_jsonb(t),'retry_key',d.retry_key,'status',d.status);
end $$;

create or replace function public.finish_line_delivery(p_ticket_id text,p_retry_key uuid,p_ok boolean,p_error text)
returns void language plpgsql security definer set search_path=public as $$
begin
  update public.line_deliveries set status=case when p_ok then 'sent' else 'failed' end,last_error=left(p_error,500),sent_at=case when p_ok then now() else null end
  where ticket_id=p_ticket_id and retry_key=p_retry_key and status<>'sent';
end $$;

create or replace function public.check_in_ticket(
  p_code text,
  p_current_day text,
  p_staff_name text,
  p_session_token text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user public.admin_users%rowtype;
  v_code public.ticket_codes%rowtype;
  v_ticket public.tickets%rowtype;
  v_now timestamptz := now();
  v_today text := to_char((now() at time zone 'Asia/Bangkok')::date, 'YYYY-MM-DD');
begin
  v_user := public.require_admin_session(p_session_token, 'checkin');

  if nullif(trim(p_staff_name), '') is null then
    raise exception 'กรุณากรอกชื่อเจ้าหน้าที่ก่อนเช็คอิน';
  end if;

  select * into v_code
  from public.ticket_codes
  where code = upper(trim(p_code));

  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;

  select * into v_ticket
  from public.tickets
  where id = v_code.ticket_id for update;
  -- Check-in and cancellation serialize on the same ticket row.
  select * into v_code from public.ticket_codes where code = upper(trim(p_code)) for update;

  if v_ticket.canceled_at is not null then
    return jsonb_build_object('status', 'canceled', 'canceled_at', v_ticket.canceled_at, 'cancel_reason', v_ticket.cancel_reason);
  end if;

  if v_ticket.event_day is distinct from p_current_day then
    return jsonb_build_object('status', 'wrong_day', 'event_day', v_ticket.event_day);
  end if;

  if v_ticket.event_day <> v_today then
    return jsonb_build_object('status', 'not_event_day', 'event_day', v_ticket.event_day, 'today', v_today);
  end if;

  if v_code.checked_in_at is not null then
    return jsonb_build_object(
      'status', 'already_checked_in',
      'checked_in_at', v_code.checked_in_at,
      'staff_name', v_code.staff_name
    );
  end if;

  update public.ticket_codes
  set checked_in_at = v_now,
      staff_name = trim(p_staff_name)
  where code = v_code.code;

  insert into public.checkins (code, ticket_id, ticket_type, event_day, staff_name, checked_in_at)
  values (v_code.code, v_ticket.id, v_ticket.ticket_type, v_ticket.event_day, trim(p_staff_name), v_now);

  insert into public.ticket_audit_logs (ticket_id, action, actor_username, actor_role, details)
  values (v_ticket.id, 'checkin', v_user.username, v_user.role, jsonb_build_object('code', v_code.code, 'staff_name', trim(p_staff_name)));

  return jsonb_build_object('status', 'checked_in', 'checked_in_at', v_now);
end;
$$;


create or replace function public.update_ticket_price(
  p_ticket_id text,
  p_ticket_price integer,
  p_session_token text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user public.admin_users%rowtype;
  v_ticket public.tickets%rowtype;
begin
  v_user := public.require_admin_session(p_session_token, 'manage_ticket');

  if p_ticket_price is null or p_ticket_price < 0 then
    raise exception 'ราคา Regular ต้องเป็นจำนวนเต็มตั้งแต่ศูนย์ขึ้นไป';
  end if;

  select * into v_ticket
  from public.tickets
  where id = upper(trim(p_ticket_id))
  for update;

  if not found then
    raise exception 'ไม่พบบัตร';
  end if;

  if v_ticket.ticket_type <> 'Regular' then
    raise exception 'แก้ราคาได้เฉพาะ Regular';
  end if;

  if v_ticket.canceled_at is not null then
    raise exception 'บัตรนี้ถูกยกเลิกแล้ว';
  end if;

  if v_ticket.payment_status = 'paid' then raise exception 'บัตรชำระแล้วไม่สามารถแก้ราคา'; end if;
  if not exists(select 1 from public.event_settings e where e.event_day=v_ticket.event_day and p_ticket_price=any(e.regular_prices)) then raise exception 'ราคาไม่อยู่ในรายการราคาของงาน'; end if;
  update public.tickets
  set price = p_ticket_price
  where id = v_ticket.id;

  insert into public.ticket_audit_logs (ticket_id, action, actor_username, actor_role, details)
  values (v_ticket.id, 'update_price', v_user.username, v_user.role, jsonb_build_object('old_price', v_ticket.price, 'new_price', p_ticket_price));

  return jsonb_build_object('ticket_id', v_ticket.id, 'old_price', v_ticket.price, 'new_price', p_ticket_price);
end;
$$;


-- Restrict this application's RPCs explicitly, including legacy overloads.
do $$ declare f record; begin
  for f in select p.oid::regprocedure sig,p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname=any(array['require_admin_session','admin_login','admin_logout','change_password','manage_user','revoke_user_sessions',
      'save_event','issue_ticket','issue_ticket_batch','check_in_ticket','cancel_ticket','update_ticket_price','get_customer_ticket','get_dashboard','get_sales_report','set_ticket_payment','prepare_line_delivery','finish_line_delivery']) loop
    execute format('revoke all on function %s from public,anon,authenticated',f.sig);
    if f.proname in ('prepare_line_delivery','finish_line_delivery') then
      execute format('grant execute on function %s to service_role',f.sig);
    elsif f.proname<>'require_admin_session' then
      execute format('grant execute on function %s to anon',f.sig);
    end if;
  end loop;
end $$;
commit;

