-- DRAFT: apply to an isolated test database first, NOT the live database.
-- No table/column/data/RLS changes. One new function; no automatic deployment.
-- Existing unrestricted whole-row writers MUST be retired before production use.
begin;

create function public.pjo_archive_apply_v1(
  p_member_id text, p_auth jsonb, p_valid_until bigint,
  p_reading_id text, p_expected jsonb, p_next jsonb
) returns jsonb
language plpgsql
security invoker
set search_path = ''
set lock_timeout = '3s'
set statement_timeout = '5s'
as $function$
declare
  v_members jsonb;
  v_member jsonb;
  v_history jsonb;
  v_current jsonb;
  v_auth jsonb;
  v_member_index integer;
  v_record_index integer;
  v_count integer;
  v_now numeric;
begin
  -- Grant is the primary boundary; this also protects against accidental grants.
  if current_user <> 'service_role' then
    raise insufficient_privilege using message = 'Server role required';
  end if;
  if p_member_id is null or octet_length(p_member_id) not between 1 and 256 or
     p_reading_id is null or octet_length(p_reading_id) not between 1 and 256 or
     p_valid_until is null or jsonb_typeof(p_auth) is distinct from 'object' then
    return jsonb_build_object('result', 'invalid');
  end if;
  if (p_expected is not null and (jsonb_typeof(p_expected) <> 'object' or p_expected->>'id' is distinct from p_reading_id)) or
     (p_next is not null and (jsonb_typeof(p_next) <> 'object' or p_next->>'id' is distinct from p_reading_id)) or
     octet_length(coalesce(p_next::text, '')) > 1048576 then
    return jsonb_build_object('result', 'invalid');
  end if;

  -- Read the latest committed row under lock. A stale server snapshot never
  -- replaces the array; only the selected record in this locked array changes.
  select s.members into v_members from public.app_state as s where s.id = 'main' for update;
  if not found or jsonb_typeof(v_members) is distinct from 'array' then
    return jsonb_build_object('result', 'invalid');
  end if;
  select count(*), min((e.ordinality - 1)::integer) into v_count, v_member_index
    from jsonb_array_elements(v_members) with ordinality as e(value, ordinality)
    where e.value->>'id' = p_member_id;
  if v_count <> 1 then return jsonb_build_object('result', 'unauthorized'); end if;
  v_member := v_members->v_member_index;
  v_auth := jsonb_build_object('id', v_member->'id', 'status', v_member->'status',
    'paid', v_member->'paid', 'expiresAt', v_member->'expiresAt',
    'password', v_member->'password', 'passwordHash', v_member->'passwordHash',
    'hasPasswordHash', v_member ? 'passwordHash');
  v_now := extract(epoch from clock_timestamp());
  if v_auth is distinct from p_auth or p_valid_until <= v_now or p_valid_until > v_now + 1200 or
     coalesce(v_member->>'status', '') not in ('active', 'approved', 'expiring_soon') or
     v_member->'paid' = 'false'::jsonb then
    return jsonb_build_object('result', 'unauthorized');
  end if;
  if v_member->'expiresAt' is not null and v_member->'expiresAt' <> 'null'::jsonb then
    if jsonb_typeof(v_member->'expiresAt') <> 'number' then return jsonb_build_object('result', 'unauthorized'); end if;
    if (v_member->>'expiresAt')::numeric <= v_now * 1000 then return jsonb_build_object('result', 'unauthorized'); end if;
  end if;
  v_history := coalesce(v_member->'history', '[]'::jsonb);
  if jsonb_typeof(v_history) is distinct from 'array' then return jsonb_build_object('result', 'invalid'); end if;
  if jsonb_array_length(v_history) > 10000 or exists (
    select 1 from jsonb_array_elements(v_history) e where jsonb_typeof(e) <> 'object' or
      jsonb_typeof(e->'id') is distinct from 'string' or coalesce(e->>'id', '') = ''
  ) or exists (select 1 from jsonb_array_elements(v_history) e group by e->>'id' having count(*) > 1) then
    return jsonb_build_object('result', 'invalid');
  end if;
  select (e.ordinality - 1)::integer, e.value into v_record_index, v_current
    from jsonb_array_elements(v_history) with ordinality as e(value, ordinality)
    where e.value->>'id' = p_reading_id;
  -- Repeated identical requests are idempotent, including delete of an absent ID.
  if v_current is not distinct from p_next then return jsonb_build_object('result', 'unchanged'); end if;
  if v_current is distinct from p_expected then return jsonb_build_object('result', 'conflict'); end if;
  if p_next is null then
    v_history := v_history - v_record_index;
  elsif v_current is null then
    if jsonb_array_length(v_history) >= 60 then return jsonb_build_object('result', 'full'); end if;
    v_history := jsonb_build_array(p_next) || v_history;
  else
    v_history := jsonb_set(v_history, array[v_record_index::text], p_next, false);
  end if;
  v_member := jsonb_set(v_member, '{history}', v_history, true);
  v_members := jsonb_set(v_members, array[v_member_index::text], v_member, false);
  update public.app_state set members = v_members, updated_at = clock_timestamp() where id = 'main';
  return jsonb_build_object('result', case when p_next is null then 'deleted' else 'saved' end);
end;
$function$;

revoke all on function public.pjo_archive_apply_v1(text, jsonb, bigint, text, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.pjo_archive_apply_v1(text, jsonb, bigint, text, jsonb, jsonb) to service_role;
commit;
