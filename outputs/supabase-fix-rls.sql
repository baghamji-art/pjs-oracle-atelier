create table if not exists public.app_state (
  id text primary key,
  members jsonb default '[]'::jsonb,
  guest_codes jsonb default '[]'::jsonb,
  logs jsonb default '[]'::jsonb,
  updated_at timestamptz default now()
);

insert into public.app_state (id, members, guest_codes, logs)
values ('main', '[]'::jsonb, '["1234","moon","tarot"]'::jsonb, '[]'::jsonb)
on conflict (id) do nothing;

alter table public.app_state enable row level security;

drop policy if exists "app_state_public_select" on public.app_state;
drop policy if exists "app_state_public_insert" on public.app_state;
drop policy if exists "app_state_public_update" on public.app_state;

create policy "app_state_public_select"
on public.app_state
for select
to anon, authenticated
using (id = 'main');

create policy "app_state_public_insert"
on public.app_state
for insert
to anon, authenticated
with check (id = 'main');

create policy "app_state_public_update"
on public.app_state
for update
to anon, authenticated
using (id = 'main')
with check (id = 'main');
