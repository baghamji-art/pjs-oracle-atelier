-- READ ONLY. No user records, passwords, keys, or consultation messages are queried.
-- Run in the Supabase SQL Editor; share policy/configuration results only.

-- 1. Is row-level security enabled on the two existing application tables?
select n.nspname as schema_name, c.relname as table_name,
       c.relrowsecurity as rls_enabled, c.relforcerowsecurity as force_rls
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relname in ('app_state', 'tarot_love_cards_core')
  and c.relkind in ('r', 'p');

-- 2. Which row policies are actually installed?
select schemaname, tablename, policyname, permissive, roles, cmd, qual, with_check
from pg_policies
where schemaname = 'public'
  and tablename in ('app_state', 'tarot_love_cards_core')
order by tablename, policyname;

-- 3. What effective table privileges do the browser roles have?
select c.relname as table_name, role_name,
       has_table_privilege(role_name, c.oid, 'SELECT') as can_select,
       has_table_privilege(role_name, c.oid, 'INSERT') as can_insert,
       has_table_privilege(role_name, c.oid, 'UPDATE') as can_update,
       has_table_privilege(role_name, c.oid, 'DELETE') as can_delete
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
cross join (values ('anon'), ('authenticated')) as browser_roles(role_name)
where n.nspname = 'public'
  and c.relname in ('app_state', 'tarot_love_cards_core')
  and c.relkind in ('r', 'p')
order by c.relname, role_name;
