// Live check of role agents against a running Briefcase with a real model connected (synthetic data only).
// Usage: node deploy/agents-live.mjs <base-url> <users.json> [roleId ...]   (default roles: R25 R01)
// Needs in the first firm: a lawyer owner and a second lawyer with a desk grant to review.
import { readFileSync } from 'node:fs';

const [base, usersPath, ...wanted] = process.argv.slice(2);
const users = JSON.parse(readFileSync(usersPath, 'utf8'));
const firm = users[0].firm;
const owner = users.find(user => user.firm === firm && (user.role ?? 'lawyer') === 'lawyer');
const reviewer = users.find(user => user.firm === firm && user !== owner && (user.role ?? 'lawyer') === 'lawyer' && user.desk?.length);
const outsider = users.find(user => user.firm !== firm);
const briefs = {
  R25: 'Draft a short research memo titled "Record summary" that states what the first page of the matter\'s record documents, citing one exact quotation from that page as its source.',
  R01: 'Prepare the partner pack for November 2026 for the east office. Inputs: 3 open matters, 1 opened this month, 0 closed, fees billed 42,000, fees collected 31,500. Do not name any matter.',
};

async function call(user, path, body, headers = {}) {
  const pdf = Buffer.isBuffer(body);
  const response = await fetch(base + path, { method: body ? 'POST' : 'GET',
    headers: { Authorization: 'Basic ' + Buffer.from(user.username + ':' + user.password).toString('base64'),
      ...(body ? { 'X-Briefcase-Request': '1', 'Content-Type': pdf ? 'application/pdf' : 'application/json' } : {}), ...headers },
    body: pdf ? body : body && JSON.stringify(body) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(path + ' → ' + response.status + ' ' + (data.error ?? ''));
  return data;
}

const overview = await call(owner, '/api/agents');
console.log('agents: ' + overview.agents.length + ', model connected: ' + overview.modelReady);
if (!overview.modelReady) { console.log('Connect a model (BRIEFCASE_MODEL_URL / _NAME / _KEY) and rerun.'); process.exit(2); }
const matter = await call(owner, '/api/matters', { name: 'Agent live check ' + new Date().toISOString().slice(0, 16) });
await call(owner, '/api/matters/' + matter.id + '/documents', readFileSync(new URL('../tests/fixtures/digital.pdf', import.meta.url)), { 'X-PDF-Name': 'Record.pdf' });
await call(owner, '/api/matters/' + matter.id + '/team', { action: 'grant', username: reviewer.username, access: 'review' });

let failed = 0;
for (const roleId of wanted.length ? wanted : ['R25', 'R01']) {
  const agent = overview.agents.find(row => row.id === roleId);
  let { run } = await call(owner, '/api/agents/runs', { roleId, title: 'Live check ' + roleId, reviewer: reviewer.username,
    matter: agent.kind === 'workflow' ? matter.id : null, brief: briefs[roleId] ?? 'Prepare the ' + agent.output + ' from this input: ' + agent.input + '. Use clearly labelled synthetic details.' });
  for (let waited = 0; run.status === 'running' && waited < 240; waited += 2) {
    await new Promise(resolve => setTimeout(resolve, 2000));
    run = (await call(owner, '/api/agents/runs/' + run.id)).run;
  }
  console.log('\n' + roleId + ' · ' + agent.title + ' → ' + run.status + ' in ' + run.turns + ' model turns');
  for (const step of run.steps) console.log('  ' + (step.kind === 'tool' ? (step.ok ? '✓ ' : '✕ ') + step.name + (step.ok ? '' : ' ' + step.result) : step.kind + ': ' + step.text.replace(/\s+/g, ' ').slice(0, 160)));
  if (run.status !== 'submitted') { failed += 1; continue; }
  const path = (run.kind === 'workflow' ? '/api/workbench/' : '/api/role-work/') + run.itemId;
  const item = (await call(reviewer, path)).item;
  const denied = await call(outsider, '/api/agents/runs/' + run.id).then(() => false, () => true);
  const selfApprove = await call(owner, path, { action: 'approve', revision: item.revision, sha256: item.versions?.at(-1).sha256, notes: 'x', attested: true }).then(() => false, () => true);
  console.log('  work item status: ' + item.status + ' · other firm denied: ' + denied + ' · supervisor self-approval refused: ' + selfApprove);
  if (item.status !== 'submitted' || !denied || !selfApprove) failed += 1;
}
process.exit(failed ? 1 : 0);
