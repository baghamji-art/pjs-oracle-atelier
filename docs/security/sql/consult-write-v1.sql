-- DRAFT: isolated test DB first. Do NOT run on the live service yet.
-- No table/schema/RLS/record changes at installation. No automatic deployment.
begin;
create function public.pjo_consult_append_v1(
  p_member_id text, p_auth jsonb, p_valid_until bigint, p_role text, p_action text,
  p_consult_id text, p_message_id text, p_message text, p_lang text
) returns jsonb
language plpgsql security invoker
set search_path = ''
set lock_timeout = '3s'
set statement_timeout = '5s'
as $function$
declare
  v_members jsonb;
  v_logs jsonb;
  v_member jsonb;
  v_auth jsonb;
  v_existing jsonb;
  v_entry jsonb;
  v_count integer;
  v_thread_count integer;
  v_now numeric;
  v_last numeric;
  v_time bigint;
begin
  if current_user <> 'service_role' then raise insufficient_privilege using message = 'Server role required'; end if;
  if p_member_id is null or octet_length(p_member_id) not between 1 and 256 or
     jsonb_typeof(p_auth) is distinct from 'object' or p_valid_until is null or
     p_role is null or p_role not in ('user', 'admin') or
     p_action is null or p_action not in ('create', 'reply') or (p_role = 'admin' and p_action <> 'reply') or
     p_consult_id is null or p_consult_id !~ '^[A-Za-z0-9_-]{1,128}$' or
     p_message_id is null or p_message_id !~ '^[A-Za-z0-9_-]{1,128}$' or
     p_message is null or btrim(p_message) = '' or octet_length(p_message) > 16000 or
     p_lang is null or p_lang not in ('ko', 'en', 'zh') then
    return jsonb_build_object('result', 'invalid');
  end if;
  select s.members, s.logs into v_members, v_logs from public.app_state s where s.id = 'main' for update;
  if not found or jsonb_typeof(v_members) is distinct from 'array' or jsonb_typeof(v_logs) is distinct from 'array' then
    return jsonb_build_object('result', 'invalid');
  end if;
  select count(*) into v_count from jsonb_array_elements(v_members) e where e->>'id' = p_member_id;
  if v_count <> 1 then return jsonb_build_object('result', 'unauthorized'); end if;
  select e into v_member from jsonb_array_elements(v_members) e where e->>'id' = p_member_id;
  v_auth := jsonb_build_object('id', v_member->'id', 'status', v_member->'status', 'paid', v_member->'paid',
    'expiresAt', v_member->'expiresAt', 'password', v_member->'password', 'passwordHash', v_member->'passwordHash',
    'hasPasswordHash', v_member ? 'passwordHash');
  v_now := extract(epoch from clock_timestamp());
  if v_auth is distinct from p_auth or p_valid_until <= v_now or p_valid_until > v_now + 1200 then
    return jsonb_build_object('result', 'unauthorized');
  end if;
  -- Members must remain entitled to send. Admins can answer an existing member's
  -- thread even after that membership expires; no account status is changed.
  if p_role = 'user' then
    if coalesce(v_member->>'status', '') not in ('active', 'approved', 'expiring_soon') or v_member->'paid' = 'false'::jsonb then
      return jsonb_build_object('result', 'unauthorized');
    end if;
    if v_member->'expiresAt' is not null and v_member->'expiresAt' <> 'null'::jsonb then
      if jsonb_typeof(v_member->'expiresAt') <> 'number' then return jsonb_build_object('result', 'unauthorized'); end if;
      if (v_member->>'expiresAt')::numeric <= v_now * 1000 then return jsonb_build_object('result', 'unauthorized'); end if;
    end if;
  end if;
  -- Old screens group by consultId alone: do not introduce cross-owner collisions.
  if exists (select 1 from jsonb_array_elements(v_logs) e where e->>'action' = 'Private consult message' and
    e->>'consultId' = p_consult_id and coalesce(nullif(e->>'userId', ''), e->>'id') is distinct from p_member_id) then
    return jsonb_build_object('result', 'not_found');
  end if;
  -- Scope the retry key by owner AND server-assigned role; messageId cannot be
  -- reused with different contents or a different thread within that scope.
  select count(*) into v_count from jsonb_array_elements(v_logs) e where
    e->>'action' = 'Private consult message' and coalesce(nullif(e->>'userId', ''), e->>'id') = p_member_id and
    e->>'role' = p_role and e->>'messageId' = p_message_id;
  if v_count > 1 then return jsonb_build_object('result', 'invalid'); end if;
  if v_count = 1 then
    select e into v_existing from jsonb_array_elements(v_logs) e where
      e->>'action' = 'Private consult message' and coalesce(nullif(e->>'userId', ''), e->>'id') = p_member_id and
      e->>'role' = p_role and e->>'messageId' = p_message_id;
    if v_existing->>'consultId' is distinct from p_consult_id or v_existing->>'message' is distinct from p_message or
       v_existing->>'lang' is distinct from p_lang then return jsonb_build_object('result', 'conflict'); end if;
    if jsonb_typeof(v_existing->'time') is distinct from 'number' then return jsonb_build_object('result', 'invalid'); end if;
    if (v_existing->>'time')::numeric not between 0 and 9007199254740991 or
       trunc((v_existing->>'time')::numeric) <> (v_existing->>'time')::numeric then return jsonb_build_object('result', 'invalid'); end if;
    return jsonb_build_object('result', 'unchanged', 'time', v_existing->'time');
  end if;
  select count(*) into v_thread_count from jsonb_array_elements(v_logs) e where
    e->>'action' = 'Private consult message' and e->>'consultId' = p_consult_id and
    coalesce(nullif(e->>'userId', ''), e->>'id') = p_member_id;
  if p_action = 'reply' and v_thread_count = 0 then return jsonb_build_object('result', 'not_found'); end if;
  if p_action = 'create' and v_thread_count > 0 then return jsonb_build_object('result', 'conflict'); end if;
  for v_entry in select e from jsonb_array_elements(v_logs) e where
    e->>'action' = 'Private consult message' and e->>'consultId' = p_consult_id loop
    if jsonb_typeof(v_entry->'time') is distinct from 'number' then return jsonb_build_object('result', 'invalid'); end if;
    if (v_entry->>'time')::numeric not between 0 and 9007199254740990 or
       trunc((v_entry->>'time')::numeric) <> (v_entry->>'time')::numeric then return jsonb_build_object('result', 'invalid'); end if;
  end loop;
  select max((e->>'time')::numeric) into v_last from jsonb_array_elements(v_logs) e where
    e->>'action' = 'Private consult message' and e->>'consultId' = p_consult_id;
  v_time := greatest(floor(extract(epoch from clock_timestamp()) * 1000), coalesce(v_last + 1, 0))::bigint;
  v_entry := jsonb_build_object('id', p_member_id, 'userId', p_member_id, 'action', 'Private consult message',
    'consultId', p_consult_id, 'role', p_role, 'message', p_message, 'time', v_time, 'lang', p_lang, 'messageId', p_message_id);
  if jsonb_array_length(v_logs) >= 10000 then return jsonb_build_object('result', 'full'); end if;
  v_logs := jsonb_build_array(v_entry) || v_logs;
  if octet_length(jsonb_build_object('id', 'main', 'members', v_members, 'logs', v_logs)::text) > 7340032 then
    return jsonb_build_object('result', 'full');
  end if;
  -- Never truncate old logs, overwrite members, or recreate a missing main row.
  update public.app_state set logs = v_logs, updated_at = clock_timestamp() where id = 'main';
  return jsonb_build_object('result', 'sent', 'time', v_time);
end;
$function$;
revoke all on function public.pjo_consult_append_v1(text, jsonb, bigint, text, text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.pjo_consult_append_v1(text, jsonb, bigint, text, text, text, text, text, text) to service_role;
commit;
