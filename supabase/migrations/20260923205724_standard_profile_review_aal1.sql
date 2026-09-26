create or replace function public.mag_profile_requires_aal2(p_profile_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from mag_private.protected_field_values v
    where v.profile_id = p_profile_id
  )
$$;

revoke all on function public.mag_profile_requires_aal2(uuid)
from public, anon, authenticated;
grant execute on function public.mag_profile_requires_aal2(uuid)
to service_role;;
