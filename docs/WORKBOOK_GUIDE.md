# Workbook guide

## Sheet 1 Sites

Add one target per row. SITE NAME is for operator display; SIGNUP URL controls navigation. Leave SITE ID blank for automatic S0001-style assignment. Leave ACTIVE blank to default to YES. URL comparison removes common tracking parameters, normalizes host casing and default ports, and detects obvious duplicates. Duplicate source rows are preserved but receive ACTIVE = NO and SITE STATUS = DUPLICATE.

## Sheet 2 People

Add one person per populated row. Leave ID blank for automatic P0001-style assignment and STATUS blank for PENDING. Names are displayed to the operator, but Person ID remains the resume key.

Approved columns are FIRST NAME/GIVEN NAME, LAST NAME, PHONE, EMAIL, ADDRESS, CITY, STATE, ZIP, DOB, OCCUPATION, ANNUAL INCOME, and PASSWORD.

- DOB accepts MM/DD/YYYY or YYYY-MM-DD. The engine formats text, date, and month/day/year controls.
- OCCUPATION never substitutes for Employer.
- ANNUAL INCOME is used only for explicit annual/yearly requests, never monthly, weekly, household, net, or revenue fields.
- PASSWORD is used only for confident registration and confirmation fields, never login, reset, administration, or ambiguous authentication.

Always save and close Excel before starting MAG.

## Sheet 3 Results

Columns A:G are a human-readable summary. Columns J:S are the authoritative detailed ledger. Every attempt records an Attempt ID, Person ID, Site ID, timestamp, status, form step, safe URL, error category, retry eligibility, and non-secret note.

The durable key is Person ID + Site ID. A completed pair is never rerun merely because sites or people rows changed. If new Site IDs are added, existing people receive only combinations that are not completed.

## Sheet 4 Site Issues

This sheet records redirects, invalid sites, blocks, and temporary errors. Temporary failures remain retryable within the configured cap. A single navigation timeout is not a reason to mark a site invalid.

## Field registry

The local registry is copied from config/field-registry.json. It specifies canonical fields, aliases, permission, sensitivity, transformations, and context restrictions. Known new headers map automatically. Unknown headers print NEW FIELD REQUIRES MAPPING. Restricted names remain blocked even if someone adds a matching People column.

## Exact reset

Only an explicitly named completed combination can be reset:

~~~bash
npm run reset -- --person P0001 --site S0001 --confirm
~~~

The command does not delete ledger history.
