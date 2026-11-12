# Briefcase Railway handoff

The current release runs on Node 24 and SQLite. Use it as a single-replica, synthetic-data staging deployment. This checklist separates staging, migration, a private pilot, and paid rollout so each can be verified on its own.

## 1. Stand up staging after moving the repository

- [ ] Connect the private repository in a Railway staging environment. Set the service source root to the directory containing the root Dockerfile. Confirm the build log detects that Dockerfile.
- [ ] Use one replica. Attach a volume at `/data`. Set `BRIEFCASE_DB=/data/briefcase.sqlite`, `BRIEFCASE_RAILWAY_HEALTH=1`, and `BRIEFCASE_ORIGIN=https://<staging-host>`. Leave `BRIEFCASE_PORT` unset so the server uses Railway's `PORT`. The Dockerfile binds to `0.0.0.0`.
- [ ] Set `BRIEFCASE_USERS_JSON` as a secret with generated credentials for two synthetic firms. Give the first firm an owner, a preparer, an assigned lawyer, and an unrelated user. Leave the optional model, Paperless, and client portal off until their individual tests. Keep secrets and database files out of Git.
- [ ] Set the deploy health check to `/health`. Check the staging URL over HTTPS. Confirm an unauthenticated API request receives 401 and only the health route accepts the Railway health-check hostname.
- [ ] In signed-in browsers, exercise one native role and one provider-receipt role. Use separate sessions for owner, preparer, reviewer, unrelated user, and the second firm. Check create, return, approve, verification download, denied access, and linked matter revocation.
- [ ] Configure the five Firm desk role grants and two office scopes using [the Firm desk guide](FIRM_DESK.md). Verify the leadership workflows in signed-in browsers with the same access roles used in the local acceptance tests.
- [ ] Import a synthetic mixed scanned PDF, verify the source pages, submit a chronology, approve it, and download the proof and source. Redeploy and confirm originals, role work, and approvals persist.
- [ ] Schedule volume backups and separate uptime monitoring. Restore a staged copy, run `npm run maintenance -- verify /path/to/restored.sqlite`, and compare counts, sampled PDF hashes, role-work proof, and post-restore access. Record elapsed recovery time and potential data loss. Volume snapshots restore the whole staging database.

Railway references [Dockerfiles](https://docs.railway.com/builds/dockerfiles), [Healthchecks](https://docs.railway.com/deployments/healthchecks), and [Volume backups](https://docs.railway.com/volumes/backups).

## 2. Build and verify hosted SaaS storage and identity

- [ ] Create separate staging and production services, secrets, provider test/live accounts, and data stores. Add managed Postgres, private object storage, and an asynchronous worker for OCR and connectors. Implement the application storage adapters and migrations before switching off SQLite. Setting `DATABASE_URL` alone will leave the current app on SQLite.
- [ ] Build firm provisioning, invitations, firm administrators, secure sessions, MFA or an approved identity provider, and account lifecycle. Add explicit role and object permissions for matter, document set, field, client and co-counsel access. Test screened matters in search, files, jobs, exports, and AI context.
- [ ] Rehearse a migration from a copy. Preserve firm, user, matter, original, approval, and role-work identifiers. Copy original bytes to private storage with hash verification. Reconcile per-firm counts for matters, memberships, originals, approvals, submissions, receipts, audit entries, and active holds. Export browser-local matters separately and verify their original files before import.
- [ ] Plan cutover. Take a verified snapshot, stop writes or drain and replay a documented change stream, migrate, reconcile, and run the smoke tests. Reopen writes after the reconciliation passes. Rehearse restoring access and storage together if the cutover fails.
- [ ] Verify per-firm export and restore independently of volume recovery. Include role-work submissions and receipts, audit records, files, and legal holds. Keep backup, restore, and migration jobs scoped and observable.
- [ ] Add structured redacted logs, queue retries and dead-letter handling, alerts for stuck imports, backups and billing events, connector credential rotation, and support access that expires and leaves an audit record.

Reference [Railway PostgreSQL](https://docs.railway.com/databases/postgresql).

## 3. Implement subscriptions and the server-side paywall

Proposed starting packaging is one subscription per firm, a single-seat Solo plan, a Team plan with paid internal seats, and separately negotiated enterprise requirements. Choose prices, trial duration, grace period, and included usage before publishing. Client and co-counsel access should have its own permission model and seat policy.

- [ ] Define plan entitlements in the application. Start with seat count and explicitly chosen premium capabilities such as OCR/AI budgets or integrations. Assign permissions by role and matter independently of subscription status. A plan upgrade cannot grant access to a restricted matter.
- [ ] Store a stable mapping from firm ID to Stripe Customer and Subscription IDs. Restrict checkout and the billing portal to authorized billing administrators. Resolve price IDs and seat counts on the server from an allowlist. Reuse the firm's Stripe Customer and prevent parallel checkout sessions from creating duplicate subscriptions.
- [ ] Create hosted Checkout and Customer Portal sessions server-side. Keep test and live keys separate. Show the current plan, renewal state, used seats, quotas, and the reason when a feature is unavailable.
- [ ] Implement the webhook route with raw-body signature verification and a test/live mode check. Persist each event ID once. Reconcile against the current Stripe subscription when deliveries are delayed or out of order. Return success only after durable acceptance, and make processing safe to retry. Use the verified subscription state for access; the Checkout redirect is for navigation.
- [ ] Enforce plan and quota limits on server APIs, uploads, queued jobs, and billable connector/model calls. Use atomic reservations for seats and usage where concurrent requests can exceed a limit. Refund or release reservations on failed work. Give the UI the same entitlement decisions through the API.
- [ ] Agree on lifecycle behavior. Test trial start and end, active, upgrade, scheduled downgrade, payment failure and recovery, expiration, cancellation, and reactivation. Proposed policy is to pause new paid work after an agreed grace period while continuing authorized read-only access, billing recovery, and data export. Establish separate policies for retention and account closure.
- [ ] Rehearse failed payments, forged signatures, replayed and out-of-order events, a canceled Checkout session, concurrent seats, direct API calls, and cross-firm billing lookups. Confirm changing a client request cannot alter its firm's entitlement or another firm's subscription.
- [ ] Set up pricing, receipts, support, cancellation, and reconciliation ownership before opening paid signup. Keep client trust transactions in their own accounting workflow and provider account.

Stripe references [Subscription webhooks](https://docs.stripe.com/billing/subscriptions/webhooks), [Webhook delivery and signatures](https://docs.stripe.com/webhooks), and [Customer portal](https://docs.stripe.com/customer-management).

## 4. Close the remaining role-specific workflow gaps

- [ ] Use the [role acceptance register](ROLE_ACCEPTANCE.md) to rerun the v0.8 workflows in signed-in staging. Check a withdrawn testimonial, an expiring counsel grant, an inactive account, a tenant-only restore, signed verification expiring after intake clearance, and a records hold placed through a different workflow.
- [ ] Verify the new Specialist workflows screen with independent preparer/reviewer sessions. Test create, structured row entry, source selection, missing-evidence blocks, return/revision, exact-version approval, output download, reassignment, and revoked access. Open R32 offline packs in the trial browser and R65 files in the firm's Word/PDF environment; inspect representative numbering, exhibits, authority tables, pagination and round-trip edits.
- [ ] Connect the approved identity provider to the signed verification contract in [SPECIALIST_WORKFLOWS.md](SPECIALIST_WORKFLOWS.md), configure its public keys, and test actual clear, review, failed, replay, expiry and provider outage results. Pin the approved R17 assignment to the inquiry before clearance.
- [ ] Configure a Railway cron service for `npm run records-scheduler` with a scoped records account and the `BRIEFCASE_SCHEDULER_*` settings. Store its JSON output in the approved job/log sink, alert on failures, and confirm current holds survive deployment and restore. This job proposes reviewed disposition work; destructive connector actions require separate authorized execution and receipt verification.
- [ ] Verify personal injury intake through demand delivery with one firm and synthetic records, including the implemented shared intake/conflicts queue, screens and document-version review. Connect one approved mailbox adapter and client signature provider; verify matched delivery receipts against actual provider results.
- [ ] Verify Tiptap and Word/PDF output against firm templates. Pilot one Composio mailbox and calendar. Preserve server-side approval of the exact destination, document and message before sending. Add other providers only with a documented scope and tested exception path.
- [ ] Validate the other practice and operations packs with practitioners. Use role-specific fixtures for court rules, privilege and e-discovery, licensed research, finance and trust, leadership reporting, specialty forms, and HR/office handoffs.
- [ ] For each of R01–R65, log a normal case, an exception, a denied-access case, and a verified output. For each external step record the approved provider, the actual resulting receipt, and recovery from rejection or outage. Track each role's native capability and provider coverage independently of the shared queue.

## What v0.5 can prove locally

Role work provides a shared assignment, submission, rework, review, and proof path across all 65 templates. It records the reviewer, activity history, exact submitted text and evidence reference, optional original PDF page, and a manually recorded provider result where required. The synthetic tests verify this path for 22 templates without a required external receipt and 43 templates with one. Those tests establish the shared controls, while the role-specific business outcomes and provider execution require their own fixtures.
