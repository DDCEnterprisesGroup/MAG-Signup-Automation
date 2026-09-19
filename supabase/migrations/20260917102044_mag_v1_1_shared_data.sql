-- MAG V1.1 shared-data foundation.
-- All objects are additive and prefixed mag_; unrelated Command Center objects are untouched.

create schema if not exists mag_private;
revoke all on schema mag_private from public, anon, authenticated;
grant usage on schema mag_private to authenticated, service_role;

create table public.mag_memberships (
  user_id uuid primary key references auth.users(id) on delete cascade,
  role text not null check (role in ('OWNER','ADMIN','OPERATOR','CUSTOMER','SERVICE')),
  display_name text not null default 'MAG User',
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.mag_customers (
  id uuid primary key default gen_random_uuid(),
  scope text not null default 'CUSTOMER' check (scope in ('CUSTOMER','INTERNAL')),
  status text not null default 'ACTIVE' check (status in ('ACTIVE','INACTIVE','ARCHIVED')),
  display_name text not null,
  normalized_name text not null,
  primary_email text,
  primary_phone text,
  legacy_source_id text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (scope, normalized_name)
);

create table public.mag_orders (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.mag_customers(id) on delete restrict,
  external_order_id text,
  service_type text not null,
  status text not null default 'DRAFT' check (status in ('DRAFT','INCOMPLETE','READY_FOR_REVIEW','ACTIVE','NEEDS_UPDATE','ARCHIVED')),
  source text not null default 'ORDER_BOT',
  project_name text,
  submitted_at timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique nulls not distinct (source, external_order_id)
);

create table public.mag_profiles (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.mag_customers(id) on delete restrict,
  order_id uuid references public.mag_orders(id) on delete set null,
  profile_type text not null check (profile_type in ('ORGANIZATION','PERSON','EVENT','PRODUCT','OTHER')),
  profile_scope text not null default 'CUSTOMER' check (profile_scope in ('CUSTOMER','INTERNAL')),
  label text not null,
  status text not null default 'DRAFT' check (status in ('DRAFT','INCOMPLETE','READY_FOR_REVIEW','ACTIVE','NEEDS_UPDATE','ARCHIVED')),
  profile_version bigint not null default 1 check (profile_version > 0),
  approved_by uuid references auth.users(id) on delete set null,
  approved_at timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz,
  unique (customer_id, profile_type, label)
);

create table public.mag_field_definitions (
  id uuid primary key default gen_random_uuid(),
  canonical_key text not null unique check (canonical_key ~ '^[a-z][a-z0-9_]{1,62}$'),
  semantic_type text not null,
  display_name text not null,
  aliases text[] not null default '{}',
  description text not null default '',
  data_type text not null default 'TEXT' check (data_type in ('TEXT','EMAIL','PHONE','URL','DATE','TIME','DATETIME','NUMBER','BOOLEAN','TEXT_ARRAY','JSON')),
  normalization_rules jsonb not null default '{}'::jsonb,
  validation_rules jsonb not null default '{}'::jsonb,
  security_class text not null default 'UNCLASSIFIED' check (security_class in ('STANDARD','SENSITIVE','RESTRICTED','CREDENTIAL','UNCLASSIFIED')),
  storage_policy text not null default 'QUARANTINE' check (storage_policy in ('PROFILE','VAULT','FORBIDDEN','QUARANTINE')),
  cache_policy text not null default 'NONE' check (cache_policy in ('LOCAL','SESSION','NONE')),
  autofill_policy text not null default 'NEVER' check (autofill_policy in ('CONFIDENCE','REVIEW_REQUIRED','EXPLICIT_UNLOCK','NEVER')),
  review_requirement text not null default 'ADMIN_REQUIRED' check (review_requirement in ('NONE','USER_REVIEW','ADMIN_REQUIRED','REAUTH_AND_APPROVAL')),
  active boolean not null default false,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    (security_class = 'STANDARD' and storage_policy = 'PROFILE' and cache_policy = 'LOCAL')
    or (security_class = 'SENSITIVE' and storage_policy = 'VAULT' and cache_policy in ('SESSION','NONE'))
    or (security_class = 'RESTRICTED' and storage_policy = 'VAULT' and cache_policy = 'NONE' and autofill_policy = 'EXPLICIT_UNLOCK')
    or (security_class = 'CREDENTIAL' and storage_policy = 'FORBIDDEN' and cache_policy = 'NONE' and autofill_policy = 'NEVER')
    or (security_class = 'UNCLASSIFIED' and storage_policy = 'QUARANTINE' and cache_policy = 'NONE' and autofill_policy = 'NEVER' and active = false)
  )
);

create table public.mag_profile_field_values (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.mag_profiles(id) on delete cascade,
  field_definition_id uuid not null references public.mag_field_definitions(id) on delete restrict,
  value jsonb not null,
  validation_status text not null default 'PENDING' check (validation_status in ('PENDING','VALID','INVALID','NEEDS_REVIEW')),
  validation_errors text[] not null default '{}',
  approved_by uuid references auth.users(id) on delete set null,
  approved_at timestamptz,
  source text not null default 'MANUAL',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (profile_id, field_definition_id)
);

create table public.mag_profile_versions (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.mag_profiles(id) on delete cascade,
  version bigint not null,
  status text not null,
  standard_snapshot jsonb not null default '{}'::jsonb,
  changed_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (profile_id, version)
);

create table public.mag_profile_access (
  profile_id uuid not null references public.mag_profiles(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  access_level text not null default 'READ' check (access_level in ('READ','OPERATE','ADMIN')),
  granted_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  primary key (profile_id, user_id)
);

create table public.mag_audit_events (
  id bigint generated always as identity primary key,
  actor_id uuid references auth.users(id) on delete set null,
  action text not null,
  entity_type text not null,
  entity_id uuid,
  field_canonical_key text,
  success boolean not null default true,
  session_id uuid,
  device_id text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  check (not (metadata ?| array['value','plaintext','password','secret','token','ssn','tax_id','bank_account','routing_number','card_number']))
);

create table mag_private.protected_field_values (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.mag_profiles(id) on delete cascade,
  field_definition_id uuid not null references public.mag_field_definitions(id) on delete restrict,
  classification text not null check (classification in ('SENSITIVE','RESTRICTED','UNCLASSIFIED')),
  vault_secret_id uuid not null,
  masked_hint text,
  key_version integer not null default 1,
  source text not null default 'MANUAL',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (profile_id, field_definition_id)
);

revoke all on all tables in schema mag_private from public, anon, authenticated;

create or replace function mag_private.current_role()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select m.role from public.mag_memberships m
  where m.user_id = (select auth.uid()) and m.active
$$;

create or replace function mag_private.is_staff()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(mag_private.current_role() in ('OWNER','ADMIN','OPERATOR'), false)
$$;

create or replace function mag_private.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(mag_private.current_role() in ('OWNER','ADMIN'), false)
$$;

create or replace function mag_private.can_read_profile(p_profile_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.mag_memberships m
    where m.user_id = (select auth.uid()) and m.active
      and (
        m.role in ('OWNER','ADMIN')
        or (m.role = 'OPERATOR' and exists (
          select 1 from public.mag_profile_access a
          where a.profile_id = p_profile_id and a.user_id = m.user_id and a.revoked_at is null
        ))
        or (m.role = 'CUSTOMER' and exists (
          select 1 from public.mag_profile_access a
          where a.profile_id = p_profile_id and a.user_id = m.user_id and a.revoked_at is null
        ))
      )
  )
$$;

revoke all on function mag_private.current_role() from public;
revoke all on function mag_private.is_staff() from public;
revoke all on function mag_private.is_admin() from public;
revoke all on function mag_private.can_read_profile(uuid) from public;
grant execute on function mag_private.current_role() to authenticated;
grant execute on function mag_private.is_staff() to authenticated;
grant execute on function mag_private.is_admin() to authenticated;
grant execute on function mag_private.can_read_profile(uuid) to authenticated;

create or replace function mag_private.touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger mag_memberships_touch before update on public.mag_memberships
for each row execute function mag_private.touch_updated_at();
create trigger mag_customers_touch before update on public.mag_customers
for each row execute function mag_private.touch_updated_at();
create trigger mag_orders_touch before update on public.mag_orders
for each row execute function mag_private.touch_updated_at();
create trigger mag_field_definitions_touch before update on public.mag_field_definitions
for each row execute function mag_private.touch_updated_at();
create trigger mag_profile_field_values_touch before update on public.mag_profile_field_values
for each row execute function mag_private.touch_updated_at();
create trigger mag_protected_values_touch before update on mag_private.protected_field_values
for each row execute function mag_private.touch_updated_at();

create or replace function mag_private.validate_standard_profile_value()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  d public.mag_field_definitions;
begin
  select * into d from public.mag_field_definitions where id = new.field_definition_id;
  if d.security_class <> 'STANDARD' or d.storage_policy <> 'PROFILE' or d.cache_policy <> 'LOCAL' then
    raise exception 'Only STANDARD/PROFILE/LOCAL fields may enter ordinary profile storage';
  end if;
  if d.security_class in ('CREDENTIAL','RESTRICTED','SENSITIVE','UNCLASSIFIED') then
    raise exception 'Protected, credential, or unclassified values are forbidden in ordinary profile storage';
  end if;
  return new;
end;
$$;

create trigger mag_profile_value_boundary
before insert or update on public.mag_profile_field_values
for each row execute function mag_private.validate_standard_profile_value();

create or replace function mag_private.bump_profile_version()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_profile uuid;
begin
  target_profile := case when tg_op = 'DELETE' then old.profile_id else new.profile_id end;
  update public.mag_profiles
    set profile_version = profile_version + 1, updated_at = now()
    where id = target_profile;
  return coalesce(new, old);
end;
$$;

create or replace function mag_private.reject_sensitive_audit_metadata()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  rendered text := lower(new.metadata::text);
begin
  if rendered ~ '"(value|plaintext|password|secret|token|ssn|tax[_ -]?id|bank[_ -]?account|routing[_ -]?number|card[_ -]?number)"[[:space:]]*:'
     or rendered ~ '[0-9]{3}-[0-9]{2}-[0-9]{4}' then
    raise exception 'Audit metadata must not contain sensitive plaintext or secret-bearing keys';
  end if;
  return new;
end;
$$;

create trigger mag_audit_no_sensitive_metadata
before insert or update on public.mag_audit_events
for each row execute function mag_private.reject_sensitive_audit_metadata();

create trigger mag_standard_value_version
after insert or update or delete on public.mag_profile_field_values
for each row execute function mag_private.bump_profile_version();
create trigger mag_protected_value_version
after insert or update or delete on mag_private.protected_field_values
for each row execute function mag_private.bump_profile_version();

create or replace function mag_private.profile_metadata_version()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  if row(new.label, new.status, new.profile_type, new.profile_scope, new.archived_at)
     is distinct from row(old.label, old.status, old.profile_type, old.profile_scope, old.archived_at)
     and new.profile_version = old.profile_version then
    new.profile_version := old.profile_version + 1;
  end if;
  return new;
end;
$$;

create trigger mag_profile_metadata_version before update on public.mag_profiles
for each row execute function mag_private.profile_metadata_version();

create or replace function mag_private.capture_profile_version()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.mag_profile_versions(profile_id, version, status, standard_snapshot, changed_by)
  select new.id, new.profile_version, new.status,
    coalesce(jsonb_object_agg(d.canonical_key, v.value) filter (where d.id is not null), '{}'::jsonb),
    (select auth.uid())
  from public.mag_profiles p
  left join public.mag_profile_field_values v on v.profile_id = p.id
  left join public.mag_field_definitions d on d.id = v.field_definition_id and d.security_class = 'STANDARD'
  where p.id = new.id
  group by p.id
  on conflict (profile_id, version) do nothing;
  return new;
end;
$$;

create trigger mag_profile_version_snapshot
after insert or update of profile_version on public.mag_profiles
for each row execute function mag_private.capture_profile_version();

create or replace function public.mag_store_protected_value(
  p_profile_id uuid,
  p_canonical_key text,
  p_plaintext text,
  p_source text default 'MANUAL'
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  d public.mag_field_definitions;
  existing mag_private.protected_field_values;
  secret_id uuid;
  hint text;
begin
  select * into d from public.mag_field_definitions where canonical_key = p_canonical_key;
  if d.id is null then raise exception 'Field definition not found'; end if;
  if d.security_class = 'CREDENTIAL' or d.storage_policy = 'FORBIDDEN' then
    raise exception 'Credential and secret values are never stored by MAG';
  end if;
  if d.security_class not in ('SENSITIVE','RESTRICTED','UNCLASSIFIED') or d.storage_policy not in ('VAULT','QUARANTINE') then
    raise exception 'Field does not use protected storage';
  end if;
  if p_plaintext is null or length(p_plaintext) = 0 then raise exception 'Protected value is empty'; end if;
  hint := case when length(p_plaintext) >= 4 then '••••' || right(p_plaintext, 4) else '••••' end;
  select * into existing from mag_private.protected_field_values
    where profile_id = p_profile_id and field_definition_id = d.id;
  if existing.id is null then
    secret_id := vault.create_secret(p_plaintext, null, 'MAG protected profile field');
    insert into mag_private.protected_field_values(profile_id, field_definition_id, classification, vault_secret_id, masked_hint, source)
      values (p_profile_id, d.id, d.security_class, secret_id, hint, p_source)
      returning id into secret_id;
    return secret_id;
  end if;
  perform vault.update_secret(existing.vault_secret_id, p_plaintext, null, 'MAG protected profile field');
  update mag_private.protected_field_values
    set classification = d.security_class, masked_hint = hint, source = p_source, key_version = key_version + 1
    where id = existing.id;
  return existing.id;
end;
$$;

create or replace function public.mag_read_restricted_value(
  p_actor_id uuid,
  p_profile_id uuid,
  p_canonical_key text
)
returns table (plaintext text, masked_hint text, classification text)
language plpgsql
security definer
set search_path = ''
as $$
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
      and pv.classification = 'RESTRICTED';
end;
$$;

revoke all on function public.mag_store_protected_value(uuid,text,text,text) from public, anon, authenticated;
revoke all on function public.mag_read_restricted_value(uuid,uuid,text) from public, anon, authenticated;
grant execute on function public.mag_store_protected_value(uuid,text,text,text) to service_role;
grant execute on function public.mag_read_restricted_value(uuid,uuid,text) to service_role;

alter table public.mag_memberships enable row level security;
alter table public.mag_customers enable row level security;
alter table public.mag_orders enable row level security;
alter table public.mag_profiles enable row level security;
alter table public.mag_field_definitions enable row level security;
alter table public.mag_profile_field_values enable row level security;
alter table public.mag_profile_versions enable row level security;
alter table public.mag_profile_access enable row level security;
alter table public.mag_audit_events enable row level security;

create policy mag_memberships_read on public.mag_memberships for select to authenticated
using (user_id = (select auth.uid()) or (select mag_private.is_admin()));
create policy mag_customers_staff_read on public.mag_customers for select to authenticated
using ((select mag_private.is_staff()));
create policy mag_orders_staff_read on public.mag_orders for select to authenticated
using ((select mag_private.is_staff()));
create policy mag_profiles_authorized_read on public.mag_profiles for select to authenticated
using ((select mag_private.can_read_profile(id)));
create policy mag_field_definitions_read on public.mag_field_definitions for select to authenticated
using (active or (select mag_private.is_staff()));
create policy mag_profile_values_authorized_read on public.mag_profile_field_values for select to authenticated
using (
  (select mag_private.can_read_profile(profile_id))
  and exists (
    select 1 from public.mag_field_definitions d
    where d.id = field_definition_id and d.security_class = 'STANDARD'
      and d.storage_policy = 'PROFILE' and d.cache_policy = 'LOCAL' and d.active
  )
);
create policy mag_profile_versions_authorized_read on public.mag_profile_versions for select to authenticated
using ((select mag_private.can_read_profile(profile_id)));
create policy mag_profile_access_read on public.mag_profile_access for select to authenticated
using (user_id = (select auth.uid()) or (select mag_private.is_admin()));
create policy mag_audit_admin_read on public.mag_audit_events for select to authenticated
using ((select mag_private.is_admin()));
create policy mag_audit_actor_insert on public.mag_audit_events for insert to authenticated
with check (actor_id = (select auth.uid()));

revoke all on table public.mag_memberships, public.mag_customers, public.mag_orders,
  public.mag_profiles, public.mag_field_definitions, public.mag_profile_field_values,
  public.mag_profile_versions, public.mag_profile_access, public.mag_audit_events
from anon;
grant select on table public.mag_memberships, public.mag_customers, public.mag_orders,
  public.mag_profiles, public.mag_field_definitions, public.mag_profile_field_values,
  public.mag_profile_versions, public.mag_profile_access, public.mag_audit_events
to authenticated;
grant insert on table public.mag_audit_events to authenticated;
grant usage, select on sequence public.mag_audit_events_id_seq to authenticated;

create index mag_orders_customer_idx on public.mag_orders(customer_id, updated_at desc);
create index mag_profiles_customer_idx on public.mag_profiles(customer_id, updated_at desc);
create index mag_profiles_sync_idx on public.mag_profiles(updated_at desc, profile_version);
create index mag_profile_values_profile_idx on public.mag_profile_field_values(profile_id);
create index mag_field_definitions_updated_idx on public.mag_field_definitions(updated_at desc);
create index mag_audit_created_idx on public.mag_audit_events(created_at desc);
create index mag_protected_profile_idx on mag_private.protected_field_values(profile_id);

-- With one pre-existing Supabase Auth account, safely bootstrap it as the MAG owner.
insert into public.mag_memberships(user_id, role, display_name)
select u.id, 'OWNER', coalesce(nullif(u.raw_user_meta_data->>'full_name',''), 'Dre')
from auth.users u
where (select count(*) from auth.users) = 1
on conflict (user_id) do nothing;
