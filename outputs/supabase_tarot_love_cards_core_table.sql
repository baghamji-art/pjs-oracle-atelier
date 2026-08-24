create table if not exists public.tarot_love_cards_core (
  id integer primary key,
  arcana text,
  suit text,
  rank text,
  en text,
  kr text,
  tone text,
  u_core text,
  u_view text,
  u_feel text,
  u_movement text,
  u_commitment text,
  u_risk text,
  u_advice text,
  r_core text,
  r_view text,
  r_feel text,
  r_movement text,
  r_commitment text,
  r_risk text,
  r_advice text,
  created_at timestamptz not null default now()
);

alter table public.tarot_love_cards_core enable row level security;

drop policy if exists "tarot_love_cards_core_read_all" on public.tarot_love_cards_core;
create policy "tarot_love_cards_core_read_all"
on public.tarot_love_cards_core
for select
to anon, authenticated
using (true);

