-- Run after security-upgrade.sql. Existing tickets and QR codes remain valid.
begin;
create or replace function public.issue_ticket_batch(p_session_token text,p_request_id uuid,p_ticket_type text,p_event_day text,p_buyer_name text,p_line_user_id text,p_ticket_price integer,p_quantity integer)
returns jsonb language plpgsql security definer set search_path=public as $$
declare u public.admin_users; e public.event_settings; req public.issue_requests; payload jsonb; v_result jsonb:='[]';
  n integer; tid text; price integer; cap integer; lim integer; sold integer; codes text[]; access uuid; i integer; seat integer; short_code text;
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
    for seat in 1..cap loop
      loop
        short_code:=to_char(p_event_day::date,'DDMMYY') ||
          lpad(((('x'||substr(replace(gen_random_uuid()::text,'-',''),1,8))::bit(32)::bigint % 100000000)::text),8,'0');
        insert into public.ticket_codes(code,ticket_id,seat_no) values(short_code,tid,seat)
          on conflict (code) do nothing;
        exit when found;
      end loop;
    end loop;
    insert into public.ticket_audit_logs(ticket_id,action,actor_username,actor_role,details) values(tid,'issue',u.username,u.role,jsonb_build_object('price',price,'request_id',p_request_id));
    v_result:=v_result||jsonb_build_array(jsonb_build_object('ticket_id',tid));
    n:=n+1;
  end loop;
  update public.ticket_counters set next_number=n where ticket_type=p_ticket_type;
  update public.issue_requests r set result=v_result where r.request_id=p_request_id;
  return v_result;
end $$;
commit;
