-- The order bot supplies stable identifiers. Names and labels are display data,
-- not identities: two customers can share a name, and one customer can order
-- the same profile label more than once.
alter table public.mag_customers add column if not exists external_customer_id text;
alter table public.mag_customers drop constraint if exists mag_customers_scope_normalized_name_key;
alter table public.mag_customers
  add constraint mag_customers_scope_external_customer_id_key
  unique (scope, external_customer_id);

alter table public.mag_profiles add column if not exists external_profile_id text;
alter table public.mag_profiles drop constraint if exists mag_profiles_customer_id_profile_type_label_key;
alter table public.mag_profiles
  add constraint mag_profiles_order_id_external_profile_id_key
  unique (order_id, external_profile_id);

comment on column public.mag_customers.external_customer_id is
  'Stable identity from the named intake source; never a customer name or email.';
comment on column public.mag_profiles.external_profile_id is
  'Stable profile identity within an order for idempotent intake retries.';
