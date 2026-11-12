const root = document.querySelector('#desk-root');
const status = document.querySelector('#desk-status');
const api = '/api/risk-intake';
const escape = value => String(value ?? '').replace(/[&<>"']/g, char =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const field = (label, name, type = 'text', required = true) => '<label>' + escape(label) +
  '<input type="' + type + '" name="' + name + '"' + (required ? ' required' : '') + '></label>';
const select = (label, name, values) => '<label>' + escape(label) + '<select name="' + name +
  '" required><option value="">Choose…</option>' + values.map(option => {
    const [id, label] = Array.isArray(option) ? option : [option, option];
    return '<option value="' + escape(id) + '">' + escape(label) + '</option>';
  }).join('') + '</select></label>';
const check = (label, name = 'attested') => '<label><span><input type="checkbox" name="' + name + '"> ' + escape(label) + '</span></label>';
const hidden = (name, value) => '<input type="hidden" name="' + name + '" value="' + escape(value) + '">';
const key = row => hidden('id', row.id) + hidden('revision', row.revision);
const p = text => '<p class="work-copy">' + escape(text) + '</p>';
const section = (title, body) => '<section><h2>' + escape(title) + '</h2>' + body + '</section>';
const detail = (title, body) => '<details><summary>' + escape(title) + '</summary>' + body + '</details>';
const form = (action, fields, label) => '<form data-action="' + action + '">' + fields +
  '<button class="btn primary">' + escape(label) + '</button></form>';
const history = row => row.history?.length ? detail('Activity', row.history.map(event => p(event.action + ' · ' + event.by + ' · ' + event.at)).join('')) : '';
let data;
let firm;
let saving = false;

async function request(path, body) {
  const response = await fetch(path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json',
    'X-Briefcase-Request': '1' }, body: JSON.stringify(body) } : {});
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'The request could not finish.');
  return result;
}
const has = role => data.roles.includes(role);
const people = role => data.people.filter(row => !role || row.desk.includes(role)).map(row => row.username);
const ownerMatters = () => firm.matters.filter(row => row.access === 'owner').map(row => [row.id, row.name]);

function incidentDesk() {
  if (!data.lawyer && !data.incidents.length) return '';
  return section('Incident review', (data.lawyer ? detail('Open a restricted investigation', form('incident-open',
    select('Owned matter', 'matterId', ownerMatters()) + select('Risk counsel', 'counsel', people('R10')) +
    select('Investigator', 'investigator', people()) + field('Audit window start (local)', 'from', 'datetime-local') +
    field('Audit window end (local)', 'to', 'datetime-local') + field('Counsel summary', 'summary') +
    field('Instructions shared with investigator', 'assignment'), 'Open investigation')) : '') +
    data.incidents.map(row => detail('Incident · ' + row.status, p(row.assignment) + (row.summary ? p(row.summary) : '') +
      (row.evidence ? detail('Preserved audit · ' + row.evidenceSha256, row.evidence.map(event =>
        p(event.at + ' · ' + event.actor + ' · ' + event.action + ' · ' + (event.target ?? ''))).join('')) : '') +
      (row.investigator === data.username && row.status === 'open' ?
        form('incident-findings', key(row) + field('Findings', 'findings'), 'Submit findings') : '') +
      (row.counsel === data.username && row.status === 'reported' ?
        form('incident-resolve', key(row) + field('Disposition and evidence references', 'decision'), 'Record disposition') : '') +
      (row.findings ? p(row.findings) : '') + (row.decision ? p(row.decision) : '') + history(row))).join(''));
}
function frontDesk() {
  if (!data.lawyer && !has('R12') && !data.callbacks.length) return '';
  return section('Private callbacks', (data.lawyer ? detail('Create a callback route', form('callback-route',
    select('Owned matter', 'matterId', ownerMatters()) + field('Private callback code', 'code'), 'Save callback route')) : '') +
    (has('R12') ? detail('Record callback', form('callback-new', field('Private callback code', 'code') +
      field('Caller name', 'caller') + field('Callback contact', 'number') + field('Message', 'note'), 'Route callback')) : '') +
    data.callbacks.map(row => detail(row.caller + ' · ' + row.status, p(row.number) + p(row.note) +
      (row.owner === data.username && row.status === 'routed' ? form('callback-ack', key(row), 'Acknowledge') : '') + history(row))).join(''));
}
function inquiryActions(row) {
  const assigned = row.assignee === data.username;
  const counsel = row.counsel === data.username;
  const analyst = row.analyst === data.username;
  const opener = row.opener === data.username;
  const reviewStates = ['conflicts', 'held'].includes(row.status);
  return (has('R13') && row.status === 'new' ? form('inquiry-assign', key(row) + select('Intake worker', 'assignee', people('R13')) +
    select('Conflict lawyer', 'counsel', people('R15')) + select('Conflict analyst', 'analyst', people('R14')) +
    select('Matter opening specialist', 'opener', people('R16')) + field('Party names, separated by commas', 'parties') +
    select('Urgency', 'urgency', ['routine', 'urgent']) + field('Lawyer review time (local)', 'reviewAt', 'datetime-local'), 'Assign review') : '') +
    (assigned && row.status === 'assigned' ? form('inquiry-submit', key(row) +
      field('Eligibility review notes', 'eligibility'), 'Submit triage') : '') +
    (analyst && ['triaged', 'conflicts', 'held', 'opening'].includes(row.status) ? form('conflict-submit',
      key(row) + hidden('scanHash', row.candidateHash), 'Submit current candidates') : '') +
    (counsel && reviewStates ? form('waiver-assign', key(row) +
      select('Professional responsibility counsel', 'advisor', people('R11')) + field('Minimum waiver context', 'notes'), 'Request waiver advice') +
      form('conflict-decision', key(row) + select('Disposition', 'disposition', ['hold', 'clear']) +
        field('Accounts to screen, separated by commas', 'screened', 'text', false) +
        field('Disposition and conditions', 'notes') + check('Waiver advice required', 'requiresWaiver') +
        check('Diligence required', 'requiresDiligence') + check('I reviewed current conflict candidates.'), 'Record conflict disposition') : '') +
    (counsel && ['assigned', 'triaged', 'conflicts', 'held'].includes(row.status) && !row.diligenceStatus ?
      form('diligence-assign', key(row) + select('Diligence analyst', 'reviewer', people('R17')) +
        field('Restricted verification package reference', 'reference'), 'Assign diligence') : '') +
    (opener && row.status === 'cleared' ? form('opening-start', key(row) + field('Matter name', 'name') +
      field('Matter code', 'code') + field('Jurisdiction', 'jurisdiction') +
      field('Billing contact', 'billingContact'), 'Start opening') : '') +
    (counsel && row.matterId ? '<a href="/?view=intake&amp;matter=' + encodeURIComponent(row.matterId) + '">Open matter engagement</a>' : '') +
    (opener && row.status === 'opening' ? form('opening-finalize', key(row), 'Verify engagement and record billing setup') : '');
}
function intake() {
  if (!data.inquiries.length && !has('R12') && !has('R13') && !data.lawyer) return '';
  return section('Intake and conflicts',
    (has('R12') || has('R13') ? detail('Capture an inquiry', form('inquiry-new', field('Duplicate reference', 'reference') +
      field('Intake channel', 'channel') + field('Contact name', 'contact') + field('Initial inquiry', 'notes'), 'Save inquiry')) : '') +
    (data.lawyer ? detail('Approve minimum names for screening', form('conflict-entity', select('Owned matter', 'matterId', ownerMatters()) +
      field('Entity name', 'name') + field('Aliases, separated by commas', 'aliases', 'text', false) +
      field('Related parties, separated by commas', 'related', 'text', false) + check('I approve only these names for screening.'),
    'Publish screening names')) : '') +
    data.inquiries.map(row => detail((row.submissions?.[0]?.contact ?? 'Inquiry') + ' · ' + row.status,
      (row.submissions ? row.submissions.map(entry => p(entry.contact + ' · ' + entry.via + ' · ' + entry.notes + ' · ' + entry.by)).join('') :
        p(row.submissionCount + ' submissions')) +
      (row.urgency ? p(row.urgency + ' · lawyer review ' + row.reviewAt) : '') +
      (row.parties ? p('Parties · ' + row.parties.join(', ')) : '') +
      (row.candidates ? detail('Conflict candidates', row.candidates.map(hit => p(hit.label + ' · ' +
        hit.reasons.map(reason => reason.name + ' (' + reason.reason + ')').join(', '))).join('') || p('No matching names.')) : '') +
      (row.waiver ? p('Waiver advice · ' + row.waiver.conditions) : '') +
      (row.decision ? p('Disposition · ' + row.decision.notes) : '') +
      (row.diligenceStatus ? p('Diligence · ' + row.diligenceStatus + (row.diligenceMode ? ' · ' + row.diligenceMode.replaceAll('-', ' ') : '')) : '') +
      (row.billing ? p('Billing setup · ' + row.billing.matterCode + ' · ' + row.billing.contact + ' · ' + row.billing.agreementSha256) : '') +
      inquiryActions(row) + history(row))).join(''));
}
function waivers() {
  return data.waiverQueue.length ? section('Waiver and screen advice', data.waiverQueue.map(row => detail('Waiver review · ' + row.status,
    p(row.waiverBrief) + form('waiver-record', key(row) + field('Waiver evidence reference', 'reference') +
      field('Waiver conditions or screen advice', 'notes'), 'Record advice'))).join('')) : '';
}
function diligence() {
  return data.diligence.length ? section('Restricted client verification', data.diligence.map(row => detail('Verification · ' + row.status,
    p('Evidence mode · ' + (row.mode ?? 'unverified').replaceAll('-', ' ')) + p('Provider request reference · ' + row.reference) +
    p('Case reference for signed verification · ' + row.id) +
    (row.receipt ? p(row.receipt + (row.notes ? ' · ' + row.notes : '')) : '') +
    (row.workItemId ? '<p><a href="/workbench.html?item=' + encodeURIComponent(row.workItemId) + '">Open linked signed verification</a></p>' : '') + history(row) +
    (row.reviewer === data.username ? detail('Link signed provider verification',
      p('Create an R17 specialist workflow with the case and request references above. Its preparer must be this analyst and its reviewer must be the assigned conflicts counsel. Current signed status is checked again before matter opening.') +
      form('diligence-link', key(row) + field('R17 specialist work item ID', 'workItemId'), 'Link current verification')) : '') +
    (row.reviewer === data.username && row.status !== 'verified' && !row.workItemId ? detail('Record a manual external receipt', form('diligence-result', key(row) +
      select('Result', 'result', ['verified', 'escalated']) + field('External verification receipt', 'receipt') +
      field('Restricted notes', 'notes'), 'Record manual verification reference')) : ''))).join('')) : '';
}
async function load() {
  [data, firm] = await Promise.all([request(api), request('/api/firm-desk')]);
  root.innerHTML = [incidentDesk(), frontDesk(), intake(), waivers(), diligence()].join('') || p('No assigned risk or intake work.');
}
function notice(text, error = false) {
  status.textContent = text;
  status.dataset.error = String(error);
}
root.addEventListener('submit', async event => {
  event.preventDefault();
  if (saving) return;
  saving = true;
  const button = event.target.querySelector('button');
  button.disabled = true;
  try {
    const fields = new FormData(event.target);
    const body = Object.fromEntries(fields);
    for (const name of ['attested', 'requiresWaiver', 'requiresDiligence']) body[name] = fields.has(name);
    for (const name of ['parties', 'aliases', 'related', 'screened']) if (name in body) body[name] = body[name].split(',').map(s => s.trim()).filter(Boolean);
    for (const name of ['reviewAt', 'from', 'to']) if (name in body) body[name] = new Date(body[name]).toISOString();
    if ('revision' in body) body.revision = Number(body.revision);
    await request(api, { ...body, action: event.target.dataset.action });
    try { await load(); notice('Saved.'); }
    catch { notice('Saved. Reload to see the current record.', true); }
  } catch (error) { notice(error.message, true); }
  finally { saving = false; button.disabled = false; }
});
try { await load(); }
catch (error) { notice(error.message, true); }
finally { root.setAttribute('aria-busy', 'false'); }
