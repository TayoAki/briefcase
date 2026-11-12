# Briefcase v0.8 verification

Verified 2026-11-12 with synthetic data against the local Node/SQLite application. The release implements specialist workflows for all 44 roles that were partial or open in v0.7.

## Results

- `TMPDIR="$PWD/.work" npm test`: **125 passed, 0 failed, 0 skipped**.
- JavaScript syntax checks for the shared server, specialist modules, scheduler and new UI passed.
- `git diff --check` passed.
- The existing 34-test regression suite remains included. New tests cover native domain operations, authenticated handoffs/exports, failure cases, isolation, source integrity, and frontend form behavior.
- Acceptance register: **58 local scenario passes; 7 partial checks; all 65 roles have an implemented work path.** This is not a new blanket five-dimension production score.

## What the tests exercise

The six specialist test files exercise each of the 44 new roles through the actual authenticated HTTP application, as well as focused business-rule tests. They create scoped assignments, import real synthetic PDF bytes, execute domain actions, trigger blocking failures, submit exact versions, approve with assigned reviewer accounts, and inspect the resulting JSON/PDF/DOCX/ZIP/TXT/EML artifacts as applicable.

Specific checks include unsupported citations, changed closing conditions, missing signatures/evidence, amended deadlines, privileged attachments, duplicate financial references across separate assignments, unmatched ledger entries, returned funds, changed payees/liens, unavailable research treatment, failed automation fixtures, and payroll/recruiting field restrictions. PDF extraction checks packet page positions and generated numbering/index text. DOCX tests edit actual document XML and verify the constrained import/diff/export path.

The shared security tests exercise stale hashes, current reviewer permissions, tenant and participant denial, revoked matter access, source/privilege changes during asynchronous PDF generation, independent review after a second account activates, participant reassignment, and restricted projections on read/write/export responses.

Technology tests perform actual tenant-only SQLite export/restore and hash verification. They pause an HTTP model response, offboard the user while the import is in flight, and confirm no original is persisted. Signed verification is linked to the actual intake gate and rechecked before clearance, opening and finalization. Records tests cover active holds across restored data, other specialist assignments, the legacy matter workspace, and holds introduced between scheduler reads.

The UI protocol suite renders all 44 workflow definitions for preparer/reviewer roles and exercises namespaced forms, full-text review before approval, escaped content, structured row add/edit/remove, numeric/list serialization, JSON import, and preservation of typed fields when sources change.

## Verification that still needs the deployment or real application

| Role | Remaining acceptance evidence |
|---|---|
| R17 | An actual approved identity provider performs the verification and returns the trusted signed result. Local cryptographic and intake-control tests do not perform identity checks themselves. |
| R32 | Extract the offline trial package and observe the approved exhibit revision and video segment playing on the intended trial browser/machine. |
| R59 | Run and sign off the recovery rehearsal on the hosted deployment, including persistence and integration configuration. |
| R60 | Rehearse hosted support diagnosis and owner-operated retry with the deployed queue and permissions. |
| R61 | Exercise revocation against the configured real provider and hosted worker path, including provider-side handling. |
| R63 | Run the deployed cron and validate the actual disposition connector's hold enforcement and receipts. The built scheduler emits non-destructive proposals. |
| R65 | Render and round-trip representative files in the firm's actual Word/PDF tools and verify filing-format fidelity. Arbitrary Word layouts and identical pagination are not claimed. |

A browser walkthrough was attempted, but the available browser could not connect to the local preview server. Browser layout, video playback and Word application rendering were not verified. Automated UI protocol checks do not substitute for those observations.

No Railway deployment, live client data, financial payment, court filing, payroll execution, external message or destructive disposition was performed. Production SaaS identity, billing/paywall, multi-instance persistence and operating controls remain tracked in the Railway handoff, as previously planned.

See [the full role audit](WORKFLOW_AUDIT_v0.8.md), [the acceptance register](ROLE_ACCEPTANCE.md), and [the workflow guide](SPECIALIST_WORKFLOWS.md).
