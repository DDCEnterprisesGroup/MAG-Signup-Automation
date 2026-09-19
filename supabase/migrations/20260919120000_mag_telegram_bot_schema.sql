-- MAGHausPR Telegram bot schema: reconciles the Python bot's SQLite tables
-- into the mag_* Supabase schema so the webhook Edge Function has one
-- Postgres source of truth for customers/orders/profiles instead of a
-- second copy. All objects are additive and prefixed mag_; unrelated
-- Command Center objects are untouched. See
-- docs/TELEGRAM_WEBHOOK_MIGRATION.md for the full SQLite -> Postgres
-- reconciliation map and which SQLite tables this replaces/retires.
--
-- Design note on "changed_by"/"admin"-style columns: a Telegram admin acts
-- by numeric Telegram user id and has no Supabase Auth account, while a
-- browser-extension/staff actor acts as an authenticated auth.users row.
-- Columns that record who performed an action carry both
-- <name>_auth_user_id and <name>_telegram_user_id (both nullable, a check
-- constraint forbids setting both) rather than inventing a fake shared
-- actor id type.

-- ---------------------------------------------------------------------
-- Telegram-only operational tables (service_role only; not a staff/
-- extension-facing concept, so no authenticated grants at all).
-- ---------------------------------------------------------------------

create table public.mag_telegram_admins (
  telegram_user_id bigint primary key,
  display_name text,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

-- Two scopes, not one row per user: the SQLite design deliberately kept
-- order_sessions (24h TTL) and affiliate_admin_sessions (1h TTL) separate
-- so an admin running the affiliate wizard can never collide with or
-- discard that same person's in-progress customer order. A single
-- telegram_user_id-only row would reintroduce that collision, so the scope
-- is part of the key instead.
create table public.mag_telegram_sessions (
  telegram_user_id bigint not null,
  session_scope text not null default 'CUSTOMER_ORDER' check (session_scope in ('CUSTOMER_ORDER', 'AFFILIATE_ADMIN')),
  chat_id bigint not null,
  current_flow text,
  current_step text,
  context jsonb not null default '{}'::jsonb,
  order_id uuid references public.mag_orders(id) on delete set null,
  last_update_id bigint,
  updated_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '24 hours'),
  primary key (telegram_user_id, session_scope)
);
create index mag_telegram_sessions_expires_idx on public.mag_telegram_sessions(expires_at);
comment on table public.mag_telegram_sessions is
  'Two rows possible per Telegram user, one per session_scope. The webhook is stateless per-invocation, so every command/callback must load, act on, and save the row for its scope instead of relying on in-memory conversation state. Replaces SQLite order_sessions (CUSTOMER_ORDER, 24h TTL) and affiliate_admin_sessions (AFFILIATE_ADMIN, 1h TTL -- set expires_at explicitly on insert for that scope).';

-- Telegram redelivers a webhook update on timeout/5xx, and a double-tapped
-- inline button can arrive as two independent callback_query updates.
-- idempotency_key covers both: pass update_id (as text) for update-level
-- dedupe, or callback_query.id for the finer-grained SQLite
-- processed_callbacks behavior this replaces -- insert here (on conflict do
-- nothing -> already processed) before any side effect.
create table public.mag_telegram_processed_updates (
  idempotency_key text primary key,
  kind text not null check (kind in ('UPDATE', 'CALLBACK')),
  telegram_user_id bigint,
  action text,
  processed_at timestamptz not null default now()
);
comment on table public.mag_telegram_processed_updates is
  'Replaces SQLite processed_callbacks, generalized to cover both whole-update retries (kind=UPDATE, key=update_id) and individual callback replays (kind=CALLBACK, key=callback_query.id).';

alter table public.mag_telegram_admins enable row level security;
alter table public.mag_telegram_sessions enable row level security;
alter table public.mag_telegram_processed_updates enable row level security;
revoke all on public.mag_telegram_admins, public.mag_telegram_sessions, public.mag_telegram_processed_updates from public, anon, authenticated;
grant select, insert, update, delete on public.mag_telegram_admins, public.mag_telegram_sessions, public.mag_telegram_processed_updates to service_role;

create trigger mag_telegram_admins_touch before update on public.mag_telegram_admins
for each row execute function mag_private.touch_updated_at();
create trigger mag_telegram_sessions_touch before update on public.mag_telegram_sessions
for each row execute function mag_private.touch_updated_at();

-- ---------------------------------------------------------------------
-- Reuse mag_customers / mag_orders / mag_profiles as the single source of
-- truth for bot-created commerce data instead of a second table set.
-- ---------------------------------------------------------------------

alter table public.mag_customers
  add column telegram_user_id bigint unique,
  add column telegram_username text;
comment on column public.mag_customers.telegram_user_id is
  'Canonical identity key for a Telegram-originated customer (replaces SQLite users.telegram_user_id). Null for customers created only through the browser extension.';

alter table public.mag_orders
  add column order_number text unique,
  add column payment_status text not null default 'DRAFT',
  add column subtotal integer not null default 0,
  add column discount integer not null default 0,
  add column total integer not null default 0,
  add column payment_method text,
  add column payment_reviewed_by_auth_user_id uuid references auth.users(id),
  add column payment_reviewed_by_telegram_user_id bigint references public.mag_telegram_admins(telegram_user_id),
  add column payment_reviewed_at timestamptz,
  add column refund_policy_accepted_at timestamptz,
  add column completed_at timestamptz,
  add constraint mag_orders_payment_reviewer_not_both check (
    payment_reviewed_by_auth_user_id is null or payment_reviewed_by_telegram_user_id is null
  );
comment on column public.mag_orders.status is
  'Submission/profile lifecycle (DRAFT/INCOMPLETE/READY_FOR_REVIEW/ACTIVE/NEEDS_UPDATE/ARCHIVED). Deliberately separate from payment_status: whether a customer has paid is a different concern from whether their profile has been reviewed and submitted.';
comment on column public.mag_orders.payment_status is
  'Commerce lifecycle for a bot order (e.g. DRAFT/AWAITING_PAYMENT/PAYMENT_SUBMITTED/CONFIRMED/COMPLETED/CANCELLED/REFUNDED). Intentionally left as free text pending confirmation of the exact enum against app/services/orders.py rather than guessing a constraint; tighten with a CHECK once confirmed.';

-- profile_count is intentionally NOT ported as a stored column: it was a
-- convenience denormalization in SQLite. Query count(*) from mag_profiles
-- where customer_id/order_id matches instead of maintaining a second
-- number that can drift.

-- ---------------------------------------------------------------------
-- Catalog / commerce tables. Staff (authenticated + is_staff()) can read
-- for administration; only service_role writes (the bot and Edge
-- Functions are the only writers today).
-- ---------------------------------------------------------------------

create table public.mag_products (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  description text not null default '',
  standard_price integer not null,
  active boolean not null default true,
  availability text not null default 'AVAILABLE',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.mag_promotions (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  active boolean not null default true,
  start_at timestamptz not null,
  end_at timestamptz not null,
  created_by_auth_user_id uuid references auth.users(id),
  created_by_telegram_user_id bigint references public.mag_telegram_admins(telegram_user_id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint mag_promotions_creator_not_both check (
    created_by_auth_user_id is null or created_by_telegram_user_id is null
  )
);
create index mag_promotions_window_idx on public.mag_promotions(active, start_at, end_at);

create table public.mag_promotion_products (
  id uuid primary key default gen_random_uuid(),
  promotion_id uuid not null references public.mag_promotions(id) on delete cascade,
  product_id uuid not null references public.mag_products(id),
  promotional_price integer not null,
  unique (promotion_id, product_id)
);

create table public.mag_order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.mag_orders(id) on delete cascade,
  product_id uuid not null references public.mag_products(id),
  profile_id uuid references public.mag_profiles(id),
  quantity integer not null default 1,
  standard_unit_price integer not null,
  charged_unit_price integer not null,
  discount integer not null default 0,
  line_total integer not null,
  promotion_id uuid references public.mag_promotions(id),
  created_at timestamptz not null default now()
);
create index mag_order_items_order_idx on public.mag_order_items(order_id);

create table public.mag_payment_settings (
  id uuid primary key default gen_random_uuid(),
  method text not null unique,
  display_name text not null,
  destination text not null default '',
  instructions text not null default '',
  enabled boolean not null default true,
  updated_at timestamptz not null default now()
);

create table public.mag_payment_proofs (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.mag_orders(id) on delete cascade,
  telegram_user_id bigint,
  payment_method text not null,
  expected_amount integer not null,
  file_id text not null,
  file_unique_id text not null,
  file_type text not null,
  uploaded_at timestamptz not null default now(),
  unique (order_id, file_unique_id)
);
comment on column public.mag_payment_proofs.file_id is
  'Telegram file reference only (not the file bytes) -- identical shape to the SQLite table this replaces. Telegram still holds the source evidence.';

create table public.mag_order_status_history (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.mag_orders(id) on delete cascade,
  previous_status text,
  new_status text not null,
  changed_by_auth_user_id uuid references auth.users(id),
  changed_by_telegram_user_id bigint references public.mag_telegram_admins(telegram_user_id),
  reason text,
  created_at timestamptz not null default now(),
  constraint mag_order_status_history_changer_not_both check (
    changed_by_auth_user_id is null or changed_by_telegram_user_id is null
  )
);
create index mag_order_status_history_order_idx on public.mag_order_status_history(order_id, created_at);

create table public.mag_reviews (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null unique references public.mag_orders(id),
  customer_id uuid not null references public.mag_customers(id),
  rating integer not null check (rating between 1 and 5),
  review_text text not null default '',
  status text not null default 'PUBLISHED',
  verified_order boolean not null default true,
  display_name text not null default 'Verified Customer',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  published_at timestamptz
);
create index mag_reviews_status_created_idx on public.mag_reviews(status, created_at);
comment on column public.mag_reviews.status is
  'Left as free text (default PUBLISHED) pending confirmation of the full moderation status enum against app/bot/reviews-equivalent logic; tighten with a CHECK once confirmed.';

-- ---------------------------------------------------------------------
-- Affiliates.
-- ---------------------------------------------------------------------

create table public.mag_affiliates (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  telegram_username text,
  telegram_user_id bigint unique,
  referral_code text not null unique,
  active boolean not null default true,
  payout_method text,
  payout_destination text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index mag_affiliates_referral_code_ci_idx on public.mag_affiliates (lower(referral_code));

create table public.mag_affiliate_commission_rates (
  id uuid primary key default gen_random_uuid(),
  affiliate_id uuid references public.mag_affiliates(id),
  product_id uuid not null references public.mag_products(id),
  commission_amount integer not null check (commission_amount >= 0),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (affiliate_id, product_id)
);
create unique index mag_global_commission_rate_idx on public.mag_affiliate_commission_rates(product_id) where affiliate_id is null;

create table public.mag_referral_attributions (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null unique references public.mag_orders(id),
  affiliate_id uuid not null references public.mag_affiliates(id),
  referral_code_snapshot text not null,
  locked_at timestamptz,
  created_at timestamptz not null default now()
);
create index mag_referral_attributions_affiliate_idx on public.mag_referral_attributions(affiliate_id);

create table public.mag_affiliate_payouts (
  id uuid primary key default gen_random_uuid(),
  affiliate_id uuid not null references public.mag_affiliates(id),
  amount integer not null check (amount > 0),
  method text not null,
  reference text,
  recorded_by_auth_user_id uuid references auth.users(id),
  recorded_by_telegram_user_id bigint references public.mag_telegram_admins(telegram_user_id),
  request_key text not null unique,
  created_at timestamptz not null default now(),
  constraint mag_affiliate_payouts_recorder_not_both check (
    recorded_by_auth_user_id is null or recorded_by_telegram_user_id is null
  )
);
create index mag_affiliate_payouts_affiliate_idx on public.mag_affiliate_payouts(affiliate_id);

create table public.mag_affiliate_commissions (
  id uuid primary key default gen_random_uuid(),
  affiliate_id uuid not null references public.mag_affiliates(id),
  order_id uuid not null references public.mag_orders(id),
  profile_id uuid not null references public.mag_profiles(id),
  product_id uuid not null references public.mag_products(id),
  commission_amount integer not null check (commission_amount >= 0),
  status text not null default 'PENDING' check (status in ('PENDING', 'EARNED', 'PAID', 'VOID')),
  earned_at timestamptz,
  paid_at timestamptz,
  payout_reference text,
  payout_id uuid references public.mag_affiliate_payouts(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (affiliate_id, order_id, profile_id, product_id)
);
create unique index mag_live_commission_line_idx on public.mag_affiliate_commissions(order_id, profile_id, product_id) where status != 'VOID';
create index mag_affiliate_commissions_affiliate_idx on public.mag_affiliate_commissions(affiliate_id, status);

create table public.mag_affiliate_audit (
  id uuid primary key default gen_random_uuid(),
  admin_auth_user_id uuid references auth.users(id),
  admin_telegram_user_id bigint references public.mag_telegram_admins(telegram_user_id),
  action text not null,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint mag_affiliate_audit_admin_not_both check (
    admin_auth_user_id is null or admin_telegram_user_id is null
  )
);

-- ---------------------------------------------------------------------
-- updated_at triggers for the new tables that have the column.
-- ---------------------------------------------------------------------

create trigger mag_products_touch before update on public.mag_products
for each row execute function mag_private.touch_updated_at();
create trigger mag_promotions_touch before update on public.mag_promotions
for each row execute function mag_private.touch_updated_at();
create trigger mag_reviews_touch before update on public.mag_reviews
for each row execute function mag_private.touch_updated_at();
create trigger mag_affiliates_touch before update on public.mag_affiliates
for each row execute function mag_private.touch_updated_at();
create trigger mag_affiliate_commission_rates_touch before update on public.mag_affiliate_commission_rates
for each row execute function mag_private.touch_updated_at();
create trigger mag_affiliate_commissions_touch before update on public.mag_affiliate_commissions
for each row execute function mag_private.touch_updated_at();

-- ---------------------------------------------------------------------
-- RLS: enabled on every new table. Staff (OWNER/ADMIN/OPERATOR via the
-- existing mag_private.is_staff()) get read access for administration;
-- anon gets nothing; all writes go through service_role (the bot and
-- Edge Functions), matching how mag_customers/mag_orders already work.
-- ---------------------------------------------------------------------

alter table public.mag_products enable row level security;
alter table public.mag_promotions enable row level security;
alter table public.mag_promotion_products enable row level security;
alter table public.mag_order_items enable row level security;
alter table public.mag_payment_settings enable row level security;
alter table public.mag_payment_proofs enable row level security;
alter table public.mag_order_status_history enable row level security;
alter table public.mag_reviews enable row level security;
alter table public.mag_affiliates enable row level security;
alter table public.mag_affiliate_commission_rates enable row level security;
alter table public.mag_referral_attributions enable row level security;
alter table public.mag_affiliate_payouts enable row level security;
alter table public.mag_affiliate_commissions enable row level security;
alter table public.mag_affiliate_audit enable row level security;

revoke all on
  public.mag_products, public.mag_promotions, public.mag_promotion_products,
  public.mag_order_items, public.mag_payment_settings, public.mag_payment_proofs,
  public.mag_order_status_history, public.mag_reviews, public.mag_affiliates,
  public.mag_affiliate_commission_rates, public.mag_referral_attributions,
  public.mag_affiliate_payouts, public.mag_affiliate_commissions, public.mag_affiliate_audit
from anon;

grant select on
  public.mag_products, public.mag_promotions, public.mag_promotion_products,
  public.mag_order_items, public.mag_payment_settings, public.mag_payment_proofs,
  public.mag_order_status_history, public.mag_reviews, public.mag_affiliates,
  public.mag_affiliate_commission_rates, public.mag_referral_attributions,
  public.mag_affiliate_payouts, public.mag_affiliate_commissions, public.mag_affiliate_audit
to authenticated;

grant all on
  public.mag_products, public.mag_promotions, public.mag_promotion_products,
  public.mag_order_items, public.mag_payment_settings, public.mag_payment_proofs,
  public.mag_order_status_history, public.mag_reviews, public.mag_affiliates,
  public.mag_affiliate_commission_rates, public.mag_referral_attributions,
  public.mag_affiliate_payouts, public.mag_affiliate_commissions, public.mag_affiliate_audit
to service_role;

create policy mag_products_staff_read on public.mag_products for select to authenticated
using ((select mag_private.is_staff()));
create policy mag_promotions_staff_read on public.mag_promotions for select to authenticated
using ((select mag_private.is_staff()));
create policy mag_promotion_products_staff_read on public.mag_promotion_products for select to authenticated
using ((select mag_private.is_staff()));
create policy mag_order_items_staff_read on public.mag_order_items for select to authenticated
using ((select mag_private.is_staff()));
create policy mag_payment_settings_staff_read on public.mag_payment_settings for select to authenticated
using ((select mag_private.is_staff()));
create policy mag_payment_proofs_staff_read on public.mag_payment_proofs for select to authenticated
using ((select mag_private.is_staff()));
create policy mag_order_status_history_staff_read on public.mag_order_status_history for select to authenticated
using ((select mag_private.is_staff()));
create policy mag_reviews_staff_read on public.mag_reviews for select to authenticated
using ((select mag_private.is_staff()));
create policy mag_affiliates_staff_read on public.mag_affiliates for select to authenticated
using ((select mag_private.is_staff()));
create policy mag_affiliate_commission_rates_staff_read on public.mag_affiliate_commission_rates for select to authenticated
using ((select mag_private.is_staff()));
create policy mag_referral_attributions_staff_read on public.mag_referral_attributions for select to authenticated
using ((select mag_private.is_staff()));
create policy mag_affiliate_payouts_staff_read on public.mag_affiliate_payouts for select to authenticated
using ((select mag_private.is_admin()));
create policy mag_affiliate_commissions_staff_read on public.mag_affiliate_commissions for select to authenticated
using ((select mag_private.is_staff()));
create policy mag_affiliate_audit_admin_read on public.mag_affiliate_audit for select to authenticated
using ((select mag_private.is_admin()));
