-- Cover MAG foreign keys used by authorization, cleanup, and audit queries.
create index mag_protected_definition_idx on mag_private.protected_field_values(field_definition_id);
create index mag_audit_actor_idx on public.mag_audit_events(actor_id);
create index mag_customers_created_by_idx on public.mag_customers(created_by);
create index mag_field_definitions_created_by_idx on public.mag_field_definitions(created_by);
create index mag_orders_created_by_idx on public.mag_orders(created_by);
create index mag_profile_access_user_idx on public.mag_profile_access(user_id);
create index mag_profile_access_granted_by_idx on public.mag_profile_access(granted_by);
create index mag_profile_values_definition_idx on public.mag_profile_field_values(field_definition_id);
create index mag_profile_values_approved_by_idx on public.mag_profile_field_values(approved_by);
create index mag_profile_versions_changed_by_idx on public.mag_profile_versions(changed_by);
create index mag_profiles_order_idx on public.mag_profiles(order_id);
create index mag_profiles_approved_by_idx on public.mag_profiles(approved_by);
create index mag_profiles_created_by_idx on public.mag_profiles(created_by);
