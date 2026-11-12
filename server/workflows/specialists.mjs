import { PDFDocument, StandardFonts } from '../../dist/vendor/packets/pdf-lib.mjs';

// These workflows record source-based professional decisions. They do not calculate
// legal deadlines or represent a provider, signature, bank or agency connection.
const text = (value, label, ctx, max = 4000) => {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) ctx.fail(422, `${label} is required (maximum ${max} characters).`);
  return value.trim();
};
const key = (value, label, ctx) => {
  const result = text(value, label, ctx, 100);
  if (!/^[a-zA-Z0-9_.:-]+$/.test(result)) ctx.fail(422, `${label} must use letters, digits, periods, colons, underscores or hyphens.`);
  return result;
};
const array = (value, label, ctx, min = 0, max = 200) => {
  if (!Array.isArray(value) || value.length < min || value.length > max) ctx.fail(422, `${label} needs ${min}–${max} rows.`);
  return value;
};
const day = (value, label, ctx) => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) ctx.fail(422, `${label} must be a valid YYYY-MM-DD date.`);
  return value;
};
const instant = (value, label, ctx) => {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) ctx.fail(422, `${label} must be an ISO timestamp, including its timezone.`);
  return value;
};
const cents = (value, label, ctx, allowZero = false) => {
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1) || value > 1_000_000_000_000) ctx.fail(422, `${label} must be a ${allowZero ? 'non-negative' : 'positive'} integer number of cents (maximum 1 trillion).`);
  return value;
};
const total = (rows, property = 'amountCents') => {
  const result = rows.reduce((sum, row) => sum + BigInt(row[property]), 0n);
  if (result > BigInt(Number.MAX_SAFE_INTEGER) || result < BigInt(Number.MIN_SAFE_INTEGER)) throw Object.assign(new Error('Amount total exceeds the safe accounting range.'), { status: 422 });
  return Number(result);
};
const unique = (rows, property, ctx) => {
  if (new Set(rows.map(row => row[property])).size !== rows.length) ctx.fail(422, `Duplicate ${property} values are not allowed.`);
  return rows;
};
const reviewer = ctx => { if (!ctx.isReviewer) ctx.fail(403, 'The assigned reviewer must perform this action.'); };
const noAction = ctx => ctx.fail(422, 'Choose an available specialist workflow action.');
const normalize = value => value.normalize('NFKC').toLocaleLowerCase('en-US').replace(/[^a-z0-9]+/g, ' ').trim();
const field = (name, label, type = 'text', extra = {}) => ({ name, label, type, required: true, ...extra });
const sourceFields = [field('documentId', 'Original PDF document ID'), field('page', 'Physical source page', 'number')];
const referenceFields = [field('reference', 'External case or application reference')];
const result = (errors = [], warnings = []) => ({ errors, warnings });
const requireFind = (rows, id, ctx, label) => {
  const row = rows.find(row => row.id === id);
  if (!row) ctx.fail(422, `${label} is not in this work item.`);
  return row;
};
function binding(input, ctx) {
  const documentId = text(input.documentId, 'Original PDF document ID', ctx, 100);
  if (!Number.isSafeInteger(input.page) || input.page < 1) ctx.fail(422, 'Choose a physical source page.');
  const source = ctx.source(documentId, input.page);
  if (!source.pages.some(page => page.number === input.page)) ctx.fail(422, 'The physical source page is unavailable.');
  const bound = ctx.sourceBinding(documentId, input.page);
  return { documentId, sha256: source.sha256, page: input.page, name: bound.name ?? source.name };
}
function verify(bound, ctx) {
  const source = ctx.source(bound.documentId, bound.page);
  if (source.sha256 !== bound.sha256 || !source.pages.some(page => page.number === bound.page)) ctx.fail(409, 'A pinned source changed or its physical page is unavailable.');
  return source;
}
function requirements(input, label, ctx) {
  return unique(array(input, label, ctx, 1).map(row => ({ id: key(row.id, 'Requirement ID', ctx), label: text(row.label, 'Requirement label', ctx, 300) })), 'id', ctx);
}
function addHistory(state, action, ctx, data) {
  if (state.history.length >= 1000) ctx.fail(409, 'Start a follow-up work item after 1,000 recorded actions.');
  state.history.push({ action, by: ctx.user.username, at: ctx.now, ...data });
}
function upsertVersion(rows, id, value, ctx) {
  const existing = rows.find(row => row.id === id);
  if (!existing) { rows.push({ id, versions: [{ ...value, at: ctx.now, by: ctx.user.username }] }); return rows.at(-1); }
  if (existing.versions.length >= 100) ctx.fail(409, 'Start a follow-up record after 100 versions.');
  existing.versions.push({ ...value, at: ctx.now, by: ctx.user.username });
  return existing;
}
const latest = row => row.versions.at(-1);
const current = rows => rows.map(row => ({ id: row.id, ...latest(row) }));

async function binder(title, entries, ctx, name) {
  const pdf = await PDFDocument.create();
  pdf.setTitle(title);
  pdf.setCreationDate(new Date('2000-01-01T00:00:00.000Z'));
  pdf.setModificationDate(new Date('2000-01-01T00:00:00.000Z'));
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  let index = pdf.addPage([612, 792]);
  let y = 750;
  const printable = value => String(value).replace(/[^\x20-\x7E]/g, '?');
  index.drawText(printable(title).slice(0, 85), { x: 42, y, size: 14, font }); y -= 28;
  index.drawText('Approved source manifest is included in the JSON verification record.', { x: 42, y, size: 9, font }); y -= 25;
  const uniqueEntries = [...new Map(entries.map(entry => [entry.source.documentId + ':' + entry.source.sha256, entry])).values()];
  // Reserve index pages before appending originals so every index position is exact.
  const indexPages = [index];
  for (let i = 26; i < uniqueEntries.length; i += 28) indexPages.push(pdf.addPage([612, 792]));
  let manifestIndex = 0;
  for (const entry of uniqueEntries) {
    const source = verify(entry.source, ctx);
    const original = await PDFDocument.load(source.bytes);
    const start = pdf.getPageCount() + 1;
    const pages = await pdf.copyPages(original, original.getPageIndices());
    for (const page of pages) pdf.addPage(page);
    if (y < 70) { index = indexPages[++manifestIndex]; y = 750; }
    const label = printable(`${entry.label} | PDF pages ${start}-${start + pages.length - 1} | source ${entry.source.documentId}`).slice(0, 105);
    index.drawText(label, { x: 42, y, size: 9, font }); y -= 25;
  }
  const bytes = Buffer.from(await pdf.save());
  // Source access is rechecked after asynchronous PDF work.
  for (const entry of uniqueEntries) verify(entry.source, ctx);
  return { bytes, mime: 'application/pdf', name };
}

const patent = {
  roleId: 'R39', title: 'Patent claim amendments', matterRequired: true,
  description: 'Draft claim amendments against pinned source pages, preserving the before/after history for review.',
  fields: [...referenceFields, field('claims', 'Initial claims', 'json', { hint: '[{"number":1,"text":"Claim text","documentId":"original-id","page":1}]' })],
  actions: [{ id: 'amend-claim', label: 'Amend claim', fields: [field('number', 'Claim number', 'number'), field('baseSha256', 'Current claim SHA-256'), field('text', 'Amended claim text', 'textarea'), field('reason', 'Amendment reason', 'textarea'), ...sourceFields] }],
  create(input, ctx) {
    const claims = unique(array(input.claims, 'Initial claims', ctx, 1, 100).map(row => {
      if (!Number.isSafeInteger(row.number) || row.number < 1 || row.number > 10000) ctx.fail(422, 'Use a positive claim number.');
      const version = { text: text(row.text, 'Claim text', ctx, 12000), source: binding(row, ctx), at: ctx.now, by: ctx.user.username, reason: 'Initial claim' };
      return { number: row.number, versions: [{ ...version, sha256: ctx.hash(version) }] };
    }), 'number', ctx);
    return { reference: text(input.reference, 'Application reference', ctx, 200), claims, history: [] };
  },
  update(state, action, input, ctx) {
    if (action !== 'amend-claim') return noAction(ctx);
    const claim = state.claims.find(row => row.number === input.number);
    if (!claim) ctx.fail(422, 'Choose an existing claim number.');
    if (input.baseSha256 !== latest(claim).sha256) ctx.fail(409, 'The claim changed. Review the current version before amending it.');
    if (claim.versions.length >= 100) ctx.fail(409, 'Start a follow-up after 100 claim versions.');
    const next = { text: text(input.text, 'Amended claim', ctx, 12000), reason: text(input.reason, 'Amendment reason', ctx), source: binding(input, ctx), at: ctx.now, by: ctx.user.username, supersedes: latest(claim).sha256 };
    if (next.text === latest(claim).text) ctx.fail(422, 'The amendment must change the claim text.');
    claim.versions.push({ ...next, sha256: ctx.hash(next) });
    addHistory(state, action, ctx, { number: claim.number, sha256: latest(claim).sha256 });
    return state;
  },
  validate(state, ctx) { for (const claim of state.claims) for (const version of claim.versions) verify(version.source, ctx); return result(state.claims.some(row => row.versions.length > 1) ? [] : ['Record at least one claim amendment.']); },
  output(state, ctx) { this.validate(state, ctx); return { application: state.reference, claims: state.claims.map(row => ({ number: row.number, original: row.versions[0], current: latest(row), changes: row.versions.slice(1) })), history: state.history }; },
};

const ipDocket = {
  roleId: 'R40', title: 'Agency notice and deadline review', matterRequired: true,
  description: 'Record source dates; an amended notice stays pending until the reviewer confirms its exact version.',
  fields: [...referenceFields, field('agency', 'Agency')],
  actions: [
    { id: 'record-notice', label: 'Record agency notice', fields: [field('noticeReference', 'Notice / receipt reference'), field('deadline', 'Source deadline', 'date'), field('receivedAt', 'Received timestamp'), ...sourceFields] },
    { id: 'confirm-notice', label: 'Confirm current notice', reviewerOnly: true, fields: [field('sha256', 'Pending notice SHA-256'), field('notes', 'Source/date review notes', 'textarea')] },
  ],
  create(input, ctx) { return { reference: text(input.reference, 'Application reference', ctx, 200), agency: text(input.agency, 'Agency', ctx, 200), notices: [], effective: null, history: [] }; },
  update(state, action, input, ctx) {
    if (action === 'record-notice') {
      if (state.notices.length >= 100) ctx.fail(409, 'Start a follow-up after 100 notices.');
      const notice = { noticeReference: text(input.noticeReference, 'Notice reference', ctx, 200), deadline: day(input.deadline, 'Source deadline', ctx), receivedAt: instant(input.receivedAt, 'Received timestamp', ctx), source: binding(input, ctx) };
      const prior = state.notices.find(row => row.noticeReference === notice.noticeReference);
      const sha256 = ctx.hash(notice);
      if (prior) { if (prior.sha256 !== sha256) ctx.fail(409, 'This notice reference already identifies a different version. Use the amended notice reference.'); return state; }
      state.notices.push({ ...notice, sha256, recordedAt: ctx.now, by: ctx.user.username, review: null });
      addHistory(state, action, ctx, { sha256 });
    } else if (action === 'confirm-notice') {
      reviewer(ctx);
      const notice = state.notices.at(-1);
      if (!notice || input.sha256 !== notice.sha256) ctx.fail(409, 'Review the latest pending notice.');
      verify(notice.source, ctx);
      notice.review = { by: ctx.user.username, at: ctx.now, notes: text(input.notes, 'Review notes', ctx), sha256: notice.sha256 };
      state.effective = { deadline: notice.deadline, sha256: notice.sha256, receipt: notice.noticeReference };
      addHistory(state, action, ctx, { sha256: notice.sha256, review: notice.review });
    } else return noAction(ctx);
    return state;
  },
  validate(state, ctx) { for (const notice of state.notices) verify(notice.source, ctx); const last = state.notices.at(-1); return result(!last ? ['Record an agency notice.'] : !last.review || state.effective?.sha256 !== last.sha256 ? ['The amended/current notice needs reviewer confirmation before the deadline can be released.'] : [], ['Deadlines are transcribed from supplied sources; no jurisdictional deadline calculation is performed.']); },
  output(state, ctx) { this.validate(state, ctx); return { application: state.reference, agency: state.agency, effective: state.effective, pending: state.notices.at(-1)?.review ? null : state.notices.at(-1), notices: state.notices, history: state.history }; },
};

const immigration = {
  roleId: 'R41', title: 'Petition evidence packet', matterRequired: true, formats: ['pdf'],
  description: 'Assemble a reviewed petition packet against an explicit evidence requirements list.',
  fields: [...referenceFields, field('petitionType', 'Petition / form type'), field('requirements', 'Required evidence', 'json', { hint: '[{"id":"identity","label":"Identity evidence"}]' })],
  actions: [
    { id: 'set-requirements', label: 'Revise evidence requirements', fields: [field('requirements', 'Required evidence', 'json', { hint: '[{"id":"identity","label":"Identity evidence"}]' })] },
    { id: 'attach-evidence', label: 'Attach required evidence', fields: [field('id', 'Requirement ID'), ...sourceFields] },
    { id: 'remove-evidence', label: 'Remove evidence', fields: [field('id', 'Requirement ID'), field('reason', 'Reason', 'textarea')] },
  ],
  create(input, ctx) { return { reference: text(input.reference, 'Petition reference', ctx, 200), petitionType: text(input.petitionType, 'Petition type', ctx, 200), requirements: requirements(input.requirements, 'Required evidence', ctx), evidence: [], history: [] }; },
  update(state, action, input, ctx) {
    if (action === 'set-requirements') { state.requirements = requirements(input.requirements, 'Required evidence', ctx); addHistory(state, action, ctx, { requirements: state.requirements }); }
    else if (action === 'attach-evidence') {
      requireFind(state.requirements, input.id, ctx, 'Requirement');
      const evidence = { source: binding(input, ctx), removed: false };
      upsertVersion(state.evidence, input.id, evidence, ctx); addHistory(state, action, ctx, { id: input.id, ...evidence });
    } else if (action === 'remove-evidence') {
      const existing = requireFind(state.evidence, input.id, ctx, 'Evidence');
      upsertVersion(state.evidence, input.id, { ...latest(existing), removed: true, reason: text(input.reason, 'Removal reason', ctx) }, ctx);
      addHistory(state, action, ctx, { id: input.id, reason: input.reason });
    } else return noAction(ctx);
    return state;
  },
  validate(state, ctx) { const errors = []; for (const required of state.requirements) { const evidence = state.evidence.find(row => row.id === required.id); if (!evidence || latest(evidence).removed) errors.push(`Missing required evidence: ${required.label}.`); else verify(latest(evidence).source, ctx); } return result(errors, ['The evidence checklist is configured by the firm; agency filing and legal eligibility remain professional decisions.']); },
  output(state, ctx) { const validation = this.validate(state, ctx); return { reference: state.reference, petitionType: state.petitionType, checklist: state.requirements.map(row => ({ ...row, evidence: state.evidence.find(entry => entry.id === row.id) ? latest(state.evidence.find(entry => entry.id === row.id)) : null })), missing: validation.errors, history: state.history }; },
  async exportFile(state, ctx, format) { if (format !== 'pdf') return noAction(ctx); const check = this.validate(state, ctx); if (check.errors.length) ctx.fail(409, check.errors.join(' ')); return binder('Petition evidence · ' + state.reference, state.requirements.map(row => ({ label: row.label, source: latest(requireFind(state.evidence, row.id, ctx, 'Evidence')).source })), ctx, 'petition-evidence.pdf'); },
};

const estate = {
  roleId: 'R42', title: 'Estate distribution reconciliation', matterRequired: true,
  description: 'Reconcile source-backed assets and expenses to beneficiary distributions using integer cents.',
  fields: referenceFields,
  actions: [
    { id: 'record-asset', label: 'Record / revise asset', fields: [field('id', 'Asset ID'), field('label', 'Asset description'), field('amountCents', 'Asset value (cents)', 'number'), ...sourceFields] },
    { id: 'record-expense', label: 'Record / revise expense', fields: [field('id', 'Expense ID'), field('label', 'Expense description'), field('amountCents', 'Expense (cents)', 'number'), ...sourceFields] },
    { id: 'set-distributions', label: 'Set distribution schedule', fields: [field('distributions', 'Beneficiary distributions', 'json', { hint: '[{"id":"beneficiary-1","name":"Beneficiary","amountCents":10000}]' })] },
  ],
  create(input, ctx) { return { reference: text(input.reference, 'Estate reference', ctx, 200), currency: 'USD', assets: [], expenses: [], distributions: [], history: [] }; },
  update(state, action, input, ctx) {
    if (['record-asset', 'record-expense'].includes(action)) {
      const id = key(input.id, 'Record ID', ctx);
      const row = { label: text(input.label, 'Description', ctx, 300), amountCents: cents(input.amountCents, 'Value', ctx, true), source: binding(input, ctx) };
      upsertVersion(action === 'record-asset' ? state.assets : state.expenses, id, row, ctx); addHistory(state, action, ctx, { id, ...row });
    } else if (action === 'set-distributions') {
      state.distributions = unique(array(input.distributions, 'Distributions', ctx, 1).map(row => ({ id: key(row.id, 'Beneficiary ID', ctx), name: text(row.name, 'Beneficiary', ctx, 200), amountCents: cents(row.amountCents, 'Distribution', ctx, true) })), 'id', ctx);
      addHistory(state, action, ctx, { distributions: state.distributions });
    } else return noAction(ctx);
    return state;
  },
  validate(state, ctx) { for (const row of [...state.assets, ...state.expenses]) verify(latest(row).source, ctx); const errors = []; if (!state.assets.length) errors.push('Record source-backed assets.'); if (!state.distributions.length) errors.push('Record a beneficiary distribution schedule.'); const available = total(current(state.assets)) - total(current(state.expenses)); if (available < 0) errors.push('Expenses exceed source assets.'); if (available !== total(state.distributions)) errors.push('Distributions do not reconcile to assets less expenses.'); return result(errors, ['USD cents only; valuations and beneficiary entitlements require reviewer confirmation.']); },
  output(state, ctx) { this.validate(state, ctx); const assets = current(state.assets), expenses = current(state.expenses); return { reference: state.reference, currency: state.currency, assets, expenses, distributions: state.distributions, totals: { assetsCents: total(assets), expensesCents: total(expenses), availableCents: total(assets) - total(expenses), distributedCents: total(state.distributions), differenceCents: total(assets) - total(expenses) - total(state.distributions) }, history: state.history }; },
};

const realEstate = {
  roleId: 'R43', title: 'Closing conditions and signed binder', matterRequired: true, formats: ['pdf'],
  description: 'Block closeout until lender conditions and exact signed originals are reviewed.',
  fields: [...referenceFields, field('conditions', 'Lender / closing conditions', 'json', { hint: '[{"id":"funding","label":"Lender funding authorization"}]' }), field('documents', 'Required signed documents', 'json', { hint: '[{"id":"deed","label":"Executed deed"}]' })],
  actions: [
    { id: 'revise-requirements', label: 'Revise closing requirements', fields: [field('conditions', 'Lender / closing conditions', 'json', { hint: '[{"id":"funding","label":"Lender funding authorization"}]' }), field('documents', 'Required signed documents', 'json', { hint: '[{"id":"deed","label":"Executed deed"}]' })] },
    { id: 'record-condition', label: 'Record condition evidence', fields: [field('id', 'Condition ID'), ...sourceFields] },
    { id: 'accept-condition', label: 'Accept condition evidence', reviewerOnly: true, fields: [field('id', 'Condition ID'), field('sha256', 'Current evidence SHA-256'), field('notes', 'Review notes', 'textarea')] },
    { id: 'record-document', label: 'Record executed original', fields: [field('id', 'Required document ID'), field('signers', 'Signers shown on original'), field('executedAt', 'Execution timestamp'), ...sourceFields] },
    { id: 'accept-document', label: 'Accept executed original', reviewerOnly: true, fields: [field('id', 'Required document ID'), field('sha256', 'Current document SHA-256'), field('notes', 'Signature review notes', 'textarea')] },
  ],
  create(input, ctx) { return { reference: text(input.reference, 'Closing reference', ctx, 200), conditions: requirements(input.conditions, 'Closing conditions', ctx), documents: requirements(input.documents, 'Signed documents', ctx), conditionEvidence: [], signedDocuments: [], history: [] }; },
  update(state, action, input, ctx) {
    if (action === 'revise-requirements') {
      const conditions = requirements(input.conditions, 'Closing conditions', ctx), documents = requirements(input.documents, 'Signed documents', ctx);
      for (const [before, after, records] of [[state.conditions, conditions, state.conditionEvidence], [state.documents, documents, state.signedDocuments]]) {
        for (const row of records) if (!after.some(next => before.some(prior => prior.id === row.id && prior.id === next.id && prior.label === next.label))) {
          upsertVersion(records, row.id, { ...latest(row), review: null }, ctx);
        }
      }
      state.conditions = conditions; state.documents = documents; addHistory(state, action, ctx, { conditions, documents });
    } else if (['record-condition', 'record-document'].includes(action)) {
      const isDocument = action === 'record-document';
      requireFind(isDocument ? state.documents : state.conditions, input.id, ctx, 'Closing requirement');
      const value = { source: binding(input, ctx), ...(isDocument ? { signers: text(input.signers, 'Signers', ctx, 500), executedAt: instant(input.executedAt, 'Execution timestamp', ctx) } : {}) };
      const row = { ...value, sha256: ctx.hash(value), review: null };
      upsertVersion(isDocument ? state.signedDocuments : state.conditionEvidence, input.id, row, ctx);
      addHistory(state, action, ctx, { id: input.id, sha256: row.sha256 });
    } else if (['accept-condition', 'accept-document'].includes(action)) {
      reviewer(ctx);
      const item = latest(requireFind(action === 'accept-document' ? state.signedDocuments : state.conditionEvidence, input.id, ctx, 'Closing evidence'));
      if (item.sha256 !== input.sha256) ctx.fail(409, 'Review the current evidence version.');
      verify(item.source, ctx);
      item.review = { by: ctx.user.username, at: ctx.now, notes: text(input.notes, 'Review notes', ctx), sha256: item.sha256 };
      addHistory(state, action, ctx, { id: input.id, sha256: item.sha256, review: item.review });
    } else return noAction(ctx);
    return state;
  },
  validate(state, ctx) { const errors = []; for (const [requirements, rows, label] of [[state.conditions, state.conditionEvidence, 'Condition'], [state.documents, state.signedDocuments, 'Executed document']]) for (const required of requirements) { const record = rows.find(row => row.id === required.id); if (!record) errors.push(`${label} missing: ${required.label}.`); else { const value = latest(record); verify(value.source, ctx); if (!value.review || value.review.sha256 !== value.sha256) errors.push(`${label} requires reviewer acceptance: ${required.label}.`); } } return result(errors, ['Signatures are inspected by the reviewer against pinned originals; this is not electronic-signature validation.']); },
  output(state, ctx) { this.validate(state, ctx); return { reference: state.reference, conditions: state.conditions.map(row => ({ ...row, evidence: state.conditionEvidence.find(value => value.id === row.id) ? latest(state.conditionEvidence.find(value => value.id === row.id)) : null })), binder: state.documents.map(row => ({ ...row, original: state.signedDocuments.find(value => value.id === row.id) ? latest(state.signedDocuments.find(value => value.id === row.id)) : null })), history: state.history }; },
  async exportFile(state, ctx, format) { if (format !== 'pdf') return noAction(ctx); const check = this.validate(state, ctx); if (check.errors.length) ctx.fail(409, check.errors.join(' ')); return binder('Signed closing binder · ' + state.reference, state.documents.map(row => ({ label: row.label, source: latest(requireFind(state.signedDocuments, row.id, ctx, 'Signed original')).source })), ctx, 'signed-closing-binder.pdf'); },
};

const personalInjury = {
  roleId: 'R44', title: 'Provider receipt matching', matterRequired: true,
  description: 'Deduplicate original attachments and hold ambiguous provider matches for explicit review.',
  fields: [...referenceFields, field('providers', 'Expected provider roster', 'json', { hint: '[{"id":"provider-1","name":"Clinic","aliases":["Clinic billing"]}]' })],
  actions: [
    { id: 'receive-attachment', label: 'Receive provider attachment', fields: [field('eventId', 'Stable delivery/event ID'), field('providerHint', 'Provider name on delivery'), field('receivedAt', 'Received timestamp'), ...sourceFields] },
    { id: 'resolve-provider', label: 'Resolve provider match', reviewerOnly: true, fields: [field('receiptId', 'Receipt ID'), field('providerId', 'Chosen provider ID'), field('notes', 'Matching evidence / reason', 'textarea')] },
  ],
  create(input, ctx) { return { reference: text(input.reference, 'Case reference', ctx, 200), providers: unique(array(input.providers, 'Provider roster', ctx, 1).map(row => ({ id: key(row.id, 'Provider ID', ctx), name: text(row.name, 'Provider name', ctx, 300), aliases: array(row.aliases ?? [], 'Provider aliases', ctx, 0, 30).map(value => text(value, 'Alias', ctx, 300)) })), 'id', ctx), receipts: [], deliveries: [], history: [] }; },
  update(state, action, input, ctx) {
    if (action === 'receive-attachment') {
      const eventId = key(input.eventId, 'Delivery ID', ctx), source = binding(input, ctx), providerHint = text(input.providerHint, 'Provider hint', ctx, 300), receivedAt = instant(input.receivedAt, 'Received timestamp', ctx);
      const event = state.deliveries.find(row => row.eventId === eventId);
      const fingerprint = ctx.hash({ sourceSha256: source.sha256, providerHint, receivedAt });
      if (event) { if (event.fingerprint !== fingerprint) ctx.fail(409, 'This delivery ID already identifies different content.'); return state; }
      if (state.deliveries.length >= 500) ctx.fail(409, 'Start a follow-up after 500 delivery events.');
      let receipt = state.receipts.find(row => row.source.sha256 === source.sha256);
      const matches = state.providers.filter(row => [row.name, ...row.aliases].some(value => normalize(value) === normalize(providerHint))).map(row => row.id);
      if (!receipt) {
        receipt = { id: 'receipt-' + source.sha256.slice(0, 24), source, providerHint, candidateProviderIds: matches, providerId: matches.length === 1 ? matches[0] : null, status: matches.length === 1 ? 'matched' : 'needs_review', receivedAt, review: null, reviewHistory: [] };
        state.receipts.push(receipt);
      } else if (matches.length !== 1 || matches[0] !== receipt.providerId) {
        receipt.candidateProviderIds = [...new Set([...receipt.candidateProviderIds, ...matches])];
        if (receipt.review) receipt.reviewHistory.push({ ...receipt.review, providerId: receipt.providerId });
        receipt.providerId = null; receipt.status = 'needs_review'; receipt.review = null;
      }
      state.deliveries.push({ eventId, fingerprint, receiptId: receipt.id, at: ctx.now });
      addHistory(state, action, ctx, { eventId, receiptId: receipt.id, duplicate: state.deliveries.filter(row => row.receiptId === receipt.id).length > 1 });
    } else if (action === 'resolve-provider') {
      reviewer(ctx);
      const receipt = requireFind(state.receipts, input.receiptId, ctx, 'Receipt');
      requireFind(state.providers, input.providerId, ctx, 'Provider');
      verify(receipt.source, ctx);
      if (receipt.review) receipt.reviewHistory.push({ ...receipt.review, providerId: receipt.providerId });
      receipt.providerId = input.providerId; receipt.status = 'reviewed'; receipt.review = { by: ctx.user.username, at: ctx.now, notes: text(input.notes, 'Match reason', ctx) };
      addHistory(state, action, ctx, { receiptId: receipt.id, providerId: input.providerId, review: receipt.review });
    } else return noAction(ctx);
    return state;
  },
  validate(state, ctx) { for (const receipt of state.receipts) verify(receipt.source, ctx); return result(!state.receipts.length ? ['Receive at least one attachment.'] : state.receipts.filter(row => !row.providerId || row.status === 'needs_review').map(row => `Receipt ${row.id} has an unresolved provider match.`)); },
  output(state, ctx) { this.validate(state, ctx); return { reference: state.reference, receipts: state.receipts, deliveryCount: state.deliveries.length, uniqueOriginalCount: state.receipts.length, duplicateDeliveries: state.deliveries.length - state.receipts.length, deliveries: state.deliveries, history: state.history }; },
};

const settlement = {
  roleId: 'R45', title: 'Settlement statement reconciliation', matterRequired: true,
  description: 'Reconcile allocations to cleared receipt evidence, approved payees and the latest recorded lien version.',
  fields: referenceFields,
  actions: [
    { id: 'record-receipt', label: 'Record / update receipt', fields: [field('id', 'Receipt reference'), field('amountCents', 'Receipt amount (cents)', 'number'), field('status', 'Receipt status', 'select', { options: ['pending', 'cleared', 'returned'] }), ...sourceFields] },
    { id: 'record-payee', label: 'Record / revise payee', fields: [field('id', 'Payee ID'), field('name', 'Payee name'), field('category', 'Payee category', 'select', { options: ['client', 'fee', 'cost', 'lien'] })] },
    { id: 'approve-payee', label: 'Approve payee', reviewerOnly: true, fields: [field('id', 'Payee ID'), field('sha256', 'Current payee SHA-256'), field('notes', 'Payee verification notes', 'textarea')] },
    { id: 'record-lien', label: 'Record current lien evidence', fields: [field('id', 'Lien ID'), field('payeeId', 'Lien payee ID'), field('amountCents', 'Current lien amount (cents)', 'number'), field('asOf', 'Evidence effective date', 'date'), ...sourceFields] },
    { id: 'set-allocations', label: 'Set settlement allocations', fields: [field('allocations', 'Allocations', 'json', { hint: '[{"payeeId":"client","amountCents":10000}]' })] },
  ],
  create(input, ctx) { return { reference: text(input.reference, 'Settlement reference', ctx, 200), currency: 'USD', receipts: [], payees: [], liens: [], allocations: [], history: [] }; },
  update(state, action, input, ctx) {
    if (action === 'record-receipt') {
      if (!['pending', 'cleared', 'returned'].includes(input.status)) ctx.fail(422, 'Choose the observed receipt status.');
      const id = key(input.id, 'Receipt reference', ctx), value = { amountCents: cents(input.amountCents, 'Receipt amount', ctx), status: input.status, source: binding(input, ctx) };
      const prior = state.receipts.find(row => row.id === id);
      if (prior && latest(prior).amountCents !== value.amountCents) ctx.fail(409, 'A receipt amount is immutable. Record a separately identified correction.');
      if (prior && ctx.hash({ amountCents: latest(prior).amountCents, status: latest(prior).status, source: latest(prior).source }) === ctx.hash(value)) return state;
      if (!prior && state.receipts.some(row => latest(row).source.sha256 === value.source.sha256)) ctx.fail(409, 'This receipt original is already recorded under another reference.');
      upsertVersion(state.receipts, id, value, ctx); addHistory(state, action, ctx, { id, status: value.status });
    } else if (action === 'record-payee') {
      if (!['client', 'fee', 'cost', 'lien'].includes(input.category)) ctx.fail(422, 'Choose a payee category.');
      const id = key(input.id, 'Payee ID', ctx), value = { name: text(input.name, 'Payee name', ctx, 300), category: input.category };
      upsertVersion(state.payees, id, { ...value, sha256: ctx.hash(value), review: null }, ctx); addHistory(state, action, ctx, { id });
    } else if (action === 'approve-payee') {
      reviewer(ctx);
      const payee = latest(requireFind(state.payees, input.id, ctx, 'Payee'));
      if (input.sha256 !== payee.sha256) ctx.fail(409, 'Review the current payee version.');
      payee.review = { by: ctx.user.username, at: ctx.now, sha256: payee.sha256, notes: text(input.notes, 'Verification notes', ctx) };
      addHistory(state, action, ctx, { id: input.id, sha256: payee.sha256, review: payee.review });
    } else if (action === 'record-lien') {
      const id = key(input.id, 'Lien ID', ctx), payee = requireFind(state.payees, input.payeeId, ctx, 'Lien payee');
      if (latest(payee).category !== 'lien') ctx.fail(422, 'The selected payee must be a lien holder.');
      const value = { payeeId: payee.id, amountCents: cents(input.amountCents, 'Lien amount', ctx, true), asOf: day(input.asOf, 'Lien effective date', ctx), source: binding(input, ctx) };
      const prior = state.liens.find(row => row.id === id);
      if (prior && latest(prior).asOf >= value.asOf) ctx.fail(409, 'New lien evidence must be later than the recorded version.');
      upsertVersion(state.liens, id, value, ctx); addHistory(state, action, ctx, { id, ...value });
    } else if (action === 'set-allocations') {
      state.allocations = unique(array(input.allocations, 'Allocations', ctx, 1).map(row => ({ payeeId: requireFind(state.payees, row.payeeId, ctx, 'Payee').id, amountCents: cents(row.amountCents, 'Allocation', ctx, true) })), 'payeeId', ctx);
      addHistory(state, action, ctx, { allocations: state.allocations });
    } else return noAction(ctx);
    return state;
  },
  validate(state, ctx) {
    const errors = [], receipts = current(state.receipts), payees = current(state.payees), liens = current(state.liens);
    for (const row of [...receipts, ...liens]) verify(row.source, ctx);
    if (!receipts.length || !receipts.some(row => row.status === 'cleared')) errors.push('Record cleared receipt evidence.');
    if (!state.allocations.length) errors.push('Record settlement allocations.');
    for (const allocation of state.allocations) {
      const payee = payees.find(row => row.id === allocation.payeeId);
      if (!payee?.review || payee.review.sha256 !== payee.sha256) errors.push(`Payee ${allocation.payeeId} requires current reviewer approval.`);
      if (payee?.category === 'lien' && !liens.some(row => row.payeeId === payee.id)) errors.push(`Lien payee ${payee.id} needs current lien evidence.`);
    }
    for (const payeeId of new Set(liens.map(row => row.payeeId))) {
      const lienTotal = total(liens.filter(row => row.payeeId === payeeId));
      if ((state.allocations.find(row => row.payeeId === payeeId)?.amountCents ?? -1) !== lienTotal) errors.push(`Allocation for ${payeeId} does not match the latest lien evidence.`);
    }
    const cleared = total(receipts.filter(row => row.status === 'cleared'));
    if (cleared !== total(state.allocations)) errors.push('Allocations do not reconcile to cleared receipts.');
    return result(errors, ['Receipt clearance and lien results are recorded from supplied evidence; no funds are moved.']);
  },
  output(state, ctx) { this.validate(state, ctx); const receipts = current(state.receipts), cleared = total(receipts.filter(row => row.status === 'cleared')); return { reference: state.reference, currency: state.currency, receipts, payees: current(state.payees), liens: current(state.liens), allocations: state.allocations, totals: { clearedCents: cleared, allocatedCents: total(state.allocations), differenceCents: cleared - total(state.allocations) }, history: state.history }; },
};

const investigator = {
  roleId: 'R46', title: 'Source-linked witness statements', matterRequired: true,
  description: 'Preserve witness statement revisions with exact excerpts, source hashes and event timestamps.',
  fields: [...referenceFields, field('objective', 'Investigation objective', 'textarea')],
  actions: [{ id: 'record-statement', label: 'Record / revise statement', fields: [field('id', 'Statement ID'), field('baseSha256', 'Previous statement SHA-256 (blank for new)', 'text', { required: false }), field('witnessReference', 'Witness reference'), field('eventAt', 'Statement / event timestamp'), field('excerpt', 'Exact supporting source excerpt', 'textarea'), field('summary', 'Statement summary', 'textarea'), ...sourceFields] }],
  create(input, ctx) { return { reference: text(input.reference, 'Investigation reference', ctx, 200), objective: text(input.objective, 'Objective', ctx), statements: [], history: [] }; },
  update(state, action, input, ctx) {
    if (action !== 'record-statement') return noAction(ctx);
    const id = key(input.id, 'Statement ID', ctx), source = binding(input, ctx), original = verify(source, ctx), excerpt = text(input.excerpt, 'Exact source excerpt', ctx, 5000);
    const page = original.pages.find(row => row.number === source.page);
    const normalizeText = value => String(value).replace(/\s+/g, ' ').trim();
    if (!normalizeText(page.text ?? '').includes(normalizeText(excerpt))) ctx.fail(422, 'The supporting excerpt was not found on the pinned physical source page.');
    const prior = state.statements.find(row => row.id === id);
    if (prior && input.baseSha256 !== latest(prior).sha256) ctx.fail(409, 'The statement changed. Review its current version.');
    const value = { witnessReference: text(input.witnessReference, 'Witness reference', ctx, 200), eventAt: instant(input.eventAt, 'Event timestamp', ctx), excerpt, summary: text(input.summary, 'Statement summary', ctx, 12000), source, supersedes: prior ? latest(prior).sha256 : null };
    upsertVersion(state.statements, id, { ...value, sha256: ctx.hash(value) }, ctx); addHistory(state, action, ctx, { id, source, sha256: ctx.hash(value) });
    return state;
  },
  validate(state, ctx) { for (const statement of state.statements) for (const version of statement.versions) verify(version.source, ctx); return result(state.statements.length ? [] : ['Record at least one source-linked statement.']); },
  output(state, ctx) { this.validate(state, ctx); return { reference: state.reference, objective: state.objective, statements: current(state.statements).sort((a, b) => a.eventAt.localeCompare(b.eventAt)), originals: [...new Map(current(state.statements).map(row => [row.source.sha256, row.source])).values()], history: state.history }; },
};

for (const def of [ipDocket, immigration, realEstate, personalInjury, settlement]) {
  def.assertExport = (live, approved, ctx) => {
    if (ctx.hash(live) !== ctx.hash(approved)) ctx.fail(409, 'This operational output was superseded. Review and approve the current work before export.');
  };
}

export const workflows = [patent, ipDocket, immigration, estate, realEstate, personalInjury, settlement, investigator];
