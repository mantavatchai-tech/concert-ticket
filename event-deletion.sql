-- Run after security-upgrade.sql. Adds admin-only backup-before-delete workflow.
begin;
create or replace function public.backup_event(p_session_token text,p_event_day text)
returns jsonb language plpgsql security definer set search_path=public as $$
declare u public.admin_users; e public.event_settings;
begin
  u:=public.require_admin_session(p_session_token,'admin');
  select * into e from public.event_settings where event_day=p_event_day;
  if not found then raise exception 'Event not found'; end if;
  return jsonb_build_object(
    'backup_version',1,'created_at',now(),'created_by',u.username,'event',to_jsonb(e),
    'tickets',coalesce((select jsonb_agg(to_jsonb(t) order by t.issued_at,t.id) from public.tickets t where t.event_day=p_event_day),'[]'),
    'ticket_codes',coalesce((select jsonb_agg(to_jsonb(c) order by c.ticket_id,c.seat_no) from public.ticket_codes c join public.tickets t on t.id=c.ticket_id where t.event_day=p_event_day),'[]'),
    'checkins',coalesce((select jsonb_agg(to_jsonb(c) order by c.checked_in_at,c.id) from public.checkins c where c.event_day=p_event_day),'[]'),
    'line_deliveries',coalesce((select jsonb_agg(to_jsonb(d)) from public.line_deliveries d join public.tickets t on t.id=d.ticket_id where t.event_day=p_event_day),'[]'),
    'audit_logs',coalesce((select jsonb_agg(to_jsonb(a) order by a.created_at,a.id) from public.ticket_audit_logs a where a.ticket_id in(select id from public.tickets where event_day=p_event_day) or a.details->>'event_day'=p_event_day),'[]')
  );
end $$;

create or replace function public.delete_event(p_session_token text,p_event_day text,p_confirmation text)
returns jsonb language plpgsql security definer set search_path=public as $$
declare u public.admin_users; e public.event_settings; n_tickets integer; n_checkins integer;
begin
  u:=public.require_admin_session(p_session_token,'admin');
  select * into e from public.event_settings where event_day=p_event_day for update;
  if not found then raise exception 'Event not found'; end if;
  if e.active and e.event_day::date>=current_date then raise exception 'Close ticket sales before deleting this event'; end if;
  if p_confirmation<>('DELETE '||p_event_day) then raise exception 'Backup confirmation is invalid'; end if;
  select count(*) into n_tickets from public.tickets where event_day=p_event_day;
  select count(*) into n_checkins from public.checkins where event_day=p_event_day;
  delete from public.checkins where event_day=p_event_day;
  delete from public.line_deliveries where ticket_id in(select id from public.tickets where event_day=p_event_day);
  delete from public.ticket_audit_logs where ticket_id in(select id from public.tickets where event_day=p_event_day) or details->>'event_day'=p_event_day;
  delete from public.issue_requests where payload->>1=p_event_day;
  delete from public.tickets where event_day=p_event_day;
  delete from public.event_settings where event_day=p_event_day;
  insert into public.ticket_audit_logs(action,actor_username,actor_role,details)
    values('delete_event',u.username,u.role,jsonb_build_object('event_day',p_event_day,'event_name',e.name,'tickets',n_tickets,'checkins',n_checkins,'backup_confirmed',true));
  return jsonb_build_object('event_day',p_event_day,'tickets_deleted',n_tickets,'checkins_deleted',n_checkins);
end $$;
revoke all on function public.backup_event(text,text) from public,anon,authenticated;
grant execute on function public.backup_event(text,text) to anon;
revoke all on function public.delete_event(text,text,text) from public,anon,authenticated;
grant execute on function public.delete_event(text,text,text) to anon;
commit;
