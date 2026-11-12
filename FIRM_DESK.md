# Firm desk · leadership and operations

Open **Firm desk** in the authenticated workspace. Choose a reporting month. Firm desk uses account-level role grants and office/practice scopes. The same matter grants and owner-managed screens apply to source rows and reviewer staffing. Set screens under **Matter team**. Removing a screen leaves the former grant revoked until the owner issues a new grant.

## Account setup

Add optional fields to accounts in `BRIEFCASE_USERS_JSON` or `BRIEFCASE_USERS_FILE`:

| Field | Example |
|---|---|
| `desk` | `["R01","R04"]` |
| `office` and `offices` | `"east"` and `["east","west"]` |
| `practiceGroup` and `practices` | `"injury"` and `["injury","general"]` |

Configure a primary office and practice in each scope list. Existing accounts default to `main` and `general` with no leadership grants. Office and practice grouping follow the configured matter owner's primary office and practice. Role grants are independent of regular lawyer and preparer permissions. An owner grants a chair reviewer access for financial reporting or referral approval and explicitly delegates staffing to an authorized practice leader. Office delegates and assigned trainees can act without a desk grant.

## Scenario coverage

| Role | Workflow and verification |
|---|---|
| R01 Managing partner | Matter owners record monthly USD budget and revenue in integer cents with a ledger reference. The chair opens a two-office pack, reviews reconciled totals and source rows, then records a decision tied to a report hash. Screened and otherwise inaccessible matters are excluded from both the export and the totals. An archived decision retains aggregate figures, actor, time, and the original report hash. Open overdue work is evaluated as of the report run against the selected period cutoff. |
| R02 Equity partner | Record a unique referral with proposed fees and costs, open its prospective matter once, and complete normal conflict and engagement steps. A different reviewing chair approves attribution, fees, and costs against the exact recorded engagement. The originating partner can export their approved monthly credits and visible ownership ledger. |
| R04 Practice group leader | Set monthly hours, inspect load and gaps, and reassign an owner-delegated reviewer slot. The new reviewer sees the matter and the previous staffing grant is revoked. Existing independently managed grants require owner reconciliation. Matter ownership and owner approvals stay with the custodian. |
| R05 COO | Start intake tracking with an SLA due date. Referral intake starts automatically. PDF processing records start, completion, or failure with a correlation ID and safe error summary. The operating review includes late intake, failed or stalled imports, training assignments and completion, and dated follow-up notes. |
| R06 Office administrator | Route renewals, book rooms, or arrange staff coverage. The internal schedule rejects conflicting room and coverage slots. An office delegate receives temporary access to the task, acknowledges it, and submits evidence for administrator verification. Cancellation removes delegate access. |

These workflows use structured ledger entries and an internal office schedule. External accounting, shared calendar sync, Railway browser verification, and production identity setup remain deployment work. The acceptance tests use synthetic records and run through authenticated HTTP.

Run `npm test` to exercise the five scenarios with the rest of the suite.
