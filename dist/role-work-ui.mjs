const root = document.querySelector('#role-desk');
const status = document.querySelector('#role-status');
const params = new URLSearchParams(location.search);
const selected = params.get('item');
const offset = Number(params.get('offset') ?? 0);
const escape = value => String(value ?? '').replace(/[&<>"']/g, char =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const label = value => value.replaceAll('_', ' ');
const link = id => '/role-work.html?item=' + encodeURIComponent(id);
const api = '/api/role-work';
let info;
let queue;
let pendingRequest;
let busy = false;

async function request(path, body) {
  const options = body ? { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Briefcase-Request': '1' },
    body: JSON.stringify(body) } : {};
  const response = await fetch(path, options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Briefcase could not complete the request.');
  return data;
}
function message(value, error = false) {
  status.textContent = value;
  status.dataset.error = String(error);
}
const field = (name, title, max, area = false) => '<label>' + escape(title) + (area
  ? '<textarea name="' + name + '" required maxlength="' + max + '"></textarea>'
  : '<input name="' + name + '" required maxlength="' + max + '">') + '</label>';
const button = (action, title) => '<button class="btn primary" name="action" value="' + action + '">' + title + '</button>';
const attestation = '<label><span><input type="checkbox" name="attested"> I checked this work against the acceptance criteria.</span></label>';

function renderQueue() {
  const options = (accounts, ownFirst = false) => [...accounts]
    .sort((a, b) => ownFirst ? Number(b.username === info.username) - Number(a.username === info.username) : 0)
    .map(account => '<option value="' + escape(account.username) + '">' + escape(account.name + ' (' + account.username + ')') + '</option>').join('');
  root.innerHTML = (info.role === 'lawyer' && !info.matterOnly ? `<details><summary>Assign role work</summary>
    <form id="assign-form">
      <label>Role workflow<select name="roleId">${queue.roles.map(role => '<option value="' + role.id + '">' + escape(role.id + ' · ' + role.title) + '</option>').join('')}</select></label>
      <p id="role-input-hint" class="work-meta"></p>
      ${field('title', 'Assignment title', 180)}
      ${field('context', 'Work inputs and instructions', 4000, true)}
      <label>Assignee<select name="assignee">${options(queue.roster)}</select></label>
      <label>Reviewing lawyer<select name="reviewer">${options(queue.roster.filter(account => account.role === 'lawyer'), true)}</select></label>
      <label>Matter ID (optional)<input name="matter" maxlength="100"></label>
      <p class="work-meta">Copy a matter ID from its workspace URL to use its access rules. Unlinked assignments are visible only to their participants. Use reference IDs for restricted records.</p>
      <button class="btn primary">Assign work</button>
    </form></details>` : '') + `<section><h2>My assignments and reviews</h2>
      ${queue.items.length ? '<ul class="work-queue">' + queue.items.map(item =>
        '<li><a href="' + link(item.id) + '">' + escape(item.title) + '</a><div class="work-meta">' +
        escape(item.roleId + ' · ' + label(item.status) + ' · ' + item.assignee + ' → ' + item.reviewer) + '</div></li>').join('') + '</ul>'
        : '<p>No visible work items on this page.</p>'}
      <div class="work-actions">
        ${offset > 0 ? '<a href="?offset=' + Math.max(0, offset - 50) + '">Previous page</a>' : ''}
        ${queue.hasMore ? '<a href="?offset=' + (offset + 50) + '">Next page</a>' : ''}
      </div></section>`;
  const roleField = root.querySelector('[name="roleId"]');
  if (roleField) {
    const hint = () => {
      const role = queue.roles.find(entry => entry.id === roleField.value);
      root.querySelector('#role-input-hint').textContent = role.input + ' → ' + role.output +
        (role.external ? ' · Provider result required.' : '');
    };
    roleField.addEventListener('change', hint);
    hint();
  }
}

function renderItem({ item, history, outputDocuments = [] }) {
  const role = queue.roles.find(role => role.id === item.roleId);
  const prepares = item.assignee === info.username;
  const reviews = item.reviewer === info.username;
  let actions = '';
  if (prepares && ['draft', 'returned'].includes(item.status)) {
    const choices = outputDocuments.length ? '<fieldset><legend>Supporting PDFs to bind to this submission</legend>' +
      outputDocuments.map(file => '<label><span><input type="checkbox" name="outputDocuments" value="' +
        escape(file.id) + '"> ' + escape(file.name) + '</span></label>').join('') + '</fieldset>' : '';
    actions = field('output', role.output, 12000, true) + field('evidence', 'Supporting references', 4000, true) +
      (item.matter ? '<label>Original document ID (optional)<input name="sourceId" maxlength="100"></label>' +
        '<label>Physical page<input name="sourcePage" type="number" min="1" step="1"></label>' : '') + choices + button('submit', 'Submit for review');
  }
  if (reviews && ['submitted', 'receipt_recorded'].includes(item.status)) {
    const reviewingReceipt = item.status === 'receipt_recorded';
    actions = field('notes', 'Review notes', 1600, true) + attestation + '<div class="work-actions">' +
      button('return', reviewingReceipt ? 'Return receipt' : 'Return submission') +
      (reviewingReceipt ? button('revise', 'Request revised output') + button('verify', 'Verify provider result') : button('approve', 'Approve output')) + '</div>';
  }
  if (prepares && ['awaiting_receipt', 'receipt_returned'].includes(item.status)) {
    actions = field('provider', 'Provider or destination', 160) + field('reference', 'Receipt or status reference', 400) +
      field('outcome', 'Observed outcome', 1200, true) + button('receipt', 'Record provider result');
  }
  const files = [item.submission, ...item.attempts.map(attempt => attempt.submission)].filter(Boolean)
    .flatMap(submission => (submission.files ?? []).map(file => '<li><a href="' + api + '/' +
      encodeURIComponent(item.id) + '/file/' + submission.revision + '/' + encodeURIComponent(file.id) + '">' +
      escape(file.name) + '</a> · submission ' + submission.revision + ' · <code>' + escape(file.sha256) + '</code></li>'));
  const entry = (title, value) => '<dt><strong>' + escape(title) + '</strong></dt><dd class="work-copy">' + escape(value) + '</dd>';
  root.innerHTML = `<p><a href="/role-work.html">← My queue</a></p><section><h2>${escape(item.title)}</h2>
    <p class="work-meta">${escape(role.id + ' · ' + role.title + ' · ' + label(item.status) + ' · ' + item.reviewMode)}</p>
    ${item.matter ? '<p><a href="/?matter=' + encodeURIComponent(item.matter) + '">Open linked matter</a></p>' : ''}
    <dl>${entry('Assigned to', item.assignee)}${entry('Reviewer', item.reviewer)}
    ${entry(role.input, item.context)}${entry('Acceptance check', role.check)}
    ${item.submission ? entry(role.output, item.submission.output) + entry('Supporting references', item.submission.evidence) +
      entry('Submission SHA-256', item.submission.sha256) : ''}
    ${item.submission?.source ? '<p><a href="/?matter=' + encodeURIComponent(item.matter) + '&amp;document=' +
      encodeURIComponent(item.submission.source.documentId) + '&amp;page=' + item.submission.source.page +
      '">Open original page ' + item.submission.source.page + '</a></p>' : ''}
    ${item.decision ? entry('Review notes', item.decision.notes) : ''}
    ${item.revisionRequest ? entry('Revised output requested', item.revisionRequest.notes) : ''}
    ${item.receipt ? entry('Provider or destination', item.receipt.provider) + entry('Receipt', item.receipt.reference) +
      entry('Observed outcome', item.receipt.outcome) : ''}
    ${item.receiptReturns?.length ? entry('Last receipt return', item.receiptReturns.at(-1).notes) : ''}
    ${item.verification?.receiptSha256 ? entry('Verification notes', item.verification.notes) : ''}</dl>
    ${files.length ? '<h3>Submitted PDFs</h3><ul class="work-copy">' + files.join('') + '</ul>' : ''}
    ${item.status === 'verified' ? '<p><a href="' + api + '/' + encodeURIComponent(item.id) + '/proof">Download verification record</a></p>' : ''}
    ${item.cancellation ? '<p>' + escape('Canceled by ' + item.cancellation.by + ' · ' + item.cancellation.reason) + '</p>' : ''}
    ${item.creator === info.username && !['verified', 'canceled'].includes(item.status) ?
      '<details><summary>Cancel assignment</summary><form data-revision="' + item.revision + '">' +
      field('notes', 'Cancellation reason', 1600, true) + button('cancel', 'Cancel assignment') + '</form></details>' : ''}
    ${actions ? '<form id="work-form" data-revision="' + item.revision + '">' + actions + '</form>' : ''}
    </section><section><h2>Activity</h2><ol class="work-log">${history.map(event =>
      '<li>' + escape(event.action + ' · ' + event.actor + ' · ' + new Date(event.at).toLocaleString()) + '</li>').join('')}</ol></section>`;
}

root.addEventListener('submit', async event => {
  event.preventDefault();
  if (busy) return;
  busy = true;
  const form = event.target;
  const fields = new FormData(form);
  const body = Object.fromEntries(fields);
  const buttons = [...form.querySelectorAll('button')];
  buttons.forEach(button => { button.disabled = true; });
  try {
    if (form.id === 'assign-form') {
      const signature = JSON.stringify(body);
      if (pendingRequest?.signature !== signature) pendingRequest = { signature, id: crypto.randomUUID() };
      body.requestId = pendingRequest.id;
      const { item } = await request(api, body);
      location.href = link(item.id);
    } else {
      body.action = event.submitter?.value;
      if (body.action === 'submit') body.outputDocuments = fields.getAll('outputDocuments');
      body.revision = Number(form.dataset.revision);
      if (body.sourcePage) body.sourcePage = Number(body.sourcePage);
      body.attested = body.attested === 'on';
      await request(api + '/' + encodeURIComponent(selected), body);
      try {
        renderItem(await request(api + '/' + encodeURIComponent(selected)));
        message('Work updated.');
      } catch (error) {
        message('Work was updated. Reload to see the current state. ' + error.message, true);
      }
    }
  } catch (error) {
    message(error.message, true);
  } finally {
    busy = false;
    buttons.forEach(button => { button.disabled = false; });
  }
});

try {
  [info, queue] = await Promise.all([request('/api/bootstrap'), request(api + '?offset=' + (selected ? 0 : offset))]);
  if (selected) renderItem(await request(api + '/' + encodeURIComponent(selected)));
  else renderQueue();
} catch (error) {
  message(error.message, true);
} finally {
  root.setAttribute('aria-busy', 'false');
}
