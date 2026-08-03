 alter table public.tickets drop constraint if exists tickets_event_day_check;

update public.tickets
set event_day = case event_day
  when 'Day 1' then '2026-08-27'
  when 'Day 2' then '2026-08-28'
  when 'Day 3' then '2026-08-30'
  when 'Day 4' then '2026-09-06'
  else event_day
end
where event_day in ('Day 1', 'Day 2', 'Day 3', 'Day 4');

update public.checkins
set event_day = case event_day
  when 'Day 1' then '2026-08-27'
  when 'Day 2' then '2026-08-28'
  when 'Day 3' then '2026-08-30'
  when 'Day 4' then '2026-09-06'
  else event_day
end
where event_day in ('Day 1', 'Day 2', 'Day 3', 'Day 4');

alter table public.tickets
add constraint tickets_event_day_check
check (event_day in ('2026-08-27', '2026-08-28', '2026-08-30', '2026-09-06'));

drop function if exists public.issue_ticket(text, text, text, text);

create or replace function public.issue_ticket(
  p_ticket_type text,
  p_event_day text,
  p_buyer_name text,
  p_line_user_id text default null,
  p_ticket_price integer default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_next integer;
  v_ticket_id text;
  v_price integer;
  v_capacity integer;
  v_perks text;
  v_codes text[];
begin
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

grant execute on function public.issue_ticket(text, text, text, text, integer) to anon;
