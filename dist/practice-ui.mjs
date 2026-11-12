import { reviewState, supportingPdf } from './model.mjs';
import {
  closeItems, currentSettlement, deductionTypes, demandText, dollars, moneyField, partyRoles, practice, queueItems,
  requestText, requestTypes, settlementTotals, updateText, workflowNames,
} from './practice.mjs';
import { buildPacket } from './packets.mjs';

const names = {
  lead: 'Inquiry', accepted: 'Accepted', declined: 'Declined', engaged: 'Engaged', cleared: 'Cleared', hold: 'On hold',
  draft: 'Draft', sent: 'Sent', partial: 'Partial', complete: 'Complete', cancelled: 'Cancelled',
  pending: 'Pending', planned: 'Follow-up', unconfirmed: 'Confirm date', confirmed: 'Confirmed', done: 'Done', approved: 'Approved',
};
const good = ['accepted', 'engaged', 'cleared', 'complete', 'confirmed', 'done', 'approved', 'sent'];

export function workflowUI(view) {
  const { button, pill, attribute, escape: e, field, option, showDialog, bindForm, errorSlot, cancelButton,
    submitButton, icon, render, toast, download, dialog } = view;
  const matter = () => view.state.matter;
  const current = () => practice(matter());
  const idData = row => attribute('id', row.id);
  const badge = status => pill(names[status] || status, good.includes(status) ? 'verified' :
    ['hold', 'partial', 'unconfirmed', 'pending'].includes(status) ? 'needs_review' : 'neutral');
  const action = (label, key, row, variant = '') => button(label, 'wf-edit', '', 'small ' + variant,
    attribute('key', key) + (row ? ' ' + idData(row) : ''));
  const openPdf = (label, documentId, page = 1) => button(label, 'view-doc', 'FileText', 'small',
    attribute('id', documentId) + ' ' + attribute('page', page));
  const sourceLink = row => openPdf('PDF p. ' + row.source.page, row.source.documentId, row.source.page);
  const upload = (label, purpose = 'supporting') => button(label, 'import', 'UploadCloud', 'small', attribute('purpose', purpose));
  const select = (label, key, options, value) => `<label class="form-field"><span>${e(label)}</span><select name="${key}">
    ${options.map(([id, text]) => option(id, text, value)).join('')}</select></label>`;
  const choices = (label, key, values, value) => select(label, key, values.map(entry => [entry, names[entry] || entry]), value);
  const area = (label, key, value, rows = 3, length = 900) => `<label class="form-field"><span>${e(label)}</span>
    <textarea name="${key}" rows="${rows}" maxlength="${length}">${e(value)}</textarea></label>`;
  const pair = (a, b) => `<div class="field-row">${a}${b}</div>`;
  const confirm = (label, key = 'attested') => `<label class="check-label wf-check"><input type="checkbox" name="${key}" required>
    <span>${e(label)}</span></label>`;
  const day = (label, key, value, optional = false) => field(label, key, value, 'type="date"' + (optional ? '' : ' required'));
  const amount = (label, key, value) => field(label, key, value, 'inputmode="decimal" required maxlength="11"');
  const note = text => text ? `<p>${e(text)}</p>` : '';
  const empty = text => `<p class="wf-empty">${e(text)}</p>`;
  const panel = (title, description, body, tools = '') => `<section class="panel wf-panel">
    <div class="wf-panel-head"><div><h3>${e(title)}</h3>${note(description)}</div><div class="button-row">${tools}</div></div>
    <div class="wf-panel-body">${body}</div></section>`;
  const row = (title, detail, actions, status = '', body = '') => `<div class="wf-row">
    <div class="wf-row-main"><div class="wf-row-title"><strong>${e(title)}</strong>${status}</div>
      ${detail ? `<small>${e(detail)}</small>` : ''}${body}</div>
    <div class="button-row">${actions}</div></div>`;
  const pdfSelect = (value, { supporting = false, optional = false, key = 'documentId', label = 'Source PDF' } = {}) => {
    const docs = matter().documents.filter(doc => !supporting || supportingPdf(doc));
    const options = docs.map(doc => [doc.id, doc.name + ' · ' + doc.pages.length + ' p.']);
    return select(label, key, optional || !options.length ? [['', optional ? 'No PDF selected' : 'Upload a PDF first'], ...options] : options, value);
  };
  const evidence = (value, optional = false) => pair(pdfSelect(value?.documentId, { optional }),
    field('Physical PDF page', 'page', value?.page ?? '1', 'type="number" min="1" step="1"'));
  const statements = state => state.settlement.versions;
  const listBy = (entries, id) => entries.find(entry => entry.id === id);

  function intake(state) {
    const item = state.intake;
    const decision = item.decision;
    const agreement = item.agreement;
    const stage = row('Inquiry status', decision ? decision.reason : item.inquiry || 'Record the facts of the inquiry.', [
      action('Edit inquiry', 'intake-details'), item.status === 'lead' ? action('Record decision', 'intake-decision') : action('Reopen inquiry', 'intake-reopen'),
    ].join(''), badge(item.status), item.contact ? note(item.contact) : '');
    const parties = item.parties.map(entry => row(entry.name, entry.role + (entry.aliases?.length ? ' · aliases ' + entry.aliases.join(', ') : ''), item.status === 'lead'
      ? action('Edit', 'party-save', entry) + action('Remove', 'party-remove', entry) : '')).join('');
    const conflict = item.conflict
      ? row('Conflict review', item.conflict.reason, '', badge(item.conflict.disposition),
        note(item.conflict.matches.length + ' candidate matches reviewed · ' + item.conflict.actor + ' · ' + item.conflict.at.slice(0, 10)))
      : empty('Review matching party names before deciding whether to accept this matter.');
    const engagement = agreement
      ? row('Signed engagement', agreement.date + ' · ' + agreement.actor, openPdf('View agreement', agreement.documentId), badge('engaged'))
      : empty('Upload the signed agreement as a supporting PDF, then record its signature date.');
    return panel('Inquiry', '', stage) +
      panel('Parties and conflict review', 'Matches are based on normalized names in this workspace. Review aliases and any other sources separately.',
        (parties || empty('Add the prospective client, adverse parties, and related parties.')) + conflict,
        item.status === 'lead' ? action('Add party', 'party-save') + button('Run conflict check', 'wf-conflicts', 'Search', 'small primary') : '') +
      panel('Engagement', '', engagement, upload('Attach agreement') +
        (['accepted', 'engaged'].includes(item.status) ? action('Record signed agreement', 'engagement-save', null, 'primary') : ''));
  }

  function records(state) {
    const open = state.requests.filter(item => !['complete', 'cancelled'].includes(item.status)).length;
    const rows = state.requests.map(item => {
      const dates = [item.from || item.to ? (item.from || 'Any start') + ' → ' + (item.to || 'Present') : '',
        item.sentDate ? 'Sent ' + item.sentDate : '', item.followUp ? 'Follow up ' + item.followUp : ''].filter(Boolean).join(' · ');
      const received = item.received.map(entry => {
        const name = matter().documents.find(doc => doc.id === entry.documentId)?.name;
        return `<div class="wf-receipt"><span>${e(name)} · ${e(entry.date)}${entry.notes ? ' · ' + e(entry.notes) : ''}</span>${openPdf('Open PDF', entry.documentId)}</div>`;
      }).join('');
      const tools = action('Edit', 'request-save', item) + button('Draft letter', 'wf-letter', 'FileText', 'small', idData(item))
        + (['draft', 'sent', 'partial'].includes(item.status) ? action('Log send', 'request-sent', item) : '')
        + (item.status !== 'cancelled' ? action('Link received PDF', 'request-receipt', item) : '')
        + action('Change status', 'request-status', item);
      return row(item.provider + ' · ' + item.kind, dates, tools, badge(item.status), note(item.scope) + note(item.statusNote) +
        (item.sends?.length > 1 ? note('Send history · ' + item.sends.join(', ')) : '') + received);
    }).join('');
    return panel('Provider requests', open + ' open · ' + state.requests.length + ' total',
      rows || empty('Add a provider request to start tracking coverage and follow-ups.'),
      upload('Import received records', 'medical') + action('Add request', 'request-save', null, 'primary'));
  }

  function versionList(kind, versions) {
    return versions.map(version => row('Version ' + version.version, version.actor + ' · ' + version.approvedAt.slice(0, 10),
      button(kind === 'demand' ? 'Download demand ZIP' : 'Download statement ZIP', 'wf-packet', 'Download', 'small',
        attribute('key', kind) + ' ' + idData(version)) +
      (kind === 'demand' ? button('Recipient ZIP', 'wf-packet', 'Download', 'small', 'data-key="demand-recipient" ' + idData(version)) +
        button('Open Negotiation', 'nav', 'ArrowRight', 'small', 'data-screen="negotiation"') : ''), badge('approved'),
      (version.closeouts ?? []).map(closeout => `<div class="wf-receipt"><span>Closed ${e(closeout.at.slice(0, 10))} · ${e(closeout.actor)}</span>
        ${button('Download closeout ZIP', 'wf-packet', 'Download', 'small', 'data-key="settlement" ' + idData(version) + ' ' + attribute('closeout', closeout.id))}</div>`).join(''),
    )).join('');
  }

  function demand(state) {
    const approved = reviewState(matter()).current;
    const total = state.bills.reduce((sum, item) => sum + item.amount, 0);
    const linked = state.demand.chronologyId === approved?.id && Boolean(approved);
    const rows = (items, key) => items.map(item => row(item.label, item.source.name + (key === 'bill' ? ' · ' + dollars(item.amount) : ''),
      sourceLink(item) + action('Edit', key + '-save', item) + action('Remove', key + '-remove', item))).join('');
    const draft = state.demand.body ? `<div class="wf-document">${e(state.demand.body)}</div>` : empty('Create a draft from the approved chronology, then review and fill in the demand terms.');
    const open = state.requests.filter(item => !['complete', 'cancelled'].includes(item.status)).length;
    return panel('Demand draft', approved ? 'Approved chronology v' + approved.version + (linked ? ' linked to draft' : ' available') :
      'Approve the current chronology to draft and approve a demand.', (open ? `<div class="wf-callout">${open} records request${open === 1 ? '' : 's'} still open.</div>` : '') +
      (state.demand.recipient ? note('Recipient · ' + state.demand.recipient) : '') + draft,
      approved ? action(state.demand.body ? 'Edit draft' : 'Draft demand', 'demand-save') +
        (state.demand.body ? action('Approve package', 'demand-approve', null, 'primary') : '') :
        button('Open chronology', 'nav', 'ListChecks', 'small', 'data-screen="chronology"')) +
      `<div class="wf-columns">${panel('Itemized bills', 'Total ' + dollars(total),
        rows(state.bills, 'bill') || empty('Add a bill with its amount and source page.'), upload('Attach bill') + action('Add bill', 'bill-save'))}
      ${panel('Exhibit pages', 'Exports copy the selected pages in this order. Review the exported pages before sharing.',
        rows(state.exhibits, 'exhibit') || empty('Select original PDF pages to include as exhibits.'), action('Add exhibit page', 'exhibit-save'))}</div>` +
      panel('Approved packages', '', versionList('demand', state.demand.versions) || empty('Approved demand versions will appear here.'));
  }

  function agenda(items, allMatters = false) {
    return items.map(item => row(item.title, item.due + ' · ' + (item.matterName ? item.matterName + ' · ' : '') + item.basis,
      allMatters ? button('Open matter', 'open-matter', 'ArrowRight', 'small', attribute('id', item.matterId) + ' ' + attribute('screen', item.screen)) :
        item.screen !== 'queue' ? button(item.screen === 'records' ? 'Open requests' : 'Open workstream', 'nav', 'ArrowRight', 'small', attribute('screen', item.screen)) :
          action('Edit', 'task-save', item) + action(item.status === 'confirmed' ? 'Mark done' : 'Confirm date', 'task-status', item),
      badge(item.status))).join('');
  }

  function queue(state) {
    const messages = state.updates.map(item => row(item.subject, 'To ' + item.recipient + (item.sentDate ? ' · Sent ' + item.sentDate : ''),
      (item.status === 'sent' ? '' : action('Edit', 'update-save', item)) +
      (item.status === 'draft' ? action('Approve', 'update-approve', item) : button('Download text', 'wf-update', 'Download', 'small', idData(item))) +
      (item.status === 'approved' ? action('Log delivery', 'update-sent', item) : ''), badge(item.status),
      `<details class="wf-details"><summary>Read update</summary><div class="wf-document">${e(item.body)}</div></details>`)).join('');
    const completed = state.tasks.filter(item => item.status === 'done').map(item =>
      row(item.title, item.due + ' · ' + item.basis, action('Reopen', 'task-status', item), badge('done'))).join('');
    return panel('Upcoming work', 'Record the source for each date. Confirm dates before relying on them.', agenda(queueItems(matter())) ||
      empty('Add a date or set a records follow-up to populate this queue.'), button('Export confirmed dates', 'calendar-export', 'Download', 'small') +
      action('Add deadline', 'task-save', null, 'primary')) +
      panel('Client updates', 'Draft and approve a message here. Record delivery after sending it.', messages ||
      empty('Start with a draft based on the current records and chronology.'), action('Draft update', 'update-save', null, 'primary')) +
      (completed ? panel('Completed work', '', completed) : '');
  }

  function closing(state) {
    const settlement = state.settlement;
    const totals = settlementTotals(settlement);
    const signed = currentSettlement(settlement);
    const locked = Boolean(settlement.closeout);
    const pending = settlement.deductions.filter(item => item.status === 'pending').length;
    const rows = settlement.deductions.map(item => row(item.label, item.kind + ' · ' + dollars(item.amount),
      (item.source ? sourceLink(item) : '') + (locked ? '' : action('Edit', 'deduction-save', item) + action('Remove', 'deduction-remove', item)), badge(item.status), note(item.note))).join('');
    const numbers = `<div class="wf-metrics">${[['Gross settlement', totals.gross], ['Deductions', totals.deductions], ['Net to client', totals.net]].map(([label, value]) =>
      `<div><small>${label}</small><strong>${dollars(value)}</strong></div>`).join('')}</div>`;
    return panel('Settlement breakdown', settlement.basis || 'Enter the settlement terms and record deductions before approving a statement.',
      numbers + (settlement.negotiated ? note('Accepted offer · ' + dollars(settlement.negotiated.amount) + ' · ' + settlement.negotiated.payer) +
        (settlement.amountOverride ? note('Amount adjustment · ' + settlement.amountOverride) : '') +
        button('Open Negotiation', 'nav', 'ArrowRight', 'small', 'data-screen="negotiation"') : '') + note(settlement.notes) +
      (totals.net < 0 || pending ? `<div class="wf-callout">${e(totals.net < 0 ? 'Deductions exceed gross settlement. ' : '')}${pending ? pending + ' deductions pending.' : ''}</div>` : ''),
      locked ? pill('Matter closed', 'verified') : action('Edit terms', 'settlement-save') + action('Approve statement', 'settlement-approve', null, 'primary')) +
      panel('Fees, costs and liens', '', rows || empty('Add the deductions that apply to this matter.'), locked ? '' : action('Add deduction', 'deduction-save')) +
      panel('Closeout', 'Review the final statement and attach any signed closing documents for the packet.',
        locked ? row('Closeout recorded', settlement.closeout.at.slice(0, 10) + ' · ' + settlement.closeout.actor, '', pill('Closed', 'verified')) :
          empty(signed ? 'The current statement is approved. Complete the closing checklist.' : 'Approve the current settlement statement before closing.'),
        locked ? action('Reopen matter', 'close-reopen') : upload('Attach closing PDF') + (signed ? action('Close matter', 'close-matter', null, 'primary') : '')) +
      panel('Approved statements and closing packages', '', versionList('settlement', statements(state)) || empty('Approved statements will appear here.'));
  }

  const screens = { intake, records, demand, queue, closing };

  function form(title, key, fields, data = {}, submit = 'Save') {
    showDialog(title, `<form class="dialog-body">${fields}${errorSlot}
      <div class="dialog-actions">${cancelButton()}${submitButton(submit)}</div></form>`);
    return bindForm(values => save(key, { ...values, ...data, ...Object.fromEntries(
      ['attested', 'check0', 'check1', 'check2'].map(name => [name, values[name] === 'on'])) }));
  }

  async function save(action, fields) {
    const selected = matter();
    try {
      const result = await view.state.store.workflow(selected, { ...fields, action });
      view.state.matter = result.matter;
    } catch (error) {
      if (error.status === 409) {
        view.state.matter = await view.state.store.matter(selected.id);
        render();
      }
      throw error;
    }
    render();
    toast('Saved to matter.');
  }

  function edit(key, id) {
    const state = current();
    const item = id ? { id } : {};
    const intake = state.intake;
    const request = listBy(state.requests, id);
    const task = listBy(state.tasks, id);
    const update = listBy(state.updates, id);
    const deduction = listBy(state.settlement.deductions, id);
    const bill = listBy(state.bills, id);
    const exhibit = listBy(state.exhibits, id);
    const activeChronology = reviewState(matter()).current;
    const reason = (label = 'Reason', value) => area(label, 'reason', value, 3, 700);
    const forms = {
      'intake-details': () => form('Edit inquiry', key, field('Contact', 'contact', intake.contact, 'maxlength="150"') + area('Inquiry notes', 'inquiry', intake.inquiry, 5, 1600)),
      'party-save': () => {
        const party = listBy(intake.parties, id);
        return form(party ? 'Edit party' : 'Add party', key, field('Party name', 'name', party?.name, 'maxlength="120" required') +
          choices('Role', 'role', partyRoles, party?.role) + area('Aliases or former names, one per line', 'aliases', party?.aliases?.join('\n'), 3, 1800), item);
      },
      'party-remove': () => form('Remove party', key, note('Removing a party clears the current conflict review.'), item, 'Remove party'),
      'intake-decision': () => form('Record intake decision', key, choices('Decision', 'status', ['accepted', 'declined']) + reason('Decision rationale') +
        confirm('I reviewed the inquiry and am recording my decision.')),
      'intake-reopen': () => form('Reopen inquiry', 'intake-decision', reason('Why are you reopening?') +
        confirm('I will review conflicts before accepting this inquiry again.'), { status: 'lead' }),
      'engagement-save': () => form('Record signed engagement', key, pdfSelect(intake.agreement?.documentId, { supporting: true, label: 'Signed agreement PDF' }) +
        day('Signature date', 'date', intake.agreement?.date) + confirm('I reviewed the signed agreement.')),
      'request-save': () => form(request ? 'Edit provider request' : 'Add provider request', key,
        pair(field('Provider', 'provider', request?.provider, 'required maxlength="150"'), choices('Request type', 'kind', requestTypes, request?.kind)) +
        pair(day('Service date from', 'from', request?.from, true), day('Service date to', 'to', request?.to, true)) +
        day('Follow-up date', 'followUp', request?.followUp, true) + area('Missing dates, bills or records', 'scope', request?.scope), item),
      'request-sent': () => form('Log request send', key, day('Date sent', 'date', request?.sentDate), item),
      'request-receipt': () => form('Link a received PDF', key, pdfSelect() + pair(day('Date received', 'date'), choices('Coverage', 'status', ['partial', 'complete'])) +
        area('Coverage notes', 'notes', '', 3, 600), item),
      'request-status': () => form('Change request status', key, choices('Status', 'status', ['draft', 'sent', 'cancelled'], request?.status) + reason(), item),
      'bill-save': () => form(bill ? 'Edit bill' : 'Add bill', key, pair(field('Bill description', 'label', bill?.label, 'required maxlength="150"'),
        amount('Amount billed', 'amount', bill && moneyField(bill.amount))) + evidence(bill?.source), item),
      'exhibit-save': () => form(exhibit ? 'Edit exhibit page' : 'Add exhibit page', key,
        field('Exhibit label', 'label', exhibit?.label, 'required maxlength="130"') + evidence(exhibit?.source), item),
      'bill-remove': () => form('Remove bill from draft', key, note(bill?.label), item, 'Remove bill'),
      'exhibit-remove': () => form('Remove exhibit from draft', key, note(exhibit?.label), item, 'Remove exhibit'),
      'demand-save': () => {
        const body = state.demand.body || demandText(matter());
        const result = form('Edit demand draft', key, field('Recipient', 'recipient', state.demand.recipient, 'maxlength="200"') +
          area('Demand letter', 'body', body, 13, 30000) + '<div><button type="button" class="text-link" id="rebuild-demand">Replace text with current chronology draft</button></div>');
        result.querySelector('#rebuild-demand').addEventListener('click', () => { result.elements.body.value = demandText(matter()); });
      },
      'demand-approve': () => {
        const total = state.bills.reduce((sum, bill) => sum + bill.amount, 0);
        return form('Approve demand package', key,
          note(dollars(total) + ' in itemized bills · ' + state.exhibits.length + ' selected exhibit pages') +
          confirm('I reviewed the letter, bill amounts, chronology and selected exhibit pages.'), { chronologyId: activeChronology?.id, billTotal: total }, 'Approve package');
      },
      'task-save': () => form(task ? 'Edit deadline' : 'Add deadline', key,
        pair(field('Task or deadline', 'title', task?.title, 'required maxlength="140"'), day('Due date', 'due', task?.due)) +
        area('Date source or basis', 'basis', task?.basis, 3, 650), item),
      'task-status': () => {
        const status = task?.status === 'confirmed' ? 'done' : task?.status === 'done' ? 'unconfirmed' : 'confirmed';
        return form(status === 'confirmed' ? 'Confirm deadline' : status === 'done' ? 'Complete task' : 'Reopen task', key,
          note(task?.title + ' · ' + task?.due + ' · ' + task?.basis) +
          (status === 'confirmed' ? confirm('I checked the date against its recorded source.') : ''), { ...item, status });
      },
      'update-save': () => form(update ? 'Edit client update' : 'Draft client update', key,
        pair(field('Recipient', 'recipient', update?.recipient ?? intake.contact, 'required maxlength="170"'),
          field('Subject', 'subject', update?.subject ?? 'Update on your matter', 'required maxlength="160"')) +
        area('Message', 'body', update?.body ?? updateText(matter()), 9, 6000), item),
      'update-approve': () => form('Approve client update', key, note(update?.subject + ' · ' + update?.recipient) +
        `<div class="wf-document">${e(update?.body)}</div>` +
        confirm('I reviewed the message and confirmed its recipient.'), item, 'Approve message'),
      'update-sent': () => form('Log client update delivery', key, day('Date sent', 'date'), item),
      'settlement-save': () => form('Edit settlement terms', key, amount('Gross settlement', 'gross', moneyField(state.settlement.gross)) +
        area('Terms or source', 'basis', state.settlement.basis, 3, 700) + area('Statement notes', 'notes', state.settlement.notes, 3, 2500) +
        (state.settlement.negotiated ? area('Reason if the amount changes', 'overrideReason', state.settlement.amountOverride, 2, 700) : '')),
      'deduction-save': () => form(deduction ? 'Edit deduction' : 'Add deduction', key,
        pair(choices('Deduction type', 'kind', deductionTypes, deduction?.kind), choices('Status', 'status', ['pending', 'confirmed'], deduction?.status)) +
        pair(field('Description', 'label', deduction?.label, 'required maxlength="140"'), amount('Amount', 'amount', deduction && moneyField(deduction.amount))) +
        evidence(deduction?.source, true) + area('Notes', 'note', deduction?.note, 2, 700), item),
      'deduction-remove': () => form('Remove deduction from draft', key, note(deduction?.label), item, 'Remove deduction'),
      'settlement-approve': () => form('Approve settlement statement', key,
        note('Net to client · ' + dollars(settlementTotals(state.settlement).net)) +
        confirm('I reconciled the settlement figures and reviewed each deduction.'), {}, 'Approve statement'),
      'close-matter': () => form('Close matter', key,
        closeItems.map((label, index) => confirm(label, 'check' + index)).join('') +
        pair(pdfSelect('', { optional: true, supporting: true, key: 'releaseId', label: 'Release PDF' }),
          pdfSelect('', { optional: true, supporting: true, key: 'letterId', label: 'Closing letter PDF' })) +
        area('Closeout notes', 'notes', '', 3, 1800), { versionId: currentSettlement(state.settlement)?.id }, 'Close matter'),
      'close-reopen': () => form('Reopen matter', key, reason('Why are you reopening?'), {}, 'Reopen matter'),
    };
    return forms[key]?.();
  }

  async function conflicts() {
    const result = await view.state.store.conflicts(matter());
    const rows = result.matches.map(match => row(match.name, match.role + ' · ' + match.matterName +
      (match.matchedName !== match.name ? ' · matched alias ' + match.matchedName : ''),
      button('Open matter', 'open-matter', 'ArrowRight', 'small', attribute('id', match.matterId) + ' data-screen="intake"'))).join('');
    return form('Review conflict candidates', 'conflict-review',
      (rows || note('No exact normalized-name matches in this workspace.')) +
      choices('Disposition', 'disposition', ['hold', 'cleared']) + area('Review rationale', 'reason', '', 3, 700) +
      confirm('I reviewed the candidates and any other relevant conflict sources.'), { matchKey: result.matchKey }, 'Record conflict review');
  }

  function updateDownload(id) {
    const update = listBy(current().updates, id);
    if (!update || update.status === 'draft') throw new Error('Approve the update before downloading it.');
    download(new Blob(['To: ' + update.recipient + '\nSubject: ' + update.subject + '\n\n' + update.body + '\n'], { type: 'text/plain' }), 'Client-update.txt');
  }

  async function packet(item) {
    const kind = item.dataset.key;
    const selected = matter();
    const version = listBy(kind.startsWith('demand') ? current().demand.versions : current().settlement.versions, item.dataset.id);
    if (!version) throw new Error('This version is unavailable.');
    item.disabled = true;
    try {
      const result = await buildPacket(kind, selected, version,
        (matter, document) => view.state.store.original(matter, document), location.origin, item.dataset.closeout);
      download(new Blob([result.bytes], { type: 'application/zip' }), result.name);
      toast('Approved package downloaded.');
    } finally { item.disabled = false; }
  }

  return {
    render: screen => `<section class="wf-content" aria-label="${workflowNames[screen]}"><div class="wf-heading"><h2>${workflowNames[screen]}</h2></div>
      ${screens[screen](current())}</section>`,
    upcoming: matters => {
      const entries = matters.flatMap(item => (item.queue ?? []).map(entry => ({ ...entry, matterName: item.name, matterId: item.id })))
        .sort((a, b) => a.due.localeCompare(b.due) || a.title.localeCompare(b.title)).slice(0, 8);
      return entries.length ? panel('Upcoming work across matters', '', agenda(entries, true)) : '';
    },
    actions: {
      'wf-edit': item => edit(item.dataset.key, item.dataset.id),
      'wf-conflicts': conflicts,
      'wf-packet': packet,
      'wf-update': item => updateDownload(item.dataset.id),
      'wf-letter': item => {
        const request = listBy(current().requests, item.dataset.id);
        if (!request) return;
        showDialog('Records request draft', `<div class="dialog-body"><div class="wf-document">${e(requestText(matter(), request))}</div>
          <div class="dialog-actions">${button('Download draft', 'wf-request-download', 'Download', 'primary', idData(request))}</div></div>`);
      },
      'wf-request-download': item => {
        const request = listBy(current().requests, item.dataset.id);
        if (request) download(new Blob([requestText(matter(), request)], { type: 'text/plain' }), 'Records-request.txt');
      },
    },
  };
}
