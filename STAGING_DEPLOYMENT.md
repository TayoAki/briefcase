# Staging deployment record · v0.8

Recorded 2026-11-12. Synthetic data only. This is the "controlled hosted pilot" milestone from [the Railway handoff](RAILWAY_HANDOFF.md); it is not the paid multi-firm release.

| Item | Value |
|---|---|
| Source | `Briefcase_Solo_v0.8.zip`, package version 0.8.0, imported as commit `ae12137` |
| Railway project / environment | `briefcase` / `staging` |
| Service | `briefcase-web`, built from the root Dockerfile, one replica, region `sfo` |
| URL | https://briefcase-web-staging.up.railway.app |
| Volume | `briefcase-data` mounted at `/data` |
| Health check | `/health`, 120 s timeout |
| Variables (names only) | `PORT`, `BRIEFCASE_DB`, `BRIEFCASE_ORIGIN`, `BRIEFCASE_RAILWAY_HEALTH`, `BRIEFCASE_USERS_JSON` |
| Accounts | Two synthetic firms: owner, preparer, reviewer and unrelated user in `firm-a`; owner and preparer in `firm-b` |
| Off | Model endpoint, Paperless, client portal, records scheduler cron |

The service follows the branch `claude/gifted-euler-hcr6ml`; every push redeploys it.

## Results

- Local suite: 125 passed, 0 failed on Node 24 and Node 22, with Poppler and Tesseract installed. Without Tesseract five OCR-dependent tests fail.
- `deploy/hosted-smoke.mjs` first run: 28 passed, 0 failed. Covers health, 401 without credentials, server-mode bootstrap for all six accounts, cross-origin and missing-header write refusal, matter creation, corrupt PDF rejection, concurrent duplicate import, hosted OCR of a scanned page, original hash, same-firm and cross-firm denial on read/download/upload/export, fabricated-quote rejection, stale-revision refusal, exact-revision approval and export.
- Same script after a real redeploy (deployment `153ba667` → `f1b83eac`): 15 passed, 0 failed. The matter, original bytes (same SHA-256), approved export and cross-firm denial all survived.
- `deploy/hosted-roles.mjs`: 65 of 65 role templates completed assign → submit → independent review → proof on staging, each with outsider and other-firm denial and preparer self-approval refused. 22 are native; 43 require a provider receipt and were completed with a **synthetic, typed-in receipt**.

## Not done here

- No backup schedule, restore rehearsal, uptime monitoring or alerting.
- Browser walkthrough of the UI, including the Specialist workflows screen and Firm desk.
- The 44 specialist business workflows were not rerun on staging; their evidence is still the local suite.
- R17 live identity provider, R32 offline playback, R59 hosted recovery signoff, R60 hosted support rehearsal, R61 real-provider revocation, R63 deployed cron and connector, R65 Word/PDF rendering.
- Sections 2 and 3 of the handoff: Postgres/object storage, firm onboarding, sessions/MFA, Stripe billing and paywall.

## Rerun

```bash
node deploy/hosted-smoke.mjs https://briefcase-web-staging.up.railway.app users.json state.json
```

```bash
node deploy/hosted-roles.mjs https://briefcase-web-staging.up.railway.app users.json report.json
```

`users.json` is the same array stored in `BRIEFCASE_USERS_JSON`. Keep it out of Git.
