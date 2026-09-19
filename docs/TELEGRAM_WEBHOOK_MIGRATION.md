# MAGHausPR: polling bot -> Telegram webhook on Supabase

Target architecture: `Telegram -> Telegram webhook -> Supabase Edge Function ->
Supabase Postgres -> MAG profile/order system -> browser extension -> controlled
autofill`. The Mac must not be required for production bot operation, and the
polling loop is retired only after webhook parity is proven (see "Cutover
gate" below). This document is the reconciliation map; it does not replace
reading the actual code it references.

## Why this is tractable

The Python bot (`MAGHausPR-Bot-GitHub`) has **no `ConversationHandler`** anywhere.
Every flow is a hand-rolled dispatcher over `callback_query.data` prefixes and
free text routed by whichever handler owns the user's currently-persisted
state, and that state already lives in SQLite tables keyed by
`telegram_user_id`, not in `python-telegram-bot`'s in-memory
`context.user_data`/conversation state machine. That means this migration is
"port persisted state + rewrite the transport glue," not "invent a state
machine that never existed."

## Domain vs transport

**Port as-is (pure domain logic, no Telegram dependency):**
`app/services/orders.py`, `validation.py`, `pricing.py`, `catalog.py`,
`affiliates.py`, `reviews.py`, `encryption.py`. These take plain
`telegram_user_id: int` and DB objects, never a `python-telegram-bot`
`Update`/`context`. Keep the Python implementation as the reference; port only
the specific functions a given webhook route needs, in whatever language that
route is written in (TypeScript/Deno for the Edge Function). Do not
transliterate the whole module tree before it's needed.

**Rewrite (Telegram transport/runtime glue, built around `python-telegram-bot`
objects that don't exist in a webhook):** the five near-identical `_screen()`
helpers (`customer.py`, `admin.py`, `promotions.py`, `reviews.py`,
`settings.py`) become direct Telegram Bot API `sendMessage`/`editMessageText`
HTTP calls; `app/bot/keyboards.py` builders become raw `inline_keyboard` JSON;
`app/main.py`'s `_mag_sync_loop`/`_post_init` polling harness is retired
entirely (superseded by the webhook calling Postgres directly, see below);
`context.application.create_task(...)` fire-and-forget has no equivalent in a
request/response function and becomes either a synchronous await or a
Postgres-queued follow-up.

**Highest-value shared extraction before porting handlers:** session
read/write is reimplemented five separate times
(`customer.py`/`reviews.py`/`promotions.py`/`settings.py`/`affiliates.py`).
Write one `supabase/functions/_shared/session-store.ts` (load/save
`mag_telegram_sessions`) instead of porting five copies.

## Postgres reconciliation map

Migration: `supabase/migrations/20260919120000_mag_telegram_bot_schema.sql`.

| SQLite table | Postgres | Status |
|---|---|---|
| `users` | `mag_customers` (+ new `telegram_user_id`, `telegram_username` columns) | **Reused, extended** — do not create a second customer table |
| `admins` | `mag_telegram_admins` (new) | **New** — Telegram numeric-ID admins have no Supabase Auth account, so they cannot live in `mag_memberships` (FK's to `auth.users`) |
| `products` | `mag_products` | **New** |
| `orders` | `mag_orders` (+ new commerce columns: `order_number`, `payment_status`, `subtotal`, `discount`, `total`, `payment_method`, `payment_reviewed_by_*`, `payment_reviewed_at`, `refund_policy_accepted_at`, `completed_at`) | **Reused, extended** — `status` (submission lifecycle) and the new `payment_status` (commerce lifecycle) are deliberately separate concerns |
| `profiles` | `mag_profiles` (+ Vault-backed `mag_private.protected_field_values` for DOB/SSN) | **Partially reconciled** — the MAG registry forbids credential storage, including email passwords. The Python add-on still captures an email password. Resolve that workflow before claiming route parity; do not put the password in session JSON, logs, or ordinary profile fields. |
| `mag_sync_state` | — | **Retired** — it existed only to bridge SQLite -> Supabase after the fact; once the webhook writes Postgres directly there's nothing to sync |
| `order_items` | `mag_order_items` | **New** |
| `promotions` | `mag_promotions` | **New** |
| `promotion_products` | `mag_promotion_products` | **New** |
| `status_history` | `mag_order_status_history` (new, dual actor columns) | **New** |
| `payment_settings` | `mag_payment_settings` | **New** |
| `payment_proofs` | `mag_payment_proofs` | **New** — stores the Telegram file reference only, same as SQLite; Telegram remains the source of the actual file |
| `reviews` | `mag_reviews` | **New** |
| `order_sessions` | `mag_telegram_sessions` (`session_scope='CUSTOMER_ORDER'`) | **New, reconciled** |
| `processed_callbacks` | `mag_telegram_processed_updates` (`kind='CALLBACK'`) | **New, generalized** — also covers whole-update retries (`kind='UPDATE'`), which SQLite's polling model never needed since polling naturally consumes each `update_id` once |
| `affiliates` | `mag_affiliates` | **New** |
| `affiliate_commission_rates` | `mag_affiliate_commission_rates` | **New** — the SQLite partial unique index for the global (`affiliate_id IS NULL`) rate per product ports directly to a Postgres partial index |
| `referral_attributions` | `mag_referral_attributions` | **New** |
| `affiliate_payouts` | `mag_affiliate_payouts` | **New** |
| `affiliate_commissions` | `mag_affiliate_commissions` | **New** — SQLite's partial unique index for the live (non-`VOID`) commission line also ports directly |
| `affiliate_audit` | `mag_affiliate_audit` (new, dual actor columns) | **New** — kept separate from the existing `mag_audit_events` table rather than merged into it, because `mag_audit_events.actor_id` is a non-null FK to `auth.users`, and a Telegram admin has no `auth.users` row; inventing a fake Auth user per Telegram admin to force-fit that table would be worse than a second, purpose-built audit table |
| `affiliate_admin_sessions` | `mag_telegram_sessions` (`session_scope='AFFILIATE_ADMIN'`) | **New, reconciled** — kept as a distinct scope, not merged into one row per user, specifically because the original design deliberately isolated it (1h TTL) from `order_sessions` (24h TTL) so an admin running the affiliate wizard can never collide with or discard that same person's in-progress customer order |
| `schema_info` | Supabase's own migration history | **Retired** — SQLite-only migration bookkeeping, no Postgres equivalent needed |

### Actor columns: two identity systems, not one

A Telegram admin acts by numeric Telegram user ID and has no Supabase Auth
account. A browser-extension/staff actor acts as an authenticated
`auth.users` row. Every column that records "who did this"
(`mag_orders.payment_reviewed_by`, `mag_order_status_history.changed_by`,
`mag_promotions.created_by`, `mag_affiliate_payouts.recorded_by`,
`mag_affiliate_audit.admin`) is split into `<name>_auth_user_id` and
`<name>_telegram_user_id`, both nullable, with a `CHECK` forbidding both being
set. Do not invent a shared "actor ID" type across two identity systems that
don't actually share one.

### Deliberately not ported

- `orders.profile_count` — a SQLite convenience denormalization. Query
  `count(*) from mag_profiles where order_id = ...` instead of maintaining a
  second number that can drift.
- Live payment provider integration — **there is none to convert.** The
  payment flow is 100% proof-based: the customer sees a static destination
  (Cash App/Chime/Zelle/Stripe payment *link*, not the Stripe API/webhook) and
  uploads a screenshot or PDF; an admin manually approves/rejects. Nothing in
  the existing bot calls a payment provider's API or receives a payment
  provider webhook, so migration item "convert payment webhooks to Edge
  Functions" is **N/A**, not a gap.

### Unconfirmed enums — left as free text, not guessed

`mag_products.availability` and `mag_reviews.status` are `text` with a
sensible default and no `CHECK` constraint, because the exact value sets
weren't independently confirmed against `app/services/catalog.py` /
`app/services/reviews.py` at migration-authoring time. Tighten with a `CHECK`
once confirmed rather than leaving an incorrect one in place.
`mag_orders.payment_status` is the same: a new commerce-lifecycle concept
(DRAFT/AWAITING_PAYMENT/PAYMENT_SUBMITTED/CONFIRMED/COMPLETED/CANCELLED/REFUNDED
is the working assumption from `ALLOWED_TRANSITIONS` in
`app/services/orders.py`) — confirm the exact set before adding a `CHECK`.

## Where the outbound Supabase sync currently hooks in (and what replaces it)

- `queue_order_for_mag_sync` — called from `accept_refund_policy` at the
  DRAFT -> AWAITING_PAYMENT transition. Cheap, no network call, just flips a
  retry-bookkeeping flag.
- `sync_order` — actually fired from the *transport* layer
  (`app/bot/customer.py`), as a fire-and-forget background task right after
  the same refund-policy-acceptance moment. This is the one real network call
  into Supabase per order today.
- `sync_pending` — the `_mag_sync_loop` poller, sweeps anything not yet
  `SYNCED` every 300s by default.
- **Webhook replacement:** call the Supabase intake logic synchronously (or
  via a bounded `EdgeRuntime.waitUntil()`) at the same DRAFT -> AWAITING_PAYMENT
  transition, directly from the webhook handler processing that callback —
  no separate poll loop needed, since the webhook already holds a live
  Postgres connection at that moment.

## Cutover gate

Per the parent instruction: do not delete `app/bot/`, `app/services/`, the
SQLite models, or LaunchAgent support yet. Python remains the reference
implementation. Retire the polling runtime only after the webhook bot passes
equivalent tests, Postgres state works, the Telegram webhook works live, and
the order/admin/payment/profile-creation flows and browser-extension
visibility have all been verified against the webhook path.

## September 19 implementation state and security boundary

MAG must use a new, separate Supabase project. Do not link this repository to
the historical DDC project ref found in older test records. The Supabase CLI
is currently unauthenticated and this repository has no MAG project link, so
no live MAG migrations or functions have been deployed.

`mag-telegram-webhook` has `verify_jwt = false` because Telegram cannot send a
Supabase user JWT. Its request boundary requires a matching
`X-Telegram-Bot-Api-Secret-Token` before parsing the update or creating clients.
`mag-order-intake`, `mag-profile-review`, and `mag-restricted-value` retain
`verify_jwt = true`. Never place the Telegram bot token or webhook secret in
Git. Do not register a webhook while the Python process is polling.

| Route or state | Webhook implementation |
|---|---|
| `/start`, active Telegram admin check | Implemented and unit tested |
| Catalog, service selection, profile count, custom count | Session state and validation implemented; draft creation/intake remains |
| Customer recent orders, order-number lookup, pricing | Implemented and unit tested; lookup is scoped to the Telegram customer |
| Add-on selection, draft creation, customer intake, profile review/edit | Pending |
| Referral, refund acknowledgement, payment method, proof upload | Pending |
| Admin dashboard, payment-status lists, order search/view, status history | Implemented and unit tested with active Telegram admin checks |
| Proof approve/reject and order status mutation | Pending |
| Promotions, affiliates, reviews | Pending |

The Python bot's `email_password` intake conflicts with the MAG registry's
`CREDENTIAL`/`FORBIDDEN` policy. DOB uses SENSITIVE Vault storage and SSN uses
RESTRICTED Vault storage; neither justifies storing an email password in the
session or profile. Resolve this product workflow with Dre before enabling
the add-on in the webhook. The original SQLite bot remains operational.

The Postgres `mag_orders.status` column is the profile lifecycle
(`DRAFT`/`READY_FOR_REVIEW`/etc.), while the Python order status combines
payment and operations (`AWAITING_PAYMENT`/`PAYMENT_REVIEW`/`PENDING`/etc.).
The webhook port must map those separately into `status` and
`payment_status`, and seed catalog, payment settings, Telegram admin IDs,
order numbers, and existing SQLite rows before parity can be demonstrated.

## Controlled cutover procedure (prepare only; Dre must be present)

1. Stop new order writes briefly and back up SQLite, including its WAL, with
   SQLite's online backup API; keep the backup encrypted and verify it opens.
2. Migrate and reconcile customers, orders, profiles, proofs, products,
   payment settings, admins, promotions, referrals, reviews, and sessions in
   the dedicated MAG Postgres project. Check counts and representative
   relationships without printing customer data.
3. Deploy the tested Edge Functions and MAG secrets. Keep JWT verification on
   intake, review, and restricted-value functions.
4. Health-check the webhook endpoint with a missing and an invalid Telegram
   secret; both must be denied. Test a valid secret with a harmless update.
5. With Dre present, pause polling and call Telegram `setWebhook` with the
   HTTPS function URL and a locally configured `secret_token`.
6. Verify `getWebhookInfo` shows the intended URL and no delivery error.
7. Send controlled test messages and callbacks, including a duplicate
   update/callback, using nonproduction records.
8. Verify customer order, admin, payment proof, profile review, and extension
   visibility paths against Postgres and Telegram responses.
9. Observe function errors, Telegram retries, idempotency rows, and logs.
   Confirm logs contain no intake values or full sensitive responses.
10. Keep the SQLite backup and rollback instructions accessible throughout
    the observation window. If any gate fails, call Telegram `deleteWebhook`
    without dropping pending updates, verify `getWebhookInfo`, restore the
    SQLite snapshot if Postgres-only writes require it, then resume polling
    and verify a controlled `/start` and order-status request.

Do not call `setWebhook` or `deleteWebhook` as part of local parity work.
