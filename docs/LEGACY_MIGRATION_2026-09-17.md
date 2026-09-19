# Legacy migration report — 2026-09-17

The source workbook was inspected read-only and remains unchanged:

- Source: `/Users/dandrecombs/Dre-Organized-2026-09-09/MAG/MAG_Workbook_Automation_Ready.xlsx`
- SHA-256: `9f7713e702085ef2699f0323f4aad0ea5e72e320c28c6b450f0eea24889ad78f`
- Archive: `/Users/dandrecombs/Dre-Organized-2026-09-09/MAG/.mag-migration-archives/2026-09-17/MAG_Workbook_Automation_Ready.xlsx`
- Archive hash matches source; permissions are owner read/write only.

The macro workbook was also archived without modification:

- Source: `/Users/dandrecombs/Dre-Organized-2026-09-09/MAG/MAG_Workbook_Automation_Ready.xlsm`
- SHA-256: `20edeeb6b965d79bab0edef63b30ee97cdf936a469d1bedc9f72724250bcdec6`
- The macro workbook uses the older incompatible People schema; it was not used as a migration source.

Audit result for the current-schema workbook: one People row, identified as an internal Dre profile; zero real/external customer candidates; zero duplicates; zero incomplete rows; zero malformed email/phone rows; one row containing data requiring non-ordinary handling; zero populated password values. The 1,386 site rows are legacy PR/media targets, not customer records. `MAG_Master PR List.xlsx` is likewise a 1,604-row target URL list, not a customer dataset.

Migration outcome: zero production customers, orders, or customer profiles migrated. No SENSITIVE or RESTRICTED value was migrated. No credential was migrated. The six extension fixtures remain marked `scope: INTERNAL`; five consolidated internal entities are seeded in Supabase with `scope = INTERNAL`. Customer metrics explicitly exclude them.

Re-run the repeatable, non-value-printing audit with:

```bash
npm run migration:audit -- /Users/dandrecombs/Dre-Organized-2026-09-09/MAG/MAG_Workbook_Automation_Ready.xlsx
```

If another workbook containing real customers exists, do not apply it blindly. Archive and hash it, audit/deduplicate, classify every column, stage only STANDARD values, quarantine credentials, and hold SENSITIVE/RESTRICTED values until the corresponding production security path has passed acceptance.
