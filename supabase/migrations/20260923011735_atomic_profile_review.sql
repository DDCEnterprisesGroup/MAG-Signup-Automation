-- One service-role-only transaction for profile review and its audit event.
-- The Edge Function authenticates the user and requires AAL2 before calling.
create or replace function public.mag_review_profile_atomic(
  p_profile_id uuid,
  p_expected_version bigint,
  p_approve boolean,
  p_actor_id uuid
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  current_profile public.mag_profiles%rowtype;
  next_status text;
begin
  if p_profile_id is null or p_expected_version is null or p_approve is null or p_actor_id is null then
    raise exception 'INVALID_REQUEST' using errcode = '22023';
  end if;

  if not exists (
    select 1 from public.mag_memberships m
    where m.user_id = p_actor_id and m.active and m.role in ('OWNER', 'ADMIN')
  ) then
    raise exception 'ADMIN_REQUIRED' using errcode = '42501';
  end if;

  -- Field-value triggers also update this row's version. The lock makes
  -- validation and the expected-version check part of the same transition.
  select p.* into current_profile
  from public.mag_profiles p
  where p.id = p_profile_id
  for update;
  if not found or current_profile.status <> 'READY_FOR_REVIEW'
      or current_profile.profile_version <> p_expected_version then
    raise exception 'PROFILE_NOT_READY' using errcode = '22023';
  end if;

  if exists (
    select 1 from public.mag_profile_field_values v
    where v.profile_id = p_profile_id and v.validation_status <> 'VALID'
  ) then
    raise exception 'PROFILE_VALIDATION_FAILED' using errcode = '22023';
  end if;

  next_status := case when p_approve then 'ACTIVE' else 'NEEDS_UPDATE' end;
  update public.mag_profiles p
    set status = next_status,
        approved_by = case when p_approve then p_actor_id else null end,
        approved_at = case when p_approve then now() else null end
    where p.id = p_profile_id
    returning p.* into current_profile;

  insert into public.mag_audit_events(actor_id, action, entity_type, entity_id, success, metadata)
  values (p_actor_id,
          case when p_approve then 'PROFILE_APPROVED' else 'PROFILE_REJECTED' end,
          'PROFILE', p_profile_id, true,
          jsonb_build_object('resulting_status', next_status));

  return jsonb_build_object('profileId', current_profile.id,
                            'status', current_profile.status,
                            'profileVersion', current_profile.profile_version);
end;
$$;

revoke all on function public.mag_review_profile_atomic(uuid, bigint, boolean, uuid)
  from public, anon, authenticated;
grant execute on function public.mag_review_profile_atomic(uuid, bigint, boolean, uuid)
  to service_role;
;
