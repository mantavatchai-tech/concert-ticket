create extension if not exists pgcrypto with schema extensions;

create table if not exists public.admin_users (
  id uuid primary key default gen_random_uuid(),
  username text not null unique,
  password_hash text not null,
  display_name text not null,
  role text not null check (role in ('admin', 'issuer', 'checkin')),
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.admin_sessions (
  token uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.admin_users(id) on delete cascade,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create table if not exists public.ticket_audit_logs (
  id bigserial primary key,
  ticket_id text references public.tickets(id) on delete set null,
  action text not null,
  actor_username text not null,
  actor_role text not null,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table public.tickets add column if not exists canceled_at timestamptz;
alter table public.tickets add column if not exists canceled_by text;
alter table public.tickets add column if not exists cancel_reason text not null default '';

create index if not exists idx_admin_sessions_expires_at on public.admin_sessions (expires_at);
create index if not exists idx_ticket_audit_logs_created_at on public.ticket_audit_logs (created_at desc);
create index if not exists idx_ticket_audit_logs_ticket_id on public.ticket_audit_logs (ticket_id);

alter table public.admin_users enable row level security;
alter table public.admin_sessions enable row level security;
alter table public.ticket_audit_logs enable row level security;

drop policy if exists "Public read ticket audit logs" on public.ticket_audit_logs;
create policy "Public read ticket audit logs" on public.ticket_audit_logs for select using (true);

drop function if exists public.require_admin_session(text, text);
create or replace function public.require_admin_session(
  p_session_token text,
  p_permission text
)
returns public.admin_users
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user public.admin_users%rowtype;
  v_token uuid;
begin
  begin
    v_token := p_session_token::uuid;
  exception when others then
    raise exception 'กรุณาเข้าสู่ระบบใหม่';
  end;

  delete from public.admin_sessions where expires_at <= now();

  select u.* into v_user
  from public.admin_sessions s
  join public.admin_users u on u.id = s.user_id
  where s.token = v_token
    and s.expires_at > now()
    and u.active = true;

  if not found then
    raise exception 'กรุณาเข้าสู่ระบบใหม่';
  end if;

  if v_user.role = 'admin' then
    return v_user;
  end if;

  if p_permission = 'issue' and v_user.role = 'issuer' then
    return v_user;
  end if;

  if p_permission = 'manage_ticket' and v_user.role = 'issuer' then
    return v_user;
  end if;

  if p_permission = 'export' and v_user.role = 'issuer' then
    return v_user;
  end if;

  if p_permission = 'checkin' and v_user.role = 'checkin' then
    return v_user;
  end if;

  raise exception 'บัญชีนี้ไม่มีสิทธิ์ทำรายการนี้';
end;
$$;

drop function if exists public.admin_login(text, text);
create or replace function public.admin_login(
  p_username text,
  p_password text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user public.admin_users%rowtype;
  v_token uuid;
begin
  delete from public.admin_sessions where expires_at <= now();

  select * into v_user
  from public.admin_users
  where lower(username) = lower(trim(p_username))
    and active = true;

  if not found or v_user.password_hash <> extensions.crypt(p_password, v_user.password_hash) then
    raise exception 'Username หรือ Password ไม่ถูกต้อง';
  end if;

  insert into public.admin_sessions (user_id, expires_at)
  values (v_user.id, now() + interval '12 hours')
  returning token into v_token;

  return jsonb_build_object(
    'token', v_token::text,
    'username', v_user.username,
    'display_name', v_user.display_name,
    'role', v_user.role,
    'expires_at', now() + interval '12 hours'
  );
end;
$$;

drop function if exists public.admin_logout(text);
create or replace function public.admin_logout(p_session_token text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.admin_sessions
  where token = p_session_token::uuid;
exception when others then
  return;
end;
$$;

drop function if exists public.issue_ticket(text, text, text, text);
drop function if exists public.issue_ticket(text, text, text, text, integer);
drop function if exists public.issue_ticket(text, text, text, text, integer, text);

create or replace function public.issue_ticket(
  p_ticket_type text,
  p_event_day text,
  p_buyer_name text,
  p_line_user_id text default null,
  p_ticket_price integer default null,
  p_session_token text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user public.admin_users%rowtype;
  v_next integer;
  v_ticket_id text;
  v_price integer;
  v_capacity integer;
  v_perks text;
  v_codes text[];
begin
  v_user := public.require_admin_session(p_session_token, 'issue');

  if p_ticket_type not in ('VIP', 'Regular') then
    raise exception 'ประเภทบัตรไม่ถูกต้อง';
  end if;

  if p_event_day not in ('2026-08-27', '2026-08-28', '2026-08-30', '2026-09-06') then
    raise exception 'วันของบัตรไม่ถูกต้อง';
  end if;

  select next_number into v_next
  from public.ticket_counters
  where ticket_type = p_ticket_type
  for update;

  if p_ticket_type = 'VIP' and v_next > 30 then
    raise exception 'VIP เต็มแล้ว ออกบัตรเพิ่มไม่ได้';
  end if;

  if p_ticket_type = 'VIP' then
    v_ticket_id := 'VIP' || lpad(v_next::text, 3, '0');
    v_price := 2000;
    v_capacity := 4;
    v_perks := 'เบียร์ 6 กระป๋อง, น้ำแข็ง 1 ชุด';
    v_codes := array[
      v_ticket_id || '-01',
      v_ticket_id || '-02',
      v_ticket_id || '-03',
      v_ticket_id || '-04'
    ];
  else
    if coalesce(p_ticket_price, 150) not in (150, 180) then
      raise exception 'ราคา Regular ไม่ถูกต้อง';
    end if;

    v_ticket_id := 'REG' || lpad(v_next::text, 4, '0');
    v_price := coalesce(p_ticket_price, 150);
    v_capacity := 1;
    v_perks := '';
    v_codes := array[v_ticket_id];
  end if;

  insert into public.tickets (id, ticket_type, event_day, buyer_name, line_user_id, price, capacity, perks)
  values (v_ticket_id, p_ticket_type, p_event_day, coalesce(nullif(trim(p_buyer_name), ''), '-'), nullif(trim(coalesce(p_line_user_id, '')), ''), v_price, v_capacity, v_perks);

  insert into public.ticket_codes (code, ticket_id, seat_no)
  select code, v_ticket_id, row_number() over ()
  from unnest(v_codes) as code;

  update public.ticket_counters
  set next_number = next_number + 1
  where ticket_type = p_ticket_type;

  insert into public.ticket_audit_logs (ticket_id, action, actor_username, actor_role, details)
  values (
    v_ticket_id,
    'issue',
    v_user.username,
    v_user.role,
    jsonb_build_object('ticket_type', p_ticket_type, 'event_day', p_event_day, 'price', v_price, 'capacity', v_capacity)
  );

  return jsonb_build_object(
    'ticket_id', v_ticket_id,
    'ticket_type', p_ticket_type,
    'event_day', p_event_day,
    'buyer_name', coalesce(nullif(trim(p_buyer_name), ''), '-'),
    'line_user_id', nullif(trim(coalesce(p_line_user_id, '')), ''),
    'price', v_price,
    'capacity', v_capacity,
    'perks', v_perks,
    'codes', v_codes
  );
end;
$$;

drop function if exists public.check_in_ticket(text, text, text);
drop function if exists public.check_in_ticket(text, text, text, text);

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
begin
  v_user := public.require_admin_session(p_session_token, 'checkin');

  if nullif(trim(p_staff_name), '') is null then
    raise exception 'กรุณากรอกชื่อเจ้าหน้าที่ก่อนเช็คอิน';
  end if;

  select * into v_code
  from public.ticket_codes
  where code = upper(trim(p_code))
  for update;

  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;

  select * into v_ticket
  from public.tickets
  where id = v_code.ticket_id;

  if v_ticket.canceled_at is not null then
    return jsonb_build_object('status', 'canceled', 'canceled_at', v_ticket.canceled_at, 'cancel_reason', v_ticket.cancel_reason);
  end if;

  if v_ticket.event_day <> p_current_day then
    return jsonb_build_object('status', 'wrong_day', 'event_day', v_ticket.event_day);
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

drop function if exists public.update_ticket_price(text, integer, text);
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

  if p_ticket_price not in (150, 180) then
    raise exception 'ราคา Regular ต้องเป็น 150 หรือ 180';
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

  update public.tickets
  set price = p_ticket_price
  where id = v_ticket.id;

  insert into public.ticket_audit_logs (ticket_id, action, actor_username, actor_role, details)
  values (v_ticket.id, 'update_price', v_user.username, v_user.role, jsonb_build_object('old_price', v_ticket.price, 'new_price', p_ticket_price));

  return jsonb_build_object('ticket_id', v_ticket.id, 'old_price', v_ticket.price, 'new_price', p_ticket_price);
end;
$$;

drop function if exists public.cancel_ticket(text, text, text);
create or replace function public.cancel_ticket(
  p_ticket_id text,
  p_reason text,
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
  v_checked_in_count integer;
begin
  v_user := public.require_admin_session(p_session_token, 'manage_ticket');

  select * into v_ticket
  from public.tickets
  where id = upper(trim(p_ticket_id))
  for update;

  if not found then
    raise exception 'ไม่พบบัตร';
  end if;

  if v_ticket.canceled_at is not null then
    raise exception 'บัตรนี้ถูกยกเลิกแล้ว';
  end if;

  select count(*) into v_checked_in_count
  from public.ticket_codes
  where ticket_id = v_ticket.id
    and checked_in_at is not null;

  if v_checked_in_count > 0 then
    raise exception 'ยกเลิกไม่ได้ เพราะมี QR ที่เช็คอินแล้ว';
  end if;

  update public.tickets
  set canceled_at = now(),
      canceled_by = v_user.username,
      cancel_reason = coalesce(nullif(trim(p_reason), ''), 'ไม่ระบุเหตุผล')
  where id = v_ticket.id;

  insert into public.ticket_audit_logs (ticket_id, action, actor_username, actor_role, details)
  values (v_ticket.id, 'cancel', v_user.username, v_user.role, jsonb_build_object('reason', coalesce(nullif(trim(p_reason), ''), 'ไม่ระบุเหตุผล')));

  return jsonb_build_object('ticket_id', v_ticket.id, 'canceled', true);
end;
$$;

grant usage on schema public to anon;
grant select on public.ticket_audit_logs to anon;
revoke execute on function public.require_admin_session(text, text) from public;
revoke execute on function public.require_admin_session(text, text) from anon;
grant execute on function public.admin_login(text, text) to anon;
grant execute on function public.admin_logout(text) to anon;
grant execute on function public.issue_ticket(text, text, text, text, integer, text) to anon;
grant execute on function public.check_in_ticket(text, text, text, text) to anon;
grant execute on function public.update_ticket_price(text, integer, text) to anon;
grant execute on function public.cancel_ticket(text, text, text) to anon;

-- ผู้ใช้เริ่มต้น 3 สิทธิ์
-- เปลี่ยน password หลังรันจริงเพื่อความปลอดภัย
insert into public.admin_users (username, password_hash, display_name, role)
values
  ('admin', extensions.crypt('Admin@1234', extensions.gen_salt('bf')), 'Admin', 'admin'),
  ('issuer', extensions.crypt('Issuer@1234', extensions.gen_salt('bf')), 'Ticket Issuer', 'issuer'),
  ('checkin', extensions.crypt('Checkin@1234', extensions.gen_salt('bf')), 'Check-in Staff', 'checkin')
on conflict (username) do nothing;
