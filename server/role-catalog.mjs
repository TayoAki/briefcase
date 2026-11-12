export const roleCatalog = [
  {
    "id": "R01",
    "title": "Managing partner / firm chair",
    "team": "Firm leadership",
    "input": "Reporting period and offices",
    "output": "Partner pack or decision record",
    "check": "Office totals reconcile to source matters and restricted matter names stay out of the partner pack.",
    "external": false
  },
  {
    "id": "R02",
    "title": "Equity partner / shareholder",
    "team": "Firm leadership",
    "input": "Referral, commitment, and proposed fees",
    "output": "Approved credit and commitment review",
    "check": "Credit follows the approved originating record. Partner sees authorized matters and ownership reports only.",
    "external": true
  },
  {
    "id": "R03",
    "title": "Non-equity partner",
    "team": "Firm leadership",
    "input": "Demand or settlement revision and authority",
    "output": "Review decision on exact revision",
    "check": "Assigned staff can draft. Only the authorized lawyer approves, and the approved versions reproduce.",
    "external": false
  },
  {
    "id": "R04",
    "title": "Practice group leader / chair",
    "team": "Firm leadership",
    "input": "Staffing and capacity inputs",
    "output": "Approved staffing or reassignment plan",
    "check": "A reassigned matter reaches the correct lawyer without exposing a screened matter.",
    "external": false
  },
  {
    "id": "R05",
    "title": "Chief operating officer / executive director",
    "team": "Firm leadership",
    "input": "Operating metrics and open exceptions",
    "output": "Operating review and action owners",
    "check": "A late intake and failed import each show an owner, duration and exception trail.",
    "external": true
  },
  {
    "id": "R06",
    "title": "Office administrator / office manager",
    "team": "Firm leadership",
    "input": "Renewal, booking, or coverage request",
    "output": "Office service disposition",
    "check": "Coverage and renewal tasks route to delegates with scoped access and documented completion.",
    "external": true
  },
  {
    "id": "R07",
    "title": "Business development manager",
    "team": "Client development",
    "input": "Opportunity and approved experience sources",
    "output": "Versioned pitch and partner handoff",
    "check": "Partner receives a versioned pitch with approved matter references and no private facts.",
    "external": true
  },
  {
    "id": "R08",
    "title": "Marketing and communications manager",
    "team": "Client development",
    "input": "Consent scope and content source",
    "output": "Approved asset and publication disposition",
    "check": "A draft using a revoked testimonial cannot reach approved export.",
    "external": true
  },
  {
    "id": "R09",
    "title": "Client relationship manager",
    "team": "Client development",
    "input": "Client feedback and account reference",
    "output": "Service escalation and assigned owner",
    "check": "The relationship manager sees permitted account history and the matter lead receives the service follow-up.",
    "external": true
  },
  {
    "id": "R10",
    "title": "Firm general counsel",
    "team": "Risk and intake",
    "input": "Incident reference and access evidence",
    "output": "Restricted findings and preservation decision",
    "check": "Firm counsel can reconstruct one incident while investigators see only specifically assigned material.",
    "external": false
  },
  {
    "id": "R11",
    "title": "Professional responsibility counsel",
    "team": "Risk and intake",
    "input": "Conflict escalation and waiver evidence",
    "output": "Waiver or screen decision record",
    "check": "Counsel records conditions, intake receives disposition, and a screened user cannot read blocked material.",
    "external": false
  },
  {
    "id": "R12",
    "title": "Receptionist / front desk coordinator",
    "team": "Risk and intake",
    "input": "Minimum callback details and destination",
    "output": "Secure intake or callback routing record",
    "check": "The receptionist captures both calls and sees only callback fields for the existing matter.",
    "external": true
  },
  {
    "id": "R13",
    "title": "Legal intake specialist",
    "team": "Risk and intake",
    "input": "Inquiry, parties, and urgency",
    "output": "Triage disposition and review assignment",
    "check": "Two submissions merge with provenance, an urgent inquiry is assigned, and nobody is auto-cleared.",
    "external": true
  },
  {
    "id": "R14",
    "title": "Conflicts analyst",
    "team": "Risk and intake",
    "input": "Party aliases and relationship evidence",
    "output": "Conflict candidate report",
    "check": "Alias and parent/subsidiary fixtures are surfaced with reasons and without screened case contents.",
    "external": false
  },
  {
    "id": "R15",
    "title": "Conflicts attorney",
    "team": "Risk and intake",
    "input": "Candidate conflicts and proposed conditions",
    "output": "Conflict disposition and clearance conditions",
    "check": "Opening is blocked until conditions are met. Every original, search and AI route respects the screen.",
    "external": false
  },
  {
    "id": "R16",
    "title": "Business intake / matter opening specialist",
    "team": "Risk and intake",
    "input": "Signed engagement and clearance references",
    "output": "Matter opening and billing setup packet",
    "check": "Approved intake opens one matter and produces one billing setup record, even after retry.",
    "external": true
  },
  {
    "id": "R17",
    "title": "Client due diligence analyst (AML/KYC)",
    "team": "Risk and intake",
    "input": "Restricted diligence case reference",
    "output": "Verification disposition and escalation status",
    "check": "An unresolved verification remains escalated and appears in intake as a minimal status.",
    "external": true
  },
  {
    "id": "R18",
    "title": "Matter lead / responsible attorney",
    "team": "Lawyers and trainees",
    "input": "Matter evidence, authority, and current offer",
    "output": "Approved demand or settlement decision",
    "check": "A lawyer approves a specific demand revision and accepts only a current authorized offer.",
    "external": true
  },
  {
    "id": "R19",
    "title": "Counsel / of counsel",
    "team": "Lawyers and trainees",
    "input": "Assigned question and allowed source references",
    "output": "Reviewed specialist memo",
    "check": "Specialist can return a reviewed memo and cannot search unassigned matters.",
    "external": false
  },
  {
    "id": "R20",
    "title": "Senior associate",
    "team": "Lawyers and trainees",
    "input": "Discovery or deposition assignment and sources",
    "output": "Reviewed strategy or exhibit packet",
    "check": "Junior changes arrive as a reviewable revision and partner can trace each exhibit.",
    "external": false
  },
  {
    "id": "R21",
    "title": "Litigation associate",
    "team": "Lawyers and trainees",
    "input": "Motion inputs and checked authorities",
    "output": "Reviewed motion and hearing or filing packet",
    "check": "A motion with an unsupported citation stays in review and the approved filing is reproducible.",
    "external": true
  },
  {
    "id": "R22",
    "title": "Transactional associate",
    "team": "Lawyers and trainees",
    "input": "Deal conditions and draft agreements",
    "output": "Closing decision and signed binder index",
    "check": "A changed condition reopens approval and the final binder matches the exact signed versions.",
    "external": false
  },
  {
    "id": "R23",
    "title": "Staff attorney",
    "team": "Lawyers and trainees",
    "input": "Matter-specific inputs and template version",
    "output": "Reviewed memorandum",
    "check": "Two generated memos remain separate and send exact, reviewed versions to the partner.",
    "external": false
  },
  {
    "id": "R24",
    "title": "Document review attorney",
    "team": "Lawyers and trainees",
    "input": "Document set and review criteria",
    "output": "Responsiveness and privilege disposition",
    "check": "A privileged attachment stays out of production while its review history remains intact.",
    "external": true
  },
  {
    "id": "R25",
    "title": "Law clerk / summer associate",
    "team": "Lawyers and trainees",
    "input": "Delegated question and research sources",
    "output": "Supervised research draft",
    "check": "Clerk submits a draft without publishing it and supervisor reviews the exact sources.",
    "external": true
  },
  {
    "id": "R26",
    "title": "Litigation paralegal",
    "team": "Legal support",
    "input": "Original page references and exhibit list",
    "output": "Reviewed exhibit or chronology packet",
    "check": "Paralegal builds the packet, lawyer signs off, and exported page references resolve.",
    "external": false
  },
  {
    "id": "R27",
    "title": "Corporate paralegal",
    "team": "Legal support",
    "input": "Corporate approvals and executed schedules",
    "output": "Closing binder index and post-close list",
    "check": "Unsigned approvals stay on the closing list and the binder contains the executed originals.",
    "external": true
  },
  {
    "id": "R28",
    "title": "Legal administrative assistant / legal secretary",
    "team": "Legal support",
    "input": "Calendar inputs and proposed communication",
    "output": "Reviewed calendar or client update handoff",
    "check": "Assistant prepares the draft and dates, while only the approver can authorize delivery.",
    "external": true
  },
  {
    "id": "R29",
    "title": "Litigation docketing specialist",
    "team": "Legal support",
    "input": "Triggering notice and applicable rule version",
    "output": "Reviewed docket date and calculation record",
    "check": "An amended order invalidates the old candidate. A confirmed override is traceable to its source.",
    "external": true
  },
  {
    "id": "R30",
    "title": "Court services / e-filing specialist",
    "team": "Legal support",
    "input": "Approved pleading version and filing destination",
    "output": "Filing package and service disposition",
    "check": "Both attempts retain exact PDFs, and a rejection does not advance service.",
    "external": true
  },
  {
    "id": "R31",
    "title": "E-discovery / litigation support specialist",
    "team": "Legal support",
    "input": "Production families and privilege decisions",
    "output": "Reviewed Bates and production manifest",
    "check": "Rerun does not duplicate evidence and the release manifest excludes privileged records.",
    "external": true
  },
  {
    "id": "R32",
    "title": "Trial technology specialist",
    "team": "Legal support",
    "input": "Approved exhibit versions and clip references",
    "output": "Offline rehearsal and presentation manifest",
    "check": "Offline rehearsal opens the correct exhibit revision and plays the approved clip.",
    "external": false
  },
  {
    "id": "R33",
    "title": "Legal project manager",
    "team": "Practice operations",
    "input": "Matter plan, budget, and scope change",
    "output": "Scope review and partner escalation record",
    "check": "A proposed scope change is visible with spend-to-date and waits for lawyer approval.",
    "external": true
  },
  {
    "id": "R34",
    "title": "Practice manager / practice operations manager",
    "team": "Practice operations",
    "input": "Practice workload and staffing availability",
    "output": "Approved reassignment or coverage plan",
    "check": "Manager sees bottlenecks and can reassign work without restricted content.",
    "external": false
  },
  {
    "id": "R35",
    "title": "Knowledge management attorney",
    "team": "Practice operations",
    "input": "Model document, jurisdiction, and version",
    "output": "Approved template or retirement record",
    "check": "New drafts use the current approved template and older approved documents reproduce.",
    "external": false
  },
  {
    "id": "R36",
    "title": "Research librarian / research analyst",
    "team": "Practice operations",
    "input": "Research request and entitled sources",
    "output": "Reviewed authority and treatment list",
    "check": "Each returned authority includes the source, date and treatment status when available.",
    "external": true
  },
  {
    "id": "R37",
    "title": "Legal technology / automation specialist",
    "team": "Practice operations",
    "input": "Automation version and synthetic fixtures",
    "output": "Release or rollback decision and test results",
    "check": "A failed fixture blocks promotion and a rollback preserves prior approvals.",
    "external": false
  },
  {
    "id": "R38",
    "title": "Pro bono counsel",
    "team": "Practice operations",
    "input": "Referral, capacity, and permitted reporting fields",
    "output": "Assignment and minimal program report",
    "check": "An accepted case reaches the assigned lawyer and exports only approved fields.",
    "external": true
  },
  {
    "id": "R39",
    "title": "Patent agent",
    "team": "Practice specialists",
    "input": "Disclosure, claims, and office action",
    "output": "Reviewed claims or response package",
    "check": "Claim amendments stay traceable to source and approved response version.",
    "external": true
  },
  {
    "id": "R40",
    "title": "Intellectual property docketing specialist",
    "team": "Practice specialists",
    "input": "Agency notice and rule version",
    "output": "Reviewed docket or renewal schedule",
    "check": "An amended agency notice replaces the prior date only after review and retains its receipt.",
    "external": true
  },
  {
    "id": "R41",
    "title": "Immigration paralegal",
    "team": "Practice specialists",
    "input": "Questionnaire, evidence, and form versions",
    "output": "Reviewed petition and missing-item disposition",
    "check": "Required evidence gaps surface before a reviewed petition can be exported.",
    "external": true
  },
  {
    "id": "R42",
    "title": "Trusts and estates paralegal",
    "team": "Practice specialists",
    "input": "Asset inventory and beneficiary references",
    "output": "Reconciled distribution or notice package",
    "check": "Distribution schedule reconciles to source assets and carries required reviewer approval.",
    "external": true
  },
  {
    "id": "R43",
    "title": "Real estate paralegal / closing coordinator",
    "team": "Practice specialists",
    "input": "Lender, title, and signature conditions",
    "output": "Approved closing checklist and binder index",
    "check": "A missing lender condition blocks closeout and the binder includes only approved signed documents.",
    "external": true
  },
  {
    "id": "R44",
    "title": "Personal injury case manager",
    "team": "Practice specialists",
    "input": "Open records request and supporting page",
    "output": "Verified chronology or records handoff",
    "check": "Replayed attachment creates one receipt; ambiguous provider match stays in review.",
    "external": true
  },
  {
    "id": "R45",
    "title": "Settlement specialist",
    "team": "Practice specialists",
    "input": "Settlement amount, lien evidence, and cleared funds",
    "output": "Reviewed settlement statement and trust handoff",
    "check": "Statement reconciles to cleared receipts, approved payees and latest lien evidence.",
    "external": true
  },
  {
    "id": "R46",
    "title": "In-house legal investigator",
    "team": "Practice specialists",
    "input": "Witness interview and original evidence references",
    "output": "Source-linked investigation report",
    "check": "The lawyer receives a source-linked statement and timestamped originals without granting other matter access.",
    "external": false
  },
  {
    "id": "R47",
    "title": "Pricing analyst / pricing manager",
    "team": "Finance",
    "input": "Staffing assumptions, rates, and terms",
    "output": "Reviewed fee scenario and pricing decision",
    "check": "Both scenarios reconcile to rates and staffing assumptions, and approval pins the selected offer.",
    "external": true
  },
  {
    "id": "R48",
    "title": "Chief financial officer",
    "team": "Finance",
    "input": "Operating and trust reporting periods",
    "output": "Reconciled finance review and variance summary",
    "check": "Operating and trust totals reconcile separately to the approved external ledger.",
    "external": true
  },
  {
    "id": "R49",
    "title": "Controller / accounting manager",
    "team": "Finance",
    "input": "Ledger period and exceptions",
    "output": "Month-close review and correction disposition",
    "check": "An unmatched entry prevents signoff and the eventual correction retains the original record.",
    "external": true
  },
  {
    "id": "R50",
    "title": "Accounts payable specialist",
    "team": "Finance",
    "input": "Invoice identifier, coding, and matter approval",
    "output": "Approved payable and payment status",
    "check": "The same vendor invoice imports once and approval is separate from payment.",
    "external": true
  },
  {
    "id": "R51",
    "title": "Law firm bookkeeper",
    "team": "Finance",
    "input": "Deposit and expense references",
    "output": "Matching and duplicate disposition",
    "check": "An imported duplicate does not affect balances and a reversed transaction retains history.",
    "external": true
  },
  {
    "id": "R52",
    "title": "Billing / e-billing specialist",
    "team": "Finance",
    "input": "Time, expenses, and billing rules",
    "output": "Approved invoice and submission disposition",
    "check": "Rejection returns the same invoice for a versioned correction and preserves submission history.",
    "external": true
  },
  {
    "id": "R53",
    "title": "Collections / accounts receivable specialist",
    "team": "Finance",
    "input": "Aged invoice, payment, and dispute references",
    "output": "Collection action or write-off decision",
    "check": "Partial payment reduces the correct balance and a write-off waits for authorization.",
    "external": true
  },
  {
    "id": "R54",
    "title": "Trust accounting specialist",
    "team": "Finance",
    "input": "Cleared receipt, allocation, and disbursement references",
    "output": "Reviewed trust reconciliation",
    "check": "A returned payment reopens the balance and no unresolved discrepancy can be signed off.",
    "external": true
  },
  {
    "id": "R55",
    "title": "Human resources generalist / HR manager",
    "team": "People",
    "input": "Minimum personnel reference and lifecycle request",
    "output": "Access activation or removal confirmation",
    "check": "Departure removes access to assigned matters while HR documents stay in the HR system.",
    "external": true
  },
  {
    "id": "R56",
    "title": "Attorney recruiting coordinator",
    "team": "People",
    "input": "Restricted candidate reference and request",
    "output": "Interview or lateral conflict disposition",
    "check": "Conflicts receives relevant names only and recruiting receives a clearance status.",
    "external": true
  },
  {
    "id": "R57",
    "title": "Attorney professional development manager",
    "team": "People",
    "input": "Training assignment and approved reporting scope",
    "output": "Completion summary and follow-up",
    "check": "Leadership sees completion aggregates without access to confidential evaluation details.",
    "external": true
  },
  {
    "id": "R58",
    "title": "Payroll specialist",
    "team": "People",
    "input": "Payroll period and authorized close reference",
    "output": "Payroll close status for finance",
    "check": "No payee banking or payroll records enter matter stores, and the status reaches finance.",
    "external": true
  },
  {
    "id": "R59",
    "title": "Chief information officer / IT director",
    "team": "Technology and records",
    "input": "Rollout scope, recovery run, and connector inventory",
    "output": "Reviewed rollout or restore decision",
    "check": "An isolated test tenant restores with complete hashes and zero cross-tenant reads.",
    "external": false
  },
  {
    "id": "R60",
    "title": "IT support specialist / help desk",
    "team": "Technology and records",
    "input": "Redacted job ID and observed failure",
    "output": "Triage disposition and retry result",
    "check": "Support can diagnose a stuck job from metadata and cannot read the original.",
    "external": false
  },
  {
    "id": "R61",
    "title": "Information security analyst",
    "team": "Technology and records",
    "input": "Download alert or actor and event references",
    "output": "Investigation and revocation confirmation",
    "check": "Revocation reaches download, search and worker paths and preserves time-stamped evidence.",
    "external": false
  },
  {
    "id": "R62",
    "title": "Document management systems engineer",
    "team": "Technology and records",
    "input": "Repository item, version, and access reference",
    "output": "Migration or sync reconciliation",
    "check": "A permission change removes search results and the imported original hash still matches.",
    "external": true
  },
  {
    "id": "R63",
    "title": "Information governance / records manager",
    "team": "Technology and records",
    "input": "Hold, file-return, or recovery request",
    "output": "Disposition or verified return manifest",
    "check": "A hold survives restore and blocks all scheduled disposition until an authorized release.",
    "external": false
  },
  {
    "id": "R64",
    "title": "Facilities / office services coordinator",
    "team": "Office services",
    "input": "Mail, room, or service request reference",
    "output": "Delivery or office service confirmation",
    "check": "A tracked mail handoff reaches the assigned recipient while room bookings stay in the calendar system.",
    "external": true
  },
  {
    "id": "R65",
    "title": "Document production specialist / word processor",
    "team": "Office services",
    "input": "Document revisions and formatting requirements",
    "output": "Reviewed Word and PDF delivery record",
    "check": "Approved Word and PDF versions preserve numbering, exhibits and authority tables on representative templates.",
    "external": false
  }
];
