# Briefcase role agents — working plan

Started 2026-11-14. This is the document we work from. Each phase lists its tasks and the check that closes it. Update the status column as work lands; do not mark a check done without the evidence it names.

## 1. Can it be built?

Yes. Every one of the 65 catalog roles (R01–R65) now has an AI agent that runs inside Briefcase, and the first working version is in this branch (section 4).

What "an agent does the role's work" means here, and where it stops:

- **The agent is the preparer.** It reads the matter's documents, fills the role's workflow, corrects what the server rejects, and submits an exact version.
- **A lawyer is always the approver.** No agent can approve, export, send, file, pay, or change who is assigned. That is a design rule, not a gap to close later.
- **Real-world steps need real connections.** 43 roles end in a provider receipt (a court, a bank, an identity provider). Today a person records that receipt. Agents can only take those steps over once the provider connection exists (Phase 5).
- **Depth varies today.** 44 agents drive a structured workflow with role-specific tools. 21 agents (mostly leadership, intake and client development) produce a written work product for review; their role-specific tools come in Phase 2.

So: all 65 agents exist and run now; all 65 doing the *full* job to a verified standard is Phases 1–8.

## 2. What we take from the three repositories

| Repository | What it is | What we use | What we do not use |
|---|---|---|---|
| [elie222/rakazo](https://github.com/elie222/rakazo) (Apache-2.0) | Self-hosted platform of persistent AI teammates: chat, memory, routines, approvals, groups, connected apps, a computer per bot. Needs Postgres, an API, a worker and sandbox machines. | Its product patterns: approval modes and cards, routines (schedule, email, webhook), groups and delegation, bots managing bots, skills as written know-how, MCP/OpenAPI as the way to add tools. Later, as an optional outside front end (Phase 6). | Its runtime as Briefcase's agent engine (see section 3). Its per-bot computers and browser control. |
| [milind-soni/OpenMausBot](https://github.com/milind-soni/OpenMausBot) (Apache-2.0, `enterprise/` excluded) | Chat-app roster of bots, each a real agent run by a CLI on the user's own machine; desktop app. | The interface idea: a contact list of bots you talk to, watch work, and answer when they ask. Question cards. Bring-your-own-agent over MCP (Phase 6). | Its local-first runtime (Briefcase is a hosted multi-firm product). Anything under `enterprise/`, which is not open source. |
| [mattpocock/skills](https://github.com/mattpocock/skills) (MIT) | Small composable skills for engineering work, in the `SKILL.md` format. | The format for our 65 role skills (`server/agents/skills/Rxx.md`). The build process for every ticket in this plan: `to-spec` → `to-tickets` → `tdd` → `code-review`, with `domain-modeling` for the shared glossary and `diagnosing-bugs` when a check fails. | The skills themselves as role instructions; they are about writing software, not legal work. |

No code from the three repositories is copied into Briefcase so far. If we later adapt code from Rakazo or OpenMausBot, it needs their Apache-2.0 notice kept in a `NOTICE` file.

## 3. Architecture decision

**Agents run inside Briefcase, on Briefcase's own permission checks.** Hosting Rakazo as the engine was the alternative and is not the plan, for three reasons:

1. **Permissions live in Briefcase.** Matter screens, firm isolation, exact-version approval and holds are enforced in Briefcase's server. An outside engine would hold a second copy of client documents and a second set of accounts that those rules do not govern.
2. **The workflows already describe the tools.** Each role workflow declares its fields and actions. Those convert directly into tool definitions, so an agent can only do what the role's form allows, and the server validates every call exactly as it does for a person.
3. **Cost and operations.** Rakazo adds Postgres, a worker and sandbox computers before the first agent runs. Briefcase's agents needed one module and one table.

Rakazo and OpenMausBot stay useful as *clients*: Phase 6 exposes Briefcase's agent tools over MCP so a firm that runs either can talk to its Briefcase agents from there, still under Briefcase's rules.

### How an agent run works

1. A signed-in person picks an agent, a reviewing lawyer, optionally a matter, and writes instructions. That person is the **supervisor**; the work is prepared in their name and marked `via: agent:<run>` in the record's history.
2. The agent loops: the model chooses a tool, Briefcase runs it with the supervisor's current permissions, the result goes back to the model. A rejected call (a quotation that is not on the page, a missing field) comes back as an error the agent must fix.
3. The agent may pause with a question. The supervisor answers in the thread and it continues.
4. The agent submits. The run stops. The reviewing lawyer reads the exact submitted version in the same screen and approves or returns it.
5. If returned, the supervisor sends the agent a follow-up and it revises.

### Guardrails that exist now

| Guardrail | How it is enforced |
|---|---|
| No approval, export, receipt, reassignment or cancel | Those are not in any agent's tool list; a test checks all 65. |
| One assignment, one matter | Tools act only on the run's own work item and linked matter. |
| Supervisor's permissions, rechecked every step | The account is looked up again before each tool call; an offboarded or screened supervisor stops the agent. |
| Independent review | The server refuses approval by the supervisor; only the assigned reviewing lawyer can approve. |
| Untrusted document text | The instructions tell the model to treat document text as evidence, not orders; and nothing a document says can add a tool. |
| Cited quotations are real | The existing workflow validation rejects any quotation not found on the cited page. |
| Bounded runs | 30 model turns per run by default, 90-second model timeout, stop button. |
| Other firms and other people | A run is visible only to its supervisor and reviewer, inside one firm, and only while they can still see the matter. |

## 4. What is built (Phase 0 — done)

| Piece | File | Evidence |
|---|---|---|
| Agent runtime, 65 profiles, tool generation, run storage | `server/agents.mjs` | `tests/agents.test.mjs`: 6 tests |
| API: `GET /api/agents`, `POST /api/agents/runs`, `GET`/`POST /api/agents/runs/:id` | `server/app.mjs` | same |
| Agents screen: roster of 65 by team, search and "Needs me" filter, profile and permissions, task composer, run thread, question and review cards | `dist/agents.html`, `dist/agents-ui.mjs`, `dist/agents.css` | Driven in a browser as supervisor, reviewer and at phone width; no page errors |
| Agent mark on work history and submissions | `server/workbench.mjs`, `server/role-work.mjs` | asserted in tests |
| Role skill loader and first skill | `server/agents/skills/R21.md` | loaded into the R21 instructions |
| Tenant export covers agent runs | `server/maintenance.mjs` | existing recovery tests pass |
| Live check script | `deploy/agents-live.mjs` | 2026-11-14, local server, real model: R25 (structured workflow, read a source page, cited an exact quotation, submitted) and R01 (written assignment) both reached "submitted"; self-approval and other-firm access refused |

Full suite: 131 tests pass. Not yet done: a live run on the Railway staging service (it has no model connected), and live runs of the other 63 agents.

### To turn agents on in a deployment

Set three variables on the service, pointing at any chat-completions endpoint that supports tool calls:

- `BRIEFCASE_MODEL_URL` — for example `https://openrouter.ai/api/v1/chat/completions`
- `BRIEFCASE_MODEL_NAME` — for example `anthropic/claude-sonnet-5.5`
- `BRIEFCASE_MODEL_KEY` — the provider key (a secret; never in Git)

The same model is also used to draft chronology candidates on PDF import, as before. Matter text is sent to that provider, so choose one the firm has approved.

## 5. Phases

Status: ☐ not started · ◐ in progress · ☑ done.

### Phase 1 — A skill and an evaluation for every agent ☐

The agents share one generic instruction set plus the workflow description. Each needs its own written know-how and a repeatable test of whether it does the job.

- [ ] Write `server/agents/skills/Rxx.md` for the 64 remaining roles: the steps a competent person in the role follows, what to check, when to ask. One exists (R21).
- [ ] Build an evaluation fixture per role: a synthetic matter, a brief, and the acceptance check from the catalog expressed as assertions on the submitted version.
- [ ] Add `deploy/agents-eval.mjs` that runs every agent on its fixture against the real model and reports pass, fail, turns and cost.
- [ ] Add adversarial fixtures: a document containing instructions, a brief that asks for an unsupported claim, a missing required input.

**Check:** 65 of 65 agents reach "submitted" on their fixture with the catalog acceptance check satisfied, on two consecutive runs; no adversarial fixture produces an unsupported quotation or an out-of-scope action. Record the run report in the repo.

### Phase 2 — Role tools for the 21 written-assignment agents ☐

R01, R02, R04–R16, R18, R19, R47, R55, R57 and R64 have real features in Firm desk, Client development, Risk and intake, and Identity, but their agents cannot use them yet.

- [ ] Describe each of those modules' operations the way workflows are described (fields and actions), so tools can be generated the same way.
- [ ] Give each of the 21 agents the operations of its role, with the same split: preparer actions for the agent, decision actions for people.
- [ ] Keep the written assignment as the fallback when a task does not fit an operation.

**Check:** each of the 21 agents completes its catalog scenario through its own module's records (for example R14 surfaces the alias and parent/subsidiary matches with reasons and no screened content), verified by test and by one live run each.

### Phase 3 — Routines and background work ☐

Today a person starts every run, and runs live inside the web process.

- [ ] Move runs to a durable job worker with leases and retry, so a restart resumes instead of interrupting.
- [ ] Routines: start an agent on a schedule, when a document is imported, when work is assigned to a person who has opted in, or when a reviewer returns work.
- [ ] Per-firm controls for which routines are on, and a run history per routine.
- [ ] Notifications when an agent asks a question or submits.

**Check:** a run survives a redeploy mid-step with no duplicate or partial record; a returned item triggers a revision run without anyone starting it; turning a routine off stops it at once.

### Phase 4 — Agents working together ☐

Real work crosses roles: intake → conflicts → matter opening; paralegal packet → associate motion → e-filing.

- [ ] Handoffs: an approved output from one agent becomes the input of the next role's assignment, with the source version pinned.
- [ ] Playbooks: named chains for the main flows (personal injury intake to demand; closing; month-end close), each step still reviewed where the role requires it.
- [ ] A board showing every open assignment by role and stage, and where each is waiting on a person.

**Check:** the personal injury playbook runs from a synthetic intake to an approved demand with every handoff citing the exact approved version it consumed, and a screened user sees none of it.

### Phase 5 — Real connections and receipts ☐

43 roles end outside Briefcase. Until a provider is connected, a person does that step and records the receipt.

- [ ] Choose one provider per category for the pilot firm: mailbox and calendar, e-signature, identity verification (R17), e-filing (R30), accounting ledger (R48–R54), document storage.
- [ ] Add each as a tool that runs **only after lawyer approval of the exact document and destination**, and that stores the provider's own receipt.
- [ ] Handle rejection, outage and replay for each.

**Check:** for each connected provider, a normal case, a rejection and an outage are exercised against the provider's test environment and the stored receipt matches the provider's record. Roles without a connected provider stay marked "receipt by a person".

### Phase 6 — Briefcase as an MCP server ☐

- [ ] Expose the agent tools over MCP with per-user sign-in, so Rakazo, OpenMausBot or a desktop assistant can start and steer Briefcase agents.
- [ ] Every MCP call goes through the same permission checks; approval stays in Briefcase.

**Check:** from a Rakazo bot, start an R26 run on a matter, answer its question, and see it submitted — while an account without matter access is refused through the same connection.

### Phase 7 — Product controls for a paid service ☐

Builds on sections 2 and 3 of [the Railway handoff](RAILWAY_HANDOFF.md).

- [ ] Per-firm model connection and approved-provider setting; firm-level switch for agents and per-role switches.
- [ ] Usage metering per firm, agent and run; budgets that stop runs; plan entitlements for agent use.
- [ ] Retention for run transcripts, included in holds, exports and deletion.
- [ ] Redacted operational logs and alerts for stuck or failing runs.

**Check:** a firm over budget cannot start a run by any route; a firm's export contains its run transcripts and no other firm's; a hold preserves them.

### Phase 8 — Acceptance and the scorecard ☐

- [ ] For each of R01–R65, record a normal case, an exception, a denied-access case and a verified output, done by the agent and reviewed by a person, on the hosted service.
- [ ] Practitioner review: a lawyer or the role's real holder rates the agent's output for each role.
- [ ] Publish the five-dimension scorecard (Task, Inputs, Output, Handoff, Access) per role with the evidence for each score.

**Check:** every claimed 2 links to current hosted evidence. Roles blocked on an unconnected provider are scored as they are, not rounded up.

## 6. How we work each ticket

1. `to-spec` — turn the phase task into a short spec with its acceptance check.
2. `to-tickets` — split it into tickets small enough to finish in one sitting.
3. `tdd` — write the failing test first (scripted model for logic, live model for behaviour), then the code.
4. `code-review` — review the diff before it merges.
5. Update this file's status and add the evidence.

Shared vocabulary (keep these meanings fixed): **agent** = one role's AI preparer; **run** = one agent working one assignment; **supervisor** = the person who started the run; **reviewer** = the lawyer who approves; **skill** = the role's written know-how; **routine** = something that starts runs without a person.

## 7. Decisions needed from you

1. **Model provider for staging and production.** Which provider and model may receive matter text? Nothing runs on Railway until this is set.
2. **Who may start agents.** Today: any lawyer, a specialist granted the role, or anyone on work already assigned to them. Should firms be able to restrict this further?
3. **First playbook for Phase 4.** Recommended: personal injury intake to demand, since those workflows are the most complete.
4. **First providers for Phase 5.** Recommended order: mailbox, e-signature, identity verification.
5. **Order of phases.** Recommended: 1, 2, 3, then 5 and 4 in parallel, then 7, 6, 8. Phase 1 comes first because it tells us how good each agent actually is.

## 8. The 65 agents today

"Role tools today" lists the tools an agent has beyond the shared ones (read matter documents, read and start the work record, submit, ask the supervisor, finish). "Receipt by a person" marks roles whose last step happens outside Briefcase.

| Agent | Role | Team | Works through | Role tools today | Receipt by a person |
|---|---|---|---|---|---|
| R01 | Managing partner / firm chair | Firm leadership | Written assignment | — | No |
| R02 | Equity partner / shareholder | Firm leadership | Written assignment | — | Yes |
| R03 | Non-equity partner | Firm leadership | Partner draft supervision | `revise-draft` | No |
| R04 | Practice group leader / chair | Firm leadership | Written assignment | — | No |
| R05 | Chief operating officer / executive director | Firm leadership | Written assignment | — | Yes |
| R06 | Office administrator / office manager | Firm leadership | Written assignment | — | Yes |
| R07 | Business development manager | Client development | Written assignment | — | Yes |
| R08 | Marketing and communications manager | Client development | Written assignment | — | Yes |
| R09 | Client relationship manager | Client development | Written assignment | — | Yes |
| R10 | Firm general counsel | Risk and intake | Written assignment | — | No |
| R11 | Professional responsibility counsel | Risk and intake | Written assignment | — | No |
| R12 | Receptionist / front desk coordinator | Risk and intake | Written assignment | — | Yes |
| R13 | Legal intake specialist | Risk and intake | Written assignment | — | Yes |
| R14 | Conflicts analyst | Risk and intake | Written assignment | — | No |
| R15 | Conflicts attorney | Risk and intake | Written assignment | — | No |
| R16 | Business intake / matter opening specialist | Risk and intake | Written assignment | — | Yes |
| R17 | Client due diligence analyst (AML/KYC) | Risk and intake | Client identity verification | `provider-response`, `escalate` | Yes |
| R18 | Matter lead / responsible attorney | Lawyers and trainees | Written assignment | — | Yes |
| R19 | Counsel / of counsel | Lawyers and trainees | Written assignment | — | No |
| R20 | Senior associate | Lawyers and trainees | Deposition and exhibit review | `revise-outline` | No |
| R21 | Litigation associate | Lawyers and trainees | Motion authority review | `revise-motion` | Yes |
| R22 | Transactional associate | Lawyers and trainees | Transaction conditions and signed binder | `amend-condition`, `replace-document` | No |
| R23 | Staff attorney | Lawyers and trainees | Independent research memos | `add-memo`, `revise-memo` | No |
| R24 | Document review attorney | Lawyers and trainees | Privilege and production review | `add-document` | Yes |
| R25 | Law clerk / summer associate | Lawyers and trainees | Supervised clerk research | `revise-draft` | Yes |
| R26 | Litigation paralegal | Legal support | Litigation packet builder | `replace-exhibits` | No |
| R27 | Corporate paralegal | Legal support | Executed closing binder | `add-requirement` | Yes |
| R28 | Legal administrative assistant / legal secretary | Legal support | Correspondence and date handoff | `revise-draft`, `record-delivery` | Yes |
| R29 | Litigation docketing specialist | Legal support | Reviewed docket amendments | `amend` | Yes |
| R30 | Court services / e-filing specialist | Legal support | Filing attempts and service | `revise-packet`, `record-attempt`, `record-service` | Yes |
| R31 | E-discovery / litigation support specialist | Legal support | Discovery ingestion and production | `import-record` | Yes |
| R32 | Trial technology specialist | Legal support | Offline trial presentation | `replace-exhibits`, `add-clip` | No |
| R33 | Legal project manager | Practice operations | Scope and spending control | `cost`, `propose` | Yes |
| R34 | Practice manager / practice operations manager | Practice operations | Practice work routing | `refresh-queue`, `reassign` | No |
| R35 | Knowledge management attorney | Practice operations | Governed template editions | `edit-template`, `draft` | No |
| R36 | Research librarian / research analyst | Practice operations | Authority and treatment register | `authority`, `treatment` | Yes |
| R37 | Legal technology / automation specialist | Practice operations | Tested automation releases | `candidate`, `run-fixtures` | No |
| R38 | Pro bono counsel | Practice operations | Pro bono referral and acceptance | `update-referral` | Yes |
| R39 | Patent agent | Practice specialists | Patent claim amendments | `amend-claim` | Yes |
| R40 | Intellectual property docketing specialist | Practice specialists | Agency notice and deadline review | `record-notice` | Yes |
| R41 | Immigration paralegal | Practice specialists | Petition evidence packet | `set-requirements`, `attach-evidence`, `remove-evidence` | Yes |
| R42 | Trusts and estates paralegal | Practice specialists | Estate distribution reconciliation | `record-asset`, `record-expense`, `set-distributions` | Yes |
| R43 | Real estate paralegal / closing coordinator | Practice specialists | Closing conditions and signed binder | `revise-requirements`, `record-condition`, `record-document` | Yes |
| R44 | Personal injury case manager | Practice specialists | Provider receipt matching | `receive-attachment` | Yes |
| R45 | Settlement specialist | Practice specialists | Settlement statement reconciliation | `record-receipt`, `record-payee`, `record-lien`, `set-allocations` | Yes |
| R46 | In-house legal investigator | Practice specialists | Source-linked witness statements | `record-statement` | No |
| R47 | Pricing analyst / pricing manager | Finance | Written assignment | — | Yes |
| R48 | Chief financial officer | Finance | Operating and trust financial reporting | `import-entries`, `import-statement`, `reverse-entry`, `correct-entry`, `record-exception` | Yes |
| R49 | Controller / accounting manager | Finance | Controller reconciliation and corrections | `import-entries`, `import-statement`, `reverse-entry`, `correct-entry`, `record-exception` | Yes |
| R50 | Accounts payable specialist | Finance | Vendor invoices and payment evidence | `import-invoice`, `record-payment` | Yes |
| R51 | Law firm bookkeeper | Finance | Bookkeeping imports and reversals | `import-entries`, `import-statement`, `reverse-entry`, `correct-entry`, `record-exception` | Yes |
| R52 | Billing / e-billing specialist | Finance | E-billing corrections and submission history | `record-submission`, `record-result`, `correct-invoice` | Yes |
| R53 | Collections / accounts receivable specialist | Finance | Receivables, partial payments and write-offs | `add-invoice`, `allocate-payment`, `request-writeoff`, `cancel-writeoff` | Yes |
| R54 | Trust accounting specialist | Finance | Trust receipts, returns and reconciliation | `import-entries`, `import-statement`, `reverse-entry`, `correct-entry`, `record-exception`, `return-payment` | Yes |
| R55 | Human resources generalist / HR manager | People | Written assignment | — | Yes |
| R56 | Attorney recruiting coordinator | People | Restricted lateral conflicts clearance | `replace-names` | Yes |
| R57 | Attorney professional development manager | People | Written assignment | — | Yes |
| R58 | Payroll specialist | People | Payroll close status handoff | `record-status` | Yes |
| R59 | Chief information officer / IT director | Technology and records | Tenant recovery and integration review | `capture`, `restore-result` | No |
| R60 | IT support specialist / help desk | Technology and records | Import support and retry coordination | `refresh-job`, `request-retry`, `confirm-retry` | No |
| R61 | Information security analyst | Technology and records | Access revocation verification | `capture-evidence`, `verify-revocation` | No |
| R62 | Document management systems engineer | Technology and records | Document source synchronization | `import-source`, `search`, `reconcile` | Yes |
| R63 | Information governance / records manager | Technology and records | Retention holds and disposition | `schedule`, `hold`, `run-schedule`, `record-disposition` | No |
| R64 | Facilities / office services coordinator | Office services | Written assignment | — | Yes |
| R65 | Document production specialist / word processor | Office services | Document production and comparison | `edit-document`, `import-docx` | No |
