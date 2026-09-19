# Legacy MAG migration and reuse

The existing `MAG-Signup-Automation` application remains intact. The extension is isolated under `mag-extension/` to avoid damaging the workbook-driven production code or its operational history.

## Reused concepts

- Field descriptors and evidence sources from `src/forms/field-mapper.ts`: labels, placeholder, name/id, autocomplete, ARIA label, and nearby text.
- Weighted alias matching and explicit confidence rather than optimistic guessing.
- Restricted-data precedence from the legacy sensitive-field detector.
- Normalization patterns from `src/utils/text.ts` and registry aliases from `config/field-registry.json`.
- Human-handoff principle and visible-browser review from `src/workflow/human-handoff.ts`.
- Site inventory/adaptation concept without carrying over unattended navigation.
- Test patterns for safe field filling, consent handling, and browser DOM fixtures.

Legacy workbook rows were not copied into extension profiles because they can contain DOB, income, passwords, addresses, and other data outside this product’s public/business scope. The initial extension data contains only facts explicitly approved for this build.

## Intentionally not reused in the extension path

- Browser launch/session orchestration and multi-site workflow engine.
- Automatic Next or final-action detection/clicking.
- Scheduled/supervised batch submission and person-to-person advancement.
- Password, DOB, income, and workbook credential fields.
- Submission/completion checkpoint automation.

The legacy workflow still contains automatic submission behavior. It is not imported, called, packaged, or reachable from the extension. Use the extension for the new V1 direction. Retiring or changing the old production runner is a separate, explicitly authorized operation.

Submission history can be migrated later as a read-only local activity history, but V1 does not claim a form was submitted because it cannot and does not observe the human’s final action as an authoritative workflow step.
