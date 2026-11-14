// Agents screen: a roster of the 65 role agents, a task composer, the run thread and the reviewer's card.
const $ = selector => typeof document === 'undefined' ? null : document.querySelector(selector);
const roster = $('#agents-roster'), main = $('#agents-main'), toast = $('#agents-status');
const esc = value => String(value ?? '').replace(/[&<>"']/g, char =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const params = new URLSearchParams(typeof location === 'undefined' ? '' : location.search);
const state = { info: null, matters: [], agent: params.get('agent'), run: params.get('run'), tab: 'work', filter: 'all', search: '',
  detail: null, review: null, existing: [], timer: null, busy: false };

export const statusLabel = { running: 'Working', needs_input: 'Needs your answer', submitted: 'Submitted for review', stopped: 'Stopped',
  failed: 'Model error', canceled: 'Canceled', interrupted: 'Interrupted' };
export const statusTone = status => status === 'running' ? 'green' : ['needs_input', 'submitted'].includes(status) ? 'amber'
  : ['failed'].includes(status) ? 'red' : 'grey';
export const hue = id => (Number(id.slice(1)) * 47) % 360;
// A run needs this person when they supervise it and it asked a question, or when they are its reviewer and it is submitted.
export const needsMe = (run, username) => (run.owner === username && run.status === 'needs_input') ||
  (run.reviewer === username && run.owner !== username && run.status === 'submitted');
export function matches(agent, search) {
  const term = search.trim().toLowerCase();
  return !term || [agent.id, agent.title, agent.team, agent.output, agent.workflow?.title].some(value => value?.toLowerCase().includes(term));
}
const when = iso => { try { return new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); } catch { return ''; } };
const badge = (text, tone) => '<span class="agent-badge"' + (tone && tone !== 'green' ? ' data-tone="' + tone + '"' : '') + '>' + esc(text) + '</span>';
const avatar = (id, large) => '<span class="agent-avatar' + (large ? ' large' : '') + '" style="--hue:' + hue(id) + '" aria-hidden="true">' + esc(id) + '</span>';
// Workflow outputs are structured. Show long text fields as readable paragraphs and keep the rest as exact JSON.
export function readable(output) {
  if (typeof output === 'string') return output;
  if (!output || typeof output !== 'object' || Array.isArray(output)) return JSON.stringify(output, null, 2);
  return Object.entries(output).map(([key, value]) => key + ':\n' + (typeof value === 'string' ? value : JSON.stringify(value, null, 2))).join('\n\n');
}
const pretty = value => { try { return JSON.stringify(JSON.parse(value), null, 2); } catch { return String(value ?? ''); } };

async function request(path, body) {
  const response = await fetch(path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Briefcase-Request': '1' }, body: JSON.stringify(body) } : {});
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Briefcase could not complete the request.');
  return data;
}
function say(text, error = false) {
  toast.textContent = text;
  toast.dataset.error = String(error);
  if (text) setTimeout(() => { if (toast.textContent === text) toast.textContent = ''; }, error ? 7000 : 3500);
}
function go(next) {
  Object.assign(state, next);
  const query = new URLSearchParams();
  if (state.agent) query.set('agent', state.agent);
  if (state.run) query.set('run', state.run);
  history.replaceState(null, '', '/agents.html' + (query.size ? '?' + query : ''));
}
const agent = () => state.info.agents.find(row => row.id === state.agent);
const runsFor = id => state.info.runs.filter(run => run.roleId === id);

export function rosterHtml(info, { agentId, filter, search }) {
  const teams = new Map();
  for (const row of info.agents) {
    const runs = info.runs.filter(run => run.roleId === row.id);
    const mine = runs.filter(run => needsMe(run, info.username)).length, running = runs.filter(run => run.status === 'running').length;
    if (!matches(row, search) || (filter === 'mine' && !mine) || (filter === 'active' && !runs.length)) continue;
    const dot = mine ? '<span class="agent-dot" title="Needs you">' + mine + '</span>'
      : running ? '<span class="agent-dot" data-kind="running" title="Working">' + running + '</span>'
      : runs.length ? '<span class="agent-dot" data-kind="idle" title="Runs">' + runs.length + '</span>' : '';
    if (!teams.has(row.team)) teams.set(row.team, []);
    teams.get(row.team).push('<button type="button" class="agent-row" data-agent="' + row.id + '"' + (row.id === agentId ? ' aria-current="true"' : '') + '>' +
      avatar(row.id) + '<span><strong>' + esc(row.title) + '</strong><small>' + esc(row.workflow?.title ?? row.output) + '</small></span>' + dot + '</button>');
  }
  if (!teams.size) return '<p class="agents-empty">No agents match.</p>';
  return [...teams].map(([team, rows]) => '<h2>' + esc(team) + '</h2>' + rows.join('')).join('');
}

function renderRoster() {
  roster.innerHTML = rosterHtml(state.info, { agentId: state.agent, filter: state.filter, search: state.search });
  const inbox = state.info.runs.filter(run => needsMe(run, state.info.username)).length;
  $('#agents-inbox-count').textContent = inbox ? '(' + inbox + ')' : '';
  const model = $('#agents-model');
  model.dataset.ready = String(state.info.modelReady);
  model.textContent = state.info.modelReady ? 'Model connected · signed in as ' + state.info.username : 'No model connected — agents cannot run yet.';
}

function profileHtml(row) {
  return `<section class="agent-card"><h3>What this agent prepares</h3><dl>
      <dt>Works from</dt><dd>${esc(row.input)}</dd>
      <dt>Produces</dt><dd>${esc(row.output)}</dd>
      <dt>Acceptance check</dt><dd>${esc(row.check)}</dd>
      <dt>Workflow</dt><dd>${row.workflow ? esc(row.workflow.title) + ' — ' + esc(row.workflow.description) : 'Prepares a written output with its supporting references for lawyer review.'}</dd>
      ${row.workflow ? '<dt>Approved exports</dt><dd>' + esc(row.workflow.formats.join(', ').toUpperCase()) + '</dd>' : ''}
    </dl></section>
    <section class="agent-card"><h3>What it is allowed to do</h3><ul>${row.tools.map(tool =>
      '<li><code>' + esc(tool.name) + '</code> — ' + esc(tool.description) + '</li>').join('')}</ul></section>
    <section class="agent-card"><h3>What stays with people</h3><ul>${row.human.map(line => '<li>' + esc(line) + '</li>').join('')}</ul></section>`;
}

function composerHtml(row) {
  const info = state.info;
  const lawyers = info.roster.filter(person => person.role === 'lawyer' && person.username !== info.username);
  const canOpen = info.role === 'lawyer' || (row.kind === 'workflow' && info.desk.includes(row.id));
  if (!info.modelReady) return `<section class="agent-card"><h3>Connect a model to run this agent</h3>
    <p>Set <code>BRIEFCASE_MODEL_URL</code>, <code>BRIEFCASE_MODEL_NAME</code> and <code>BRIEFCASE_MODEL_KEY</code> on the server to a chat-completions endpoint that supports tool calls. Until then you can read each agent's profile.</p></section>`;
  const existing = state.existing.length ? `<label>Or continue work already assigned to you
      <select name="itemId"><option value="">Start a new assignment</option>${state.existing.map(item =>
        '<option value="' + esc(item.id) + '">' + esc(item.title + ' (' + item.status + ')') + '</option>').join('')}</select></label>` : '';
  if (!canOpen && !state.existing.length) return `<section class="agent-card"><h3>Give this agent work</h3>
    <p>${row.kind === 'workflow' ? 'A lawyer, or a specialist granted ' + esc(row.id) + ', starts this agent.' : 'A lawyer opens this assignment.'} Ask for the work to be assigned to you, then start the agent on it here.</p></section>`;
  return `<section class="agent-card"><h3>Give this agent work</h3>
    <form class="agent-form" id="agent-start">
      ${existing}
      <div data-new>
        <div class="row">
          <label>Assignment title<input name="title" maxlength="180" ${canOpen ? 'required' : 'disabled'}></label>
          <label>Reviewing lawyer<select name="reviewer" ${canOpen ? 'required' : 'disabled'}>${lawyers.length ? lawyers.map(person =>
            '<option value="' + esc(person.username) + '">' + esc(person.name) + '</option>').join('') : '<option value="">No other lawyer in this firm</option>'}</select></label>
          <label>Matter${row.matterRequired ? ' (required)' : ''}<select name="matter" ${row.matterRequired ? 'required' : ''} ${canOpen ? '' : 'disabled'}>
            <option value="">${row.matterRequired ? 'Choose a matter' : 'No matter'}</option>${state.matters.map(matter =>
            '<option value="' + esc(matter.id) + '">' + esc(matter.name) + '</option>').join('')}</select></label>
        </div>
      </div>
      <label>Instructions for the agent<textarea name="brief" maxlength="4000" required placeholder="${esc('Works from: ' + row.input + '. Say what you need and anything the documents will not tell it.')}"></textarea></label>
      <p class="hint">The agent prepares and submits in your name. ${esc(row.human[0])}</p>
      <div class="agent-actions"><button class="btn primary" type="submit">Start agent</button></div>
    </form></section>`;
}

function runsHtml(row) {
  const runs = runsFor(row.id);
  if (!runs.length) return '';
  return '<section class="agent-card"><h3>Runs</h3><ul class="agent-runs">' + runs.map(run =>
    '<li><button type="button" data-run="' + run.id + '"><span><strong>' + esc(run.title) + '</strong><small>' + esc(when(run.updatedAt)) +
    ' · supervised by ' + esc(run.owner) + ' · reviewer ' + esc(run.reviewer) + '</small></span>' + badge(statusLabel[run.status] ?? run.status, statusTone(run.status)) + '</button></li>').join('') + '</ul></section>';
}

export function stepHtml(step, username) {
  if (step.kind === 'reply') return '<div class="bubble me"><small>' + esc(step.by === username ? 'You' : step.by) + '</small>' + esc(step.text) + '</div>';
  if (step.kind === 'say') return '<div class="bubble bot">' + esc(step.text) + '</div>';
  if (step.kind === 'ask') return '<div class="bubble ask"><small>Question for the supervisor</small>' + esc(step.text) + '</div>';
  if (step.kind === 'note') return '<p class="thread-note">' + esc(step.text) + '</p>';
  return '<details class="tool-step" data-ok="' + step.ok + '"><summary>' + (step.ok ? '✓' : '✕') + ' <code>' + esc(step.name) + '</code>' +
    (step.ok ? '' : ' — rejected, the agent must correct it') + '</summary><h4>Input</h4><pre>' + esc(pretty(step.input)) + '</pre><h4>Result</h4><pre>' + esc(pretty(step.result)) + '</pre></details>';
}

function reviewHtml(run) {
  const review = state.review;
  if (!review) return '';
  const link = (run.kind === 'workflow' ? '/workbench.html?item=' : '/role-work.html?item=') + encodeURIComponent(run.itemId);
  const open = '<a href="' + link + '">Open the full work record</a>';
  if (review.error) return '<section class="agent-card"><p>' + esc(review.error) + '</p></section>';
  const mineToReview = run.reviewer === state.info.username && review.status === 'submitted';
  const body = `<h3>${mineToReview ? 'Review the exact submitted version' : 'Submitted work'} ${badge(review.status.replaceAll('_', ' '), review.status === 'submitted' ? 'amber' : review.status === 'returned' ? 'red' : 'green')}</h3>
    <div class="review-output" tabindex="0">${esc(review.output)}</div>
    ${review.evidence ? '<p><strong>Relies on:</strong> ' + esc(review.evidence) + '</p>' : ''}
    ${review.sources?.length ? '<p><strong>Bound sources:</strong> ' + review.sources.map(source => esc(source.name + (source.page ? ' p.' + source.page : ''))).join(', ') + '</p>' : ''}`;
  if (!mineToReview) return '<section class="agent-card">' + body + '<p>' + open + (review.status === 'approved' || review.status === 'verified' ? ' to export it.' : '.') + '</p></section>';
  return `<section class="agent-card review-card">${body}
    <form class="agent-form" id="agent-review">
      <label>Review notes<textarea name="notes" maxlength="1600" required></textarea></label>
      <label class="attest"><input type="checkbox" name="attested"> <span>I read this output and checked it against its sources and the acceptance check.</span></label>
      <div class="agent-actions"><button class="btn primary" name="action" value="approve">Approve this version</button>
        <button class="btn" name="action" value="return">Return for changes</button> ${open}</div>
    </form></section>`;
}

function threadHtml(row) {
  const run = state.detail;
  const owner = run.owner === state.info.username;
  const canReply = owner && run.status !== 'running' && state.info.modelReady && !['approved', 'verified'].includes(state.review?.status);
  return `<p><button class="btn ghost small" type="button" data-run="">← All ${esc(row.id)} runs</button></p>
    <section class="agent-card"><div class="agent-actions" style="justify-content:space-between">
      <div><h3 style="margin:0">${esc(run.title)}</h3><small>Supervised by ${esc(run.owner)} · reviewer ${esc(run.reviewer)}${run.matter ? ' · matter linked' : ''}</small></div>
      <div class="agent-actions">${badge(statusLabel[run.status] ?? run.status, statusTone(run.status))}
        ${owner && ['running', 'needs_input'].includes(run.status) ? '<button class="btn small danger" type="button" data-cancel>Stop agent</button>' : ''}</div></div></section>
    <div class="thread" id="agent-thread">${run.steps.map(step => stepHtml(step, state.info.username)).join('')}
      ${run.status === 'running' ? '<p class="typing">' + esc(row.id) + ' agent is working</p>' : ''}</div>
    ${reviewHtml(run)}
    ${canReply ? `<form class="agent-form agent-card" id="agent-reply">
      <label>${run.status === 'needs_input' ? 'Answer the agent' : 'Send the agent a follow-up'}<textarea name="text" maxlength="4000" required placeholder="${run.status === 'needs_input' ? 'Your answer' : 'For example: the reviewer returned it — fix the second citation.'}"></textarea></label>
      <div class="agent-actions"><button class="btn primary" type="submit">Send</button></div></form>` : ''}`;
}

function renderMain() {
  const row = agent();
  if (!row) { main.innerHTML = '<p class="agents-empty">Choose a role agent to see what it does and give it work.</p>'; return; }
  const keep = main.querySelector('#agent-reply textarea')?.value;
  main.innerHTML = `<header class="agent-head">${avatar(row.id, true)}<div><h2>${esc(row.title)}</h2>
      <p>${esc(row.id)} · ${esc(row.team)} · ${badge(row.kind === 'workflow' ? 'Structured workflow' : 'Written assignment', row.kind === 'workflow' ? 'green' : 'grey')}
      ${row.external ? badge('Needs a provider receipt', 'amber') : ''}</p></div></header>
    <div class="agent-tabs" role="tablist"><button type="button" role="tab" data-tab="work" aria-selected="${state.tab === 'work'}">Work</button>
      <button type="button" role="tab" data-tab="profile" aria-selected="${state.tab === 'profile'}">Profile and permissions</button></div>
    ${state.tab === 'profile' ? profileHtml(row) : state.detail ? threadHtml(row) : composerHtml(row) + runsHtml(row)}`;
  if (keep) { const area = main.querySelector('#agent-reply textarea'); if (area) area.value = keep; }
}

async function loadReview(run) {
  state.review = null;
  if (!run.itemId) return;
  try {
    if (run.kind === 'workflow') {
      const { item } = await request('/api/workbench/' + run.itemId);
      const version = item.versions.at(-1);
      state.review = version ? { status: item.status, revision: item.revision, sha256: version.sha256, sources: version.sources,
        output: readable(version.output) } : null;
    } else {
      const { item } = await request('/api/role-work/' + run.itemId);
      state.review = item.submission ? { status: item.status, revision: item.revision, output: item.submission.output, evidence: item.submission.evidence } : null;
    }
  } catch (error) { state.review = { error: error.message }; }
}

async function loadExisting() {
  state.existing = [];
  const row = agent();
  if (!row) return;
  try {
    const items = row.kind === 'workflow' ? (await request('/api/workbench')).items : (await request('/api/role-work')).items;
    state.existing = items.filter(item => item.roleId === row.id && item.assignee === state.info.username && ['draft', 'returned'].includes(item.status));
  } catch { /* The picker is optional. */ }
}

async function refresh() {
  state.info = await request('/api/agents');
  if (state.run) {
    try {
      const previous = state.detail?.status;
      state.detail = (await request('/api/agents/runs/' + state.run)).run;
      state.agent = state.detail.roleId;
      if (state.detail.status !== 'running' && (previous !== state.detail.status || !state.review)) await loadReview(state.detail);
    } catch (error) { state.detail = null; state.run = null; say(error.message, true); }
  } else { state.detail = null; state.review = null; }
  renderRoster();
  renderMain();
  clearTimeout(state.timer);
  state.timer = setTimeout(() => refresh().catch(() => {}), state.detail?.status === 'running' ? 1200 : 15000);
}

async function guarded(work) {
  if (state.busy) return;
  state.busy = true;
  try { await work(); } catch (error) { say(error.message, true); } finally { state.busy = false; }
}

function bind() {
  $('#agents-search').addEventListener('input', event => { state.search = event.target.value; renderRoster(); });
  document.querySelector('.agents-filters').addEventListener('click', event => {
    const button = event.target.closest('[data-filter]');
    if (!button) return;
    state.filter = button.dataset.filter;
    for (const other of document.querySelectorAll('[data-filter]')) other.setAttribute('aria-pressed', String(other === button));
    renderRoster();
  });
  roster.addEventListener('click', event => {
    const button = event.target.closest('[data-agent]');
    if (!button) return;
    go({ agent: button.dataset.agent, run: null, detail: null, review: null, tab: 'work' });
    guarded(async () => { await loadExisting(); await refresh(); main.scrollIntoView({ block: 'start' }); });
  });
  main.addEventListener('click', event => {
    const tab = event.target.closest('[data-tab]'), run = event.target.closest('[data-run]');
    if (tab) { state.tab = tab.dataset.tab; renderMain(); }
    else if (run) { go({ run: run.dataset.run || null, detail: null, review: null }); guarded(refresh); }
    else if (event.target.closest('[data-cancel]')) guarded(async () => { await request('/api/agents/runs/' + state.run, { action: 'cancel' }); await refresh(); });
  });
  main.addEventListener('change', event => {
    if (event.target.name !== 'itemId') return;
    const fresh = main.querySelector('[data-new]');
    if (fresh) fresh.hidden = Boolean(event.target.value);
    for (const input of fresh?.querySelectorAll('input,select') ?? []) input.disabled = Boolean(event.target.value);
  });
  main.addEventListener('submit', event => {
    event.preventDefault();
    const form = event.target, data = Object.fromEntries(new FormData(form));
    if (form.id === 'agent-start') guarded(async () => {
      const body = data.itemId ? { roleId: state.agent, itemId: data.itemId, brief: data.brief }
        : { roleId: state.agent, title: data.title, reviewer: data.reviewer, matter: data.matter || null, brief: data.brief };
      const { run } = await request('/api/agents/runs', body);
      go({ run: run.id });
      await refresh();
    });
    if (form.id === 'agent-reply') guarded(async () => {
      await request('/api/agents/runs/' + state.run, { action: 'reply', text: data.text });
      form.reset();
      state.review = null;
      await refresh();
    });
    if (form.id === 'agent-review') guarded(async () => {
      const action = event.submitter?.value, run = state.detail, review = state.review;
      const body = { action, revision: review.revision, notes: data.notes, attested: data.attested === 'on', ...(run.kind === 'workflow' ? { sha256: review.sha256 } : {}) };
      await request((run.kind === 'workflow' ? '/api/workbench/' : '/api/role-work/') + run.itemId, body);
      say(action === 'approve' ? 'Approved.' : 'Returned to the supervisor.');
      await loadReview(run);
      await refresh();
    });
  });
}

if (typeof document !== 'undefined' && roster) {
  bind();
  Promise.all([request('/api/agents'), request('/api/matters').catch(() => [])]).then(async ([info, matters]) => {
    state.info = info;
    state.matters = Array.isArray(matters) ? matters.filter(matter => !matter.demo).map(({ id, name }) => ({ id, name })) : [];
    if (!state.agent && !state.run) state.agent = info.agents[0].id;
    await loadExisting();
    await refresh();
    $('#agents').setAttribute('aria-busy', 'false');
  }).catch(error => say(error.message, true));
}
