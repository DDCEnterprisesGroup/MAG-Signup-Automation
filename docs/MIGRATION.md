# Migration

The portable backup is the supported transfer unit. Do not copy node_modules, logs, screenshots, browser caches, or workbook lock files.

## Old computer

1. Close Excel.
2. Stop MAG.
3. Run npm run backup.
4. Locate the timestamped ZIP path printed by the command.
5. Transfer it through an encrypted or otherwise trusted channel.

## New computer

1. Install Node.js LTS and Git.
2. Clone the shared or private deployment repository.
3. Run npm install and npm run setup.
4. Do not run init when restoring an existing deployment unless no workbook exists and you intentionally want a fresh one.
5. Restore the transferred ZIP:

~~~bash
npm run restore -- --file "/secure/path/MAG-Backup-date.zip"
npm run doctor
~~~

6. Open the restored workbook read-only at first and confirm People, Sites, and detailed Results history.
7. Close Excel and run npm start.
8. Confirm completed Person ID + Site ID history remains skipped.

## Windows to macOS

Create the backup on Windows, transfer it securely, clone on Mac, install Node/Git and Playwright Chromium, run setup, restore, doctor, verify the workbook, and start. Browser profiles are intentionally excluded, so sign-in/session state may need to be re-established manually.

## macOS to Windows

Use the same workflow in reverse. File paths stored by the backup are logical archive paths; restore resolves them into the destination computer's local MAG data directory.

## Same-platform moves

Windows-to-Windows and Mac-to-Mac use the same process. Do not assume an old browser profile is safe or portable.
