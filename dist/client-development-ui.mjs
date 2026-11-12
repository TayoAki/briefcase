const root = document.querySelector('#desk-root');
const status = document.querySelector('#desk-status');
const api = '/api/client-development';
const escape = value => String(value ?? '').replace(/[&<>"']/g, char =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const field = (title, name, type = 'text', attrs = '') =>
  '<label>' + escape(title) + '<input name="' + name + '" type="' + type + '" required ' + attrs + '></label>';
const area = (title, name, max) => '<label>' + escape(title) + '<textarea name="' + name + '" maxlength="' + max + '" required></textarea></label>';
const hidden = (name, value) => '<input type="hidden" name="' + name + '" value="' + escape(value) + '">';
const select = (title, name, values) => '<label>' + escape(title) + '<select name="' + name + '" required><option value="">Choose…</option>' +
  values.map(option => {
    const [value, label] = Array.isArray(option) ? option : [option, option];
    return '<option value="' + escape(value) + '">' + escape(label) + '</option>';
  }).join('') + '</select></label>';
const form = (action, fields, label) =>
  '<form data-action="' + action + '">' + fields + '<button class="btn primary">' + escape(label) + '</button></form>';
const block = (title, body) => '<section><h2>' + escape(title) + '</h2>' + body + '</section>';
const detail = (title, body) => '<details><summary>' + escape(title) + '</summary>' + body + '</details>';
const p = text => '<p class="work-copy">' + escape(text) + '</p>';
const activity = row => detail('Activity', row.history.map(event =>
  p(event.action + ' · ' + event.by + (event.note ? ' · ' + event.note : ''))).join(''));
const attest = title => '<label><span><input type="checkbox" name="attested" required> ' + escape(title) + '</span></label>';
const key = row => hidden('id', row.id) + hidden('revision', row.revision);
const current = row => key(row) + hidden('version', row.version);
let data;
let firm;
let busy = false;

async function request(path, body) {
  const response = await fetch(path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json',
    'X-Briefcase-Request': '1' }, body: JSON.stringify(body) } : {});
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'The request could not be completed.');
  return result;
}
const has = role => data.roles.includes(role);
const person = role => data.people.filter(account => account.desk.includes(role)).map(row => row.username);
const matters = () => firm.matters.filter(row => row.access === 'owner').map(row => [row.id, row.name]);
const file = (kind, id) => '<a class="desk-report-link" href="' + api + '/' + kind + '/' + encodeURIComponent(id) + '/export">Download approved version</a>';

function authorship() {
  if (!data.lawyer) return '';
  const options = data.options;
  const referrals = (firm.referrals ?? []).filter(row => row.partner === data.username);
  const owned = data.clientAccounts.filter(row => row.owner === data.username);
  const contributors = data.clientAccounts.filter(row => row.manager !== data.username || row.owner === data.username);
  return block('Permissions and source material',
    detail('Approve an experience card', form('experience-add', select('Closed source matter', 'matterId', matters()) +
      select('Practice area', 'area', options.areas) + select('Service', 'service', options.services) +
      select('Outcome', 'outcome', options.outcomes) + attest('These categories are approved for reuse.'), 'Approve experience') +
      data.ownedExperience.map(row => row.active ? form('experience-retire', key(row), 'Retire ' + row.area + ' · ' + row.service) : '').join('')) +
    detail('Share a referral brief', form('referral-share', select('Referral', 'referralId', referrals.map(row => [row.id, row.reference])) +
      select('Business development manager', 'manager', person('R07')) + select('Practice area', 'area', options.areas), 'Share brief') +
      data.ownedBriefs.map(row => form('referral-withdraw', key(row), 'Withdraw ' + row.area + ' brief from ' + row.manager)).join('')) +
    detail('Record limited marketing consent', form('consent-add', select('Matter', 'matterId', matters()) +
      select('Signed consent PDF', 'documentId', []) + select('Marketing author', 'marketer', person('R08')) +
      select('Marketing reviewer', 'reviewer', person('R08')) + select('Authorized channel', 'channel', options.channels) +
      field('Expiry date (UTC)', 'expires', 'date') + area('Exact authorized client copy', 'excerpt', 3000) +
      attest('I checked the signed consent for this text, channel and expiry.'), 'Record consent') +
      data.ownedConsents.filter(row => !row.revokedAt).map(row => detail('Withdraw ' + row.channel + ' consent · ' + row.marketer,
        form('consent-revoke', key(row) + area('Withdrawal reason', 'notes', 800), 'Withdraw consent'))).join('')) +
    detail('Create a client account', form('account-add', field('Approved account label', 'label') +
      select('Relationship manager', 'manager', person('R09')), 'Create account')) +
    owned.map(row => detail('Invite a matter owner · ' + row.label, form('account-invite', key(row) +
      select('Contributing lawyer', 'username', data.people.filter(p => p.role === 'lawyer' && p.username !== data.username).map(p => p.username)),
      'Invite lawyer'))).join('') +
    detail('Share a matter milestone', form('account-link', select('Client account', 'accountId', contributors.map(row => [row.id, row.label])) +
      select('Owned matter', 'matterId', matters()) + field('Approved history label', 'label') +
      select('Milestone', 'milestone', ['Opened', 'In progress', 'Resolved', 'Closed']) + hidden('revision', 0), 'Share milestone')));
}

function pitchForm(row) {
  const briefs = data.briefs.filter(row => row.manager === data.username);
  const cardList = data.experience.map(card => '<label><span><input type="checkbox" name="cards" value="' +
    escape(card.reference) + '"' + (row?.selection?.cards.includes(card.reference) ? ' checked' : '') + '> ' +
    escape(card.area + ' · ' + card.service + ' · ' + card.outcome) + '</span></label>').join('');
  return form('pitch-save', (row ? key(row) + hidden('brief', row.selection?.brief ?? '') :
    hidden('revision', 0) + select('Shared referral brief', 'brief', briefs.map(item => [item.id, item.area + ' · ' + item.owner]))) +
    select('Pitch format', 'style', [['introduction', 'Introduction'], ['followup', 'Follow-up']]) +
    '<fieldset><legend>Approved experience cards</legend>' + cardList + '</fieldset>', 'Save version');
}
function storyForm(row) {
  const options = data.consentOptions.filter(item => item.marketer === data.username);
  return form('story-save', (row ? key(row) + hidden('consent', row.selection?.consent ?? '') :
    hidden('revision', 0) + select('Consent record', 'consent', options.map(item => [item.id, item.channel + ' · ' + item.excerpt.slice(0, 45)]))) +
    select('Authorized channel', 'channel', data.options.channels) +
    select('Story format', 'style', Object.entries(data.options.storyStyles)), 'Save version');
}
function work(row, kind, edit) {
  const preview = row.artifact ? kind === 'pitch' ? p(row.artifact.title) + p(row.artifact.introduction) +
    row.artifact.experience.map(card => p([card.area, card.service, card.outcome].join(' · '))).join('') :
    p(row.artifact.headline) + p(row.artifact.copy) + p(row.artifact.channel) : p('Source permission is no longer available.');
  const author = row.author === data.username;
  return detail(kind + ' v' + row.version + ' · ' + row.status, preview +
    (row.artifact && author && ['draft', 'returned'].includes(row.status) ? edit(row) : '') +
    (row.artifact && author && row.status === 'draft' ? form(kind + '-submit', current(row), 'Submit for review') : '') +
    (row.artifact && row.reviewer === data.username && row.status === 'submitted' ?
      form(kind + '-return', current(row) + area('Requested changes', 'notes', 800), 'Return for changes') +
      form(kind + '-approve', current(row) + area('Review notes', 'notes', 800) +
        attest('I checked the exact version and permitted material.'), 'Approve version') : '') +
    (row.artifact && row.status === 'approved' ? file(kind, row.id) : '') + activity(row));
}
function relationships() {
  if (!data.clientAccounts.length && !data.feedback.length) return '';
  return block('Client history and service follow-up', data.clientAccounts.map(account => detail(account.label,
    data.clientHistory.filter(row => row.accountId === account.id).map(row => p(row.label + ' · ' + row.milestone) +
      (has('R09') && account.manager === data.username ? form('feedback-new', hidden('linkId', row.id) +
        select('Topic', 'topic', ['Communication', 'Timing', 'Billing', 'Other']) + area('Client feedback', 'feedback', 1800) +
        area('Requested follow-up', 'nextStep', 900), 'Route to matter lead') : '') +
      (row.matterId ? form('account-unlink', hidden('accountId', account.id) + hidden('matterId', row.matterId) +
        hidden('revision', row.revision), 'Withdraw history permission') : '')).join(''))).join('') +
    data.feedback.map(row => detail(row.topic + ' · ' + row.status, p(row.feedback) + p(row.nextStep) +
      (row.resolution ? p(row.resolution) : '') +
      (row.lead === data.username && row.status === 'routed' ? form('feedback-ack', key(row), 'Acknowledge') : '') +
      (row.lead === data.username && row.status === 'acknowledged' ? form('feedback-resolve', key(row) +
        area('Resolution and evidence', 'resolution', 1400), 'Resolve follow-up') : '') + activity(row))).join(''));
}
async function load() {
  [data, firm] = await Promise.all([request(api), request('/api/firm-desk')]);
  root.innerHTML = [
    has('R07') || data.pitches.length ? block('Business development pitches',
      (has('R07') ? detail('Draft a pitch', pitchForm()) : '') + data.pitches.map(row => work(row, 'pitch', pitchForm)).join('')) : '',
    has('R08') || data.stories.length ? block('Marketing stories', (has('R08') && data.consentOptions.some(row => row.marketer === data.username)
      ? detail('Draft a consent-scoped story', storyForm()) : '') + data.stories.map(row => work(row, 'story', storyForm)).join('')) : '',
    relationships(), authorship(),
  ].join('') || p('There are no client development assignments for this account.');
}
function notice(message, error = false) {
  status.textContent = message;
  status.dataset.error = String(error);
}
root.addEventListener('change', async event => {
  const select = event.target;
  const form = select.closest('form');
  if (select.name !== 'matterId' || form?.dataset.action !== 'consent-add') return;
  const documents = form.elements.documentId;
  documents.innerHTML = '<option value="">Choose…</option>';
  if (!select.value) return;
  const selected = select.value;
  try {
    const matter = await request('/api/matters/' + encodeURIComponent(selected));
    if (select.value !== selected) return;
    documents.insertAdjacentHTML('beforeend', matter.documents.filter(row => row.purpose === 'supporting')
      .map(row => '<option value="' + escape(row.id) + '">' + escape(row.name) + '</option>').join(''));
  } catch (error) { notice(error.message, true); }
});
root.addEventListener('submit', async event => {
  event.preventDefault();
  if (busy) return;
  busy = true;
  const button = event.target.querySelector('button');
  button.disabled = true;
  try {
    const fields = new FormData(event.target);
    const body = Object.fromEntries(fields);
    body.action = event.target.dataset.action;
    if (body.action === 'pitch-save') body.cards = fields.getAll('cards');
    for (const name of ['revision', 'version']) if (name in body) body[name] = Number(body[name]);
    if (body.action === 'account-link') body.revision = data.ownedLinks.find(row =>
      row.matterId === body.matterId && row.accountId === body.accountId)?.revision ?? 0;
    body.attested = fields.has('attested');
    await request(api, body);
    try { await load(); notice('Saved.'); }
    catch { notice('Saved. Reload to see the current record.', true); }
  } catch (error) { notice(error.message, true); }
  finally { busy = false; button.disabled = false; }
});
try { await load(); }
catch (error) { notice(error.message, true); }
finally { root.setAttribute('aria-busy', 'false'); }
