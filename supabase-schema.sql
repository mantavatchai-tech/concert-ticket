create table if not exists public.ticket_counters (
  ticket_type text primary key check (ticket_type in ('VIP', 'Regular')),
  next_number integer not null default 1
);

insert into public.ticket_counters (ticket_type, next_number)
values ('VIP', 1), ('Regular', 1)
on conflict (ticket_type) do nothing;

create table if not exists public.tickets (
  id text primary key,
  ticket_type text not null check (ticket_type in ('VIP', 'Regular')),
  event_day text not null check (event_day in ('2026-08-27', '2026-08-28', '2026-08-30', '2026-09-06')),
  buyer_name text not null default '-',
  line_user_id text,
  price integer not null,
  capacity integer not null,
  perks text not null default '',
  line_send_status text not null default 'not_sent' check (line_send_status in ('not_sent', 'sent', 'failed')),
  line_sent_at timestamptz,
  line_send_error text not null default '',
  issued_at timestamptz not null default now()
);

create table if not exists public.ticket_codes (
  code text primary key,
  ticket_id text not null references public.tickets(id) on delete cascade,
  seat_no integer not null,
  checked_in_at timestamptz,
  staff_name text,
  unique (ticket_id, seat_no)
);

create table if not exists public.checkins (
  id bigserial primary key,
  code text not null references public.ticket_codes(code),
  ticket_id text not null references public.tickets(id),
  ticket_type text not null,
  event_day text not null,
  staff_name text not null,
  checked_in_at timestamptz not null default now()
);

create table if not exists public.line_customers (
  line_user_id text primary key,
  display_name text,
  picture_url text,
  last_event_type text,
  followed_at timestamptz,
  last_seen_at timestamptz not null default now()
);

create index if not exists idx_tickets_issued_at on public.tickets (issued_at desc);
create index if not exists idx_ticket_codes_ticket_id on public.ticket_codes (ticket_id);
create index if not exists idx_checkins_checked_in_at on public.checkins (checked_in_at desc);
create index if not exists idx_line_customers_last_seen_at on public.line_customers (last_seen_at desc);

alter table public.tickets enable row level security;
alter table public.ticket_codes enable row level security;
alter table public.checkins enable row level security;
alter table public.ticket_counters enable row level security;
alter table public.line_customers enable row level security;

drop policy if exists "Public read tickets" on public.tickets;
drop policy if exists "Public read ticket codes" on public.ticket_codes;
drop policy if exists "Public read checkins" on public.checkins;
drop policy if exists "Public read line customers" on public.line_customers;

create policy "Public read tickets" on public.tickets for select using (true);
create policy "Public read ticket codes" on public.ticket_codes for select using (true);
create policy "Public read checkins" on public.checkins for select using (true);
create policy "Public read line customers" on public.line_customers for select using (true);

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
    v_perks := 'พร้อมเครื่องดื่ม';
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

create or replace function public.check_in_ticket(
  p_code text,
  p_current_day text,
  p_staff_name text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_code public.ticket_codes%rowtype;
  v_ticket public.tickets%rowtype;
  v_now timestamptz := now();
begin
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
      staff_name = coalesce(nullif(trim(p_staff_name), ''), 'ไม่ระบุ')
  where code = v_code.code;

  insert into public.checkins (code, ticket_id, ticket_type, event_day, staff_name, checked_in_at)
  values (
    v_code.code,
    v_ticket.id,
    v_ticket.ticket_type,
    v_ticket.event_day,
    coalesce(nullif(trim(p_staff_name), ''), 'ไม่ระบุ'),
    v_now
  );

  return jsonb_build_object('status', 'checked_in', 'checked_in_at', v_now);
end;
$$;

grant usage on schema public to anon;
grant select on public.tickets to anon;
grant select on public.ticket_codes to anon;
grant select on public.checkins to anon;
grant select on public.line_customers to anon;
grant execute on function public.issue_ticket(text, text, text, text, integer) to anon;
grant execute on function public.check_in_ticket(text, text, text) to anon;
