-- ============================================================================
-- Hisaab: trip expense splitter. Supabase / Postgres schema.
--
-- Safe to run more than once (idempotent). Every object it creates is prefixed
-- hs_ so it can share a project with other apps.
--
-- Security model
--   * There are no logins. A trip is reached only through its secret token
--     (24 random bytes, base64url) that lives in the invite link.
--   * Row-level security is ON for every hs_ table and there are NO policies,
--     and anon/authenticated have no table privileges at all. The browser
--     cannot read or write a table directly.
--   * The browser calls the hs_* functions below. They are SECURITY DEFINER,
--     pin search_path to '', and every one of them requires the trip token.
--     Anyone holding a trip's link can read and edit that trip, and nothing else.
--   * Internal helpers (hs__*) are not executable by anon/authenticated.
--
-- Money is stored as integer paise (bigint). Rupees are only a display format.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table if not exists public.hs_trips (
  id          uuid primary key default gen_random_uuid(),
  token       text not null unique check (char_length(token) between 24 and 64),
  name        text not null check (char_length(name) between 1 and 60),
  version     bigint not null default 1,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table if not exists public.hs_members (
  id          uuid primary key default gen_random_uuid(),
  trip_id     uuid not null references public.hs_trips (id) on delete cascade,
  name        text not null check (char_length(name) between 1 and 24),
  upi         text check (upi is null or upi ~ '^[a-z0-9._-]{2,64}@[a-z][a-z0-9.-]{1,48}$'),
  position    integer not null check (position > 0),
  created_at  timestamptz not null default now()
);
create unique index if not exists hs_members_trip_name_key on public.hs_members (trip_id, lower(name));
create index if not exists hs_members_trip_idx on public.hs_members (trip_id, position);

create table if not exists public.hs_expenses (
  id            uuid primary key default gen_random_uuid(),
  trip_id       uuid not null references public.hs_trips (id) on delete cascade,
  title         text not null check (char_length(title) between 1 and 60),
  amount_paise  bigint not null check (amount_paise > 0 and amount_paise <= 100000000), -- up to Rs 10 lakh
  paid_by       uuid not null references public.hs_members (id) deferrable initially deferred,
  created_by    uuid references public.hs_members (id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists hs_expenses_trip_idx on public.hs_expenses (trip_id, created_at);
create index if not exists hs_expenses_paid_by_idx on public.hs_expenses (paid_by);
create index if not exists hs_expenses_created_by_idx on public.hs_expenses (created_by);

-- Who an expense is split between (equal split, paise-exact on the client).
create table if not exists public.hs_expense_shares (
  expense_id  uuid not null references public.hs_expenses (id) on delete cascade,
  member_id   uuid not null references public.hs_members (id) deferrable initially deferred,
  primary key (expense_id, member_id)
);
create index if not exists hs_expense_shares_member_idx on public.hs_expense_shares (member_id);

-- Settle-up payments someone marked as paid.
create table if not exists public.hs_payments (
  id            uuid primary key default gen_random_uuid(),
  trip_id       uuid not null references public.hs_trips (id) on delete cascade,
  from_member   uuid not null references public.hs_members (id) deferrable initially deferred,
  to_member     uuid not null references public.hs_members (id) deferrable initially deferred,
  amount_paise  bigint not null check (amount_paise > 0 and amount_paise <= 1000000000),
  created_at    timestamptz not null default now(),
  check (from_member <> to_member)
);
create index if not exists hs_payments_trip_idx on public.hs_payments (trip_id, created_at);
create index if not exists hs_payments_from_idx on public.hs_payments (from_member);
create index if not exists hs_payments_to_idx on public.hs_payments (to_member);

-- Member references are checked at commit (deferred), so deleting a trip cascades
-- cleanly, while deleting a member who still has money on the trip still fails.
-- Upgrades databases created by earlier versions of this file (RESTRICT / immediate).
do $$
declare
  c record;
begin
  for c in
    select con.conname, cls.relname, att.attname
    from pg_constraint con
    join pg_class cls on cls.oid = con.conrelid
    join pg_namespace ns on ns.oid = cls.relnamespace
    join pg_attribute att on att.attrelid = con.conrelid and att.attnum = con.conkey[1]
    where ns.nspname = 'public'
      and con.contype = 'f'
      and con.confrelid = 'public.hs_members'::regclass
      and (con.confdeltype = 'r' or not con.condeferred)
      and (cls.relname, att.attname) in (('hs_expenses', 'paid_by'), ('hs_expense_shares', 'member_id'),
                                         ('hs_payments', 'from_member'), ('hs_payments', 'to_member'))
  loop
    execute format('alter table public.%I drop constraint %I', c.relname, c.conname);
    execute format('alter table public.%I add constraint %I foreign key (%I) references public.hs_members (id) deferrable initially deferred',
                   c.relname, c.conname, c.attname);
  end loop;
  -- created_by is only a note of who added an expense: it clears when that person is removed.
  if exists (select 1 from pg_constraint
             where conname = 'hs_expenses_created_by_fkey' and conrelid = 'public.hs_expenses'::regclass
               and confdeltype <> 'n') then
    alter table public.hs_expenses drop constraint hs_expenses_created_by_fkey;
    alter table public.hs_expenses add constraint hs_expenses_created_by_fkey
      foreign key (created_by) references public.hs_members (id) on delete set null;
  end if;
end $$;

-- Lock the tables: RLS on, no policies, no grants to the API roles.
alter table public.hs_trips          enable row level security;
alter table public.hs_members        enable row level security;
alter table public.hs_expenses       enable row level security;
alter table public.hs_expense_shares enable row level security;
alter table public.hs_payments       enable row level security;

revoke all on table public.hs_trips, public.hs_members, public.hs_expenses,
                    public.hs_expense_shares, public.hs_payments
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Internal helpers (not callable from the browser)
-- ---------------------------------------------------------------------------

-- Resolve a token to a trip id, or fail with HTTP 404.
create or replace function public.hs__trip(p_token text)
returns uuid
language plpgsql stable security definer set search_path = ''
as $$
declare v_id uuid;
begin
  if p_token is null or char_length(p_token) not between 24 and 64 then
    raise exception 'trip_not_found' using errcode = 'PT404';
  end if;
  select t.id into v_id from public.hs_trips t where t.token = p_token;
  if v_id is null then
    raise exception 'trip_not_found' using errcode = 'PT404';
  end if;
  return v_id;
end $$;

-- Bump the trip's version so polling clients know to refetch.
create or replace function public.hs__touch(p_trip uuid)
returns bigint
language sql volatile security definer set search_path = ''
as $$
  update public.hs_trips set version = version + 1, updated_at = now()
  where id = p_trip
  returning version;
$$;

create or replace function public.hs__clean_name(p_name text, p_max int)
returns text
language plpgsql immutable set search_path = ''
as $$
declare v text := btrim(regexp_replace(coalesce(p_name, ''), '\s+', ' ', 'g'));
begin
  if char_length(v) = 0 then
    raise exception 'name_required' using errcode = 'PT400';
  end if;
  if char_length(v) > p_max then
    raise exception 'name_too_long' using errcode = 'PT400';
  end if;
  return v;
end $$;

create or replace function public.hs__clean_upi(p_upi text)
returns text
language plpgsql immutable set search_path = ''
as $$
declare v text := lower(btrim(coalesce(p_upi, '')));
begin
  if v = '' then return null; end if;
  if v !~ '^[a-z0-9._-]{2,64}@[a-z][a-z0-9.-]{1,48}$' then
    raise exception 'bad_upi' using errcode = 'PT400';
  end if;
  return v;
end $$;

create or replace function public.hs__member_in_trip(p_trip uuid, p_member uuid)
returns void
language plpgsql stable security definer set search_path = ''
as $$
begin
  if p_member is null or not exists (
    select 1 from public.hs_members m where m.id = p_member and m.trip_id = p_trip
  ) then
    raise exception 'member_not_found' using errcode = 'PT404';
  end if;
end $$;

-- Validate an expense's fields; returns the de-duplicated split list.
create or replace function public.hs__check_expense(
  p_trip uuid, p_title text, p_amount_paise bigint, p_paid_by uuid, p_split uuid[]
)
returns uuid[]
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_split uuid[];
  v_found int;
begin
  if p_amount_paise is null or p_amount_paise <= 0 or p_amount_paise > 100000000 then
    raise exception 'bad_amount' using errcode = 'PT400';
  end if;
  perform public.hs__member_in_trip(p_trip, p_paid_by);
  select coalesce(array_agg(distinct s), '{}') into v_split
  from unnest(coalesce(p_split, '{}'::uuid[])) as s where s is not null;
  if cardinality(v_split) = 0 then
    raise exception 'split_required' using errcode = 'PT400';
  end if;
  select count(*) into v_found from public.hs_members m
  where m.trip_id = p_trip and m.id = any (v_split);
  if v_found <> cardinality(v_split) then
    raise exception 'member_not_found' using errcode = 'PT404';
  end if;
  return v_split;
end $$;

-- ---------------------------------------------------------------------------
-- API (callable by anon through PostgREST: POST /rest/v1/rpc/<name>)
-- ---------------------------------------------------------------------------

-- Create a trip and its first member. Returns the secret token.
create or replace function public.hs_create_trip(p_name text, p_member_name text, p_member_upi text default null)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_token  text := translate(encode(extensions.gen_random_bytes(24), 'base64'), '+/', '-_');
  v_name   text := public.hs__clean_name(p_name, 60);
  v_member text := public.hs__clean_name(p_member_name, 24);
  v_upi    text := public.hs__clean_upi(p_member_upi);
  v_trip   uuid;
  v_mid    uuid;
begin
  insert into public.hs_trips (token, name) values (v_token, v_name) returning id into v_trip;
  insert into public.hs_members (trip_id, name, upi, position)
  values (v_trip, v_member, v_upi, 1) returning id into v_mid;
  return jsonb_build_object('token', v_token, 'trip_id', v_trip, 'member_id', v_mid);
end $$;

-- Everything the app shows for one trip.
create or replace function public.hs_get_trip(p_token text)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare v_trip uuid := public.hs__trip(p_token);
begin
  return (
    select jsonb_build_object(
      'trip', jsonb_build_object('id', t.id, 'name', t.name, 'version', t.version,
                                 'created_at', t.created_at, 'updated_at', t.updated_at),
      'members', coalesce((
        select jsonb_agg(jsonb_build_object('id', m.id, 'name', m.name, 'upi', m.upi,
                                            'position', m.position) order by m.position)
        from public.hs_members m where m.trip_id = t.id), '[]'::jsonb),
      'expenses', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'id', e.id, 'title', e.title, 'amount_paise', e.amount_paise,
                 'paid_by', e.paid_by, 'created_by', e.created_by,
                 'split', coalesce((select jsonb_agg(s.member_id) from public.hs_expense_shares s
                                    where s.expense_id = e.id), '[]'::jsonb),
                 'created_at', e.created_at, 'updated_at', e.updated_at)
               order by e.created_at desc, e.id)
        from public.hs_expenses e where e.trip_id = t.id), '[]'::jsonb),
      'payments', coalesce((
        select jsonb_agg(jsonb_build_object('id', p.id, 'from', p.from_member, 'to', p.to_member,
                                            'amount_paise', p.amount_paise, 'created_at', p.created_at)
               order by p.created_at desc, p.id)
        from public.hs_payments p where p.trip_id = t.id), '[]'::jsonb)
    )
    from public.hs_trips t where t.id = v_trip
  );
end $$;

-- Cheap polling: has anything changed?
create or replace function public.hs_trip_version(p_token text)
returns bigint
language plpgsql stable security definer set search_path = ''
as $$
declare v_trip uuid := public.hs__trip(p_token);
begin
  return (select t.version from public.hs_trips t where t.id = v_trip);
end $$;

create or replace function public.hs_rename_trip(p_token text, p_name text)
returns bigint
language plpgsql volatile security definer set search_path = ''
as $$
declare v_trip uuid := public.hs__trip(p_token);
begin
  update public.hs_trips set name = public.hs__clean_name(p_name, 60) where id = v_trip;
  return public.hs__touch(v_trip);
end $$;

-- Join a trip from its link. Names are unique per trip (case-insensitive).
create or replace function public.hs_join_trip(p_token text, p_name text, p_upi text default null)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_trip uuid := public.hs__trip(p_token);
  v_name text := public.hs__clean_name(p_name, 24);
  v_upi  text := public.hs__clean_upi(p_upi);
  v_pos  int;
  v_mid  uuid;
begin
  perform 1 from public.hs_trips where id = v_trip for update;  -- serialise joins per trip
  if (select count(*) from public.hs_members where trip_id = v_trip) >= 30 then
    raise exception 'trip_full' using errcode = 'PT409';
  end if;
  if exists (select 1 from public.hs_members where trip_id = v_trip and lower(name) = lower(v_name)) then
    raise exception 'name_taken' using errcode = 'PT409';
  end if;
  select coalesce(max(position), 0) + 1 into v_pos from public.hs_members where trip_id = v_trip;
  insert into public.hs_members (trip_id, name, upi, position)
  values (v_trip, v_name, v_upi, v_pos) returning id into v_mid;
  return jsonb_build_object('member_id', v_mid, 'version', public.hs__touch(v_trip));
end $$;

create or replace function public.hs_update_member(p_token text, p_member uuid, p_name text, p_upi text default null)
returns bigint
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_trip uuid := public.hs__trip(p_token);
  v_name text := public.hs__clean_name(p_name, 24);
begin
  perform public.hs__member_in_trip(v_trip, p_member);
  if exists (select 1 from public.hs_members
             where trip_id = v_trip and id <> p_member and lower(name) = lower(v_name)) then
    raise exception 'name_taken' using errcode = 'PT409';
  end if;
  update public.hs_members set name = v_name, upi = public.hs__clean_upi(p_upi) where id = p_member;
  return public.hs__touch(v_trip);
end $$;

-- Remove someone who joined by mistake. Only allowed while they have no money on the trip.
create or replace function public.hs_remove_member(p_token text, p_member uuid)
returns bigint
language plpgsql volatile security definer set search_path = ''
as $$
declare v_trip uuid := public.hs__trip(p_token);
begin
  perform public.hs__member_in_trip(v_trip, p_member);
  if exists (select 1 from public.hs_expenses where paid_by = p_member)
     or exists (select 1 from public.hs_expense_shares where member_id = p_member)
     or exists (select 1 from public.hs_payments where from_member = p_member or to_member = p_member) then
    raise exception 'member_has_activity' using errcode = 'PT409';
  end if;
  update public.hs_expenses set created_by = null where created_by = p_member;
  delete from public.hs_members where id = p_member;
  return public.hs__touch(v_trip);
end $$;

create or replace function public.hs_add_expense(
  p_token text, p_title text, p_amount_paise bigint, p_paid_by uuid, p_split uuid[], p_actor uuid default null
)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_trip  uuid := public.hs__trip(p_token);
  v_title text := public.hs__clean_name(p_title, 60);
  v_split uuid[];
  v_id    uuid;
begin
  v_split := public.hs__check_expense(v_trip, v_title, p_amount_paise, p_paid_by, p_split);
  if p_actor is not null then perform public.hs__member_in_trip(v_trip, p_actor); end if;
  if (select count(*) from public.hs_expenses where trip_id = v_trip) >= 500 then
    raise exception 'trip_full' using errcode = 'PT409';
  end if;
  insert into public.hs_expenses (trip_id, title, amount_paise, paid_by, created_by)
  values (v_trip, v_title, p_amount_paise, p_paid_by, p_actor) returning id into v_id;
  insert into public.hs_expense_shares (expense_id, member_id) select v_id, unnest(v_split);
  return jsonb_build_object('id', v_id, 'version', public.hs__touch(v_trip));
end $$;

create or replace function public.hs_update_expense(
  p_token text, p_expense uuid, p_title text, p_amount_paise bigint, p_paid_by uuid, p_split uuid[]
)
returns bigint
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_trip  uuid := public.hs__trip(p_token);
  v_title text := public.hs__clean_name(p_title, 60);
  v_split uuid[];
begin
  if not exists (select 1 from public.hs_expenses where id = p_expense and trip_id = v_trip) then
    raise exception 'expense_not_found' using errcode = 'PT404';
  end if;
  v_split := public.hs__check_expense(v_trip, v_title, p_amount_paise, p_paid_by, p_split);
  update public.hs_expenses
     set title = v_title, amount_paise = p_amount_paise, paid_by = p_paid_by, updated_at = now()
   where id = p_expense;
  delete from public.hs_expense_shares where expense_id = p_expense;
  insert into public.hs_expense_shares (expense_id, member_id) select p_expense, unnest(v_split);
  return public.hs__touch(v_trip);
end $$;

create or replace function public.hs_delete_expense(p_token text, p_expense uuid)
returns bigint
language plpgsql volatile security definer set search_path = ''
as $$
declare v_trip uuid := public.hs__trip(p_token);
begin
  delete from public.hs_expenses where id = p_expense and trip_id = v_trip;
  if not found then
    raise exception 'expense_not_found' using errcode = 'PT404';
  end if;
  return public.hs__touch(v_trip);
end $$;

-- "Mark as paid" on a settle-up card.
create or replace function public.hs_record_payment(p_token text, p_from uuid, p_to uuid, p_amount_paise bigint)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_trip uuid := public.hs__trip(p_token);
  v_id   uuid;
begin
  perform public.hs__member_in_trip(v_trip, p_from);
  perform public.hs__member_in_trip(v_trip, p_to);
  if p_from = p_to then
    raise exception 'same_member' using errcode = 'PT400';
  end if;
  if p_amount_paise is null or p_amount_paise <= 0 or p_amount_paise > 1000000000 then
    raise exception 'bad_amount' using errcode = 'PT400';
  end if;
  if (select count(*) from public.hs_payments where trip_id = v_trip) >= 500 then
    raise exception 'trip_full' using errcode = 'PT409';
  end if;
  insert into public.hs_payments (trip_id, from_member, to_member, amount_paise)
  values (v_trip, p_from, p_to, p_amount_paise) returning id into v_id;
  return jsonb_build_object('id', v_id, 'version', public.hs__touch(v_trip));
end $$;

create or replace function public.hs_delete_payment(p_token text, p_payment uuid)
returns bigint
language plpgsql volatile security definer set search_path = ''
as $$
declare v_trip uuid := public.hs__trip(p_token);
begin
  delete from public.hs_payments where id = p_payment and trip_id = v_trip;
  if not found then
    raise exception 'payment_not_found' using errcode = 'PT404';
  end if;
  return public.hs__touch(v_trip);
end $$;

-- ---------------------------------------------------------------------------
-- Function privileges: helpers private, API open to the anon key.
-- ---------------------------------------------------------------------------

revoke all on function public.hs__trip(text)                                     from public, anon, authenticated;
revoke all on function public.hs__touch(uuid)                                    from public, anon, authenticated;
revoke all on function public.hs__clean_name(text, int)                          from public, anon, authenticated;
revoke all on function public.hs__clean_upi(text)                                from public, anon, authenticated;
revoke all on function public.hs__member_in_trip(uuid, uuid)                     from public, anon, authenticated;
revoke all on function public.hs__check_expense(uuid, text, bigint, uuid, uuid[]) from public, anon, authenticated;

revoke all on function public.hs_create_trip(text, text, text)                         from public;
revoke all on function public.hs_get_trip(text)                                        from public;
revoke all on function public.hs_trip_version(text)                                    from public;
revoke all on function public.hs_rename_trip(text, text)                               from public;
revoke all on function public.hs_join_trip(text, text, text)                           from public;
revoke all on function public.hs_update_member(text, uuid, text, text)                 from public;
revoke all on function public.hs_remove_member(text, uuid)                             from public;
revoke all on function public.hs_add_expense(text, text, bigint, uuid, uuid[], uuid)   from public;
revoke all on function public.hs_update_expense(text, uuid, text, bigint, uuid, uuid[]) from public;
revoke all on function public.hs_delete_expense(text, uuid)                            from public;
revoke all on function public.hs_record_payment(text, uuid, uuid, bigint)              from public;
revoke all on function public.hs_delete_payment(text, uuid)                            from public;

grant execute on function public.hs_create_trip(text, text, text)                         to anon, authenticated;
grant execute on function public.hs_get_trip(text)                                        to anon, authenticated;
grant execute on function public.hs_trip_version(text)                                    to anon, authenticated;
grant execute on function public.hs_rename_trip(text, text)                               to anon, authenticated;
grant execute on function public.hs_join_trip(text, text, text)                           to anon, authenticated;
grant execute on function public.hs_update_member(text, uuid, text, text)                 to anon, authenticated;
grant execute on function public.hs_remove_member(text, uuid)                             to anon, authenticated;
grant execute on function public.hs_add_expense(text, text, bigint, uuid, uuid[], uuid)   to anon, authenticated;
grant execute on function public.hs_update_expense(text, uuid, text, bigint, uuid, uuid[]) to anon, authenticated;
grant execute on function public.hs_delete_expense(text, uuid)                            to anon, authenticated;
grant execute on function public.hs_record_payment(text, uuid, uuid, bigint)              to anon, authenticated;
grant execute on function public.hs_delete_payment(text, uuid)                            to anon, authenticated;

-- Tell PostgREST to pick up the new functions right away.
notify pgrst, 'reload schema';
