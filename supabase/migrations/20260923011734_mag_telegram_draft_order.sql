-- Create Telegram draft orders and profile shells atomically. The webhook
-- passes only identifiers and catalog choices; customer intake never enters
-- mag_telegram_sessions.context or this function's arguments.
create sequence if not exists public.mag_order_number_seq;
revoke all on sequence public.mag_order_number_seq from public, anon, authenticated;
grant usage on sequence public.mag_order_number_seq to service_role;

-- A Telegram customer may create or cancel an order. Their numeric ID is not
-- necessarily a mag_telegram_admins row, so this audit column cannot FK only
-- to the admin allowlist. Authorization remains in the service-only function.
alter table public.mag_order_status_history
  drop constraint if exists mag_order_status_history_changed_by_telegram_user_id_fkey;

create or replace function public.mag_create_telegram_draft(
  p_telegram_user_id bigint,
  p_draft_key uuid,
  p_service_code text,
  p_profile_count integer
)
returns table(order_id uuid, order_number text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_customer_id uuid;
  v_product_id uuid;
  v_existing_customer_id uuid;
  v_existing_service text;
  v_existing_status text;
  v_number text;
  v_order_id uuid;
begin
  if p_draft_key is null or p_telegram_user_id is null or p_profile_count is null or p_profile_count not between 1 and 25 then
    raise exception 'Invalid draft order request';
  end if;
  select c.id into v_customer_id from public.mag_customers c
    where c.telegram_user_id = p_telegram_user_id and c.scope = 'CUSTOMER' and c.status = 'ACTIVE';
  if v_customer_id is null then raise exception 'Telegram customer not found'; end if;

  select p.id into v_product_id from public.mag_products p
    where p.code = p_service_code and p.active and p.availability = 'AVAILABLE'
      and p.code <> 'EMAIL_CONFIRMATION';
  if v_product_id is null then raise exception 'Service unavailable'; end if;

  select o.id, o.order_number, o.customer_id, o.service_type, o.status
    into v_order_id, v_number, v_existing_customer_id, v_existing_service, v_existing_status
    from public.mag_orders o
    where o.source = 'TELEGRAM_WEBHOOK' and o.external_order_id = p_draft_key::text;
  if v_order_id is not null then
    if v_existing_customer_id <> v_customer_id or v_existing_service <> p_service_code or v_existing_status <> 'DRAFT'
      or (select count(*) from public.mag_profiles p where p.order_id = v_order_id) <> p_profile_count then
      raise exception 'Draft identity or state conflict';
    end if;
    return query select v_order_id, v_number;
    return;
  end if;

  v_number := 'MAGHP-' || lpad(nextval('public.mag_order_number_seq')::text, 6, '0');
  insert into public.mag_orders
    (customer_id, external_order_id, service_type, source, status, payment_status, order_number)
  values (v_customer_id, p_draft_key::text, p_service_code, 'TELEGRAM_WEBHOOK', 'DRAFT', 'DRAFT', v_number)
  on conflict (source, external_order_id) do nothing
  returning id into v_order_id;

  if v_order_id is null then
    -- A concurrent delivery completed this same draft first. Its transaction
    -- committed the order and profiles together before this SELECT resumes.
    select o.id, o.order_number, o.customer_id, o.service_type, o.status
      into v_order_id, v_number, v_existing_customer_id, v_existing_service, v_existing_status
      from public.mag_orders o
      where o.source = 'TELEGRAM_WEBHOOK' and o.external_order_id = p_draft_key::text;
    if v_order_id is null or v_existing_customer_id <> v_customer_id or v_existing_service <> p_service_code
      or v_existing_status <> 'DRAFT'
      or (select count(*) from public.mag_profiles p where p.order_id = v_order_id) <> p_profile_count then
      raise exception 'Draft identity or state conflict';
    end if;
    return query select v_order_id, v_number;
    return;
  end if;

  insert into public.mag_profiles
    (customer_id, order_id, external_profile_id, profile_type, profile_scope, label, status)
  select v_customer_id, v_order_id, n::text, 'PERSON', 'CUSTOMER', 'Profile ' || n, 'DRAFT'
    from generate_series(1, p_profile_count) n;
  insert into public.mag_order_status_history
    (order_id, previous_status, new_status, changed_by_telegram_user_id, reason)
  values (v_order_id, null, 'DRAFT', p_telegram_user_id, 'Telegram draft created');
  return query select v_order_id, v_number;
end;
$$;

revoke all on function public.mag_create_telegram_draft(bigint,uuid,text,integer) from public, anon, authenticated;
grant execute on function public.mag_create_telegram_draft(bigint,uuid,text,integer) to service_role;

create or replace function public.mag_cancel_telegram_draft(
  p_telegram_user_id bigint,
  p_order_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order public.mag_orders;
begin
  select o.* into v_order
    from public.mag_orders o
    join public.mag_customers c on c.id = o.customer_id
    where o.id = p_order_id and c.telegram_user_id = p_telegram_user_id
      and o.source = 'TELEGRAM_WEBHOOK'
    for update of o;
  if v_order.id is null then raise exception 'Draft order not found'; end if;
  if v_order.status = 'ARCHIVED' and v_order.payment_status = 'CANCELLED' then return false; end if;
  if v_order.status <> 'DRAFT' or v_order.payment_status <> 'DRAFT' then
    raise exception 'Order cannot be cancelled as a draft';
  end if;
  update public.mag_profiles p set status = 'ARCHIVED', archived_at = now()
    where p.order_id = p_order_id and p.status = 'DRAFT';
  update public.mag_orders o set status = 'ARCHIVED', payment_status = 'CANCELLED'
    where o.id = p_order_id;
  insert into public.mag_order_status_history
    (order_id, previous_status, new_status, changed_by_telegram_user_id, reason)
  values (p_order_id, 'DRAFT', 'CANCELLED', p_telegram_user_id, 'Cancelled by customer');
  return true;
end;
$$;

revoke all on function public.mag_cancel_telegram_draft(bigint,uuid) from public, anon, authenticated;
grant execute on function public.mag_cancel_telegram_draft(bigint,uuid) to service_role;

-- Before enabling the webhook after SQLite import, advance the sequence to
-- the imported MAGHP numeric maximum. This migration does not read SQLite or
-- make assumptions about its current order IDs.
;
