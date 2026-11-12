import { clean, getPage, now, referenceUrl, reviewState, uid, ValidationError } from './model.mjs';
import { changeOffice, officeQueue, officeRows } from './office.mjs';

export const workflowNames = {
  intake: 'Intake & engagement', records: 'Records collection', demand: 'Demand packages',
  queue: 'Deadlines & updates', closing: 'Settlement & closeout',
};
export const requestTypes = ['Medical records', 'Itemized bills', 'Records and bills', 'Other'];
export const partyRoles = ['Prospective client', 'Adverse party', 'Related party', 'Insurer'];
export const deductionTypes = ['Attorney fee', 'Case costs', 'Medical lien', 'Other deduction'];
export const closeItems = ['Settlement terms recorded', 'Release and closing documents reviewed', 'Final client statement reviewed'];

export function practice(matter) {
  if (matter.practice) return matter.practice;
  const state = {
    revision: 0, activity: [], intake: { status: 'lead', parties: [], conflict: null },
    requests: [], bills: [], exhibits: [], demand: { recipient: '', body: '', versions: [] },
    tasks: [], updates: [], settlement: { gross: 0, notes: '', deductions: [], versions: [], closeout: null },
  };
  if (matter.demo) {
    state.intake.parties = [
      { id: 'sample-client', name: 'Morgan Ellis', role: 'Prospective client' },
      { id: 'sample-adverse', name: 'Northline Logistics', role: 'Adverse party' },
    ];
    state.requests = [{ id: 'sample-request', provider: 'Alder Physical Therapy', kind: 'Itemized bills',
      from: '2026-04-22', to: '', scope: 'Include all visits through discharge.', followUp: '2026-11-18', status: 'draft', received: [] }];
    state.tasks = [{ id: 'sample-task', title: 'Review the treatment record packet',
      due: '2026-11-20', basis: 'Internal review date', status: 'unconfirmed' }];
  }
  return state;
}

function required(value, label, size) {
  if (typeof value !== 'string' || !clean(value, size)) throw new ValidationError('Enter ' + label + '.');
  return clean(value, size);
}

function choice(value, values, label) {
  if (!values.includes(value)) throw new ValidationError('Choose ' + label + '.');
  return value;
}

function date(value, label, optional = false) {
  if (!value && optional) return '';
  const parsed = /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(value + 'T00:00:00Z') : null;
  if (!parsed || Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new ValidationError('Enter a valid ' + label + '.');
  }
  return value;
}

export function money(value) {
  if (typeof value !== 'string' || !/^\d{1,8}(?:\.\d{1,2})?$/.test(value.trim())) {
    throw new ValidationError('Enter a dollar amount with up to two decimal places.');
  }
  const [whole, fractional = ''] = value.trim().split('.');
  return Number(whole) * 100 + Number(fractional.padEnd(2, '0'));
}

export const dollars = cents => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);
export const moneyField = cents => (cents / 100).toFixed(2);
const normalize = value => String(value ?? '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

export function conflictMatches(matter, others) {
  const partyNames = party => [party.name, ...(party.aliases ?? [])].map(normalize).filter(Boolean);
  const names = new Set(practice(matter).intake.parties.flatMap(partyNames));
  return others.filter(other => other.id !== matter.id).flatMap(other =>
    practice(other).intake.parties.flatMap(party => {
      const matchedName = [party.name, ...(party.aliases ?? [])].find(value => names.has(normalize(value)));
      return matchedName ? [{ matterId: other.id, matterName: other.name, name: party.name, role: party.role, matchedName }] : [];
    })).sort((a, b) => a.matterId.localeCompare(b.matterId) || a.name.localeCompare(b.name) || a.role.localeCompare(b.role));
}

function item(items, id) {
  const found = items.find(entry => entry.id === id);
  if (!found) throw new ValidationError('This item is unavailable in the matter.');
  return found;
}

function put(items, id, fields) {
  if (id) return Object.assign(item(items, id), fields);
  if (items.length >= 150) throw new ValidationError('This list has reached the pilot limit of 150 items.');
  const entry = { id: uid(), ...fields };
  items.push(entry);
  return entry;
}

function remove(items, id) { items.splice(items.indexOf(item(items, id)), 1); }

function pdf(matter, id) {
  return item(matter.documents, id);
}

function source(matter, input) {
  const doc = pdf(matter, input.documentId);
  const page = getPage(matter, doc.id, input.page);
  if (!page) throw new ValidationError('Choose a physical page in this matter’s PDF.');
  return { documentId: doc.id, name: doc.name, sha256: doc.sha256, page: page.number, label: page.label };
}

function attestation(input) {
  if (input.attested !== true) throw new ValidationError('Confirm that you reviewed this step.');
}

function fingerprint(matches) { return JSON.stringify(matches.map(row => [row.matterId, normalize(row.name), row.role, normalize(row.matchedName ?? row.name)])); }
function matterInfo(matter) { return { id: matter.id, name: matter.name, reference: matter.reference }; }

export function settlementTotals(settlement) {
  const deductions = settlement.deductions.reduce((total, row) => total + row.amount, 0);
  return { gross: settlement.gross, deductions, net: settlement.gross - deductions };
}

export function demandText(matter) {
  const state = practice(matter);
  const approved = reviewState(matter).current;
  if (!approved) throw new ValidationError('Approve the current medical chronology before drafting the demand.');
  return [
    'Re: ' + matter.name + (matter.reference ? ' (' + matter.reference + ')' : ''),
    '', 'Dear ' + (state.demand.recipient || '[recipient]') + ',',
    '', 'We submit the following summary and supporting records for your review.',
    '', 'Treatment chronology',
    ...approved.events.map(event => event.date + ' · ' + event.title + ' — ' + event.summary + ' (' + event.sourceName + ', PDF p. ' + event.page + ')'),
    '', 'Itemized bills',
    ...(state.bills.length ? state.bills.map(row => row.label + ' — ' + dollars(row.amount) + ' (' + row.source.name + ', PDF p. ' + row.source.page + ')')
      : ['[Confirm bills and damages before sending.]']),
    'Total itemized bills: ' + dollars(state.bills.reduce((sum, row) => sum + row.amount, 0)),
    '', 'Demand and response date', '[Insert the reviewed demand terms and response date.]', '', 'Sincerely,', '[Attorney]',
  ].join('\n');
}

export function updateText(matter) {
  const state = practice(matter);
  const open = state.requests.filter(row => !['complete', 'cancelled'].includes(row.status)).length;
  const approved = reviewState(matter).current;
  return [
    'Hello,', '', 'Here is an update on your matter.',
    open ? 'We are tracking ' + open + ' outstanding records or billing requests.' : 'There are no outstanding requests on the current records list.',
    approved ? 'We have completed our review of the current treatment timeline.' : 'Our review of the treatment records is ongoing.',
    '', 'Next step: [Add the next step and timing you can confirm.]', '', 'Best,', '[Attorney]',
  ].join('\n');
}

export function requestText(matter, row) {
  return [
    'To: ' + row.provider, 'Subject: ' + row.kind + ' request · ' + matter.reference,
    '', 'Please provide the ' + row.kind.toLowerCase() + ' for the patient identified in the accompanying authorization.',
    row.from || row.to ? 'Requested service dates: ' + (row.from || 'earliest available') + ' through ' + (row.to || 'present') + '.' : '',
    row.scope, '', 'Please let us know if any part of the requested material is unavailable.',
    '', 'Thank you,', '[Attorney]',
  ].filter((line, index, list) => line || list[index - 1]).join('\n');
}

export function queueItems(matter) {
  const state = practice(matter);
  return [
    ...officeQueue(matter),
    ...state.tasks.filter(row => row.status !== 'done').map(row => ({ ...row, screen: 'queue' })),
    ...state.requests.filter(row => row.followUp && !['complete', 'cancelled'].includes(row.status))
      .map(row => ({ id: row.id, title: 'Follow up with ' + row.provider, due: row.followUp, status: 'planned', basis: row.kind, screen: 'records' })),
  ].sort((a, b) => a.due.localeCompare(b.due) || a.title.localeCompare(b.title));
}

function setIntake(matter, state, input, { actor, others }) {
  const intake = state.intake;
  const action = input.action;
  if (action === 'intake-details') {
    Object.assign(intake, { contact: clean(input.contact, 150), inquiry: clean(input.inquiry, 1600) });
  } else if (action === 'party-save' || action === 'party-remove') {
    if (intake.status !== 'lead') throw new ValidationError('Reopen the intake before changing its parties.');
    if (action === 'party-remove') remove(intake.parties, input.id);
    else {
      const aliases = [...new Set(clean(input.aliases, 1800).split(/\r?\n/).map(value => clean(value, 120)).filter(Boolean))];
      if (aliases.length > 12) throw new ValidationError('Enter up to 12 aliases per party.');
      put(intake.parties, input.id, {
        name: required(input.name, 'the party name', 120), role: choice(input.role, partyRoles, 'a party role'), aliases,
      });
    }
    intake.conflict = null;
  } else if (action === 'conflict-review') {
    if (intake.status !== 'lead' || !intake.parties.length) throw new ValidationError('Add parties to an open inquiry before reviewing conflicts.');
    attestation(input);
    const matches = conflictMatches(matter, others);
    if (input.matchKey !== fingerprint(matches)) throw new ValidationError('The candidate list changed. Run the conflict check again.');
    intake.conflict = { matches, disposition: choice(input.disposition, ['cleared', 'hold'], 'a disposition'),
      reason: required(input.reason, 'the review rationale', 700), at: now(), actor };
  } else if (action === 'intake-decision') {
    const next = choice(input.status, ['lead', 'accepted', 'declined'], 'an intake decision');
    attestation(input);
    if (next === 'accepted' && (intake.status !== 'lead' || intake.conflict?.disposition !== 'cleared' ||
        fingerprint(intake.conflict.matches) !== fingerprint(conflictMatches(matter, others)))) {
      throw new ValidationError('Review the current conflict results and record clearance before accepting the matter.');
    }
    if (next !== 'lead' && intake.status !== 'lead') throw new ValidationError('Reopen the inquiry before recording a different decision.');
    intake.decision = { reason: required(input.reason, 'the decision rationale', 700), status: next, actor, at: now() };
    intake.status = next;
    if (next === 'lead') { intake.conflict = null; intake.agreement = null; }
  } else {
    if (!['accepted', 'engaged'].includes(intake.status)) throw new ValidationError('Accept the matter before recording engagement.');
    if (intake.conflict?.disposition !== 'cleared' ||
        fingerprint(intake.conflict.matches) !== fingerprint(conflictMatches(matter, others))) {
      throw new ValidationError('Reopen the inquiry and review the latest conflict candidates before recording engagement.');
    }
    attestation(input);
    const agreement = pdf(matter, input.documentId);
    if (agreement.purpose !== 'supporting') throw new ValidationError('Choose a signed agreement uploaded as a supporting PDF.');
    intake.agreement = { documentId: agreement.id, sha256: agreement.sha256, date: date(input.date, 'signature date'), actor, at: now() };
    intake.status = 'engaged';
  }
}

export function conflictResult(matter, others) {
  const matches = conflictMatches(matter, others);
  return { matches, matchKey: fingerprint(matches) };
}

function setRecords(matter, state, input) {
  const { id, action } = input;
  if (action === 'request-save') {
    const from = date(input.from, 'start date', true);
    const to = date(input.to, 'end date', true);
    if (from && to && from > to) throw new ValidationError('The end date must follow the start date.');
    const fields = {
      provider: required(input.provider, 'the provider', 150), kind: choice(input.kind, requestTypes, 'a request type'),
      from, to, scope: clean(input.scope, 900), followUp: date(input.followUp, 'follow-up date', true),
      ...(id ? {} : { status: 'draft', received: [] }),
    };
    if (id) {
      const previous = item(state.requests, id);
      if (!['draft', 'cancelled'].includes(previous.status) && ['provider', 'kind', 'from', 'to', 'scope'].some(key => fields[key] !== previous[key])) {
        fields.status = previous.received.length ? 'partial' : 'draft';
        fields.statusNote = 'Scope changed. Recheck coverage.';
      }
    }
    put(state.requests, id, fields);
    return;
  }
  const row = item(state.requests, id);
  if (action === 'request-sent') {
    if (!['draft', 'sent', 'partial'].includes(row.status)) throw new ValidationError('Reopen the request before recording another send.');
    row.sentDate = date(input.date, 'sent date');
    row.sends = [...new Set([...(row.sends ?? []), row.sentDate])];
    if (row.status !== 'partial') row.status = 'sent';
  } else if (action === 'request-receipt') {
    if (row.status === 'cancelled') throw new ValidationError('Reopen the request before recording receipt.');
    const document = pdf(matter, input.documentId);
    const status = choice(input.status, ['partial', 'complete'], 'a coverage status');
    const receipt = { documentId: document.id, date: date(input.date, 'receipt date'), notes: clean(input.notes, 600) };
    const existing = row.received.find(received => received.documentId === document.id);
    if (existing) Object.assign(existing, receipt);
    else row.received.push(receipt);
    row.status = status;
  } else {
    row.status = choice(input.status, ['cancelled', 'sent', 'draft'], 'a request status');
    if (row.status === 'sent' && !row.sentDate) throw new ValidationError('Record the sent date before using the sent status.');
    row.statusNote = required(input.reason, 'the reason for the status change', 500);
  }
}

function setDemand(matter, state, input, { actor }) {
  if (input.action === 'bill-save') {
    put(state.bills, input.id, { label: required(input.label, 'the bill description', 150), amount: money(input.amount), source: source(matter, input) });
  } else if (input.action === 'exhibit-save') {
    const evidence = source(matter, input);
    if (state.exhibits.some(row => row.id !== input.id && row.source.documentId === evidence.documentId && row.source.page === evidence.page)) {
      throw new ValidationError('This PDF page is already on the exhibit list.');
    }
    put(state.exhibits, input.id, { label: required(input.label, 'the exhibit label', 130), source: evidence });
  } else if (input.action === 'bill-remove' || input.action === 'exhibit-remove') {
    remove(input.action === 'bill-remove' ? state.bills : state.exhibits, input.id);
  } else if (input.action === 'demand-save') {
    state.demand.recipient = clean(input.recipient, 200);
    state.demand.body = required(input.body, 'the demand draft', 30000);
    state.demand.chronologyId = reviewState(matter).current?.id ?? null;
  } else {
    attestation(input);
    const chronology = reviewState(matter).current;
    if (!chronology || state.demand.chronologyId !== chronology.id || input.chronologyId !== chronology.id) {
      throw new ValidationError('Approve the current chronology, then update and save the demand draft against it.');
    }
    if (!state.demand.recipient || !state.demand.body || /\[(?:insert|attorney|recipient|confirm)/i.test(state.demand.body) || !state.exhibits.length) {
      throw new ValidationError('Enter a recipient, finish the draft placeholders, and select at least one exhibit page.');
    }
    const total = state.bills.reduce((sum, row) => sum + row.amount, 0);
    if (input.billTotal !== total) throw new ValidationError('The bill total changed. Review the new total.');
    const contents = { recipient: state.demand.recipient, body: state.demand.body, chronologyId: chronology.id,
      bills: structuredClone(state.bills), exhibits: structuredClone(state.exhibits), total };
    const previous = state.demand.versions[0];
    if (previous && JSON.stringify(previous.contents) === JSON.stringify(contents)) return;
    state.demand.versions.unshift({ id: uid(), version: state.demand.versions.length + 1, matter: matterInfo(matter),
      actor, approvedAt: now(), contents, chronology: structuredClone(chronology) });
  }
}

function setQueue(matter, state, input, { actor }) {
  if (input.action === 'task-save') {
    put(state.tasks, input.id, { title: required(input.title, 'the deadline or task', 140), due: date(input.due, 'due date'),
      basis: required(input.basis, 'the date source or basis', 650), status: 'unconfirmed' });
  } else if (input.action === 'task-status') {
    const row = item(state.tasks, input.id);
    const status = choice(input.status, ['confirmed', 'done', 'unconfirmed'], 'a task status');
    if ((status === 'done' && row.status !== 'confirmed') || (status === 'confirmed' && row.status !== 'unconfirmed')) {
      throw new ValidationError('Confirm the date before marking the task done.');
    }
    if (status === 'confirmed') attestation(input);
    Object.assign(row, { status, changedBy: actor, changedAt: now() });
  } else if (input.action === 'update-save') {
    const old = input.id ? item(state.updates, input.id) : null;
    if (old?.status === 'sent') throw new ValidationError('Create a new draft to follow up on a sent update.');
    put(state.updates, input.id, { recipient: required(input.recipient, 'the recipient', 170), subject: required(input.subject, 'the subject', 160),
      body: required(input.body, 'the update', 6000), status: 'draft', approvedAt: null, approvedBy: null });
  } else {
    const row = item(state.updates, input.id);
    if (input.action === 'update-approve') {
      if (row.status !== 'draft' || /\[(?:add|attorney)/i.test(row.body)) throw new ValidationError('Finish the draft before approving it.');
      attestation(input);
      Object.assign(row, { status: 'approved', approvedAt: now(), approvedBy: actor });
    } else {
      if (row.status !== 'approved') throw new ValidationError('Approve the update before recording delivery.');
      Object.assign(row, { status: 'sent', sentDate: date(input.date, 'sent date') });
    }
  }
}

function setClosing(matter, state, input, { actor }) {
  const settlement = state.settlement;
  if (settlement.closeout && input.action !== 'close-reopen' && input.action !== 'close-matter') {
    throw new ValidationError('Reopen the matter before amending the settlement.');
  }
  if (input.action === 'settlement-save') {
    const gross = money(input.gross);
    if (settlement.negotiated && settlement.gross !== gross) {
      settlement.amountOverride = required(input.overrideReason, 'the reason the gross differs from the accepted offer', 700);
    }
    settlement.gross = gross;
    settlement.notes = clean(input.notes, 2500);
    settlement.basis = required(input.basis, 'the settlement terms or source', 700);
  } else if (input.action === 'deduction-save') {
    const kind = choice(input.kind, deductionTypes, 'a deduction type');
    put(settlement.deductions, input.id, { kind, label: required(input.label, 'the deduction description', 140),
      amount: money(input.amount), status: choice(input.status, ['pending', 'confirmed'], 'a deduction status'),
      source: input.documentId ? source(matter, input) : null, note: clean(input.note, 700) });
  } else if (input.action === 'deduction-remove') {
    remove(settlement.deductions, input.id);
  } else if (input.action === 'settlement-approve') {
    attestation(input);
    const totals = settlementTotals(settlement);
    if (!totals.gross || totals.net < 0 || settlement.deductions.some(row => row.status === 'pending')) {
      throw new ValidationError('Enter the settlement amount, resolve pending deductions and reconcile the client net.');
    }
    const openLiens = officeRows({ practice: state }, 'lien').some(row => ['Asserted', 'Disputed', 'Negotiated'].includes(row.status));
    if (openLiens) throw new ValidationError('Review outstanding lien amounts before approving the statement.');
    const contents = settlementDraft(settlement);
    const previous = settlement.versions[0];
    if (previous && JSON.stringify(previous.contents) === JSON.stringify(contents)) return;
    settlement.versions.unshift({ id: uid(), version: settlement.versions.length + 1, matter: matterInfo(matter),
      actor, approvedAt: now(), contents });
  } else if (input.action === 'close-reopen') {
    if (!settlement.closeout) throw new ValidationError('The matter is already open.');
    required(input.reason, 'the reason for reopening', 700);
    settlement.closeout = null;
  } else {
    if (settlement.closeout) return;
    const previous = currentSettlement(settlement);
    if (!previous || previous.id !== input.versionId) throw new ValidationError('Approve the current settlement statement before closing.');
    if (!closeItems.every((_, index) => input['check' + index] === true)) throw new ValidationError('Confirm each closeout checklist item.');
    if (officeRows({ practice: state }, 'obligation').some(row => ['Open', 'Partial'].includes(row.status))) {
      throw new ValidationError('Resolve or record a waiver for the open settlement obligations before closing.');
    }
    const attachments = [...new Set([input.releaseId, input.letterId].filter(Boolean))].map(id => {
      const doc = pdf(matter, id);
      if (doc.purpose !== 'supporting') throw new ValidationError('Choose closing documents uploaded as supporting PDFs.');
      return { documentId: doc.id, name: doc.name, sha256: doc.sha256 };
    });
    const packet = { id: uid(), versionId: previous.id, notes: clean(input.notes, 1800), actor, at: now(), checklist: [...closeItems], attachments };
    previous.closeouts = [...(previous.closeouts ?? []), packet];
    settlement.closeout = packet;
  }
}

export function currentSettlement(settlement) {
  const previous = settlement.versions[0];
  if (!previous) return null;
  const draft = settlementDraft(settlement);
  return JSON.stringify(previous.contents) === JSON.stringify(draft) ? previous : null;
}

function settlementDraft(settlement) {
  return {
    totals: settlementTotals(settlement), basis: settlement.basis, notes: settlement.notes,
    deductions: structuredClone(settlement.deductions),
    ...(settlement.negotiated ? { negotiated: structuredClone(settlement.negotiated) } : {}),
    ...(settlement.amountOverride ? { amountOverride: settlement.amountOverride } : {}),
  };
}

const groups = [
  [setIntake, ['intake-details', 'party-save', 'party-remove', 'conflict-review', 'intake-decision', 'engagement-save']],
  [setRecords, ['request-save', 'request-sent', 'request-receipt', 'request-status']],
  [setDemand, ['bill-save', 'bill-remove', 'exhibit-save', 'exhibit-remove', 'demand-save', 'demand-approve']],
  [setQueue, ['task-save', 'task-status', 'update-save', 'update-approve', 'update-sent']],
  [setClosing, ['settlement-save', 'deduction-save', 'deduction-remove', 'settlement-approve', 'close-matter', 'close-reopen']],
];

export function changePractice(matter, input, actor, others = []) {
  if (!input || typeof input !== 'object') throw new ValidationError('Choose a workflow action.');
  const officeAction = ['office-save', 'office-accept', 'office-archive', 'office-apply-bills', 'office-apply-deductions'].includes(input.action);
  const handler = groups.find(([, actions]) => actions.includes(input.action))?.[0];
  if (!handler && !officeAction) throw new ValidationError('Choose a workflow action.');
  const state = structuredClone(practice(matter));
  const before = JSON.stringify(state);
  if (officeAction) changeOffice(matter, state, input, actor, currentSettlement(state.settlement));
  else handler(matter, state, input, { actor, others });
  if (before === JSON.stringify(state)) return;
  state.revision += 1;
  matter.updatedAt = now();
  state.activity.unshift({ action: input.action, actor, at: matter.updatedAt, itemId: clean(input.id, 80),
    ...(['conflict-review', 'intake-decision', 'close-reopen', 'request-status'].includes(input.action)
      ? { reason: clean(input.reason, 700) } : {}) });
  matter.practice = state;
}

export function packetText(kind, snapshot) {
  if (kind === 'demand') return snapshot.contents.body + '\n';
  const { totals, basis, notes, deductions, negotiated, amountOverride } = snapshot.contents;
  const closed = snapshot.selectedCloseout;
  return [
    'Settlement statement · ' + snapshot.matter.name,
    'Approved by ' + snapshot.actor + ' · ' + snapshot.approvedAt.slice(0, 10),
    '', 'Gross settlement: ' + dollars(totals.gross), 'Basis: ' + basis,
    ...(negotiated ? ['Accepted offer: ' + dollars(negotiated.amount) + ' · ' + negotiated.payer + ' · ' + negotiated.acceptedAt] : []),
    ...(amountOverride ? ['Amount adjustment: ' + amountOverride] : []),
    '', ...deductions.map(row => row.kind + ' · ' + row.label + ': ' + dollars(row.amount)),
    'Total deductions: ' + dollars(totals.deductions), 'Net to client: ' + dollars(totals.net),
    '', notes, ...(closed ? ['', 'Closeout recorded on ' + closed.at.slice(0, 10), ...closed.checklist, closed.notes] : []),
  ].join('\n') + '\n';
}

export function sourceIndex(matter, snapshot, origin) {
  return JSON.stringify({
    ...snapshot,
    contents: {
      ...snapshot.contents,
      ...Object.fromEntries(['bills', 'exhibits', 'deductions'].filter(key => snapshot.contents[key]).map(key => [key,
        snapshot.contents[key].map(row => ({ ...row, source: row.source ? {
          ...row.source, url: referenceUrl(origin, matter.id, row.source.documentId, row.source.page),
        } : null })),
      ])),
    },
  }, null, 2) + '\n';
}
