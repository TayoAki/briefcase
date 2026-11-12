const root = document.querySelector('#desk-root');
const status = document.querySelector('#desk-status');
const api = '/api/identity';
const escape = value => String(value ?? '').replace(/[&<>"']/g, char =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
async function request(body) {
  const response = await fetch(api, body ? { method: 'POST', headers: { 'Content-Type': 'application/json',
    'X-Briefcase-Request': '1' }, body: JSON.stringify(body) } : {});
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'The identity action could not finish.');
  return result;
}
async function load() {
  const { accounts, username, canActivate, accessEvents } = await request();
  root.innerHTML = '<section><h2>Firm accounts</h2>' + accounts.map(row => {
    const action = row.status === 'active' ? 'offboard' : row.status === 'pending' && canActivate ? 'activate' : '';
    return '<details><summary>' + escape(row.username + ' · ' + row.status) + '</summary>' +
      row.history.map(event => '<p>' + escape(event.at + ' · ' + event.by + ' · ' + event.action) + '</p>').join('') +
      (action && row.username !== username ? '<form data-action="' + action + '" data-user="' + escape(row.username) +
        '" data-revision="' + row.revision + '"><label>External HR or incident reference<input name="reference" maxlength="180" required></label>' +
        '<label><span><input type="checkbox" required> Confirm this account change.</span></label>' +
        '<button class="btn primary">' + (action === 'activate' ? 'Activate account' : 'Offboard account') + '</button></form>' : '') + '</details>';
  }).join('') + '</section>' + (accessEvents.length ? '<section><h2>Recent access events</h2>' +
    accessEvents.map(event => '<p>' + escape(event.at + ' · ' + event.actor + ' · ' + event.action + ' · ' + event.id) +
      '</p>').join('') + '</section>' : '');
}
function notice(message, error = false) {
  status.textContent = message;
  status.dataset.error = String(error);
}
root.addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.target;
  const button = form.querySelector('button');
  button.disabled = true;
  try {
    await request({ action: form.dataset.action, username: form.dataset.user, revision: Number(form.dataset.revision),
      reference: new FormData(form).get('reference') });
    try { await load(); notice('Account updated.'); }
    catch { notice('Account updated. Reload to see its current state.', true); }
  } catch (error) { notice(error.message, true); }
  finally { button.disabled = false; }
});
try { await load(); }
catch (error) { notice(error.message, true); }
finally { root.setAttribute('aria-busy', 'false'); }
