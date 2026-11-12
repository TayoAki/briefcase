# Client development, risk and operations

Role codes are explicit account grants in `BRIEFCASE_USERS_JSON` or `BRIEFCASE_USERS_FILE`. Follow the office and practice configuration in [Firm desk](FIRM_DESK.md). Roles added in v0.7 include R07–R17, R47, R55, R57, R60, R61, and R64. Matter permissions, screens, and assignment requirements apply independently.

## Client development

- **R07** uses the internal referral register from Firm desk. The referral owner shares a practice-area brief with an assigned business development manager. Matter owners approve categorical experience cards from closed matters. Drafts are assembled from a format and approved cards. The receiving partner reviews and approves the exact version. Export contains the approved categories and opaque card references. It excludes source matter identities, financial figures, and referral details. Retiring a card, reopening its source, withdrawing a brief, or screening a participant blocks subsequent export.
- **R08** uses a supporting signed-consent PDF retained in the source matter. The owner records exact authorized copy, one channel, expiry, author, and distinct reviewer. The author selects a story format and the reviewer approves the exact result. Expired, withdrawn, or screened consent blocks preview, approval, and download. Review notes stay in the private workflow. A file already downloaded must be handled through the firm's external publishing process.
- **R09** uses a client account with one assigned relationship manager. An invited matter owner can share a specific milestone and approved display label for each owned matter. The manager receives that projection and routes feedback to the linked matter's owner. The lead acknowledges and resolves it with a recorded outcome. A screen or withdrawal removes the manager's affected history and feedback access.

## Risk and intake

- **R10** uses an owner-created incident that pins a bounded window of actual matter audit events. Assigned counsel can inspect the audit and disposition. Investigators see their instructions and findings. Granting incident access does not grant source-document access.
- **R11–R16** use the scoped Risk and intake desk. Reception can use an opaque callback code and capture a new inquiry. Intake merges by a stable duplicate reference and assigns an urgent or routine lawyer review. Analysts check explicitly shared minimum names, aliases and related parties. Counsel records waiver or screen conditions and clears the current candidate snapshot. Matter opening creates one prospective workspace, applies screens, and records one billing setup after the lawyer records a signed engagement.
- **R17** uses a restricted external verification package reference and manually recorded result. An unresolved result blocks clearance. Intake sees the verification status. Vendor-side identity and beneficial-owner verification require a live provider.

## Other workflow changes

- **R19** uses a configured `matterOnly: true` account and an expiring matter grant. Create a linked Role work assignment and select the exact supporting memo PDF. The reviewer checks the submitted version. Outside counsel loses access to the matter and submitted file at expiry. The grant currently covers one whole matter, and production identity provisioning remains open.
- **R47** compares fixed and hourly fee arrangements using staffing minutes, cost rates, billing rates and expenses. The assigned lawyer reviews the comparison and selects an option pinned to its version hash.
- **R55 and R61** use Identity and access. A firm admin can activate a pending `initiallyDisabled: true` account or offboard an active one using an external case reference. Offboarding revokes login, matter grants, and portal links issued by that account, and logs the change. Hosted SSO, owner reassignment, and automated HR provisioning remain separate.
- **R57** can assign training and track completion. Authorized leadership sees office totals with no completion evidence or evaluation notes in those totals.
- **R59 and R63** can rehearse local recovery. Run `npm run maintenance -- export-tenant LIVE.sqlite NEW.sqlite FIRM_ID` from the app host to generate a compact, verified copy for one firm. The command preserves verified originals and refuses an unknown table without a tenant rule. Use separate accounts and an isolated destination for the rehearsal. An active records hold blocks recorded disposition after restore until the owner releases it.
- **R60** can review timing, states and limited history for scoped import jobs, and record a triage disposition. The support projection excludes original names, matter IDs, original files and private exception notes.
- **R64** can route mail or a facilities escalation, reserve an internal room, and verify completion with a scoped delegate.
- **Role work** now binds supporting PDFs to the submission hash. Reviewers can download current and prior submitted versions while their linked-matter access remains active. Verified proof and backup verification check those bindings.

These workflows use the internal CRM, office schedule and reference records. Live CRM, CMS, identity-verification, court, accounting, HR, and document-management connections remain specific integration work.
