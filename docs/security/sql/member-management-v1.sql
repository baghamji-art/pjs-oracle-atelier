-- DRAFT, isolated test database only until coordinated cutover is approved.
-- Policy confirmed 2026-10-15: instant permanent MEMBER signup (not admin).
-- New functions only. No table/column/RLS/data changes at installation.
begin;
create function public.pjo_member_register_v1(
  p_member_id text, p_password_hash text, p_request_id text, p_fingerprint text, p_valid_until bigint
) returns jsonb language plpgsql security invoker
set search_path = '' set lock_timeout = '3s' set statement_timeout = '5s'
as $function$
declare
  v_members jsonb; v_logs jsonb; v_member jsonb; v_count integer; v_time bigint; v_now numeric;
begin
  if current_user <> 'service_role' then raise insufficient_privilege using message = 'Server role required'; end if;
  if p_member_id is null or octet_length(p_member_id) not between 1 and 256 or btrim(p_member_id) <> p_member_id or
     p_password_hash is null or p_password_hash !~ '^pjo-scrypt-v1\$[a-f0-9]{32}\$[a-f0-9]{128}$' or
     p_request_id is null or p_request_id !~ '^[A-Za-z0-9_-]{16,128}$' or
     p_fingerprint is null or p_fingerprint !~ '^[A-Za-z0-9_-]{43}$' or p_valid_until is null then
    return jsonb_build_object('result', 'invalid');
  end if;
  select s.members, s.logs into v_members, v_logs from public.app_state s where s.id = 'main' for update;
  if not found or jsonb_typeof(v_members) is distinct from 'array' or jsonb_typeof(v_logs) is distinct from 'array' then
    return jsonb_build_object('result', 'invalid');
  end if;
  v_now := extract(epoch from clock_timestamp());
  if p_valid_until <= v_now or p_valid_until > v_now + 1200 then return jsonb_build_object('result', 'unauthorized'); end if;
  if exists (select 1 from jsonb_array_elements(v_members) e where jsonb_typeof(e) <> 'object' or
    jsonb_typeof(e->'id') is distinct from 'string' or coalesce(e->>'id','') = '') or exists (
    select 1 from jsonb_array_elements(v_members) e group by e->>'id' having count(*) > 1
  ) then return jsonb_build_object('result', 'invalid'); end if;
  -- Legacy deletion tombstones must not silently hide/resurrect a new account.
  if exists (select 1 from jsonb_array_elements(v_logs) e where e->>'action' = 'Member deleted' and e->>'id' = p_member_id) then
    return jsonb_build_object('result', 'unavailable');
  end if;
  select count(*) into v_count from jsonb_array_elements(v_members) e where e->>'id' = p_member_id;
  if v_count = 1 then
    select e into v_member from jsonb_array_elements(v_members) e where e->>'id' = p_member_id;
    if v_member->'_registration'->>'requestId' = p_request_id and v_member->'_registration'->>'fingerprint' = p_fingerprint then
      return jsonb_build_object('result', 'unchanged');
    end if;
    return jsonb_build_object('result', 'unavailable');
  end if;
  if jsonb_array_length(v_members) >= 10000 then return jsonb_build_object('result', 'full'); end if;
  v_time := floor(v_now * 1000)::bigint;
  v_member := jsonb_build_object('id', p_member_id, 'passwordHash', p_password_hash,
    'plan', 'permanent', 'tier', 'member', 'paid', true, 'uniqueCode', '', 'memo', '', 'status', 'active',
    'createdAt', v_time, 'firstLoginAt', null, 'lastLoginAt', null, 'expiresAt', 4102444800000,
    'permanent', true, 'history', '[]'::jsonb,
    '_registration', jsonb_build_object('requestId', p_request_id, 'fingerprint', p_fingerprint));
  v_members := v_members || jsonb_build_array(v_member);
  if octet_length(jsonb_build_object('id','main','members',v_members,'logs',v_logs)::text) > 7340032 then
    return jsonb_build_object('result', 'full');
  end if;
  update public.app_state set members = v_members, updated_at = clock_timestamp() where id = 'main';
  return jsonb_build_object('result', 'created');
end;
$function$;
revoke all on function public.pjo_member_register_v1(text,text,text,text,bigint) from public, anon, authenticated;
grant execute on function public.pjo_member_register_v1(text,text,text,text,bigint) to service_role;

create function public.pjo_member_manage_v1(
  p_member_id text, p_expected jsonb, p_valid_until bigint, p_action text, p_payload jsonb
) returns jsonb language plpgsql security invoker
set search_path = '' set lock_timeout = '3s' set statement_timeout = '5s'
as $function$
declare
  v_members jsonb; v_logs jsonb; v_member jsonb; v_snapshot jsonb; v_next jsonb;
  v_count integer; v_index integer; v_now numeric; v_key text;
begin
  if current_user <> 'service_role' then raise insufficient_privilege using message = 'Server role required'; end if;
  if p_member_id is null or octet_length(p_member_id) not between 1 and 256 or p_valid_until is null or
     jsonb_typeof(p_expected) is distinct from 'object' or jsonb_typeof(p_payload) is distinct from 'object' or
     p_action is null or p_action not in ('approve','set-entitlement','set-memo') then
    return jsonb_build_object('result', 'invalid');
  end if;
  if p_action = 'set-memo' then
    if (select count(*) from jsonb_object_keys(p_payload)) <> 1 or jsonb_typeof(p_payload->'memo') is distinct from 'string' or
       octet_length(p_payload->>'memo') > 16384 then return jsonb_build_object('result','invalid'); end if;
  else
    if (select count(*) from jsonb_object_keys(p_payload)) <> 4 or
       not (p_payload ?& array['plan','tier','permanent','expiresAt']) or
       coalesce(p_payload->>'plan','') not in ('trial3','trial7','month1','month3','year1','permanent') or
       coalesce(p_payload->>'tier','') not in ('member','premium','vip') or
       jsonb_typeof(p_payload->'permanent') is distinct from 'boolean' or
       jsonb_typeof(p_payload->'expiresAt') is distinct from 'number' then return jsonb_build_object('result','invalid'); end if;
  end if;
  select s.members, s.logs into v_members, v_logs from public.app_state s where s.id = 'main' for update;
  if not found or jsonb_typeof(v_members) is distinct from 'array' or jsonb_typeof(v_logs) is distinct from 'array' then
    return jsonb_build_object('result','invalid');
  end if;
  v_now := extract(epoch from clock_timestamp());
  if p_valid_until <= v_now or p_valid_until > v_now + 1200 then return jsonb_build_object('result','unauthorized'); end if;
  if p_action <> 'set-memo' then
    if trunc((p_payload->>'expiresAt')::numeric) <> (p_payload->>'expiresAt')::numeric then return jsonb_build_object('result','invalid'); end if;
    if p_payload->'permanent' = 'true'::jsonb then
      if p_payload->>'plan' <> 'permanent' or (p_payload->>'expiresAt')::numeric <> 4102444800000 then return jsonb_build_object('result','invalid'); end if;
    else
      if p_payload->>'plan' = 'permanent' or (p_payload->>'expiresAt')::numeric <= v_now * 1000 or
         (p_payload->>'expiresAt')::numeric >= 4102444800000 then return jsonb_build_object('result','invalid'); end if;
    end if;
  end if;
  select count(*), min((e.ordinality - 1)::integer) into v_count, v_index from
    jsonb_array_elements(v_members) with ordinality as e(value,ordinality) where e.value->>'id' = p_member_id;
  if v_count <> 1 then return jsonb_build_object('result','unavailable'); end if;
  v_member := v_members->v_index;
  v_snapshot := jsonb_build_object('id',v_member->'id','status',v_member->'status','paid',v_member->'paid',
    'expiresAt',v_member->'expiresAt','password',v_member->'password','passwordHash',v_member->'passwordHash',
    'hasPasswordHash',v_member ? 'passwordHash', 'plan',v_member->'plan','tier',v_member->'tier',
    'permanent',v_member->'permanent','memo',v_member->'memo','uniqueCode',v_member->'uniqueCode',
    'createdAt',v_member->'createdAt','lastApprovedAt',v_member->'lastApprovedAt','_registration',v_member->'_registration');
  if v_snapshot is distinct from p_expected then return jsonb_build_object('result','conflict'); end if;
  -- Merge onto the locked latest member. Do not replace their history/credentials.
  v_next := v_member;
  for v_key in select jsonb_object_keys(p_payload) loop
    v_next := jsonb_set(v_next, array[v_key], p_payload->v_key, true);
  end loop;
  if p_action = 'approve' then
    v_next := v_next || jsonb_build_object('status','active','paid',true,'lastApprovedAt',floor(v_now * 1000)::bigint);
  end if;
  if v_next = v_member then return jsonb_build_object('result','unchanged'); end if;
  v_members := jsonb_set(v_members, array[v_index::text], v_next, false);
  if octet_length(jsonb_build_object('id','main','members',v_members,'logs',v_logs)::text) > 7340032 then
    return jsonb_build_object('result','full');
  end if;
  update public.app_state set members = v_members, updated_at = clock_timestamp() where id = 'main';
  return jsonb_build_object('result','saved');
end;
$function$;
revoke all on function public.pjo_member_manage_v1(text,jsonb,bigint,text,jsonb) from public, anon, authenticated;
grant execute on function public.pjo_member_manage_v1(text,jsonb,bigint,text,jsonb) to service_role;
commit;
