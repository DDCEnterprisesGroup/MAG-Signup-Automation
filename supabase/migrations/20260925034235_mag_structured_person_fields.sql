-- Additive MAG structured-person registry expansion.
-- Existing canonical fields remain in place for legacy rows and aliases.
do $$
begin
  if not exists (select 1 from public.mag_field_definitions where canonical_key = 'middle_name') then
    insert into public.mag_field_definitions
      (canonical_key, semantic_type, display_name, aliases, description, data_type,
       normalization_rules, validation_rules, security_class, storage_policy,
       cache_policy, autofill_policy, review_requirement, active)
    values
      ('middle_name', 'MIDDLE_NAME', 'Middle name', array['Middle Name','Middle Initial','Middle'],
       'Optional person middle name or initial.', 'TEXT', '{}'::jsonb, '{}'::jsonb,
       'STANDARD', 'PROFILE', 'LOCAL', 'CONFIDENCE', 'USER_REVIEW', true);
  end if;

  if not exists (select 1 from public.mag_field_definitions where canonical_key = 'address_line_2') then
    insert into public.mag_field_definitions
      (canonical_key, semantic_type, display_name, aliases, description, data_type,
       normalization_rules, validation_rules, security_class, storage_policy,
       cache_policy, autofill_policy, review_requirement, active)
    values
      ('address_line_2', 'ADDRESS_LINE_2', 'Address line 2',
       array['Address Line 2','Address2','Apt','Apartment','Suite','Unit'],
       'Optional apartment, suite, or unit information.', 'TEXT', '{}'::jsonb, '{}'::jsonb,
       'STANDARD', 'PROFILE', 'LOCAL', 'CONFIDENCE', 'USER_REVIEW', true);
  end if;

  if not exists (select 1 from public.mag_field_definitions where canonical_key = 'full_address') then
    insert into public.mag_field_definitions
      (canonical_key, semantic_type, display_name, aliases, description, data_type,
       normalization_rules, validation_rules, security_class, storage_policy,
       cache_policy, autofill_policy, review_requirement, active)
    values
      ('full_address', 'FULL_ADDRESS', 'Full address', array['Full Address','Mailing Address'],
       'Derived compatibility address assembled from structured address parts.', 'TEXT', '{}'::jsonb, '{}'::jsonb,
       'STANDARD', 'PROFILE', 'LOCAL', 'CONFIDENCE', 'USER_REVIEW', true);
  end if;
end $$;

update public.mag_field_definitions
set aliases = (select array_agg(distinct value order by value)
               from unnest(aliases || array['Address Line 1','Street Address']) as value),
    updated_at = now()
where canonical_key = 'address';

update public.mag_field_definitions
set display_name = 'XXX-XX-XXXX',
    aliases = (select array_agg(distinct value order by value)
               from unnest(aliases || array['XXX-XX-XXXX','Social Security']) as value),
    updated_at = now()
where canonical_key = 'ssn';
