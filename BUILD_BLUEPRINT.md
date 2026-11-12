# Briefcase Solo build blueprint

## Outcome

A solo plaintiff personal injury lawyer imports a PDF, selects a drafted service event, reviews the original page, verifies or corrects the event, and exports an approved chronology. An unreadable page stays visible until the lawyer records how they handled it. CSV contains one row per verified event. JSON captures the source hashes, physical page numbers, Bates labels, reviewer and exclusions.

## Implemented workflow

| ID | Capability | Evidence |
|---|---|---|
| F01 | Create and open a matter with an exact ownership scope | HTTP integration creates two matters, rejects another account and firm, and checks an original against its matter ID. |
| F02 | Preserve original bytes and index by physical page | Synthetic digital, scanned, mixed, blank, corrupt and encrypted fixtures exercise extraction and failure paths. |
| F03 | Draft and review page-linked events | Model and deterministic drafts attach known document and page IDs. Server accepts an indexed excerpt or an explicit manual transcription. |
| F04 | Approve an exact revision and export it | HTTP integration checks open review, attestation, stale revisions, idempotent approval, manifest content and unchanged prior CSV after edits. |
| F05 | Use Paperless behind a replaceable import adapter | API fixture checks receipt polling and original hash. Reordered derivative fixture exercises direct OCR fallback. Live Paperless deployment check remains open. |
| F06 | Accept model candidates scoped to the supplied PDF pages | API fixture returns fabricated page and excerpt candidates and the adapter discards them. A live configured provider check remains open. |
| F07 | Move an inquiry through conflict review, acceptance and signed engagement | The lifecycle test finds exact normalized-name candidates, excludes a different firm, rejects stale clearance and records a signed supporting PDF. |
| F08 | Follow provider requests until the requested coverage is received | The lifecycle test logs delivery and both partial and complete receipts, then checks that revised scope reopens coverage and its follow-up. |
| F09 | Produce an approved demand with the selected exhibit pages | The lifecycle test checks chronology revision binding, cents reconciliation, immutable approvals, ZIP contents and physical page references. |
| F10 | Confirm deadlines and review client updates | The lifecycle test checks source-date confirmation, matter agenda ordering and immutable sent updates. |
| F11 | Reconcile settlement and close the matter | The lifecycle test blocks pending liens, checks net cents, validates checklist completion and compares the exported supporting PDF with its source bytes. |
| F12 | Negotiate and carry exact accepted terms into Settlement | The expanded suite checks demand delivery, stale and revoked authority, expiration, conditional acceptance, pinned versions and an idempotent handoff. |
| F13 | Record and reconcile external funds | The expanded suite blocks insufficient receipt matching, detects duplicate external IDs, approves allocations and checks disbursements, mismatches and reversals. |
| F14 | Run a local scoped client portal | The expanded suite denies a wrong code and unshared file, quarantines and deduplicates uploads, verifies lawyer review and checks revoked access. |
| F15 | Review court dates and preserve filed and produced versions | The expanded suite checks holiday-aware synthetic date candidates, confirms and exports only current dates, archives an accepted filing against its original approved draft and tests production review. |
| F16 | Export a verifiable encrypted matter archive and restore a local SQLite snapshot | The expanded suite checks original hashes, bad passphrase, tampering and isolated restore without overwriting an existing database. |
| F17 | Extend the case and firm desk on legacy matters | All new section templates render from v0.2 matter state. Typed inputs, history, source links, approvals and agenda entries share the same server-scoped matter. |
| F18 | Share a whole matter with a preparer or an assigned lawyer | The two-firm HTTP test checks same-firm grants, denial for unassigned and foreign accounts, copy-link denial, and revocation. |
| F19 | Route a chronology from preparer to assigned lawyer | The two-firm test exercises return with reason, changed-revision rejection, exact assigned approval, no duplicate approval on replay, and approval preservation after restore. |
| F20 | Search originals and propose records matches within a matter | The test checks original-page search and a provider-name match with physical-page evidence, then rejects unauthorized and cross-matter lookups. |
| F21 | Prepare a Railway-compatible synthetic staging build | Includes a Dockerfile, configurable port and service origin, and a hostname exception restricted to the Railway health endpoint. HTTP behavior is tested locally. Docker build and live deployment remain open. |

## Records and boundaries

- **Matter** belongs to a firm and lawyer in the local server. It has its own documents, draft revision and review history. The hosted pilot uses the current browser as its workspace.
- **Document version** binds its identifier to original bytes and SHA-256. The page index stores physical page number, optional printed label, extraction method and text.
- **Event** has an asserted service date, source page, excerpt and review status. Edits reopen review.
- **Approval** captures the reviewed revision, actor, source hashes, events, exclusions and any documented OCR gaps. A later draft change creates a new review path.
- **Import job** is scoped to the local firm and original hash. The Paperless task receipt is persisted independently of the matter draft so a retry can resume.
- **Practice state** uses its own revision. Workflow changes and supporting PDFs preserve the chronology approval. Demand versions reference the approved chronology and source hashes. Settlement and closeout versions retain approval and checklist evidence.

The work queue and original viewer are the primary interface. Source PDFs shows hashes and coverage gaps. Approvals holds stable downloads and review history. A hosted import is a browser transaction. A local import commits the document and its original in the same SQLite transaction.

## Release checks still open

Run the mixed and reordered-page tests against the actual Paperless instance. Exercise a backup restore and retention procedure for both stores. Confirm the data path and applicable client requirements before a real-file pilot. On three authorized, representative files, measure lawyer time through final review and compare every material event to the source. The proposed target is 30% less median active time.

## Backlog coverage in v0.3

| Backlog wave | Implemented | Still open |
|---|---|---|
| 0 Pilot readiness | Local permission tests, revision preservation, encrypted matter archive, verified SQLite snapshot/restore, flattened page export, support diagnostics | Signed-in hosted verification, visual redaction fixture, durable hosted accounts and migration, monitoring and backup scheduling, client-file approval and measured trial |
| 1 Negotiation | Delivery attempts, exact-version offers and authority, accepted terms into Settlement, release status and payment obligations | Selected provider delivery and actual authorized pilot timing |
| 2 Pre-suit operations | Alias candidates, screening, case plans, evidence and witnesses, insurance, provider windows, damages/costs/liens, separated demand packages, calendar file, representative records | Native media ingest, automatic incoming file matching, source-packet comparisons, advanced multi-claimant allocations and production validation |
| 3 Firm operations | Scoped local client access and PDF intake, correspondence and signature records, external-funds reconciliation, invoices/referrals/templates/continuity records | Live mail, e-signature, calendar and accounting integrations, hosted guest access and identity validation, cross-matter finance analytics and provider monitoring |
| 4 Litigation | Matter branch, pleading and filing records, reviewed deadline inputs, service, discovery, verified authority and hearing records, indexed packets and post-order records | Court adapters and jurisdiction test sets, full discovery numbering and privilege logs, citation-service integrations and practitioner validation |
| 5 Expansion | Specialty and delegation records with reviewed statuses and sources | Specialty-specific forms, rule validation, collaborator accounts and permissions, and external people systems |
