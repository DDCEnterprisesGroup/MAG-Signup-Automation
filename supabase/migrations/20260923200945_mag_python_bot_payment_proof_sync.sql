create or replace function public.mag_sync_order_payment_proof(
  p_external_order_id text,
  p_telegram_user_id bigint,
  p_payment_method text,
  p_expected_amount integer,
  p_file_id text,
  p_file_unique_id text,
  p_file_type text,
  p_uploaded_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order public.mag_orders%rowtype;
  v_proof_id uuid;
  v_previous_status text;
begin
  if nullif(trim(p_external_order_id), '') is null
     or nullif(trim(p_payment_method), '') is null
     or nullif(trim(p_file_id), '') is null
     or nullif(trim(p_file_unique_id), '') is null
     or p_file_type not in ('photo', 'document', 'pdf')
     or p_expected_amount < 0 then
    raise exception 'INVALID_PAYMENT_PROOF';
  end if;

  select * into v_order
  from public.mag_orders
  where source = 'ORDER_BOT' and external_order_id = trim(p_external_order_id)
  for update;

  if v_order.id is null then
    raise exception 'ORDER_NOT_FOUND';
  end if;

  insert into public.mag_payment_proofs (
    order_id, telegram_user_id, payment_method, expected_amount,
    file_id, file_unique_id, file_type, uploaded_at
  ) values (
    v_order.id, p_telegram_user_id, trim(p_payment_method), p_expected_amount,
    p_file_id, p_file_unique_id, p_file_type, coalesce(p_uploaded_at, now())
  )
  on conflict (order_id, file_unique_id) do update
    set file_id = excluded.file_id
  returning id into v_proof_id;

  v_previous_status := v_order.payment_status;
  update public.mag_orders
  set order_number = coalesce(order_number, trim(p_external_order_id)),
      payment_status = 'PAYMENT_REVIEW',
      payment_method = trim(p_payment_method),
      total = p_expected_amount,
      updated_at = now()
  where id = v_order.id;

  if v_previous_status is distinct from 'PAYMENT_REVIEW' then
    insert into public.mag_order_status_history (
      order_id, previous_status, new_status, reason
    ) values (
      v_order.id, v_previous_status, 'PAYMENT_REVIEW', 'Payment proof received through the Python Telegram bot'
    );
  end if;

  return jsonb_build_object(
    'orderId', v_order.id,
    'proofId', v_proof_id,
    'paymentStatus', 'PAYMENT_REVIEW'
  );
end;
$$;

revoke all on function public.mag_sync_order_payment_proof(text, bigint, text, integer, text, text, text, timestamptz)
from public, anon, authenticated;
grant execute on function public.mag_sync_order_payment_proof(text, bigint, text, integer, text, text, text, timestamptz)
to service_role;;
