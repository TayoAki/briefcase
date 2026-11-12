import { officeSections, collections } from './office-schema.mjs';
import { financialSummary, office, officeRows, recordStatuses } from './office.mjs';
import { dollars, moneyField, practice } from './practice.mjs';
import { buildOfficePacket } from './packets.mjs';

const tones = {
  Accepted: 'verified', Approved: 'verified', Verified: 'verified', Confirmed: 'verified', Executed: 'verified',
  Reviewed: 'verified', Complete: 'verified', Cleared: 'verified', Delivered: 'verified', Served: 'verified',
  Failed: 'issue', Rejected: 'issue', Revoked: 'issue', Disputed: 'needs_review', Partial: 'needs_review',
  Pending: 'needs_review', Proposed: 'needs_review', Archived: 'neutral',
};
const displayTime = value => value ? new Date(value).toLocaleString() : '';
function localTime(value) {
  if (!value) return '';
  const time = new Date(value);
  return new Date(time.valueOf() - time.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}
const nameFor = (type, value) => type === 'source' ? value.name + ' · PDF p. ' + value.page :
  type === 'money' ? dollars(value) : type === 'time' ? displayTime(value) :
    type === 'list' ? value.map(item => item.title).join(', ') : type === 'ref' ? value.title : String(value);

export function officeUI(view) {
  const { state, escape: e, option, field, button, pill, attribute, icon, showDialog, bindForm, errorSlot, cancelButton,
    submitButton, render, toast, download } = view;
  const tabs = {};
  const current = () => state.matter;
  const read = type => officeRows(current(), type);
  const find = (type, id) => read(type).find(item => item.id === id);
  const idFor = (type, row) => attribute('type', type) + (row ? ' ' + attribute('id', row.id) : '');
  const act = (label, action, type, row, graphic = '', variant = 'small') => button(label, action, graphic, variant, idFor(type, row));
  const statusPill = status => pill(status, tones[status] ?? 'neutral');
  const docLink = source => source ? button('PDF p. ' + source.page, 'view-doc', 'FileText', 'small',
    attribute('id', source.documentId) + ' ' + attribute('page', source.page)) : '';
  const formSelect = (label, name, entries, value, required = true) =>
    `<label class="form-field"><span>${e(label)}</span><select name="${e(name)}"${required ? ' required' : ''}>
      ${option('', required ? 'Choose…' : 'None', value ?? '')}${entries.map(([id, name]) => option(id, name, value)).join('')}
    </select></label>`;
  const textarea = (label, name, value, required = false) => `<label class="form-field"><span>${e(label)}</span>
    <textarea name="${e(name)}" rows="3" maxlength="6500"${required ? ' required' : ''}>${e(value)}</textarea></label>`;
  const confirm = (label, name = 'attested', required = true) => `<label class="check-label wf-check">
    <input type="checkbox" name="${name}"${required ? ' required' : ''}><span>${e(label)}</span></label>`;
  const approved = key => key === 'demand' ? practice(current()).demand.versions :
    key === 'settlement' ? practice(current()).settlement.versions : current().approvals;
  const refs = types => types.flatMap(type => read(type).filter(row => row.status !== 'Archived')
    .map(row => [row.id, row.title + ' · ' + row.status]));
  const moneyMetrics = summary => `<div class="wf-metrics office-metrics">${[
    ['Cleared receipts', summary.receipts], ['Cleared disbursements', summary.disbursed], ['Cleared balance', summary.balance],
  ].map(([label, value]) => `<div><small>${label}</small><strong>${dollars(value)}</strong></div>`).join('')}</div>`;

  function renderField(spec, value) {
    const { key, label, required, options, type } = spec;
    const req = required ? ' required' : '';
    if (type === 'select') return formSelect(label, key, options.map(value => [value, value]), value, required);
    if (type === 'ref') return formSelect(label, key, refs(options), value?.id, required);
    if (type === 'approval') return formSelect(label, key, approved(options[0]).map(row =>
      [row.id, 'Version ' + row.version + ' · ' + (row.approvedAt ?? '').slice(0, 10)]), value, required);
    if (type === 'list') {
      const selected = new Set((value ?? []).map(item => item.id));
      const entries = refs(options);
      return `<fieldset class="office-list-input"><legend>${e(label)}${required ? ' · select at least one' : ''}</legend>
        ${entries.length ? entries.map(([id, title]) => `<label class="check-label"><input type="checkbox" name="${key}"
          value="${e(id)}"${selected.has(id) ? ' checked' : ''}>${e(title)}</label>`).join('') : '<p>Add a linked record first.</p>'}</fieldset>`;
    }
    if (type === 'source') return `<div class="field-row">
      ${formSelect(label, 'sourceDocument', current().documents.map(doc => [doc.id, doc.name + ' · ' + doc.pages.length + ' pages']), value?.documentId, required)}
      ${field('Physical page', 'sourcePage', value?.page ?? 1, 'type="number" min="1" step="1"')}</div>`;
    if (type === 'note') return textarea(label, key, value, required);
    if (type === 'date') return field(label, key, value, 'type="date"' + req);
    if (type === 'time') return field(label + ' (local time)', key, localTime(value), 'type="datetime-local"' + req);
    if (type === 'money') return field(label, key, value != null ? moneyField(value) : '', 'inputmode="decimal" maxlength="11"' + req);
    if (type === 'url') return field(label, key, value, 'type="url" maxlength="250"' + req);
    return field(label, key, value, 'maxlength="250"' + req);
  }

  async function save(input) {
    const matter = current();
    try {
      const result = await state.store.workflow(matter, input);
      state.matter = result.matter;
    } catch (error) {
      if (error.status === 409) {
        state.matter = await state.store.matter(matter.id);
        render();
      }
      throw error;
    }
    render();
    toast(input.action === 'office-accept' ? 'Accepted terms carried into Settlement.' : 'Saved to matter.');
  }

  function form(title, content, work, label = 'Save record') {
    showDialog(title, `<form class="dialog-body">${content}${errorSlot}
      <div class="dialog-actions">${cancelButton()}${submitButton(label)}</div></form>`);
    return bindForm(work);
  }

  function edit(type, item) {
    const spec = collections[type];
    const statuses = recordStatuses(type, item);
    const revoke = type === 'authority' && item;
    const titleField = revoke ? '' : field('Record title', 'title', item?.title, 'maxlength="160" required');
    const fields = revoke ? '' : spec.fields.map(entry => renderField(entry, item?.fields[entry.key])).join('');
    return form(item ? (revoke ? 'Revoke recorded authority' : 'Update ' + spec.label.toLowerCase()) : 'Add ' + spec.label.toLowerCase(),
      titleField + formSelect('Status', 'status', statuses.map(value => [value, value]), statuses.includes(item?.status) ? item.status : statuses[0]) + fields +
      textarea('Review or change reason', 'reason', '', Boolean(revoke)) +
      confirm('I reviewed this record and its supporting evidence where this status requires it.', 'attested', false),
      (values, element) => {
        const fields = Object.fromEntries(spec.fields.map(entry => {
          const value = values[entry.key];
          if (entry.type === 'source') return [entry.key, { documentId: values.sourceDocument, page: values.sourcePage }];
          if (entry.type === 'list') return [entry.key, new FormData(element).getAll(entry.key)];
          if (entry.type === 'time' && value) return [entry.key, new Date(value).toISOString()];
          return [entry.key, value ?? ''];
        }));
        return save({ action: 'office-save', type, id: item?.id, versionId: item?.versionId, title: values.title ?? item?.title,
          status: values.status, fields, reason: values.reason, attested: values.attested === 'on' });
      });
  }

  function accept(item) {
    const options = read('authority').filter(row => row.status === 'Recorded' && row.fields.offer?.versionId === item.versionId &&
      row.fields.decision === 'Accept exact terms');
    if (!options.length) throw new Error('Record client authority for this exact offer version first.');
    const existing = practice(current()).settlement.gross;
    return form('Record acceptance and prepare settlement', `<div class="choice-box">${e(item.fields.payer)} · ${dollars(item.fields.amount)}</div>
      <div class="wf-document">${e(item.fields.terms)}</div>` +
      formSelect('Recorded client authority', 'authority', options.map(row => [row.id, row.title + ' · ' + row.fields.person]), options[0].id) +
      field('Acceptance time (local time)', 'accepted', localTime(new Date().toISOString()), 'type="datetime-local" required') +
      confirm('I reviewed the terms and recorded the client’s decision to accept.') +
      (options.some(row => row.fields.conditions) ? confirm('Any recorded conditions on authority were satisfied.', 'conditionsMet', false) : '') +
      (existing && existing !== item.fields.amount ? confirm('Replace the amount in the existing settlement draft.', 'replaceDraft') : ''),
      values => {
        const authority = options.find(row => row.id === values.authority);
        return save({ action: 'office-accept', id: item.id, versionId: item.versionId, authorityId: authority?.id,
          authorityVersion: authority?.versionId, acceptedAt: new Date(values.accepted).toISOString(),
          conditionsMet: values.conditionsMet === 'on', replaceDraft: values.replaceDraft === 'on', attested: values.attested === 'on' });
      }, 'Record acceptance');
  }

  function details(row, spec) {
    return `<dl class="office-facts">${spec.fields.filter(field => row.fields[field.key] != null).map(field => {
      const value = row.fields[field.key];
      return `<div><dt>${e(field.label)}</dt><dd>${field.type === 'approval' ?
        e('Approved version ' + (approved(field.options[0]).find(item => item.id === value)?.version ?? '')) :
        e(nameFor(field.type, value))}</dd></div>`;
    }).join('')}</dl>`;
  }

  function rowCard(row) {
    const spec = collections[row.type];
    const field = row.fields;
    const current = office(state.matter);
    const staleDeadline = row.type === 'deadline' && [field.notice, field.rule].filter(Boolean)
      .some(link => !current.records[link.type]?.some(target => target.id === link.id && target.versionId === link.versionId));
    const summary = Object.values(field).find(value => typeof value === 'string' && value.length > 40) ?? '';
    const revision = row.history.length + 1;
    const next = recordStatuses(row.type, row);
    const actions = [
      docLink(field.source),
      act('View record', 'office-view', row.type, row, 'Eye'),
      next.length && row.status !== 'Archived' ? act(row.type === 'authority' ? 'Revoke' : 'Update', 'office-edit', row.type, row, 'Pencil') : '',
      row.type === 'offer' && row.status === 'Open' ? act('Record acceptance', 'office-accept', row.type, row, 'Check', 'small primary') : '',
      row.type === 'offer' && row.status === 'Accepted' ? button('Open Settlement', 'nav', 'ArrowRight', 'small', 'data-screen="closing"') : '',
      (['production', 'hearing'].includes(row.type) && ['Reviewed', 'Prepared', 'Delivered', 'Held', 'Supplemented'].includes(row.status))
        ? act('Download indexed packet', 'office-packet', row.type, row, 'Download') : '',
      row.type === 'filing' && row.status !== 'Archived' ? act('Download filing ZIP', 'office-packet', row.type, row, 'Download') : '',
    ].filter(Boolean).join('');
    return `<article class="wf-row office-record">
      <div class="wf-row-main"><div class="wf-row-title"><strong>${e(row.title)}</strong>${statusPill(row.status)}</div>
        <small>v${revision} · ${e(row.changedBy)} · ${e(row.changedAt.slice(0, 10))}${field.amount != null ? ' · ' + dollars(field.amount) : ''}</small>
        ${field.candidate ? `<small>Candidate date ${e(field.candidate)}${field.confirmed ? ' · confirmed ' + e(field.confirmed) : ''}</small>` : ''}
        ${staleDeadline ? '<div class="wf-callout">The reviewed notice or rule changed. Reconfirm this date.</div>' : ''}
        ${summary ? `<p>${e(summary.slice(0, 170))}</p>` : ''}</div><div class="button-row">${actions}</div></article>`;
  }

  function showRecord(row) {
    const archive = !['offer', 'authority', 'agreement', 'receipt', 'allocation', 'disbursement', 'reconciliation', 'hold'].includes(row.type) &&
      row.status !== 'Archived';
    showDialog(row.title, `<div class="dialog-body">${statusPill(row.status)}${details(row, collections[row.type])}
      ${row.history.length ? `<details class="wf-details"><summary>Revision history</summary>
        ${row.history.map((version, index) => `<details class="office-version"><summary>v${row.history.length - index} · ${e(version.status)}
          · ${e(version.changedBy)} · ${e(version.changedAt.slice(0, 10))}</summary>${details(version, collections[row.type])}
          ${version.reason ? `<p>${e(version.reason)}</p>` : ''}</details>`).join('')}</details>` : ''}
      <div class="dialog-actions">${archive ? act('Archive record', 'office-archive', row.type, row, '', 'small') : ''}
        ${act('Download record', 'office-record', row.type, row, 'Download')}</div></div>`);
  }

  function archive(row) {
    return form('Archive ' + collections[row.type].label.toLowerCase(), textarea('Reason', 'reason', '', true) +
      confirm('I reviewed the record. Its history will remain in this matter.'),
      values => save({ action: 'office-archive', type: row.type, id: row.id, versionId: row.versionId,
        reason: values.reason, attested: values.attested === 'on' }), 'Archive record');
  }

  function applyAmounts(kind) {
    const bills = kind === 'office-apply-bills';
    return form(bills ? 'Carry reviewed bills into Demand' : 'Carry reviewed amounts into Settlement',
      confirm(bills ? 'I reviewed the medical-bill sources and amounts.' : 'I reviewed the resolved lien amounts and reimbursable costs.'),
      values => save({ action: kind, attested: values.attested === 'on' }), 'Carry amounts forward');
  }

  async function packet(row) {
    const result = await buildOfficePacket(current(), row, (matter, doc) => state.store.original(matter, doc), location.origin);
    download(new Blob([result.bytes], { type: 'application/zip' }), result.name);
    toast('Indexed packet downloaded.');
  }

  return {
    render(sectionId) {
      const section = officeSections.find(item => item.id === sectionId);
      const type = tabs[sectionId] ?? section.collections[0];
      const spec = collections[type];
      const items = read(type);
      const settlement = practice(current()).settlement.negotiated;
      return `<section class="wf-content office-content" aria-label="${e(section.name)}">
        <div class="wf-heading office-heading"><div><h2>${e(section.name)}</h2><p>${e(section.summary)}</p></div>
          ${sectionId === 'negotiation' && settlement ? button('Open Settlement', 'nav', 'ArrowRight', 'small', 'data-screen="closing"') : ''}</div>
        ${sectionId === 'money' ? moneyMetrics(financialSummary(office(current()))) + `<div class="button-row office-amounts">
          ${button('Carry bills into Demand', 'office-apply-bills', 'ArrowRight', 'small')}
          ${button('Carry costs and liens into Settlement', 'office-apply-deductions', 'ArrowRight', 'small')}</div>` : ''}
        <div class="office-tabs" aria-label="Workstreams">${section.collections.map(key =>
          `<button type="button" data-action="office-tab" data-type="${key}" aria-pressed="${key === type}">${e(collections[key].plural)}
            <span>${read(key).filter(row => row.status !== 'Archived').length}</span></button>`).join('')}</div>
        <section class="panel wf-panel office-panel"><div class="wf-panel-head"><div><h3>${e(spec.plural)}</h3><p>${e(spec.summary)}</p></div>
          ${act('Add ' + spec.label.toLowerCase(), 'office-edit', type, null, 'Plus', 'small primary')}</div>
          <div class="wf-panel-body">${items.map(rowCard).join('') || `<p class="wf-empty">No ${e(spec.plural.toLowerCase())} recorded for this matter.</p>`}</div></section>
        ${sectionId === 'operations' && view.recovery ? view.recovery.panel() : ''}
        ${sectionId === 'communications' && view.portal ? view.portal.panel() : ''}
        </section>`;
    },
    actions: {
      'office-tab': item => { tabs[state.screen] = item.dataset.type; render(); },
      'office-edit': item => edit(item.dataset.type, item.dataset.id ? find(item.dataset.type, item.dataset.id) : undefined),
      'office-view': item => showRecord(find(item.dataset.type, item.dataset.id)),
      'office-accept': item => accept(find(item.dataset.type, item.dataset.id)),
      'office-archive': item => archive(find(item.dataset.type, item.dataset.id)),
      'office-packet': item => packet(find(item.dataset.type, item.dataset.id)),
      'office-apply-bills': () => applyAmounts('office-apply-bills'),
      'office-apply-deductions': () => applyAmounts('office-apply-deductions'),
      'office-record': item => {
        const row = find(item.dataset.type, item.dataset.id);
        download(new Blob([JSON.stringify({ matter: current().reference, record: row }, null, 2) + '\n'], { type: 'application/json' }), row.type + '-record.json');
      },
    },
  };
}
