# Specialist workflows · Briefcase v0.8

The authenticated **Specialist workflows** workspace adds native business operations for the 44 roles that were partial or open in v0.7. It complements the existing Firm desk, Client development, Risk and intake, Identity, matter workspaces, and shared Role work queue.

## Complete a workflow

1. Configure an account's `desk` role grants (R01–R65 are accepted). A lawyer may assign work to an active firm account; a specialist may start a workflow for their granted role. Select an independent reviewing lawyer. A firm with only one active account may explicitly self-review; activating another account ends that exception for further submissions and approvals.
2. Open **Specialist workflows**, choose the role, title, preparer, reviewer, and source matter. Source-dependent workflows require both people to have current matter access; the reviewer also needs review permission. Only participants may read an unlinked assignment. A firm-wide role label does not grant matter access.
3. Complete the role-specific fields. Common arrays use editable rows; advanced JSON and file imports remain available. The source inventory exposes the selected matter's original IDs and physical page counts. Financial amounts are integer cents, not floating point dollar values.
4. Use the business actions to add sources, revise work, resolve discrepancies, and record required decisions. Reviewer-only domain actions are checked on the server against current account and matter permissions.
5. Resolve the displayed blocking checks, then submit. A version binds the complete state, derived work product, original document hashes, and source page references. The reviewer examines the complete draft, sources, warnings, and exact version before approving or returning it.
6. Download the approved artifact. Changes reset current approval. Historical versions remain in the internal record, but operational releases also respect current privilege, deadlines, signatures, financial state, consent/status and preservation holds. Revocation during asynchronous document generation is checked again before sending bytes.

Every assignment has optimistic revision checks and an append-only activity trail. Request replay cannot create a second assignment. Changes to participants require a new submission. Native workflow events, provider receipts, and imported records remain distinguishable.

## Role work products

| Roles | Native work and output | Scenario tests |
|---|---|---|
| R03, R20–R25 | Supervised drafts; junior revision/exhibit review; source-checked motion citations; condition-gated executed closing binder; separate memos; privilege-safe production. JSON/PDF and production manifest as applicable. | `tests/legal-workflows.test.mjs` |
| R26–R28, R30–R32, R65 | Indexed litigation PDFs; executed-original binders; authorized EML/PDF correspondence; filing attempts and service gates; deduplicated discovery production; offline exhibit/video ZIP; structured Word/PDF production and comparison. | `tests/documents-workflows.test.mjs` |
| R29, R33–R38 | Amended-order date confirmation; spend-linked scope approval; actual delegated work reassignment; governed template editions and TXT/ZIP drafts; sourced research/treatment reports; executed fixture promotion/rollback; minimal pro bono referral exports. | `tests/practice-operations-workflows.test.mjs` |
| R39–R46 | Claim amendments; reviewed agency notices; petition evidence/PDF packs; reconciled estate schedules; closing conditions and signed binder; duplicate/ambiguous provider queue; cleared-funds/lien settlement statements; source-linked witness statements. | `tests/specialists-workflows.test.mjs` |
| R48–R54, R56, R58 | Operating/trust reconciliation; immutable corrections and reversals; duplicate-safe payable invoices; billing retries; partial payments and authorized write-offs; returned trust receipts; restricted lateral clearance; payroll status handoff. | `tests/finance-people-workflows.test.mjs` |
| R17, R59–R63 | Signed verification and live intake linkage; recovery manifest/operator review; scoped import retry coordination; revocation evidence; hash-bound document synchronization; global holds and scheduled disposition proposals. | `tests/technology-workflows.test.mjs` |

Shared security and frontend checks live in `tests/workbench-security.test.mjs` and `tests/workbench-ui.test.mjs`. The frontend suite exercises the actual renderer and form payloads through a DOM protocol harness; it is not a browser layout or playback test.

## Signed verification connected to intake (R17)

Configure `BRIEFCASE_DILIGENCE_PUBLIC_KEYS_JSON` as a server-side JSON object mapping approved key IDs to Ed25519 public-key PEM strings. Briefcase does not need or store the provider's private signing key. Without a configured trusted public key, signed-provider verification fails closed.

The configured provider or firm's approved adapter returns:

```json
{
  "keyId": "approved-provider-key",
  "payload": {
    "firm": "configured-firm-id",
    "caseReference": "exact-intake-inquiry-id",
    "requestReference": "exact-diligence-package-reference",
    "provider": "approved-provider-name",
    "sequence": 1,
    "status": "clear",
    "issuedAt": "2026-11-12T12:00:00.000Z",
    "expiresAt": "2026-11-13T12:00:00.000Z",
    "evidenceHash": "64-lowercase-hex-characters"
  },
  "signature": "base64-ed25519-signature-of-UTF8-JSON.stringify(payload)"
}
```

This illustrates the wire contract; the timestamps, IDs, digest, and signature must come from the actual provider. Supported statuses are `clear`, `review`, and `failed`. The issuer and verifier must serialize the payload identically. Signatures, trusted-key availability, firm/case/request binding, monotonic sequence, conflicting replays, issue time and expiry are checked. Raw identity documents stay with the approved provider.

Set the R17 work item's case reference to the inquiry ID and its request reference to the diligence package reference. Use the inquiry's assigned due-diligence analyst as preparer and assigned conflicts counsel as reviewer. Complete the independent review, then use **Link signed verification** in Risk and intake. Signed linkage cannot be overwritten by a manual status. Intake views, conflict clearance, opening, and finalization recheck the current approved result; a later failure, pending revision, expiry, revoked key or offboarded participant blocks opening. A verified signature establishes the origin of a result; the external provider still performs identity verification.

## Records scheduler and preservation (R63)

Use a scoped records-assignee account and run:

```sh
npm run records-scheduler
```

Configure these environment variables on the job runner (keep the password in secrets):

- `BRIEFCASE_SCHEDULER_ORIGIN`: the configured HTTPS app origin (loopback HTTP permitted for local tests).
- `BRIEFCASE_SCHEDULER_USER` and `BRIEFCASE_SCHEDULER_PASSWORD`: the records-assignee account.
- `BRIEFCASE_SCHEDULER_LIMIT`: maximum records work items per run, default 100, maximum 500.

The runner reads approved retention policies, current originals and due dates; checks current access and holds again before emitting deterministic JSON job proposals; and records held, ready-for-review, nothing-due, or skipped states. Holds apply across other R63 work items and the original matter Operations desk. The native retention route also consults specialist holds. An assignment cannot bypass a hold by creating another work item. Cron output is non-destructive: it never deletes an original, grants deletion authority, or claims a connector ran. Store proposals in the firm's approved job/log sink; authorized external execution and a reviewed connector receipt remain separate steps.

## Document production boundaries

R65 supports the Briefcase structured template: numbered sections, source-backed authorities, exhibit references, DOCX export, bounded Word paragraph round-trip import, before/after comparison, and PDF export. It rejects unsupported Word structures instead of silently dropping them. Generated PDF text is checked against the supported standard font and layout before submission; imported original PDF pages retain their original text/fonts. Word and PDF pagination is not guaranteed identical. Inspect representative templates in the firm's actual Word/PDF environment before treating filing-format fidelity as accepted.

R32 exports a real offline HTML/exhibit/video package with approved source revisions and clips. Extract the ZIP and rehearse playback on the actual trial machine/browser. Local automated checks inspect the packaged files and media bytes; this run did not observe browser video playback.

## Deployment and external evidence

This release adds the `specialist_work` SQLite table on startup and includes it in tenant-only recovery and version/source integrity verification. Back up before upgrading, retain the pre-upgrade snapshot for rollback, and run the maintenance verifier on restored copies. Continue using one app replica with a persistent SQLite volume until the planned production data migration is implemented.

The new workflows do not execute bank transfers, payroll, court filings, agency submissions or destructive records deletion. Accounting/bank statements, signed documents, provider receipts and research treatment reports are explicitly imported or recorded and checked by the reviewer. Live vendor adapters, practitioner review, hosted recovery, production identity/SSO and subscription/paywall controls remain governed by `RAILWAY_HANDOFF.md`.

See `ROLE_ACCEPTANCE.md` for the exact local-pass versus remaining-verification status. A scenario pass is not a claim that every responsibility of a profession or every live integration has been validated.
