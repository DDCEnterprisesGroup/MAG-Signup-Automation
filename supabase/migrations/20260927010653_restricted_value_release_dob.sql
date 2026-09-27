-- Release the vaulted date of birth (SENSITIVE) through the existing
-- mag-restricted-value path. Previously only RESTRICTED rows were returned, so
-- DOB could never be read even though it is stored in the same vault.
-- Access checks (OWNER/ADMIN/OPERATOR + profile access) and the audit row are
-- unchanged. The Edge Function still requires recent MFA for every RESTRICTED
-- key; only date_of_birth is released to a normal signed-in session.
CREATE OR REPLACE FUNCTION public.mag_read_restricted_value(p_actor_id uuid, p_profile_id uuid, p_canonical_key text)
 RETURNS TABLE(plaintext text, masked_hint text, classification text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if not exists (
    select 1 from public.mag_memberships m
    where m.user_id = p_actor_id and m.active and m.role in ('OWNER','ADMIN','OPERATOR')
  ) then
    raise exception 'Restricted access denied';
  end if;
  if not exists (
    select 1 from public.mag_memberships m
    where m.user_id = p_actor_id and m.active and (
      m.role in ('OWNER','ADMIN') or exists (
        select 1 from public.mag_profile_access a
        where a.user_id = p_actor_id and a.profile_id = p_profile_id and a.revoked_at is null
      )
    )
  ) then
    raise exception 'Restricted profile access denied';
  end if;
  insert into public.mag_audit_events(actor_id, action, entity_type, entity_id, field_canonical_key, success, metadata)
    values (p_actor_id, 'RESTRICTED_ACCESS_SUCCESS', 'PROFILE', p_profile_id, p_canonical_key, true, '{"source":"edge_function"}'::jsonb);
  return query
    select ds.decrypted_secret, pv.masked_hint, pv.classification
    from mag_private.protected_field_values pv
    join public.mag_field_definitions d on d.id = pv.field_definition_id
    join vault.decrypted_secrets ds on ds.id = pv.vault_secret_id
    where pv.profile_id = p_profile_id and d.canonical_key = p_canonical_key
      and (pv.classification = 'RESTRICTED'
           or (pv.classification = 'SENSITIVE' and p_canonical_key = 'date_of_birth'));
end;
$function$;
