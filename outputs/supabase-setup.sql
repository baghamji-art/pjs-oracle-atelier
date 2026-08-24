create table if not exists app_state (
  id text primary key,
  members jsonb default '[]'::jsonb,
  guest_codes jsonb default '[]'::jsonb,
  logs jsonb default '[]'::jsonb,
  updated_at timestamptz default now()
);

insert into app_state (id, members, guest_codes, logs)
values ('main', '[]'::jsonb, '["1234","moon","tarot"]'::jsonb, '[]'::jsonb)
on conflict (id) do nothing;
