-- MAG V1.1 order-bot SERVICE identity provisioning.
-- No credentials are embedded here and none should ever be added to a migration.
-- An authorized Supabase Admin operation (Dashboard, Admin API, or a script holding
-- the service-role key) creates the Auth user for the order-bot out-of-band. This
-- migration only adds the safe, idempotent database-side mechanism that turns that
-- already-created auth user id into a SERVICE membership, and a matching revoke path.
-- Both functions are security definer but are executable only by service_role, so an
-- authenticated user or the extension can never call them.

create or replace function public.mag_provision_service_membership(
  p_user_id uuid,
  p_display_name text default 'MAG Order Bot'
)
returns public.mag_memberships
language plpgsql
security definer
set search_path = ''
as $$
declare
  result public.mag_memberships;
  existing_role text;
begin
  if p_user_id is null then
    raise exception 'p_user_id is required';
  end if;
  if not exists (select 1 from auth.users where id = p_user_id) then
    raise exception 'No auth.users row for %', p_user_id;
  end if;

  select role into existing_role from public.mag_memberships where user_id = p_user_id;
  if existing_role is not null and existing_role <> 'SERVICE' then
    raise exception 'Refusing to reassign existing % membership % to SERVICE', existing_role, p_user_id;
  end if;

  insert into public.mag_memberships(user_id, role, display_name, active)
    values (p_user_id, 'SERVICE', p_display_name, true)
  on conflict (user_id) do update
    set display_name = excluded.display_name, active = true, updated_at = now()
    where public.mag_memberships.role = 'SERVICE'
  returning * into result;

  return result;
end;
$$;

revoke all on function public.mag_provision_service_membership(uuid, text) from public, anon, authenticated;
grant execute on function public.mag_provision_service_membership(uuid, text) to service_role;

-- Symmetric, non-destructive revoke: deactivates the SERVICE membership without
-- deleting it, preserving the audit/foreign-key trail on mag_orders/mag_profiles
-- rows the bot previously created.
create or replace function public.mag_revoke_service_membership(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.mag_memberships
    set active = false, updated_at = now()
    where user_id = p_user_id and role = 'SERVICE';
end;
$$;

revoke all on function public.mag_revoke_service_membership(uuid) from public, anon, authenticated;
grant execute on function public.mag_revoke_service_membership(uuid) to service_role;
