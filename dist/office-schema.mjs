const field = (key, label, type = 'text', required = false, options = []) => ({ key, label, type, required, options });
const text = (key, label, required = true) => field(key, label, 'text', required);
const note = (key, label, required = false) => field(key, label, 'note', required);
const date = (key, label, required = true) => field(key, label, 'date', required);
const time = (key, label, required = false) => field(key, label, 'time', required);
const money = (key, label, required = true) => field(key, label, 'money', required);
const pick = (key, label, options) => field(key, label, 'select', true, options.split('|'));
const ref = (key, label, type, required = true) => field(key, label, 'ref', required, type.split('|'));
const source = (label = 'Original PDF page', required = false) => field('source', label, 'source', required);
const web = (key, label, required = false) => field(key, label, 'url', required);
const list = (key, label, type, required = true) => field(key, label, 'list', required, [type]);
const approval = (label, type, required = true) => field(type, label, 'approval', required, [type]);
const section = (id, name, icon, summary, collections) => ({ id, name, icon, summary, collections });
const entry = (label, plural, summary, fields, status = '', review = '') => ({
  label, plural, summary, fields, status: status ? status.split('|') : [], review: review ? review.split('|') : [],
});

export const officeSections = [
  section('negotiation', 'Negotiation', 'History', 'Track delivery, exact offer terms, client authority, and settlement obligations.', [
    'delivery', 'offer', 'authority', 'agreement', 'obligation',
  ]),
  section('casework', 'Investigation & coverage', 'Search', 'Connect facts, sources, providers and insurers to the matter.', [
    'screening', 'caseplan', 'incident', 'witness', 'evidence', 'preservation', 'claim', 'coverage', 'provider', 'representative',
  ]),
  section('money', 'Damages & funds', 'FileCheck2', 'Review damages and liens, track external payments and reconcile them against approved figures.', [
    'damage', 'casecost', 'lien', 'receipt', 'allocation', 'disbursement', 'reconciliation', 'invoice',
  ]),
  section('communications', 'Client & correspondence', 'FileUp', 'Manage client submissions, correspondence, sharing and signature records.', [
    'correspondence', 'clienttask', 'signature', 'filehandoff', 'referral', 'feedback',
  ]),
  section('court', 'Litigation', 'CalendarClock', 'Keep the lawsuit, docket, deadlines, discovery and hearing work on the same matter.', [
    'courtcase', 'pleading', 'notice', 'rule', 'deadline', 'filing', 'service', 'discovery', 'production', 'deposition', 'expert',
    'authoritysource', 'motion', 'hearing', 'judgment', 'appeal', 'enforcement',
  ]),
  section('operations', 'Practice operations', 'ShieldCheck', 'Maintain templates, retention, vendors, evaluations and continuity for this matter.', [
    'hold', 'retention', 'template', 'vendor', 'risk', 'continuity', 'evaluation',
  ]),
  section('expansion', 'Practice packs', 'Layers3', 'Configure specialty work and delegated tasks after reviewing the applicable procedures.', ['specialty', 'delegation']),
];

export const collections = {
  delivery: entry('Demand delivery', 'Demand deliveries', 'Record attempts against an approved demand version.', [
    approval('Approved demand', 'demand'), text('recipient', 'Recipient'), pick('channel', 'Channel', 'Email|Mail|Portal|Other'),
    date('date', 'Attempt date'), date('followUp', 'Response follow-up', false), source('Delivery receipt page'), note('details', 'Attempt and receipt details'),
  ], 'Sent|Confirmed|Failed', 'Confirmed'),
  offer: entry('Offer', 'Offers and counteroffers', 'Keep every revision of a party’s terms.', [
    text('payer', 'Payer or proposing party'), pick('direction', 'Direction', 'Incoming offer|Outgoing counteroffer'),
    money('amount', 'Gross offer'), time('received', 'Received or made at', true), time('expires', 'Expires at'),
    ref('claim', 'Insurance claim', 'claim', false), ref('prior', 'Responds to', 'offer', false),
    note('terms', 'Payment conditions and other terms', true), source('Offer correspondence page'),
  ], 'Open|Withdrawn|Rejected|Impasse'),
  authority: entry('Client decision', 'Client instructions and authority', 'Pin instructions to the exact offer revision the client reviewed.', [
    ref('offer', 'Offer revision', 'offer'), text('person', 'Client or representative'), text('capacity', 'Capacity or authority'),
    ref('representative', 'Recorded representative authority', 'representative', false),
    pick('decision', 'Client instruction', 'Accept exact terms|Reject|Counter|Discuss'), time('recorded', 'Instruction recorded at', true),
    note('advice', 'Advice and decision record', true), note('conditions', 'Conditions on authority'), source('Written confirmation page'),
  ], 'Recorded|Revoked', 'Recorded|Revoked'),
  agreement: entry('Agreement', 'Settlement agreements', 'Compare the release to the accepted terms, then record the executed original.', [
    ref('offer', 'Accepted offer', 'offer'), money('amount', 'Agreed amount'), text('signers', 'Signers'),
    date('executed', 'Execution date', false), source('Exact release page', true), note('terms', 'Reviewed release and payment terms', true),
  ], 'Draft|Reviewed|Executed|Superseded', 'Reviewed|Executed'),
  obligation: entry('Obligation', 'Settlement obligations', 'Follow through on settlement documents and payments.', [
    ref('agreement', 'Agreement', 'agreement'), text('party', 'Responsible party'), pick('kind', 'Obligation type', 'Payment|Document|Other'),
    money('amount', 'Expected amount', false), date('due', 'Due date'), source('Completion proof page'),
    note('details', 'What is due or how it was resolved', true),
  ], 'Open|Partial|Complete|Waived', 'Complete|Waived'),
  screening: entry('Intake review', 'Intake review and scope', 'Capture referral source, aliases and an explained decision alongside the original intake.', [
    pick('channel', 'Inquiry channel', 'Phone|Form|Email|Referral|Other'), text('contact', 'Contact or inquiry source'),
    note('aliases', 'Aliases and related parties'), note('scope', 'Proposed scope, fee terms and budget', true),
    date('followUp', 'Follow-up date', false), source('Signed terms or decision page'),
  ], 'Triage|Review|Accepted|Declined|Referred', 'Accepted|Declined|Referred'),
  caseplan: entry('Case milestone', 'Case plan', 'Connect phases and next actions to a named owner and source.', [
    text('phase', 'Phase or milestone'), text('owner', 'Owner'), ref('after', 'Prerequisite milestone', 'caseplan', false),
    date('due', 'Due date', false), note('next', 'Next action', true), source(),
  ], 'Planned|Active|Done|Cancelled', 'Done|Cancelled'),
  incident: entry('Fact or account', 'Incident facts and issues', 'Retain competing accounts and link each one to its evidence.', [
    date('date', 'Incident date', false), text('location', 'Location', false), text('assertedBy', 'Who gave this account'),
    note('account', 'Fact or disputed account', true), ref('contrary', 'Contrary evidence or account', 'evidence|incident', false), source(),
  ], 'Unverified|Disputed|Reviewed', 'Reviewed'),
  witness: entry('Witness', 'Witnesses and interviews', 'Record contact permissions, availability and interview notes.', [
    text('name', 'Witness name'), text('contact', 'Contact details', false), text('role', 'Relationship or role'),
    pick('contactPermission', 'Contact preference', 'Unknown|Approved|Restricted'),
    date('date', 'Interview date', false), note('account', 'Interview or availability notes'), source(),
  ], 'Identified|Scheduled|Interviewed|Unavailable'),
  evidence: entry('Evidence item', 'Evidence register', 'Index original evidence, provenance and the issue it supports.', [
    pick('kind', 'Type', 'Incident report|Photo or video|Witness statement|Correspondence|Medical|Other'),
    text('custodian', 'Source or custodian'), date('collected', 'Collected date'),
    ref('issue', 'Fact or issue', 'incident', false), source('Original PDF or indexed reference page'),
    text('location', 'External evidence identifier or location', false), note('provenance', 'Transfer and integrity notes', true),
  ], 'Requested|Received|Reviewed|Restricted', 'Reviewed|Restricted'),
  preservation: entry('Preservation request', 'Preservation and evidence requests', 'Track sends, receipts and missing material.', [
    text('recipient', 'Recipient or custodian'), date('sent', 'Sent date', false),
    date('followUp', 'Follow-up date'), ref('evidence', 'Related evidence', 'evidence', false),
    note('scope', 'Preservation or collection scope', true), source('Request or response page'),
  ], 'Draft|Sent|Partial|Complete|Cancelled', 'Complete|Cancelled'),
  claim: entry('Insurance claim', 'Insurance claims', 'Keep carriers, adjusters and policies distinct across payers.', [
    text('carrier', 'Carrier'), text('number', 'Claim number'), text('policy', 'Policy identifier', false),
    text('adjuster', 'Adjuster or contact', false), text('insured', 'Insured or party', false),
    date('from', 'Policy start', false), date('to', 'Policy end', false), source(), note('details', 'Claim notes'),
  ], 'Open|Disputed|Closed', 'Closed'),
  coverage: entry('Coverage issue', 'Coverage verification', 'Separate asserted limits, verified terms and disputed correspondence.', [
    ref('claim', 'Claim', 'claim'), text('type', 'Coverage type'), money('limit', 'Asserted or verified limit', false),
    date('date', 'Source or verification date'), source('Coverage source page', true), note('issue', 'Conditions, exclusions or dispute', true),
  ], 'Asserted|Verified|Disputed|Denied', 'Verified|Denied'),
  provider: entry('Provider coverage', 'Provider windows and authorizations', 'Track the exact service dates and coverage still missing.', [
    text('provider', 'Provider'), date('from', 'Service start'), date('to', 'Service end', false),
    date('authorizationExpires', 'Authorization expires', false), date('followUp', 'Next follow-up', false),
    note('scope', 'Authorization scope and missing dates or items', true), source('Authorization or response page'),
  ], 'Open|Partial|Complete|Expired', 'Complete'),
  representative: entry('Representative', 'Capacity and representatives', 'Record who may act and the precise limits of that authority.', [
    text('person', 'Representative'), text('client', 'Person represented'), text('capacity', 'Capacity'), date('from', 'Effective date'),
    date('to', 'Expires', false), note('scope', 'Scope and limits', true), source('Authority evidence page', true),
  ], 'Pending|Verified|Revoked', 'Verified|Revoked'),
  damage: entry('Damage item', 'Damages schedule', 'Source-link medical bills, wages, expenses and other asserted losses.', [
    pick('kind', 'Type', 'Medical bill|Lost wage|Out-of-pocket expense|Other'), text('party', 'Provider or payee'),
    date('from', 'Service or loss start'), date('to', 'Service or loss end', false), money('amount', 'Claimed amount'),
    money('paid', 'Documented payment', false), source('Amount source page', true), note('basis', 'Calculation or overlap notes'),
  ], 'Asserted|Reviewed|Excluded', 'Reviewed|Excluded'),
  casecost: entry('Case cost', 'Case costs and advances', 'Track paid costs and reimbursability using accounting references.', [
    text('payee', 'Payee'), text('reference', 'Accounting or invoice reference'), date('date', 'Date'),
    money('amount', 'Amount'), pick('reimbursable', 'Reimbursable', 'Review|Yes|No'), source(), note('details', 'Cost and correction notes'),
  ], 'Incurred|Paid|Reimbursed|Voided', 'Reimbursed|Voided'),
  lien: entry('Lien', 'Liens and reimbursement claims', 'Keep original assertions, revised amounts and payoff evidence.', [
    text('claimant', 'Claimant'), money('asserted', 'Originally asserted amount'), money('resolved', 'Resolved or payoff amount', false),
    date('due', 'Payoff or follow-up date', false), source('Claim or payoff page'), note('details', 'Dispute, negotiated terms or payoff notes', true),
  ], 'Asserted|Disputed|Negotiated|Resolved|Paid', 'Resolved|Paid'),
  receipt: entry('External receipt', 'Receipts from accounting', 'Record actual receipts and bank or accounting identifiers.', [
    text('payer', 'Payer'), text('externalId', 'External transaction ID'), date('date', 'Transaction date'),
    money('amount', 'Amount'), ref('obligation', 'Payment obligation', 'obligation', false), source(), note('details', 'Clearing or reversal notes'),
  ], 'Pending|Cleared|Reversed', 'Cleared|Reversed'),
  allocation: entry('Allocation', 'Payee allocations', 'Review intended amounts against the approved statement and cleared receipts.', [
    approval('Approved settlement statement', 'settlement'), text('payee', 'Payee'),
    pick('kind', 'Allocation type', 'Client net|Attorney fee|Cost reimbursement|Lien|Other'),
    money('amount', 'Allocation amount'), ref('lien', 'Linked lien', 'lien', false), source(), note('basis', 'Payee verification and basis', true),
  ], 'Draft|Approved|Voided', 'Approved|Voided'),
  disbursement: entry('External disbursement', 'Disbursements from accounting', 'Record settled or returned external transactions against an allocation.', [
    ref('allocation', 'Approved allocation', 'allocation'), text('externalId', 'External transaction ID'), date('date', 'Transaction date'),
    money('amount', 'Amount'), source(), note('details', 'Accounting evidence or correction'),
  ], 'Pending|Cleared|Returned|Voided', 'Cleared|Returned|Voided'),
  reconciliation: entry('Reconciliation', 'Reconciliation signoffs', 'Match actual external cleared balance and retain difference evidence.', [
    date('date', 'Statement date'), money('balance', 'Accounting cleared balance'),
    text('reference', 'External statement reference'), source(), note('details', 'Reconciliation notes', true),
  ], 'Draft|Reviewed', 'Reviewed'),
  invoice: entry('Invoice or fee record', 'Fees, invoices and collections', 'Capture agreed billing terms and amounts from the accounting source.', [
    text('reference', 'Invoice or fee reference'), pick('kind', 'Fee model', 'Contingency|Hourly|Flat fee|Other'),
    money('amount', 'Approved billed amount'), money('received', 'Received amount', false),
    date('due', 'Collection follow-up', false), source(), note('terms', 'Terms, time record or budget notes', true),
  ], 'Draft|Issued|Partial|Paid|Credited', 'Issued|Paid|Credited'),
  correspondence: entry('Correspondence', 'Matter correspondence', 'Review recipient, message and exact approved attachments. Record delivery separately.', [
    pick('direction', 'Direction', 'Incoming|Outgoing'), text('contact', 'Sender or recipient'),
    pick('channel', 'Channel', 'Email|Phone|Mail|Portal|Other'), date('date', 'Message date'),
    note('body', 'Message or call record', true), source('Attached original page'), text('receipt', 'Delivery or message identifier', false),
  ], 'Draft|Received|Approved|Sent|Failed', 'Approved|Sent'),
  clienttask: entry('Client task', 'Client requests and submissions', 'Track who owes an item and keep incoming evidence in review.', [
    text('person', 'Client or representative'), pick('kind', 'Request type', 'Questionnaire|Document|Decision|Other'),
    date('due', 'Due or follow-up date'), note('details', 'Requested item and outcome', true), source('Submitted original page'),
  ], 'Draft|Requested|Received|Reviewed|Closed', 'Reviewed|Closed'),
  signature: entry('Signature request', 'Signature and execution records', 'Pin the signature request to the exact original and record proof.', [
    text('signer', 'Signer'), date('requested', 'Requested date', false), date('signed', 'Signed date', false),
    text('externalId', 'Provider envelope ID', false), source('Approved or signed PDF page', true), note('details', 'Signing or completion evidence', true),
  ], 'Draft|Approved|Requested|Signed|Voided', 'Approved|Signed|Voided'),
  filehandoff: entry('File handoff', 'File return and transfers', 'Record exact files, recipient, delivery and confirmation.', [
    text('recipient', 'Recipient'), pick('kind', 'Transfer type', 'Client return|Co-counsel|Referral|Archive'),
    date('date', 'Prepared or delivered date'), source('Receipt or transfer evidence page'),
    note('scope', 'Selected files, version and delivery details', true),
  ], 'Draft|Approved|Delivered|Acknowledged', 'Approved|Delivered'),
  referral: entry('Referral', 'Referrals and follow-ups', 'Track referral source, permission and outcome.', [
    text('contact', 'Referrer or destination'), pick('direction', 'Direction', 'Inbound|Outbound'),
    date('date', 'Referral date'), date('followUp', 'Follow-up date', false), note('details', 'Permission, scope and outcome', true),
  ], 'Open|Contacted|Engaged|Declined|Transferred', 'Engaged|Declined|Transferred'),
  feedback: entry('Feedback or consent', 'Feedback and marketing consent', 'Pin permission and scope for approved client feedback or content.', [
    text('contact', 'Contact or source'), date('date', 'Recorded date'), note('scope', 'Feedback, permitted use and limits', true),
    source('Permission evidence page'),
  ], 'Received|Permission pending|Approved|Revoked', 'Approved|Revoked'),
  courtcase: entry('Court case', 'Court case and issues', 'Branch from this matter and record forum, parties and case identifiers.', [
    text('forum', 'Court and jurisdiction'), text('number', 'Case number', false),
    date('opened', 'Opened date'), ref('offer', 'Related offer or impasse', 'offer', false),
    note('issues', 'Claims, defenses and unresolved issues', true), source(),
  ], 'Preparing|Filed|Stayed|Resolved', 'Filed|Resolved'),
  pleading: entry('Pleading', 'Pleadings and amendments', 'Track exact approved drafts and references before filing.', [
    ref('case', 'Court case', 'courtcase'), pick('kind', 'Type', 'Complaint|Answer|Amendment|Other'),
    ref('prior', 'Prior pleading', 'pleading', false), source('Exact draft page', true), note('issues', 'Issues, exhibits and signature checks', true),
  ], 'Draft|Approved|Superseded', 'Approved|Superseded'),
  notice: entry('Court notice', 'Docket notices and orders', 'Record original notices, trigger dates and possible order overrides.', [
    ref('case', 'Court case', 'courtcase'), text('number', 'Docket entry ID', false), date('received', 'Received date'),
    date('trigger', 'Trigger date'), source('Original order page', true), note('details', 'Order terms and any date override', true),
  ], 'Received|Reviewed|Superseded', 'Reviewed|Superseded'),
  rule: entry('Deadline rule', 'Reviewed deadline inputs', 'Use sourced, reviewed inputs for a candidate date.', [
    text('forum', 'Forum'), web('citation', 'Authoritative rule URL', true), text('version', 'Rule version or effective date'),
    pick('method', 'Counting method', 'Calendar days|Business days'), text('offset', 'Whole days after trigger'),
    pick('roll', 'Non-working end date', 'Keep calculated date|Move to next working day'),
    note('holidays', 'Excluded dates in YYYY-MM-DD, one per line'), note('exceptions', 'Applicability and exceptions', true),
  ], 'Draft|Reviewed|Retired', 'Reviewed|Retired'),
  deadline: entry('Court deadline', 'Candidate and confirmed court deadlines', 'Compare calculated, court-ordered and lawyer-confirmed dates.', [
    ref('notice', 'Trigger notice or order', 'notice'), ref('rule', 'Reviewed rule', 'rule', false),
    date('override', 'Explicit date from order', false), date('confirmed', 'Lawyer-confirmed date', false),
    note('basis', 'Method, service facts or override explanation', true),
  ], 'Proposed|Confirmed|Complete|Superseded', 'Confirmed|Complete|Superseded'),
  filing: entry('Filing', 'Filing attempts and receipts', 'Record the approved draft, submitted files and outcome.', [
    ref('draft', 'Approved pleading or motion', 'pleading|motion'), date('date', 'Attempt date'),
    text('receipt', 'Court receipt or rejection ID', false), source('Receipt page'), note('details', 'Filed files, rejection or correction notes', true),
  ], 'Ready|Submitted|Accepted|Rejected', 'Submitted|Accepted|Rejected'),
  service: entry('Service attempt', 'Service and proof', 'Track recipient, attempts, proof and the next review.', [
    ref('filing', 'Related filing', 'filing'), text('recipient', 'Recipient'), text('method', 'Method'),
    date('date', 'Attempt date'), date('followUp', 'Follow-up date', false), source('Proof page'), note('details', 'Attempt details'),
  ], 'Scheduled|Attempted|Failed|Served', 'Served'),
  discovery: entry('Discovery item', 'Discovery requests and responses', 'Track item-level requests, objections and supplements.', [
    ref('case', 'Court case', 'courtcase'), pick('direction', 'Direction', 'Incoming|Outgoing'),
    text('party', 'Requesting or responding party'), date('due', 'Confirmed due date', false), source('Request or response page'),
    note('details', 'Request, objection, response or dispute', true),
  ], 'Draft|Served|Partial|Responded|Disputed|Closed', 'Responded|Closed'),
  production: entry('Production', 'Discovery productions', 'Review exact source pages, privilege exclusions and delivery evidence.', [
    ref('request', 'Discovery item', 'discovery'), list('exhibits', 'Reviewed evidence items', 'evidence'),
    text('range', 'Bates range or index identifier'), note('exclusions', 'Privilege, redaction and excluded materials review', true),
    date('date', 'Delivery date', false), source('Production proof page'),
  ], 'Draft|Reviewed|Delivered|Supplemented', 'Reviewed|Delivered|Supplemented'),
  deposition: entry('Deposition', 'Depositions and testimony', 'Prepare witness packet and retain transcript page-line references.', [
    ref('case', 'Court case', 'courtcase'), ref('witness', 'Witness', 'witness'),
    date('due', 'Scheduled date'), source('Notice or transcript page'), text('lines', 'Transcript page and line range', false),
    note('outline', 'Outline, exhibits or errata', true),
  ], 'Planned|Noticed|Taken|Reviewed', 'Reviewed'),
  expert: entry('Expert', 'Experts and disclosures', 'Track scope, revised reports and disclosure dates.', [
    ref('case', 'Court case', 'courtcase'), text('name', 'Expert name'), text('specialty', 'Specialty'),
    date('due', 'Disclosure or deliverable due', false), source('Report or disclosure page'), note('scope', 'Scope and restricted material', true),
  ], 'Identified|Retained|Report received|Reviewed|Disclosed', 'Reviewed|Disclosed'),
  authoritysource: entry('Legal authority', 'Legal research sources', 'Record propositions, quotes and verification against the selected source.', [
    text('citation', 'Citation'), web('url', 'Source URL', true), text('court', 'Court or issuing authority'),
    date('date', 'Authority date', false), note('proposition', 'Proposition and exact quote', true),
    note('treatment', 'Treatment check and contrary authority'),
  ], 'Candidate|Verified|Questioned|Superseded', 'Verified|Superseded'),
  motion: entry('Motion', 'Research memos and motions', 'Bind factual support and verified authorities to the exact draft.', [
    ref('case', 'Court case', 'courtcase'), list('authorities', 'Supporting authorities', 'authoritysource'),
    list('facts', 'Matter evidence', 'evidence', false), source('Exact draft page', true),
    note('issue', 'Question, relief or drafting review notes', true),
  ], 'Draft|Approved|Superseded', 'Approved|Superseded'),
  hearing: entry('Hearing or trial', 'Mediation, hearings and trial', 'Build an indexed list of witnesses, evidence and rulings.', [
    ref('case', 'Court case', 'courtcase', false), pick('kind', 'Event', 'Mediation|Conference|Hearing|Trial'),
    date('due', 'Event date'), list('exhibits', 'Selected evidence', 'evidence', false), list('witnesses', 'Selected witnesses', 'witness', false),
    source('Ruling or notice page'), note('details', 'Preparation, objections or ruling', true),
  ], 'Planned|Prepared|Held|Reviewed', 'Prepared|Reviewed'),
  judgment: entry('Judgment', 'Judgments and orders', 'Preserve amendments and obligations tied to the order.', [
    ref('case', 'Court case', 'courtcase'), ref('prior', 'Amended judgment', 'judgment', false),
    date('date', 'Entered date'), money('amount', 'Award amount', false), source('Judgment or order page', true),
    note('details', 'Parties, obligations and changes', true),
  ], 'Entered|Reviewed|Amended|Satisfied', 'Reviewed|Satisfied'),
  appeal: entry('Appeal decision', 'Appeal and post-order decisions', 'Link advice, instructions and review dates to the order.', [
    ref('judgment', 'Judgment or order', 'judgment'), date('due', 'Reviewed decision or filing date', false),
    note('details', 'Client decision, briefing or referral', true), source('Decision or notice page'),
  ], 'Review|Proceed|Decline|Referred|Closed', 'Proceed|Decline|Referred|Closed'),
  enforcement: entry('Enforcement action', 'Enforcement and recoveries', 'Record actions, recoveries and open obligations.', [
    ref('judgment', 'Judgment', 'judgment'), date('date', 'Action date'), date('followUp', 'Next follow-up', false),
    ref('receipt', 'Recorded recovery receipt', 'receipt', false), source(), note('details', 'Action and outstanding obligation', true),
  ], 'Open|Partial|Recovered|Transferred|Closed', 'Recovered|Transferred|Closed'),
  hold: entry('Records hold', 'Holds and releases', 'Track scope and release evidence before disposition review.', [
    text('owner', 'Owner'), date('date', 'Effective date'), note('scope', 'Documents and reason', true), source(),
  ], 'Active|Released', 'Released'),
  retention: entry('Retention decision', 'Retention and disposition review', 'Document eligibility and verification against holds.', [
    date('due', 'Review date'), text('policy', 'Applicable policy version'),
    note('scope', 'Scope, disposition decision and evidence', true), source(),
  ], 'Scheduled|Reviewed|Cleared for disposition|Completed externally', 'Reviewed|Cleared for disposition|Completed externally'),
  template: entry('Template', 'Approved templates', 'Version recurring drafts, owner and applicable scope.', [
    text('owner', 'Template owner'), text('jurisdiction', 'Practice or jurisdiction'), date('date', 'Review date'),
    note('body', 'Template text or fields', true), source('Reference version page'),
  ], 'Draft|Approved|Retired', 'Approved|Retired'),
  vendor: entry('Vendor review', 'Vendors and data routes', 'Record purpose, approved data, access, retention and renewal.', [
    text('provider', 'Provider or service'), date('due', 'Renewal or review date', false),
    note('scope', 'Data routes, permitted use, retention and access', true), source(),
  ], 'Review|Approved|Paused|Offboarded', 'Approved|Paused|Offboarded'),
  risk: entry('Risk or incident', 'Risk and incident records', 'Track disposition and evidence in the lawyer workspace.', [
    pick('kind', 'Type', 'Conflicts escalation|Complaint|Security incident|Operational issue|Other'),
    date('date', 'Recorded date'), text('owner', 'Owner'), note('details', 'Issue, containment and decision', true), source(),
  ], 'Open|Investigating|Resolved', 'Resolved'),
  continuity: entry('Continuity plan', 'Recovery and continuity', 'Record target, recovery run, owner and follow-up.', [
    pick('kind', 'Type', 'Backup restore|Emergency handoff|Service outage|Other'), date('date', 'Exercise or review date'),
    text('owner', 'Owner'), note('result', 'Target, observed result and follow-up', true), source(),
  ], 'Planned|Rehearsed|Verified', 'Verified'),
  evaluation: entry('Evaluation', 'Workflow and AI evaluations', 'Capture tested version, scenario and result with evidence.', [
    text('version', 'Tested version'), text('check', 'Backlog or check ID'), date('date', 'Run date'),
    note('result', 'Expected result, observed result and evidence', true),
  ], 'Planned|Passed|Failed|Blocked', 'Passed|Failed'),
  specialty: entry('Practice pack item', 'Specialty workflows', 'Record selected pack, local procedure, output and evidence.', [
    pick('pack', 'Pack', 'Transactions|IP|Immigration|Probate|Pro bono'), text('jurisdiction', 'Jurisdiction or program'),
    text('stage', 'Stage or milestone'), date('due', 'Reviewed due date', false), note('details', 'Requirements and expected output', true), source(),
  ], 'Scoped|In progress|Reviewed|Complete', 'Reviewed|Complete'),
  delegation: entry('Delegated work', 'Delegation and supervision', 'Record owner, scoped work, reviewer and handoff.', [
    text('person', 'Assigned person'), text('reviewer', 'Lawyer reviewer'), date('due', 'Review date'),
    note('scope', 'Task, access scope and expected deliverable', true), source(),
  ], 'Assigned|Submitted|Reviewed|Closed', 'Reviewed|Closed'),
};
