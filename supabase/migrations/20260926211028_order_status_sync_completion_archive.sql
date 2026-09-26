-- Order-bot status sync (supersedes the never-applied 20260923214500 draft).
--
-- The Python bot posts each local order transition to the mag-order-status
-- Edge Function, which calls this function. Completing an order stamps
-- mag_orders.completed_at/payment_status and archives only the CUSTOMER
-- profiles linked to that order (mag_profiles.order_id). The extension drops
-- ARCHIVED profiles on its next automatic sync.

alter table public.mag_order_status_history
  add column if not exists external_event_id text;

create unique index if not exists mag_order_status_history_external_event_uidx
  on public.mag_order_status_history(external_event_id)
  where external_event_id is not null;

-- Lifecycle position of a payment status. Orders never move backwards and
-- COMPLETED/CANCELLED are terminal.
create or replace function mag_private.order_payment_rank(p_status text)
returns integer
language sql
immutable
set search_path = ''
as $$
  select case p_status
    when 'AWAITING_PAYMENT' then 1
    when 'PAYMENT_REVIEW' then 2
    when 'PAYMENT_NEEDS_PROOF' then 2
    when 'PAYMENT_REJECTED' then 2
    when 'PENDING' then 3
    when 'PROCESSING' then 4
    when 'COMPLETED' then 5
    when 'CANCELLED' then 5
    else 0
  end;
$$;

create or replace function public.mag_sync_order_status(
  p_external_order_id text,
  p_external_event_id text,
  p_previous_status text,
  p_new_status text,
  p_reason text,
  p_actor_id uuid,
  p_occurred_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order public.mag_orders%rowtype;
  v_existing public.mag_order_status_history%rowtype;
  v_applied boolean;
  v_archived integer := 0;
  v_allowed constant text[] := array[
    'AWAITING_PAYMENT','PAYMENT_REVIEW','PAYMENT_NEEDS_PROOF','PAYMENT_REJECTED',
    'PENDING','PROCESSING','COMPLETED','CANCELLED'
  ];
begin
  if nullif(trim(p_external_order_id), '') is null
     or nullif(trim(p_external_event_id), '') is null
     or p_new_status is null
     or not (p_new_status = any(v_allowed))
     or length(coalesce(p_reason, '')) > 250 then
    raise exception 'INVALID_ORDER_STATUS';
  end if;

  -- Idempotent replay: the bot retries until it sees a success response.
  select * into v_existing
  from public.mag_order_status_history
  where external_event_id = trim(p_external_event_id);
  if v_existing.id is not null then
    select * into v_order from public.mag_orders where id = v_existing.order_id;
    return jsonb_build_object('orderId', v_order.id, 'eventId', v_existing.id,
      'paymentStatus', v_existing.new_status, 'currentPaymentStatus', v_order.payment_status,
      'applied', v_order.payment_status = v_existing.new_status, 'archivedProfiles', 0);
  end if;

  select * into v_order
  from public.mag_orders
  where source = 'ORDER_BOT' and external_order_id = trim(p_external_order_id)
  for update;
  if v_order.id is null then
    raise exception 'ORDER_NOT_FOUND';
  end if;

  -- The bot owns the order lifecycle and sends events in order. Apply the
  -- expected transition, or a forward catch-up when earlier events never
  -- reached MAG. An older event is recorded but never moves the order back.
  v_applied := v_order.payment_status is not distinct from p_previous_status
    or (mag_private.order_payment_rank(v_order.payment_status) < 5
        and mag_private.order_payment_rank(p_new_status) > mag_private.order_payment_rank(v_order.payment_status));

  if v_applied then
    update public.mag_orders
    set payment_status = p_new_status,
        completed_at = case when p_new_status = 'COMPLETED' then coalesce(p_occurred_at, now()) else completed_at end,
        updated_at = now()
    where id = v_order.id;

    if p_new_status = 'COMPLETED' then
      update public.mag_profiles
      set status = 'ARCHIVED', archived_at = now()
      where order_id = v_order.id
        and profile_scope = 'CUSTOMER'
        and status <> 'ARCHIVED';
      get diagnostics v_archived = row_count;
    end if;
  end if;

  insert into public.mag_order_status_history (
    order_id, previous_status, new_status, changed_by_auth_user_id,
    reason, created_at, external_event_id
  ) values (
    v_order.id, p_previous_status, p_new_status, p_actor_id,
    left(concat_ws(' · ', nullif(trim(p_reason), ''),
      case when not v_applied then 'superseded: order already ' || v_order.payment_status end), 250),
    coalesce(p_occurred_at, now()), trim(p_external_event_id)
  )
  returning * into v_existing;

  -- paymentStatus acknowledges the event's status (the bot's contract);
  -- currentPaymentStatus is the order's actual status afterwards.
  return jsonb_build_object('orderId', v_order.id, 'eventId', v_existing.id,
    'paymentStatus', p_new_status,
    'currentPaymentStatus', case when v_applied then p_new_status else v_order.payment_status end,
    'applied', v_applied, 'archivedProfiles', v_archived);
end;
$$;

revoke all on function mag_private.order_payment_rank(text) from public, anon, authenticated;
revoke all on function public.mag_sync_order_status(text,text,text,text,text,uuid,timestamptz)
from public, anon, authenticated;
grant execute on function public.mag_sync_order_status(text,text,text,text,text,uuid,timestamptz)
to service_role;
