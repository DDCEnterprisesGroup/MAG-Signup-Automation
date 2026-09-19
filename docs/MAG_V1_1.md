# MAG V1.1 shared-data architecture

## Runtime architecture

The order bot authenticates as a dedicated `SERVICE` user and calls the JWT-protected `mag-order-intake` Edge Function. Intake creates or identifies a customer, creates an order, and writes a `DRAFT`, `INCOMPLETE`, or `READY_FOR_REVIEW` profile. Raw intake never becomes `ACTIVE` automatically. An owner/admin with MFA uses `mag-profile-review` to approve a validation-clean `READY_FOR_REVIEW` profile.

The Manifest V3 extension signs in with Supabase Auth using the client-safe publishable key. Access and refresh tokens are held in `chrome.storage.session`, not the normal profile cache. Sync reads only rows allowed by RLS. Only active profile values whose registry policy is `STANDARD / PROFILE / LOCAL` enter `chrome.storage.local`. A full authorized profile-metadata comparison detects additions, updates, deactivations, archival, and revoked access; field values are fetched only for new/version-changed profiles. Remote profiles are read-only in the extension, so local changes cannot silently overwrite canonical data. A local ID collision is retained as a reported conflict.

Offline mode uses the last authorized STANDARD cache. SENSITIVE and RESTRICTED values are absent. Logout revokes the server session when online and always clears the browser-session token. Revoking a membership or profile grant takes effect at the RLS boundary immediately and removes the profile on next sync.

## Schema and lifecycle

Reproducible SQL is in `supabase/migrations/`.

- `mag_memberships`: OWNER, ADMIN, OPERATOR, CUSTOMER, or SERVICE authorization.
- `mag_customers`: customer identity, with `CUSTOMER` and `INTERNAL` scopes kept separate.
- `mag_orders`: multiple projects/orders per customer.
- `mag_profiles`: multiple organization/person/event/product profiles per customer, status, approval, and monotonically increasing version.
- `mag_field_definitions`: dynamic canonical registry, aliases, type, normalization/validation metadata, security/storage/cache/autofill policies, and active state.
- `mag_profile_field_values`: ordinary STANDARD values only; a trigger rejects every other class.
- `mag_private.protected_field_values`: Vault secret references and masked hints only.
- `mag_profile_versions`: STANDARD-only version snapshots.
- `mag_profile_access`: explicit operator/customer grants.
- `mag_audit_events`: identifiers/actions/results only; a trigger rejects secret-bearing keys and SSN-shaped text.
- `mag_customer_metrics`: security-invoker customer/order metrics filtered to `scope = CUSTOMER`.

Profiles move through `DRAFT / INCOMPLETE / READY_FOR_REVIEW / ACTIVE / NEEDS_UPDATE / ARCHIVED`. Only `ACTIVE` profiles synchronize. Every field or material profile-status change increments `profile_version`.

## Security model

All nine exposed MAG tables have RLS enabled. Anonymous users have no table grants. Authenticated access is constrained by active membership, role, and optional profile grants. Service-role credentials exist only in Supabase-managed Edge Function secrets and are never in the extension. Authorization uses database membership, not user-editable metadata.

Field behavior:

| Class | Storage | Browser persistence | Autofill |
|---|---|---|---|
| STANDARD | ordinary versioned profile table | allowed | confidence policy |
| SENSITIVE | protected Vault path | none in V1.1 | review/controlled workflow only |
| RESTRICTED | protected Vault path | never | recent AAL2 MFA unlock plus a separate explicit Fill click |
| CREDENTIAL | forbidden | never | never |
| UNCLASSIFIED | protected quarantine, inactive | never | never until admin classification |

Restricted values use Supabase Vault, which uses authenticated encryption through the installed Vault/pgsodium stack. The database stores a Vault secret UUID, classification, masked hint, and key version—not plaintext in ordinary tables. The Edge Function validates the JWT against Auth, requires `aal2` issued within ten minutes, calls a service-only RPC, returns `Cache-Control: no-store`, and does not log the value. The popup holds the value only in an in-memory `Map` between Unlock and the explicit Fill click, then deletes it. The content script clears its reference after filling. No extension path can submit the form.

Production activation of RESTRICTED data remains disabled operationally until Dre enrolls MFA and completes a real AAL2 acceptance test. No restricted legacy value was migrated. Vault supports key-version metadata for rotation; before storing production restricted data, document and rehearse the project-level Vault root-key rotation/recovery procedure and backup ownership in the Supabase operations runbook.

## Adding or changing a bot field

If Dre adds `Birthday`, the intake function normalizes the label and checks both canonical keys and aliases. The existing `date_of_birth` definition maps it to SENSITIVE/Vault/NONE-cache policy, changes the profile version, and the extension receives only the definition metadata—not the value. The extension recognizes Birthday/DOB/Date of Birth/Birth Date without a release.

For a genuinely new field, intake creates an inactive `UNCLASSIFIED / QUARANTINE / NONE / NEVER` definition and makes the profile `INCOMPLETE`. An owner/admin reviews the meaning, adds aliases, chooses type/validation, selects security/storage/cache/autofill policy, activates it, validates the quarantined data, and moves the profile back through review. No extension release is needed for ordinary alias-based behavior. New behavior, rather than new data, may still require code.

To change a security class, first deactivate the definition, migrate values through a reviewed database migration, verify no prohibited old copies remain, update policy metadata, then reactivate. Never reclassify a populated field in place without moving/removing values from the previous storage boundary.

## Bot integration

`integrations/order-bot/mag-supabase-client.mjs` is the host-side adapter. Its credentials belong in the bot host's secret manager using the names in `.env.example`. Provision a dedicated Auth user, set its `mag_memberships.role` to `SERVICE`, and grant no browser or admin role. Call `submitIntake` after the order bot has assembled the payload. The Python bot uses the same contract. `customer.externalId`, `externalOrderId`, and `profile.externalId` are stable source identifiers; retries use all three and never use a customer name or profile label as identity. An already `ACTIVE` profile remains approved on a late retry.

The SERVICE Auth user must be created separately with an authorized Supabase Admin operation. Once Dre confirms the project and provides that user's UUID, an authorized service-role operation can call `public.mag_provision_service_membership(<auth-user-uuid>,'MAG Order Bot')`. The migration creates only this guarded membership binding and a revoke function; it contains no credentials or fixed UUID. The binding refuses to replace an existing non-SERVICE membership.

The shared synthetic valid and invalid payloads live in `tests/fixtures/` in this repository and the bot repository. Both adapters and the intake logic test them. No live customer value belongs in a fixture.

The canonical Python checkout is `MAGHausPR-Bot-GitHub`. It contains the outbound adapter, durable retry state, and the order acceptance hook. Its current production host remains unverified. Keep sync disabled in runtime configuration until the project, SERVICE identity, deployment, and live RLS tests are complete.

## Audit and operations

Security events include intake, profile approval/rejection, restricted successes/failures, and client sync/login/logout behavior. Audit rows record actor/profile/field/action/time/result and non-sensitive reason codes. Never add profile values to metadata.

To revoke extension access, deactivate the membership or revoke the relevant `mag_profile_access` row; revoke Auth sessions from Supabase Auth; then have the operator log out/sync. Cached STANDARD data is intentionally available offline. If device revocation must erase it immediately, remove the extension or clear its site/extension storage on that device.

Back up database schema/migrations separately from data. Supabase backups cover database state, but restricted values require the Vault key/recovery plan. The legacy workbook archive is independent and must remain access-controlled. Roll forward with new migrations; do not edit already-applied migration files.

## Local development and deployment

1. Install dependencies and run `npm run check`.
2. Run the legacy audit with `npm run migration:audit -- /absolute/workbook.xlsx`.
3. Review migrations, then use `supabase db push --linked` or the project migration API.
4. Deploy the three functions with JWT verification enabled.
5. Configure bot secrets only on the bot host; never add a service key to the extension.
6. Load `mag-extension/` in Chromium developer mode, sign in from Settings, sync, and run the acceptance test below.

## Rollback and restore

The safe immediate rollback is operational: undeploy/disable the three `mag-*` Edge Functions, remove the V1.1 extension build, and restore the prior unpacked V1 directory from version control. This leaves the additive `mag_*` database objects inert and preserves data. The extension does not depend on the legacy automation, so that code remains untouched.

Before a database rollback, export only the `mag_*` tables and preserve Vault/key recovery material according to the project runbook. Then create a new forward migration—never edit the four applied migration files—that revokes MAG grants/functions, removes the `mag_customer_metrics` view, drops MAG tables in foreign-key order, and finally drops `mag_private`. Do not use a broad schema reset because the Supabase project contains unrelated Command Center tables. The original workbook and its verified archive are the legacy rollback sources; neither should be overwritten.

## Manual acceptance

1. Reload the unpacked `mag-extension/` folder in `chrome://extensions`.
2. Open extension Settings, sign in with Dre's authorized Supabase user, and click **Sync approved profiles**.
3. Confirm the connection name, active count, and last-sync time appear; close the network and confirm cached STANDARD profiles still work.
4. Open an existing V1 fixture and verify detection, safe fill, review highlights, manual corrections, reset, consent/signature protection, and zero submission.
5. In Supabase, create/approve a test STANDARD field/profile update; sync and confirm the new alias/value appears without an extension code change.
6. Archive that test profile; sync and confirm it disappears.
7. After MFA is enrolled, use a non-production restricted probe: Unlock, authenticate, confirm only a masked hint is shown, click Fill separately, and verify no local cache/log contains the value.
8. Manually submit only if you intentionally want to submit the real form; MAG itself must never do so.
