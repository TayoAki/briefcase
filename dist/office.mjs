import { clean, getPage, now, uid, ValidationError } from './model.mjs';
import { collections, officeSections } from './office-schema.mjs';

export const office = matter => matter.practice?.office ?? { records: {}, events: [] };
export const officeRows = (matter, type) => office(matter).records[type] ?? [];
export const officeSectionNames = Object.fromEntries(officeSections.map(section => [section.id, section.name]));
const rejected = message => { throw new ValidationError(message); };

export function validDay(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(value + 'T00:00:00Z');
  return Number.isFinite(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

const timestamp = value => {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d{1,3})?)?(?:Z|[+-]\d\d:\d\d)$/.test(value) ||
      !validDay(value.slice(0, 10))) return null;
  const time = new Date(value);
  return Number.isFinite(time.valueOf()) ? time.toISOString() : null;
};

function amount(value) {
  if (typeof value !== 'string' || !/^\d{1,8}(?:\.\d{1,2})?$/.test(value.trim())) return null;
  const [dollars, cents = ''] = value.trim().split('.');
  return Number(dollars) * 100 + Number(cents.padEnd(2, '0'));
}

const record = (state, type, id) => (state.records[type] ?? []).find(row => row.id === id);
const rows = (state, type) => state.records[type] ?? [];
const versionOf = row => ({ id: row.id, versionId: row.versionId, type: row.type, title: row.title });
const isCurrent = (state, pinned) => pinned && record(state, pinned.type, pinned.id)?.versionId === pinned.versionId;
const archived = row => row.status === 'Archived';

function needRecord(state, pinned, statuses, label) {
  const linked = pinned && record(state, pinned.type, pinned.id);
  if (!linked || !isCurrent(state, pinned) || (statuses.length && !statuses.includes(linked.status))) {
    rejected('Select a current ' + label + '.');
  }
  return linked;
}

function source(matter, value, field) {
  const doc = matter.documents.find(row => row.id === value?.documentId);
  const page = doc && getPage(matter, doc.id, value.page);
  if (!doc || !page || !Number.isInteger(Number(value.page))) rejected('Choose a physical page for ' + field.label + '.');
  return { documentId: doc.id, page: page.number, sha256: doc.sha256, name: doc.name, label: page.label };
}

function approvals(matter, state, type) {
  if (type === 'demand') return state.demand?.versions ?? [];
  if (type === 'settlement') return state.settlement?.versions ?? [];
  return matter.approvals ?? [];
}

function normalizeField(matter, practice, state, spec, raw) {
  if (raw === '' || raw == null || (spec.type === 'source' && !raw.documentId) || (Array.isArray(raw) && !raw.length)) {
    if (spec.required) rejected('Enter ' + spec.label.toLowerCase() + '.');
    return null;
  }
  if (spec.type === 'ref' || spec.type === 'list') {
    const keys = spec.type === 'list' ? raw : [raw];
    if (!Array.isArray(keys) || keys.length > 60 || keys.some(key => typeof key !== 'string')) rejected('Choose valid linked records.');
    const links = [...new Set(keys)].map(key => {
      const row = spec.options.map(type => record(state, type, key)).find(Boolean);
      if (!row || archived(row)) rejected('A linked ' + spec.label.toLowerCase() + ' is unavailable.');
      return versionOf(row);
    });
    return spec.type === 'ref' ? links[0] : links;
  }
  if (spec.type === 'source') return source(matter, raw, spec);
  if (spec.type === 'approval') {
    if (!approvals(matter, practice, spec.options[0]).some(item => item.id === raw)) rejected('Select an approved version.');
    return raw;
  }
  if (typeof raw !== 'string') rejected('Enter valid ' + spec.label.toLowerCase() + '.');
  const value = clean(raw, spec.type === 'note' ? 6500 : 250);
  if (spec.type === 'select' && !spec.options.includes(value)) rejected('Choose ' + spec.label.toLowerCase() + '.');
  if (spec.type === 'date' && !validDay(value)) rejected('Enter a valid date for ' + spec.label.toLowerCase() + '.');
  if (spec.type === 'time') {
    const time = timestamp(value);
    if (!time) rejected('Enter a valid date and time for ' + spec.label.toLowerCase() + '.');
    return time;
  }
  if (spec.type === 'money') {
    const money = amount(value);
    if (money === null) rejected('Enter a dollar amount with at most two decimal places.');
    return money;
  }
  if (spec.type === 'url') {
    let url;
    try { url = new URL(value); } catch { rejected('Enter a valid source URL.'); }
    if (url.protocol !== 'https:' || url.username || url.password) rejected('Use an HTTPS source URL.');
  }
  if (spec.required && !value) rejected('Enter ' + spec.label.toLowerCase() + '.');
  return value;
}

function assertReview(input) {
  if (input.attested !== true) rejected('Confirm you reviewed the exact record and supporting evidence.');
}

function reviewReason(input) {
  const reason = clean(input.reason, 750);
  if (!reason) rejected('Record your reason for this change.');
  return reason;
}

export function dueCandidate(trigger, rule) {
  if (!validDay(trigger) || !rule) return null;
  const { offset, method, roll, holidays } = rule;
  const number = Number(offset);
  if (!/^\d{1,3}$/.test(String(offset)) || number > 366 ||
      !['Calendar days', 'Business days'].includes(method) ||
      !['Keep calculated date', 'Move to next working day'].includes(roll)) return null;
  const holidaysList = String(holidays ?? '').split(/[\n,]+/).map(item => item.trim()).filter(Boolean);
  if (holidaysList.length > 100 || holidaysList.some(value => !validDay(value))) return null;
  const excluded = new Set(holidaysList);
  const date = new Date(trigger + 'T00:00:00Z');
  const advance = () => date.setUTCDate(date.getUTCDate() + 1);
  const working = () => ![0, 6].includes(date.getUTCDay()) && !excluded.has(date.toISOString().slice(0, 10));
  for (let count = 0; count < number;) {
    advance();
    if (method === 'Calendar days' || working()) count += 1;
  }
  if (roll === 'Move to next working day') while (!working()) advance();
  return date.toISOString().slice(0, 10);
}

export function financialSummary(state) {
  const active = (type, status) => rows(state, type).filter(row => row.status === status);
  const total = entries => entries.reduce((sum, row) => sum + row.fields.amount, 0);
  const receipts = total(active('receipt', 'Cleared'));
  const disbursed = total(active('disbursement', 'Cleared'));
  const pending = total(active('receipt', 'Pending'));
  const allocated = total(active('allocation', 'Approved'));
  const missing = active('disbursement', 'Cleared').filter(row => !isCurrent(state, row.fields.allocation)).length;
  return { receipts, disbursed, pending, allocated, balance: receipts - disbursed, missing };
}

function dueField(state, type, row) {
  const f = row.fields;
  if (type === 'deadline') {
    if (!['Confirmed', 'Proposed'].includes(row.status)) return null;
    if (!isCurrent(state, f.notice) || (f.rule && !isCurrent(state, f.rule))) return null;
    return row.status === 'Confirmed' ? f.confirmed : f.candidate;
  }
  if (type === 'offer') return row.status === 'Open' ? f.expires?.slice(0, 10) : null;
  if (['Approved', 'Closed', 'Complete', 'Done', 'Waived', 'Cancelled', 'Rejected', 'Declined', 'Delivered', 'Paid',
    'Resolved', 'Served', 'Reviewed', 'Taken', 'Held', 'Superseded', 'Archived', 'Expired', 'Transferred'].includes(row.status)) return null;
  return f.followUp ?? f.due ?? null;
}

export function officeQueue(matter) {
  const state = office(matter);
  return officeSections.flatMap(section => section.collections.flatMap(type => rows(state, type).flatMap(row => {
    const due = dueField(state, type, row);
    return due ? [{ id: row.id, title: row.title, due, screen: section.id, status: row.status === 'Confirmed' ? 'confirmed' : 'planned',
      basis: collections[type].label + ' · ' + row.status }] : [];
  })));
}

function checkUnique(state, type, key, value, id) {
  if (value && rows(state, type).some(row => row.id !== id && String(row.fields[key]).toLowerCase() === String(value).toLowerCase())) {
    rejected('This external identifier is already recorded.');
  }
}

function validateNegotiation(state, type, fields, status, prior) {
  if (type === 'offer') {
    if (!fields.amount) rejected('Enter a positive offer amount.');
    if (fields.expires && fields.expires <= fields.received) rejected('Expiry must follow the offer time.');
    if (fields.prior?.id === prior?.id && prior) rejected('Choose a different offer to reference.');
  } else if (type === 'authority') {
    if (status === 'Revoked') return;
    const offer = needRecord(state, fields.offer, ['Open'], 'offer revision');
    if (fields.recorded < offer.fields.received) rejected('Record instructions after the offer was made.');
    if (fields.representative && status === 'Recorded') {
      const representative = needRecord(state, fields.representative, ['Verified'], 'verified representative record');
      const day = fields.recorded.slice(0, 10);
      if (day < representative.fields.from || (representative.fields.to && day > representative.fields.to)) {
        rejected('The recorded authority falls outside the representative’s verified dates.');
      }
    }
  } else if (type === 'agreement') {
    const offer = needRecord(state, fields.offer, ['Accepted'], 'accepted offer');
    if (['Reviewed', 'Executed'].includes(status) && fields.amount !== offer.fields.amount) rejected('Reconcile the release amount with the accepted offer.');
    if (status === 'Executed' && !fields.executed) rejected('Record the execution date and exact signed release.');
  } else if (type === 'obligation') {
    needRecord(state, fields.agreement, ['Reviewed', 'Executed'], 'reviewed agreement');
    if (fields.kind === 'Payment' && !fields.amount) rejected('Enter the expected payment.');
    if (status === 'Complete' && fields.kind === 'Payment') {
      const matched = rows(state, 'receipt').filter(row => row.status === 'Cleared' && row.fields.obligation?.id === prior?.id)
        .reduce((sum, row) => sum + row.fields.amount, 0);
      if (matched < fields.amount) rejected('Match sufficient cleared receipts to this payment obligation.');
    }
  }
}

function validateFunds(currentStatement, state, type, fields, status, prior) {
  if (type === 'receipt' || type === 'disbursement') {
    checkUnique(state, type, 'externalId', fields.externalId, prior?.id);
    if (!fields.amount) rejected('Enter a positive transaction amount.');
    if (prior && ['Cleared', 'Reversed', 'Returned', 'Voided'].includes(prior.status) &&
        (prior.fields.externalId !== fields.externalId || prior.fields.amount !== fields.amount || prior.fields.allocation?.id !== fields.allocation?.id)) {
      rejected('Keep the recorded transaction identifier, amount and allocation. Record corrections as a separate external event.');
    }
  }
  if (type === 'allocation' && status === 'Approved') {
    const statement = currentStatement;
    if (!statement || statement.id !== fields.settlement) {
      rejected('Choose the current approved settlement statement.');
    }
    const previous = rows(state, 'allocation').filter(row => row.id !== prior?.id && row.status === 'Approved');
    const planned = previous.reduce((sum, row) => sum + row.fields.amount, fields.amount);
    const clientTotal = previous.filter(row => row.fields.kind === 'Client net').reduce((sum, row) => sum + row.fields.amount, fields.amount);
    if (!fields.amount || planned > Math.min(statement.contents.totals.gross, financialSummary(state).receipts) ||
        (fields.kind === 'Client net' && clientTotal > statement.contents.totals.net)) {
      rejected('Reconcile the allocation with the approved statement and cleared receipts.');
    }
    if (fields.kind === 'Lien' && fields.lien) {
      const lien = needRecord(state, fields.lien, ['Resolved', 'Paid'], 'resolved lien');
      if (fields.amount !== lien.fields.resolved) rejected('The allocation differs from the reviewed lien amount.');
    }
  }
  if (type === 'disbursement' && status === 'Cleared') {
    const allocation = needRecord(state, fields.allocation, ['Approved'], 'approved allocation');
    const other = rows(state, 'disbursement').filter(row => row.id !== prior?.id && row.status === 'Cleared');
    const already = other.filter(row => row.fields.allocation.id === allocation.id).reduce((sum, row) => sum + row.fields.amount, 0);
    const spent = other.reduce((sum, row) => sum + row.fields.amount, fields.amount);
    if (already + fields.amount > allocation.fields.amount || spent > financialSummary(state).receipts) {
      rejected('This disbursement exceeds the approved allocation or cleared funds.');
    }
  }
  if (type === 'reconciliation' && status === 'Reviewed') {
    const ledger = financialSummary(state);
    if (ledger.balance !== fields.balance || ledger.missing || ledger.pending ||
        rows(state, 'disbursement').some(row => row.status === 'Pending')) rejected('Resolve pending transactions and reconciliation differences before signoff.');
    fields.ledger = ledger;
  }
}

function validateCourt(state, type, fields, status) {
  if (type === 'rule' && !dueCandidate('2026-01-01', fields)) rejected('Check the day count and excluded dates.');
  if (type === 'deadline') {
    const notice = needRecord(state, fields.notice, ['Reviewed'], 'reviewed notice');
    const rule = fields.rule ? needRecord(state, fields.rule, ['Reviewed'], 'reviewed rule') : null;
    const court = record(state, 'courtcase', notice.fields.case.id);
    if (rule && rule.fields.forum.toLowerCase() !== court?.fields.forum.toLowerCase()) rejected('Choose a reviewed rule for this court or record an order date.');
    fields.candidate = fields.override ?? dueCandidate(notice.fields.trigger, rule?.fields);
    if (['Confirmed', 'Complete'].includes(status) && !fields.confirmed) rejected('Enter the lawyer-confirmed date.');
  }
  if (type === 'motion' && status === 'Approved') {
    for (const authority of fields.authorities) needRecord(state, authority, ['Verified'], 'verified authority');
    for (const fact of fields.facts ?? []) needRecord(state, fact, ['Reviewed'], 'reviewed evidence item');
  }
  if (type === 'filing' && status !== 'Ready') {
    if (status === 'Submitted') needRecord(state, fields.draft, ['Approved'], 'approved filing version');
    else {
      const row = record(state, fields.draft.type, fields.draft.id);
      const version = row?.versionId === fields.draft.versionId ? row : row?.history.find(entry => entry.versionId === fields.draft.versionId);
      if (version?.status !== 'Approved') rejected('The submitted draft approval is unavailable.');
    }
    if (['Accepted', 'Rejected'].includes(status) && !fields.receipt && !fields.source) rejected('Record the receipt or rejection evidence.');
  }
  if (type === 'service' && status === 'Served') {
    needRecord(state, fields.filing, ['Accepted'], 'accepted filing');
    if (!fields.source) rejected('Attach the proof of service.');
  }
  if (type === 'production' && ['Reviewed', 'Delivered', 'Supplemented'].includes(status)) {
    for (const evidence of fields.exhibits) {
      const item = needRecord(state, evidence, ['Reviewed'], 'reviewed evidence item');
      if (!item.fields.source) rejected('Attach a source page to each selected evidence item.');
    }
    if (['Delivered', 'Supplemented'].includes(status) && (!fields.date || !fields.source)) rejected('Record the delivery date and proof.');
  }
}

const transitionRules = {
  offer: { Open: ['Open', 'Withdrawn', 'Rejected', 'Impasse'], Withdrawn: [], Rejected: [], Impasse: [], Accepted: [] },
  authority: { Recorded: ['Revoked'], Revoked: [] },
  delivery: { Sent: ['Sent', 'Confirmed', 'Failed'], Confirmed: [], Failed: [] },
  agreement: { Draft: ['Draft', 'Reviewed'], Reviewed: ['Draft', 'Reviewed', 'Executed', 'Superseded'], Executed: ['Superseded'], Superseded: [] },
  receipt: { Pending: ['Pending', 'Cleared', 'Reversed'], Cleared: ['Reversed'], Reversed: [] },
  disbursement: { Pending: ['Pending', 'Cleared', 'Returned', 'Voided'], Cleared: ['Returned'], Returned: [], Voided: [] },
  allocation: { Draft: ['Draft', 'Approved'], Approved: ['Voided'], Voided: [] },
  filing: { Ready: ['Ready', 'Submitted'], Submitted: ['Accepted', 'Rejected'], Accepted: [], Rejected: [] },
  signature: { Draft: ['Draft', 'Approved'], Approved: ['Requested', 'Voided'], Requested: ['Signed', 'Voided'], Signed: [], Voided: [] },
  correspondence: { Draft: ['Draft', 'Approved'], Received: [], Approved: ['Sent', 'Failed'], Sent: [], Failed: [] },
};
const initialStatus = {
  offer: ['Open'], authority: ['Recorded'], agreement: ['Draft'], allocation: ['Draft'],
  filing: ['Ready'], signature: ['Draft'], correspondence: ['Draft', 'Received'],
};
export function recordStatuses(type, prior) {
  return prior ? transitionRules[type]?.[prior.status] ?? collections[type].status : initialStatus[type] ?? collections[type].status;
}

function appendVersion(row, values, actor, reason = '') {
  const { title, fields, status, versionId, changedAt, changedBy, reason: formerReason } = row;
  if (versionId) row.history.unshift({ title, fields, status, versionId, changedAt, changedBy, reason: formerReason });
  Object.assign(row, values, { versionId: uid(), changedAt: now(), changedBy: actor, reason });
  return row;
}

function saveRecord(matter, practice, state, input, actor, currentStatement) {
  const type = input.type;
  const spec = Object.hasOwn(collections, type) && collections[type];
  if (!spec) rejected('Choose a workstream.');
  const prior = input.id ? record(state, type, input.id) : null;
  if (input.id && (!prior || prior.versionId !== input.versionId || archived(prior))) rejected('This record changed. Reopen the editor.');
  const title = clean(input.title, 160);
  if (!title) rejected('Enter a title.');
  const status = input.status;
  if (!recordStatuses(type, prior).includes(status)) rejected('Choose an available status transition.');
  const fields = type === 'authority' && status === 'Revoked' && prior ? structuredClone(prior.fields) : Object.fromEntries(spec.fields.map(field => [
    field.key, normalizeField(matter, practice, state, field, input.fields?.[field.key]),
  ]));
  if (prior?.status === 'Submitted' && type === 'filing' && fields.draft?.id === prior.fields.draft.id) fields.draft = prior.fields.draft;
  if (type === 'delivery' && prior && ['Confirmed', 'Failed'].includes(status) &&
      ['demand', 'recipient', 'channel', 'date'].some(key => fields[key] !== prior.fields[key])) rejected('Record a separate delivery attempt for changed recipients or contents.');
  if (prior && !['Draft', 'Open', 'Pending', 'Ready', 'Sent'].includes(prior.status) &&
      ['authority', 'agreement', 'correspondence', 'signature', 'filing', 'allocation'].includes(type) &&
      status !== 'Draft' && (title !== prior.title || spec.fields.some(field => {
        const previous = prior.fields[field.key];
        const next = fields[field.key];
        const optionalUpdates = { agreement: ['executed', 'source'], correspondence: ['receipt', 'date'], signature: ['requested', 'signed', 'externalId', 'source'],
          filing: ['receipt', 'source', 'details', 'date'] };
        return !optionalUpdates[type]?.includes(field.key) && JSON.stringify(previous) !== JSON.stringify(next);
      }))) rejected('Create a new draft for changed approved terms.');
  if (spec.review.includes(status)) assertReview(input);
  if (type === 'authority' && status === 'Revoked') reviewReason(input);
  if (type === 'caseplan' && fields.after && prior) {
    const seen = new Set([prior.id]);
    for (let linked = fields.after; linked; linked = record(state, 'caseplan', linked.id)?.fields.after) {
      if (seen.has(linked.id)) rejected('This prerequisite would create a cycle.');
      seen.add(linked.id);
    }
  }
  if (fields.from && fields.to && fields.from > fields.to) rejected('The end date must follow the start date.');
  if (type === 'retention' && ['Cleared for disposition', 'Completed externally'].includes(status) &&
      rows(state, 'hold').some(row => row.status === 'Active')) rejected('Resolve the active records hold before disposition.');
  if (type === 'authoritysource' && status === 'Verified' && !fields.treatment) rejected('Record your source and treatment check.');
  if (type === 'lien' && ['Resolved', 'Paid'].includes(status) && (fields.resolved === null || !fields.source)) rejected('Record the reviewed amount and its source.');
  if (type === 'signature' && status === 'Signed' && !fields.signed) rejected('Record the signature date and signed document.');
  if (type === 'correspondence' && status === 'Sent' && !fields.receipt) rejected('Record delivery evidence or its identifier.');
  if (type === 'offer' && ['Withdrawn', 'Rejected', 'Impasse'].includes(status)) assertReview(input);
  if (type === 'delivery' && status === 'Confirmed' && !fields.source && !fields.details) rejected('Record delivery confirmation evidence.');
  validateNegotiation(state, type, fields, status, prior);
  validateFunds(currentStatement, state, type, fields, status, prior);
  validateCourt(state, type, fields, status);
  const list = state.records[type] ??= [];
  if (type === 'delivery' && !prior && list.some(row => row.status === status && JSON.stringify(row.fields) === JSON.stringify(fields))) {
    return list.find(row => row.status === status && JSON.stringify(row.fields) === JSON.stringify(fields));
  }
  if (prior && title === prior.title && status === prior.status && JSON.stringify(fields) === JSON.stringify(prior.fields)) return prior;
  if (!prior && list.length >= 200) rejected('This workstream reached the pilot limit of 200 records.');
  const row = prior ?? { id: uid(), type, history: [] };
  if (row.history.length >= 200) rejected('This record reached the pilot history limit.');
  appendVersion(row, { title, fields, status }, actor, clean(input.reason, 750));
  if (!prior) list.unshift(row);
  state.events.unshift({ id: uid(), type, recordId: row.id, action: status, at: row.changedAt, actor });
  return row;
}

function acceptOffer(practice, state, input, actor) {
  const offer = record(state, 'offer', input.id);
  const authority = record(state, 'authority', input.authorityId);
  const settlement = practice.settlement;
  if (offer?.status === 'Accepted' && settlement.negotiated?.offerId === offer.id &&
      settlement.negotiated?.authorityId === input.authorityId && settlement.negotiated?.offerVersionId === input.versionId) return;
  assertReview(input);
  if (!offer || offer.versionId !== input.versionId || offer.status !== 'Open') rejected('Choose a current open offer.');
  if (!authority || authority.versionId !== input.authorityVersion || authority.status !== 'Recorded' ||
      authority.fields.offer.versionId !== offer.versionId || authority.fields.decision !== 'Accept exact terms') {
    rejected('Record current client authority to accept this exact offer.');
  }
  if (authority.fields.conditions && input.conditionsMet !== true) rejected('Confirm the recorded conditions were satisfied.');
  if (authority.fields.representative) needRecord(state, authority.fields.representative, ['Verified'], 'current representative record');
  const acceptedAt = timestamp(input.acceptedAt);
  if (!acceptedAt || acceptedAt < authority.fields.recorded || acceptedAt > now() ||
      (offer.fields.expires && acceptedAt > offer.fields.expires)) rejected('Record an acceptance time within the offer and authority window.');
  if (settlement.closeout || settlement.versions.length || settlement.negotiated) {
    rejected('The matter already has a settlement handoff or approved statement. Review that existing record.');
  }
  if (settlement.gross && settlement.gross !== offer.fields.amount && input.replaceDraft !== true) {
    rejected('Confirm that the accepted amount replaces the current settlement draft.');
  }
  settlement.negotiated = {
    offerId: offer.id, offerVersionId: offer.versionId, authorityId: authority.id, authorityVersionId: authority.versionId,
    payer: offer.fields.payer, amount: offer.fields.amount, terms: offer.fields.terms, source: offer.fields.source,
    acceptedAt, recordedAt: now(), actor,
  };
  settlement.gross = offer.fields.amount;
  settlement.basis = 'Accepted offer · ' + offer.fields.payer + ' · ' + acceptedAt;
  appendVersion(offer, { title: offer.title, status: 'Accepted', fields: offer.fields }, actor, 'Authority recorded and handoff created.');
  state.events.unshift({ id: uid(), type: 'offer', recordId: offer.id, action: 'Accepted and carried into Settlement', at: now(), actor });
}

export function changeOffice(matter, practice, input, actor, currentStatement) {
  const state = practice.office ??= { records: {}, events: [] };
  if (input.action === 'office-save') return saveRecord(matter, practice, state, input, actor, currentStatement);
  if (input.action === 'office-accept') return acceptOffer(practice, state, input, actor);
  if (input.action === 'office-apply-bills') {
    assertReview(input);
    for (const entry of rows(state, 'damage').filter(row => row.status === 'Reviewed' && row.fields.kind === 'Medical bill')) {
      const { amount, source } = entry.fields;
      const existing = practice.bills.find(row => row.officeId === entry.id);
      if (existing) Object.assign(existing, { label: entry.title, amount, source });
      else if (!practice.bills.some(row => row.amount === amount && row.source.documentId === source.documentId && row.source.page === source.page)) {
        if (practice.bills.length >= 150) rejected('The demand bill list reached its pilot limit.');
        practice.bills.push({ id: uid(), officeId: entry.id, label: entry.title, amount, source });
      }
    }
    return;
  }
  if (input.action === 'office-apply-deductions') {
    assertReview(input);
    if (practice.settlement.closeout) rejected('Reopen the matter before amending settlement inputs.');
    const reviewed = [
      ...rows(state, 'lien').filter(row => ['Resolved', 'Paid'].includes(row.status))
        .map(row => ({ row, amount: row.fields.resolved, kind: 'Medical lien' })),
      ...rows(state, 'casecost').filter(row => row.status === 'Paid' && row.fields.reimbursable === 'Yes')
        .map(row => ({ row, amount: row.fields.amount, kind: 'Case costs' })),
    ];
    for (const { row, amount, kind } of reviewed) {
      const deduction = { officeId: row.id, kind, label: row.title, amount, source: row.fields.source, status: 'confirmed', note: 'Reviewed workstream entry' };
      const existing = practice.settlement.deductions.find(item => item.officeId === row.id);
      if (existing) Object.assign(existing, deduction);
      else if (!practice.settlement.deductions.some(item => item.kind === kind && item.amount === amount && item.label === row.title)) {
        if (practice.settlement.deductions.length >= 150) rejected('The deduction list reached its pilot limit.');
        practice.settlement.deductions.push({ id: uid(), ...deduction });
      }
    }
    return;
  }
  if (input.action === 'office-archive') {
    const row = record(state, input.type, input.id);
    if (!row || row.versionId !== input.versionId || archived(row)) rejected('This record changed. Refresh and retry.');
    if (['offer', 'authority', 'agreement', 'receipt', 'allocation', 'disbursement', 'reconciliation', 'hold'].includes(row.type)) {
      rejected('Use the recorded workflow status to resolve this item.');
    }
    assertReview(input);
    appendVersion(row, { title: row.title, status: 'Archived', fields: row.fields }, actor, reviewReason(input));
    state.events.unshift({ id: uid(), type: row.type, recordId: row.id, action: 'Archived', at: now(), actor });
    return row;
  }
  rejected('Choose a workflow action.');
}
