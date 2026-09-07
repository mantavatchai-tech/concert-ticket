-- Run after security-upgrade.sql on databases already upgraded.
begin;
alter table public.event_settings add column if not exists ticket_color text not null default '#0f766e';
alter table public.event_settings drop constraint if exists event_settings_ticket_color_check;
alter table public.event_settings add constraint event_settings_ticket_color_check check (ticket_color ~ '^#[0-9A-Fa-f]{6}$');

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

revoke all on function public.save_event(text,text,text,boolean,integer,integer,integer,integer[],text) from public,anon,authenticated;
grant execute on function public.save_event(text,text,text,boolean,integer,integer,integer,integer[],text) to anon;
revoke all on function public.get_customer_ticket(text) from public,anon,authenticated;
grant execute on function public.get_customer_ticket(text) to anon;
revoke all on function public.get_dashboard(text,text,integer,integer) from public,anon,authenticated;
grant execute on function public.get_dashboard(text,text,integer,integer) to anon;
commit;