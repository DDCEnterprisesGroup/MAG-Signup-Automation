# Backup and restore

## Backup contents

npm run backup creates a timestamped ZIP containing:

- the live workbook;
- the local field registry;
- reconciliation hashes and installation metadata when present;
- the non-secret ingestion idempotency ledger when present;
- application version, creation time, and source platform metadata.

Browser profiles are excluded because cookies and authentication material may be present. Dependencies, caches, logs, screenshots, and temporary locks are excluded.

## Restore safeguards

The restore command validates metadata, field-registry JSON, and workbook schema before replacement. If live data exists, explicit confirmation is required. Existing workbook and registry files are renamed to timestamped pre-restore recovery copies before the validated replacement is installed.

Interactive newest-backup restore:

~~~bash
npm run restore
~~~

Named backup:

~~~bash
npm run restore -- --file "/path/to/MAG-Backup-date.zip"
~~~

For a scripted, already reviewed restore, append --confirm. Do not use that flag unless the exact destination and backup have been verified.

After restore, run npm run doctor and inspect the workbook before starting.

## Corruption recovery

If the workbook is corrupt, stop MAG, preserve the corrupt file for forensics, restore the newest known-good backup, run doctor, and compare the detailed ledger with the last operator notes. Never repair by deleting Results rows or reassigning IDs.
