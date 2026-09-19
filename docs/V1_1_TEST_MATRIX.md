# MAG V1.1 test matrix

Automated extension coverage is in `mag-extension/tests/`; order-bot contract coverage is in `tests/order-bot-supabase.test.ts`. Live boundary tests were executed against Supabase project `swsnttpchmxekbftcvlu` in rollback-only transactions.

| Requirement | Evidence/result |
|---|---|
| Auth/session/logout | Unit login/refresh-session storage/logout PASS; live Auth has one owner account |
| Unauthenticated access | Live REST `mag_profiles` returned HTTP 401 |
| Unauthorized authenticated RLS | Synthetic authenticated JWT subject saw 0 profiles |
| Authorized owner RLS | Owner claims saw all 6 INTERNAL profiles; CUSTOMER query remains separate |
| Initial/incremental sync | Unit initial/version 16→17/add profile PASS |
| Deactivation/revocation | Unit archived/disappeared profile removed PASS |
| Dynamic STANDARD field | Live transaction created `favorite_color`, exposed it, version advanced to 3; extension runtime alias/value PASS |
| Dynamic SENSITIVE field | `date_of_birth` registry/classification protected/no cache PASS |
| Unknown field safe default | Edge code and migration enforce inactive UNCLASSIFIED/QUARANTINE/NONE/NEVER; unit UNKNOWN PASS |
| Restricted ordinary API/cache exclusion | Live ordinary row count 0; cache rejection PASS |
| Explicit restricted authorization/fill | Edge requires recent AAL2; extension TOTP challenge then distinct Unlock and Fill actions; unit MFA endpoint/session boundary PASS |
| Restricted plaintext exclusion | Live audit probe: 0 plaintext matches, 0 forbidden metadata keys; local cache test PASS |
| Service-role absence | Extension source scan PASS |
| Credential rejection | Live ordinary/protected write probe rejected password definition PASS |
| Audit logging | Live restricted RPC created 1 audit event with zero plaintext; login/logout/sync/intake/review code paths write metadata-only events |
| Offline STANDARD | Cached profile remains available after mocked network failure PASS |
| Restricted offline | Requires authenticated Edge call; no local value exists PASS |
| Profile version/conflict | Trigger and sync conflict tests PASS |
| Bot draft/approval | JWT Edge functions deployed; intake remains DRAFT/INCOMPLETE/READY_FOR_REVIEW and MFA admin review is required before ACTIVE |
| Legacy filtering/dedupe/malformed | Repeatable audit: 1 row, 1 internal excluded, 0 customer candidates, 0 duplicates, 0 malformed |
| Internal metric exclusion | Live result: 5 INTERNAL entities, 6 INTERNAL profiles, customer metric 0 |
| Consent/signature/CAPTCHA | Browser fixture PASS; all untouched |
| Zero form submissions | Browser fixture submit count 0; static prohibited-submit scan PASS |
| Existing V1 suite | 58/58 legacy tests and 17/17 extension assertions PASS |

Production restricted activation is not accepted yet: the live Auth account currently has zero verified MFA factors, so a real AAL2 unlock cannot be exercised until Dre enrolls TOTP and approves the Vault key-rotation/recovery runbook.
