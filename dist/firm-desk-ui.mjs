const root = document.querySelector('#desk-root');
const status = document.querySelector('#desk-status');
const endpoint = '/api/firm-desk';
const period = new URLSearchParams(location.search).get('month');
const escape = value => String(value ?? '').replace(/[&<>"']/g, char =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const currency = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const dollars = cents => currency.format(cents / 100);
const numberFields = new Set(['option', 'revision', 'hours', 'fee', 'commitment', 'budget', 'revenue']);
const hidden = (name, value) => '<input type="hidden" name="' + name + '" value="' + escape(value) + '">';
const field = (label, name, type = 'text', value = '', extra = '') =>
  '<label>' + escape(label) + '<input name="' + name + '" type="' + type + '" value="' + escape(value) + '" required ' + extra + '></label>';
const numeric = (label, name, value = 0) => field(label, name, 'number', value, 'min="0" step="1"');
const select = (label, name, choices, current) => '<label>' + escape(label) + '<select name="' + name + '" required>' +
  '<option value="">Choose…</option>' + choices.map(([value, label]) => '<option value="' + escape(value) + '"' +
    (current === value ? ' selected' : '') + '>' + escape(label) + '</option>').join('') + '</select></label>';
const button = title => '<button class="btn primary">' + escape(title) + '</button>';
const form = (action, fields, label) => '<form data-action="' + action + '">' + fields + button(label) + '</form>';
const detail = (title, contents) => '<details class="desk-inline"><summary>' + escape(title) + '</summary>' + contents + '</details>';
const paragraph = value => '<p>' + escape(value) + '</p>';
const link = (href, title) => '<a class="desk-report-link" href="' + escape(href) + '">' + escape(title) + '</a>';
const matterLink = (id, title) => link('/?matter=' + encodeURIComponent(id) + '&view=intake', title);
const section = (title, body) => '<section><h2>' + escape(title) + '</h2>' + body + '</section>';
const table = (columns, rows) => rows.length ? '<div class="desk-table"><table><thead><tr>' +
  columns.map(column => '<th scope="col">' + escape(column) + '</th>').join('') + '</tr></thead><tbody>' +
  rows.map(row => '<tr>' + row.map(cell => '<td>' + escape(cell) + '</td>').join('') + '</tr>').join('') +
  '</tbody></table></div>' : paragraph('No records in this view.');
const timeLabel = stamp => stamp ? new Date(stamp).toLocaleString() : '';
const minutes = ms => Math.max(0, ms / 60_000).toFixed(1) + ' min';
const history = row => detail('Activity history', table(['Time', 'Account', 'Action', 'Notes'],
  row.history.map(event => [timeLabel(event.at), event.by, event.action, event.note ?? ''])));
const key = row => hidden('id', row.id) + hidden('revision', row.revision);
let data;
let saving = false;

async function request(path, body) {
  const response = await fetch(path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json',
    'X-Briefcase-Request': '1' }, body: JSON.stringify(body) } : {});
  const output = await response.json();
  if (!response.ok) throw new Error(output.error || 'The firm desk request could not finish.');
  return output;
}
const query = () => period ? '?month=' + encodeURIComponent(period) : '';
const download = role => link(endpoint + '/' + role + '/export?month=' + encodeURIComponent(data.period), 'Download report');
const role = id => data.roles.includes(id);
const personOptions = (predicate = () => true) => data.people.filter(predicate)
  .map(account => [account.username, account.username + ' · ' + account.office]);
const nameFor = id => data.matters.find(matter => matter.id === id)?.name ?? 'Matter';

function partnerPack() {
  if (!data.pack) return '';
  const { pack } = data;
  return section('Monthly partner pack', paragraph('Totals reconcile to the accessible matter rows below. Missing ledger records are shown separately.') +
    table(['Office', 'Budget', 'Revenue', 'Variance', 'Overdue items', 'Capacity gap', 'Missing ledger'],
      pack.offices.map(row => [row.office, dollars(row.budget), dollars(row.revenue), dollars(row.variance),
        row.overdue, row.capacityGapHours + ' h', row.missingLedger])) +
    table(['Source matter', 'Office', 'Budget', 'Revenue', 'Ledger reference', 'Overdue'], pack.rows.map(row =>
      [row.name, row.office, row.ledger ? dollars(row.ledger.budget) : 'Missing',
        row.ledger ? dollars(row.ledger.revenue) : 'Missing', row.ledger?.reference ?? '', row.overdue])) +
    download('R01') + detail('Record partner decision', form('decision-save',
      hidden('period', pack.period) + hidden('packHash', data.packHash) + field('Decision', 'decision', 'text', '', 'maxlength="1200"'),
      'Record decision')) + data.decisions.map(row => paragraph(row.decision + ' · ' + timeLabel(row.updatedAt)) +
      link(endpoint + '/' + encodeURIComponent(row.id) + '/decision', 'Download decision record')).join(''));
}

function referrals() {
  if (!data.referrals) return '';
  const start = role('R02') ? detail('Record a referral', form('referral-new', field('Referral reference', 'reference') +
    field('Referring source', 'source') + field('Prospective matter name', 'name') + numeric('Proposed fee (cents)', 'fee') +
    numeric('Proposed cost commitment (cents)', 'commitment'), 'Record referral')) : '';
  return section('Referrals and ownership', (data.portfolio ? paragraph(data.portfolio.approvedReferrals + ' approved referrals · ' +
    dollars(data.portfolio.fees) + ' fees · ' + dollars(data.portfolio.commitments) + ' commitments') + download('R02') : '') + start +
    data.referrals.map(row => {
      const action = row.status === 'received' && role('R02') ? form('referral-open', key(row) +
        field('Jurisdiction', 'practice') + field('Intake due', 'due', 'date'), 'Open prospective matter') :
        row.status === 'intake' && role('R01') && data.matters.some(m => m.id === row.matterId && m.intake === 'engaged') ?
          form('referral-approve', key(row) + field('Approval rationale', 'notes'), 'Approve fee, commitment and credit') : '';
      return '<div class="desk-action"><h3>' + escape(row.name) + '</h3>' + paragraph(row.status + ' · ' + row.source +
        ' · ' + dollars(row.fee) + ' fee · ' + dollars(row.commitment) + ' commitment' +
        (row.creditedTo ? ' · credited to ' + row.creditedTo : '')) +
        (row.matterId ? matterLink(row.matterId, 'Open matter intake') : '') + action + history(row) + '</div>';
    }).join(''));
}

function staffing() {
  if (!data.capacity) return '';
  const capacityRows = data.capacity.map(row => detail(row.username + ' · ' + (row.available ?? 'Unplanned') +
    ' available · ' + row.assigned + ' assigned', form('capacity-save', hidden('username', row.username) +
    hidden('period', data.period) + hidden('revision', row.revision) + numeric('Available hours', 'hours', row.available ?? 0), 'Save capacity')));
  const assignments = data.matters.filter(m => m.access === 'owner' || data.delegations.some(r => r.matterId === m.id && r.manager === data.username))
    .map(matter => {
      const row = data.staffing.find(item => item.matterId === matter.id);
      return detail(matter.name, form('staffing-save', hidden('matterId', matter.id) + hidden('period', data.period) +
        hidden('revision', row?.revision ?? 0) + select('Responsible lawyer', 'username', personOptions(person =>
          person.role === 'lawyer' && person.username !== data.username), row?.username) +
        numeric('Assigned hours', 'hours', row?.hours ?? 1) + field('Assignment reason', 'notes'),
      row ? 'Update reviewer assignment' : 'Assign reviewer') + (row ? history(row) : ''));
    });
  return section('Practice capacity and staffing', table(['Lawyer', 'Office', 'Group', 'Available hours', 'Assigned hours', 'Gap'],
    data.capacity.map(row => [row.username, row.office, row.practiceGroup, row.available ?? 'Unplanned', row.assigned, row.gap ?? 'Unplanned'])) +
    download('R04') + detail('Set available hours', capacityRows.join('')) + detail('Assign or replace a matter reviewer',
      assignments.join('') || paragraph('No matters delegated for staffing.')));
}

function matters() {
  const owned = data.matters.filter(matter => matter.access === 'owner');
  const coverage = data.myStaffing.filter(row => row.period === data.period);
  if (!owned.length && !coverage.length) return '';
  return section('My matter work', coverage.map(row => paragraph(row.hours + ' assigned hours · ' + row.period) +
    matterLink(row.matterId, nameFor(row.matterId))).join('') + owned.map(matter => {
    const ledger = data.ledger.find(row => row.matterId === matter.id);
    const delegation = data.delegations.find(row => row.matterId === matter.id);
    const managers = personOptions(account => account.managesStaffing);
    const common = hidden('matterId', matter.id);
    return detail(matter.name, matterLink(matter.id, 'Open matter') + detail('Monthly ledger input', form('ledger-save',
      common + hidden('period', data.period) + hidden('revision', ledger?.revision ?? 0) +
      numeric('Budget (cents)', 'budget', ledger?.budget) + numeric('Revenue (cents)', 'revenue', ledger?.revenue) +
      field('Ledger source reference', 'reference', 'text', ledger?.reference), 'Save ledger')) +
      (!data.intakeTargets.includes(matter.id) && !['engaged', 'declined'].includes(matter.intake) ?
        detail('Set intake due date', form('intake-start', common + field('Intake due', 'due', 'date'), 'Start intake tracking')) : '') +
      (managers.length ? detail('Delegate staffing', form('staffing-delegate', common +
        hidden('revision', delegation?.revision ?? 0) + select('Practice leader', 'manager', managers, delegation?.manager), 'Delegate staffing') +
        (delegation?.manager ? form('staffing-delegate', common + hidden('revision', delegation.revision) +
          hidden('enabled', 'false'), 'Revoke staffing delegation') : '')) : ''));
  }).join(''));
}

function operations() {
  if (!data.intake) return '';
  const exceptions = [...data.intake.filter(row => row.late).map(row => ({ ...row, kind: 'intake' })),
    ...data.imports.filter(row => row.status === 'failed' || row.stalled).map(row => ({ ...row, kind: 'import' }))];
  return section('Operating review', download('R05') +
    table(['Intake', 'Owner', 'Status', 'Duration', 'Due'],
      data.intake.map(row => [nameFor(row.matterId), row.owner, row.late ? 'Late' : row.status, minutes(row.durationMs), row.due])) +
    table(['PDF import', 'Matter', 'Owner', 'Status', 'Duration'],
      data.imports.map(row => [row.id, nameFor(row.matterId), row.owner, row.stalled ? 'Stalled' : row.status, minutes(row.durationMs)])) +
    exceptions.map(row => detail((row.kind === 'intake' ? 'Late intake' : 'Import exception') + ' · ' + nameFor(row.matterId),
      history(row) + form('exception-note', key(row) + hidden('kind', row.kind) + field('Follow-up or resolution', 'notes'), 'Record follow-up'))).join('') +
    table(['Training', 'Account', 'Office', 'Status', 'Due'],
      data.training.map(row => [row.title, row.username, row.office, row.status, row.due])) +
    detail('Assign training', form('training-assign', select('Staff member', 'username', personOptions()) +
      field('Training title', 'title') + field('Due date', 'due', 'date'), 'Assign training')));
}
function officeServices() {
  const manages = role('R06') || role('R64');
  if (!manages && !data.services.length) return '';
  const types = [['room', 'Room reservation'], ['mail', 'Mail handoff'], ['facilities', 'Facilities escalation']];
  if (role('R06')) types.unshift(['renewal', 'Vendor renewal'], ['coverage', 'Coverage']);
  const add = manages ? (role('R06') ? download('R06') : '') + detail('Route office work', form('service-new',
    select('Office', 'office', data.offices.map(office => [office, office]), data.office) +
    select('Type', 'type', types) +
    select('Delegate', 'delegate', personOptions(person => person.username !== data.username)) +
    field('Service title', 'title') + field('Resource or agreement reference', 'resource') +
    field('Start (your local time)', 'start', 'datetime-local') + field('End (your local time)', 'end', 'datetime-local') +
    field('Delegate access ends (your local time)', 'accessUntil', 'datetime-local'), 'Route service item')) : '';
  return section('Office services', add + data.services.map(row => {
    const own = row.delegate === data.username;
    const verify = manages && !own && row.status === 'submitted';
    const action = own && row.status === 'assigned' ? form('service-ack', key(row), 'Acknowledge') :
      own && row.status === 'accepted' ? form('service-complete', key(row) + field('Completion evidence', 'evidence'), 'Submit completion') :
      verify ? form('service-verify', key(row) + field('Verification notes', 'notes'), 'Verify completion') : '';
    const cancel = manages && !own && !['canceled', 'verified'].includes(row.status) ?
      detail('Cancel assignment', form('service-cancel', key(row) + field('Cancellation reason', 'notes'), 'Cancel assignment')) : '';
    return detail(row.title + ' · ' + row.status, paragraph(row.type + ' · ' + row.resource + ' · ' + row.office + ' · ' + row.delegate) +
      paragraph(timeLabel(row.start) + ' – ' + timeLabel(row.end) + ' · delegate access ends ' + timeLabel(row.accessUntil)) +
      (row.evidence ? paragraph('Completion evidence · ' + row.evidence) : '') + action + cancel + history(row));
  }).join(''));
}
function pricingDesk() {
  if (!role('R47') && !data.pricing.length) return '';
  const pricingForm = row => {
    const version = row?.versions.at(-1);
    const options = [0, 1].map(index => {
      const option = version?.options[index];
      const staff = option?.staff.map(member => [member.label, member.minutes, member.costRate, member.billRate].join('|')).join('\n');
      return '<fieldset><legend>Option ' + (index + 1) + '</legend>' +
        field('Option name', 'label' + index, 'text', option?.label) +
        select('Fee type', 'type' + index, [['fixed', 'Fixed fee'], ['hourly', 'Hourly']], option?.type) +
        numeric('Fixed fee cents (ignored for hourly)', 'fixed' + index, option?.type === 'fixed' ? option.fee : 0) +
        numeric('Estimated expense cents', 'expenses' + index, option?.expenses ?? 0) +
        '<label>Staff lines (label | minutes | hourly cost cents | hourly bill cents)<textarea name="staff' + index +
          '" required>' + escape(staff) + '</textarea></label></fieldset>';
    });
    return form('pricing-save', (row ? hidden('id', row.id) : '') + hidden('revision', row?.revision ?? 0) +
      select('Matter', 'matterId', data.matters.map(m => [m.id, m.name]), row?.matterId) +
      select('Reviewing lawyer', 'reviewer', personOptions(p => p.role === 'lawyer' && p.username !== data.username), row?.reviewer) +
      field('Rates and staffing assumptions', 'assumptions', 'text', version?.assumptions) + options.join(''), 'Save comparison');
  };
  return section('Fee and staffing comparisons', (role('R47') ? detail('Compare two arrangements', pricingForm()) : '') +
    data.pricing.map(row => {
      const version = row.versions.at(-1);
      const fields = hidden('id', row.id) + hidden('revision', row.revision) + hidden('sha256', version.sha256);
      return detail(nameFor(row.matterId) + ' · ' + row.status, paragraph(version.assumptions) +
        table(['Option', 'Fee', 'Staffing cost', 'Expenses', 'Margin'], version.options.map(option =>
          [option.label, dollars(option.fee), dollars(option.staffing), dollars(option.expenses), dollars(option.margin)])) +
        version.options.map(option => detail(option.label + ' staffing', table(['Staff', 'Minutes', 'Hourly cost', 'Hourly fee'],
          option.staff.map(member => [member.label, member.minutes, dollars(member.costRate), dollars(member.billRate)])))).join('') +
        (row.author === data.username && ['draft', 'returned'].includes(row.status) ? pricingForm(row) +
          (row.status === 'draft' ? form('pricing-submit', fields, 'Submit for review') : '') : '') +
        (row.reviewer === data.username && row.status === 'submitted' ?
          form('pricing-approve', fields + select('Select option', 'option', version.options.map((option, i) => [i, option.label])) +
            field('Approval rationale', 'notes') +
            '<label><span><input type="checkbox" name="attested" required> I checked the rates and staffing.</span></label>', 'Approve selected option') +
          form('pricing-return', fields + field('Return rationale', 'notes'), 'Return comparison') : '') +
        (row.selected ? paragraph('Selected · ' + version.options[row.selected.index].label) +
          link(endpoint + '/' + encodeURIComponent(row.id) + '/pricing', 'Download approved comparison') : '') + history(row));
    }).join(''));
}
function trainingSupport() {
  const aggregates = data.trainingTotals ? section('Training completion totals', table(['Office', 'Assigned', 'Completed'],
    data.trainingTotals.map(row => [row.office, row.assigned, row.completed]))) : '';
  const training = role('R57') && !role('R05') ? section('Training administration',
    table(['Training', 'Account', 'Status', 'Due'], data.training.map(row => [row.title, row.username, row.status, row.due])) +
    form('training-assign', select('Staff member', 'username', personOptions()) + field('Training title', 'title') +
      field('Due date', 'due', 'date'), 'Assign training')) : '';
  const support = data.support ? section('Import support', data.support.map(row => detail(row.id + ' · ' + row.status,
    paragraph(minutes(row.durationMs) + (row.stalled ? ' · stalled' : '')) +
    table(['Action', 'Time'], row.history.map(entry => [entry.action, timeLabel(entry.at)])) +
    (row.triage ? paragraph(row.triage.outcome) : '') + (row.status !== 'complete' ? form('support-triage',
      hidden('id', row.id) + hidden('revision', row.triage?.revision ?? 0) +
      select('Disposition', 'outcome', ['Retry requested', 'Escalated to operations', 'Awaiting user response'].map(value => [value, value])),
      'Record triage') : ''))).join('')) : '';
  return aggregates + training + support;
}

function myTraining() {
  if (!data.myTraining.length) return '';
  return section('My training', data.myTraining.map(row => detail(row.title + ' · ' + row.status,
    paragraph('Due ' + row.due) + (row.status === 'assigned' ?
      form('training-complete', key(row) + field('Completion evidence', 'evidence'), 'Record completion') : history(row)))).join(''));
}

async function load() {
  data = await request(endpoint + query());
  document.querySelector('.desk-period input').value = data.period;
  root.innerHTML = [partnerPack(), referrals(), staffing(), operations(), officeServices(), pricingDesk(), trainingSupport(), myTraining(), matters()].join('') ||
    paragraph('There are no firm desk assignments for this account.');
}
function notice(message, error = false) {
  status.textContent = message;
  status.dataset.error = String(error);
}
root.addEventListener('submit', async event => {
  event.preventDefault();
  if (saving) return;
  saving = true;
  const submit = event.target.querySelector('button');
  submit.disabled = true;
  try {
    const body = Object.fromEntries(new FormData(event.target));
    for (const name of Object.keys(body)) {
      if (numberFields.has(name)) body[name] = Number(body[name]);
      if (['start', 'end', 'accessUntil'].includes(name)) body[name] = new Date(body[name]).toISOString();
      if (name === 'enabled') body[name] = body[name] === 'true';
    }
    if (event.target.dataset.action === 'pricing-save') {
      body.options = [0, 1].map(index => ({ label: body['label' + index], type: body['type' + index],
        fixedFee: Number(body['fixed' + index]), expenses: Number(body['expenses' + index]),
        staff: body['staff' + index].split(/\r?\n/).filter(line => line.trim()).map(line => {
          const [label, minutes, costRate, billRate] = line.split('|').map(value => value.trim());
          return { label, minutes: Number(minutes), costRate: Number(costRate), billRate: Number(billRate) };
        }) }));
    }
    body.attested = body.attested === 'on';
    await request(endpoint, { ...body, action: event.target.dataset.action });
    try {
      await load();
      notice('Saved.');
    } catch {
      notice('Saved. Reload to see the updated record.', true);
    }
  } catch (error) {
    notice(error.message, true);
  } finally {
    submit.disabled = false;
    saving = false;
  }
});
try { await load(); }
catch (error) { notice(error.message, true); }
finally { root.setAttribute('aria-busy', 'false'); }
