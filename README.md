# Briefcase Solo

Run a plaintiff PI matter from inquiry through closeout and review a medical chronology against its original PDF pages. The sample is fictional.

## Use the hosted pilot

Open the sample matter and select any chronology event. The viewer opens its physical PDF page and displays the Bates label separately. Verify, edit, or exclude the open events. Select **Export**, approve the chronology, and download the CSV and source manifest. Approvals retains each approved version.

To test ingestion, open **Matters → New matter → Import PDF → Use sample PDF**. This runs PDF text extraction and OCR on the mixed sample packet. The hosted pilot stores matters, PDFs and drafts in the current browser. Opening an exported source link requires that browser and its saved matter. Use synthetic records.

### Run the practice workflows

| Workflow | How to try it |
|---|---|
| Intake & engagement | Create an inquiry, enter parties, check normalized-name candidates from your workspace, and record your decision. Attach a supporting PDF to test logging a signed agreement. |
| Records collection | Add a request with a provider, coverage and follow-up date. Download the draft letter, log the send, and link imported PDFs as partial or complete receipts. |
| Demand packages | Approve the current chronology. Add itemized amounts and exhibit pages, edit the generated letter, and approve the package. The ZIP contains the letter, selected PDF pages, approved chronology and source index. |
| Deadlines & updates | Add a deadline with its source and confirm the date. Provider follow-ups appear automatically in the agenda. Draft and approve a client update, then log delivery after sending it. |
| Settlement & closeout | Enter the gross amount, reconcile fees, costs and liens, approve the statement and complete the checklist. Download the closeout ZIP with the statement and selected supporting PDFs. |

The workspace records manual sends and signatures. Date confirmation, conflict clearance, package approval and settlement reconciliation are lawyer decisions. Supporting PDFs stay in the matter without generating medical events or sending their text to the configured drafting model.

### Case and firm desk

| Section | What to try |
|---|---|
| Negotiation | Approve a demand, log delivery, enter two offers, record exact-version client authority, then record acceptance. The accepted terms populate Settlement. Add a reviewed release and track obligations and matched receipts. |
| Investigation & coverage | Enter intake triage, incident accounts, witnesses, evidence, preservation requests, claims, provider windows and capacity records. Link related records and source pages. The intake conflict search also checks recorded aliases. |
| Damages & funds | Enter reviewed losses, costs and liens, then carry the reviewed bill and deduction amounts into Demand or Settlement. Log cleared transactions from accounting, check allocations against the approved statement, and reconcile. |
| Client & correspondence | Record correspondence, signatures, client tasks, file handoffs and referrals. The optional local portal provides scoped PDF access and a lawyer review queue for incoming PDFs. |
| Litigation | Open a court case on the same matter. Link notices to reviewed rules or exact order dates, confirm dates, track filing and service, review discovery evidence, and download filing, production or hearing packets. |
| Practice operations | Record holds, retention reviews, templates, vendors, incidents and recovery exercises. Export encrypted matter archives and verify original hashes. The local server also exports sanitized import diagnostics. |
| Practice packs | Record specialty milestones and delegated work. Validate the selected pack and its local procedures separately before applying it to client matters. |

Use **Recipient ZIP** on an approved demand to download the letter and selected exhibits. The internal demand ZIP also contains the approved chronology and source index. Review each released page. From **Source PDFs → Redact page**, draw rectangles, inspect the preview, and download a separate flattened copy. Use **Deadlines & updates → Export confirmed dates** for an all-day calendar file. Candidate court dates are review aids and depend on the applicable forum, orders, inputs and exceptions entered by the lawyer.

## Run the local server

Install Node.js 24 or newer, Poppler utilities (including `pdfinfo`, `pdftotext` and `pdftoppm`), Tesseract with English language data, and unzip this source package. Run these commands in the project directory.

```bash
read -rsp 'Choose a local Briefcase password (at least 12 characters): ' BRIEFCASE_PASSWORD
echo
export BRIEFCASE_PASSWORD
npm start
```

Open [http://127.0.0.1:4177](http://127.0.0.1:4177) and sign in as `lawyer`. SQLite stores original bytes, draft state and approved revisions in `data/briefcase.sqlite`. The default listener is loopback. `BRIEFCASE_USER`, `BRIEFCASE_LAWYER_NAME`, `BRIEFCASE_DB` and `BRIEFCASE_PORT` customize the local instance. Run `npm test` to repeat the synthetic checks.

### Test a staffed firm

Configure `BRIEFCASE_USERS_FILE` with an array of account objects or provide the same array in the server-side `BRIEFCASE_USERS_JSON` secret. Each object has `username`, `password`, `firm`, `name` and an optional `role` of `lawyer` or `preparer`. Use unique usernames and passwords of at least 12 characters. Existing configurations default to `lawyer`. Keep configuration outside Git.

1. Sign in as a lawyer, create a new synthetic matter and open **Matter team**. Grant access to a preparer and, optionally, another assigned lawyer in the same firm.
2. In a separate browser profile, sign in as the preparer. Upload a synthetic packet, use **Search pages** and **Check records packet**, and check the chronology against the original. Packet comparison uses normalized page text. Matching and comparison produce candidates for review.
3. Submit the checked chronology. The assigned lawyer can return it with a reason or approve the submitted revision. A revision changed after submission must be submitted again.
4. Revoke access and verify that copied original, search and export links fail for the removed account. The owner can inspect recent access and approval events in **Matter team**.

The v0.4 release scopes collaborator access to a whole assigned matter. Preparation includes selected draft records and supporting documents. Lawyer approval and owner operations are enforced by the server. Existing owner-only matters and single-lawyer setup are preserved. The static hosted workspace continues in browser-only mode. Team controls run on the authenticated Node server.

### Railway synthetic staging

See the [Railway handoff checklist](RAILWAY_HANDOFF.md) for staging, migration, subscriptions, server-side entitlements, and paid release checks.

Connect a private repository containing this source to Railway. The root Dockerfile installs Node 24, Poppler and English Tesseract. Keep one instance and mount a volume at `/data`. Configure `BRIEFCASE_ORIGIN` as the public HTTPS origin, `BRIEFCASE_DB` as `/data/briefcase.sqlite`, `BRIEFCASE_RAILWAY_HEALTH=1`, and the account configuration as a service secret. Configure `/health` as the health check. The service uses Railway’s `PORT` when `BRIEFCASE_PORT` is unset. Check upload, review and isolated restore with synthetic files. Railway deployment and the signed-in browser walkthrough have yet to be verified.

Postgres and private object storage, self-service firm provisioning, field-level or ethical-wall permissions, firm identity integration and tenant-level hosted restore remain production work. Composio, Tiptap and live external service integrations remain separate implementation and verification tasks.

### Firm desk

The [Firm desk guide](FIRM_DESK.md) covers account permissions, partner reporting, referral credit, capacity and staffing, operating review, and office services.

## Client development and risk

See the [client development, risk and operations guide](CLIENT_AND_RISK.md) for role setup and workflow boundaries. The [role acceptance register](ROLE_ACCEPTANCE.md) tracks local evidence for all 65 scenarios.

### Specialist workflows (v0.8)

Open **Specialist workflows** in the authenticated workspace for the 44 roles previously marked partial or open. Each workflow has structured domain inputs, business actions, blocking validation, a distinct reviewing lawyer, exact-version approval, and downloadable work products. See [the specialist workflow guide](SPECIALIST_WORKFLOWS.md) for the role map, output formats, signed verification setup, scheduled retention review, and external-service boundaries.

The implementation includes indexed PDF packets, constrained DOCX round trips and comparison, offline trial packs, versioned legal drafts and closing conditions, reviewed deadlines, template releases, ledger reconciliation, invoice/payment controls, restricted recruiting/payroll handoffs, signed diligence status, and scoped technology operations. Account `desk` grants can name any of R01–R65. Source matter permissions remain independently required. Hosted rollout and real-provider verification are still tracked separately from local synthetic test results.

## Role work

On the authenticated server, open **Role work** from the Workspace navigation. A lawyer assigns one of the 65 role templates to a firm account and chooses a reviewing lawyer. A solo firm can self-review with explicit attribution. An assignee submits an output and supporting references. A linked matter can supply an original PDF page with its hash. A reviewer can return work or approve the exact revision. Provider workflows require a recorded result and a second review of that result before proof is available. Assignments with no matter link are private to their participants. Linked assignments also require current matter access.

Download the verified record for the output, the evidence reference, any provider receipt, and the activity log. The synthetic suite checks the assignment path for all 65 templates. The role templates provide a common path for recording work and human verification. Native specialist engines now have their own acceptance tests; live provider connections, subscription billing, and hosted SaaS controls remain tracked in the Railway handoff.

## Local client portal and recovery

Set `BRIEFCASE_PORTAL=1` and restart the local server. Open **Client & correspondence → Create access**, select the exact files and an expiry, then copy the link and access code. On another test browser, enter the code, download a shared file or submit a PDF, and review the submission in the lawyer workspace. Revoke the link and verify further access fails. The hosted owner workspace keeps its existing private audience and browser-local matter data.

Use protected storage for the SQLite backup and make a separate recovery copy. The destination paths must be new files. These commands check database integrity, original hashes and chronology references.

```bash
npm run maintenance -- backup data/briefcase.sqlite data/verified-copy.sqlite
npm run maintenance -- restore data/verified-copy.sqlite data/restored-test.sqlite
npm run maintenance -- verify data/restored-test.sqlite
```

### Release work still open

The v0.3 build supports manual delivery, signature, court and accounting records. Live e-signature, email, banking, filing and calendar-provider adapters require selected services, credentials, provider-specific testing and approval. A public client-portal deployment, hosted durable multi-user data and restore, real-file authorization and measured pilot, alerts and scheduled backup operations, and separate specialist validation still need completion. Browser archive export verifies a portable copy. The local maintenance commands restore a SQLite snapshot to a separate file. The managed preview relay was unavailable during this build, so the signed-in hosted browser walkthrough and visual redaction check remain open.

## Connect an isolated Paperless service

The local server can use an existing private Paperless instance or start the pinned service in `compose.paperless.yml`. The hosted pilot uses browser OCR. Use a dedicated Paperless instance for each firm.

```bash
export PAPERLESS_SECRET_KEY="$(openssl rand -hex 48)"
read -rsp 'Choose a Paperless admin password: ' PAPERLESS_ADMIN_PASSWORD
echo
export PAPERLESS_ADMIN_PASSWORD
docker compose -f compose.paperless.yml up -d
```

Open [http://127.0.0.1:8010](http://127.0.0.1:8010), sign in as `briefcase-admin`, and obtain a token for the Briefcase service account. The account needs access to import documents, see its tasks and retrieve the originals and derivatives it imports. [Paperless REST API](https://docs.paperless-ngx.com/api/)

```bash
export BRIEFCASE_PAPERLESS_URL=http://127.0.0.1:8010
read -rsp 'Paperless API token: ' BRIEFCASE_PAPERLESS_TOKEN
echo
export BRIEFCASE_PAPERLESS_TOKEN
npm start
```

Stop the previous local Briefcase server before starting it with new settings. Import a synthetic packet in a new matter. Briefcase records the task receipt, compares the downloaded original with the input SHA-256, and uses the archive only when it can match the original pages. Retry the same file if Paperless is still processing. For uncertain receipt or terminal failure, inspect the private Paperless task first. To use the direct OCR path, unset both Paperless variables and restart Briefcase.

## Enable model-assisted drafting locally

Set `BRIEFCASE_MODEL_URL` to the full Chat Completions URL of an approved OpenAI-compatible endpoint, `BRIEFCASE_MODEL_NAME` to its model identifier, and `BRIEFCASE_MODEL_KEY` if that endpoint requires one. Restart the local server. When configured, new uploads send extracted page text to that endpoint. Briefcase accepts candidate excerpts it can match to pages in the PDF. Each candidate still needs lawyer review. With the variables unset, deterministic date and section rules produce draft events. [Chat Completions API](https://developers.openai.com/api/reference/resources/chat)

## Pilot limits

Use synthetic data while evaluating this build. Imports are limited to 25 MB and 60 pages. The OCR engine uses English, and the draft rules are aimed at U.S. service dates and labelled clinical text. Check material events against the original PDF, including pages where an event is absent from the draft. Downloads contain record content and should be handled with the same care as the source.

The synthetic suite exercises local OCR, original fidelity, duplicate imports, authorization, approval replay, export preservation and restart persistence. The lifecycle test covers all five practice workflows and inspects the actual demand and closeout ZIPs. It uses local HTTP fixtures for the Paperless and model APIs. A signed-in hosted walkthrough, live Paperless smoke test where applicable, approved client-data path, production restore and retention rehearsal, and representative time study are release checks still to run.
