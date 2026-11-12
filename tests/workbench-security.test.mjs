import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { buildApp } from '../server/app.mjs';
import { workflows } from '../server/workbench.mjs';
import { PDFDocument, StandardFonts } from '../dist/vendor/packets/pdf-lib.mjs';

async function setup(t, specified) {
  const users = (specified ?? [
    ['owner', 'lawyer', ['R55']], ['reviewer', 'lawyer', []], ['staff', 'preparer', ['R24', 'R56']],
    ['manager', 'preparer', ['R34']], ['replacement', 'preparer', ['R24']], ['foreign', 'lawyer', [], { firm: 'beta' }],
    ['guest', 'lawyer', [], { matterOnly: true }],
  ]).map(([username, role, desk, extra = {}]) => ({ username, role, desk, firm: 'alpha', password: 'security-synthetic-' + username, ...extra }));
  const server = buildApp({ database: ':memory:', users });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = 'http://127.0.0.1:' + server.address().port;
  async function call(username, path, body, expected = 200, extras = {}) {
    const pdf = Buffer.isBuffer(body);
    const response = await fetch(base + path, { method: body ? 'POST' : 'GET', headers: {
      Authorization: 'Basic ' + Buffer.from(username + ':security-synthetic-' + username).toString('base64'),
      ...(body ? { 'X-Briefcase-Request': '1', 'Content-Type': pdf ? 'application/pdf' : 'application/json' } : {}), ...extras,
    }, body: body && (pdf ? body : JSON.stringify(body)) });
    const result = response.headers.get('content-type')?.includes('application/json') ? await response.json() : Buffer.from(await response.arrayBuffer());
    assert.equal(response.status, expected, result.error);
    return result;
  }
  async function matter() {
    const m = await call('owner', '/api/matters', { name: 'Private security fixture matter' }, 201);
    for (const [username, access] of [['reviewer', 'review'], ['staff', 'prepare'], ['replacement', 'prepare']]) {
      if (users.some(u => u.username === username)) await call('owner', '/api/matters/' + m.id + '/team', { action: 'grant', username, access });
    }
    return m;
  }
  async function upload(matterId) {
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    pdf.addPage().drawText('A public receipt for the synthetic purchase.', { x: 54, y: 700, font, size: 12 });
    const { document } = await call('owner', '/api/matters/' + matterId + '/documents', Buffer.from(await pdf.save()), 201,
      { 'X-PDF-Name': 'Receipt.pdf', 'X-PDF-Purpose': 'supporting' });
    return document;
  }
  const create = async (roleId, data, options = {}) => (await call('owner', '/api/workbench', {
    roleId, title: 'Security fixture ' + roleId, requestId: randomUUID(), assignee: 'staff', reviewer: 'reviewer', data, ...options,
  }, 201)).item;
  const command = async (user, item, action, data = {}, expected = 200) => call(user, '/api/workbench/' + item.id, { revision: item.revision, action, data }, expected);
  async function approve(item, assignee = 'staff', reviewer = 'reviewer') {
    item = (await command(assignee, item, 'submit')).item;
    return (await call(reviewer, '/api/workbench/' + item.id, { revision: item.revision, action: 'approve', sha256: item.submission.sha256, notes: 'Checked exact sources and output.', attested: true })).item;
  }
  return { call, matter, upload, create, command, approve };
}

test('reviewer-only domain actions require the current matter review grant', async t => {
  const { call, matter, upload, create, command } = await setup(t);
  assert.deepEqual((await call('guest', '/api/workbench')).roster, [], 'Outside counsel cannot enumerate the firm roster.');
  const m = await matter(), doc = await upload(m.id);
  const item = await create('R24', { documents: [{ id: 'E1', documentId: doc.id }] }, { matter: m.id });
  await call('owner', '/api/matters/' + m.id + '/team', { action: 'grant', username: 'reviewer', access: 'prepare' });
  await command('reviewer', item, 'code-document', { id: 'E1', sourceSha256: doc.sha256, designation: 'responsive', reason: 'Downgraded account must not make review decisions.' }, 403);
  const current = (await call('owner', '/api/workbench/' + item.id)).item;
  assert.equal(current.revision, item.revision);
  assert.equal(current.data.documents[0].designation, 'unreviewed');
});

test('a former sole lawyer cannot keep using self-review after a second account activates', async t => {
  const { call, create, command } = await setup(t, [
    ['owner', 'lawyer', ['R55']], ['newhire', 'preparer', [], { initiallyDisabled: true }],
  ]);
  let item = await create('R33', { scope: 'Initial scope', budgetCents: 10000, budgetReference: 'Budget-1' }, { assignee: 'owner', reviewer: 'owner' });
  assert.equal(item.reviewMode, 'self-review');
  item = (await command('owner', item, 'propose', { scope: 'Expanded scope', budgetCents: 12000, reason: 'Additional research' })).item;
  item = (await command('owner', item, 'accept-change', { proposalHash: item.data.proposals.at(-1).hash, notes: 'Solo review before another account is activated.' })).item;
  await call('owner', '/api/identity', { action: 'activate', username: 'newhire', revision: 0, reference: 'HR-activation' });
  await command('owner', item, 'submit', {}, 409);
});

test('recruiting projections hide names and review notes on mutations, detail and approved export', async t => {
  const { call, create, command, approve } = await setup(t);
  let item = await create('R56', { candidateReference: 'Candidate-Delta', names: [{ name: 'Confidential Former Client', relationship: 'former client' }] });
  const privateHash = item.data.namesHash;
  const publicDetail = await call('staff', '/api/workbench/' + item.id);
  assert.doesNotMatch(JSON.stringify(publicDetail), /Confidential Former Client|"names":/);
  item = (await command('reviewer', item, 'record-clearance', { namesHash: privateHash, status: 'conditions', reference: 'Conflicts-Delta' })).item;
  const submitted = (await command('staff', item, 'submit')).item;
  assert.doesNotMatch(JSON.stringify(submitted), /Confidential Former Client|"names":/);
  await call('reviewer', '/api/workbench/' + item.id, { revision: submitted.revision, action: 'approve', sha256: submitted.submission.sha256, notes: 'Private investigative detail for conflicts counsel only.', attested: true });
  const restricted = await call('staff', '/api/workbench/' + item.id);
  assert.doesNotMatch(JSON.stringify(restricted), /Confidential Former Client|Private investigative detail|"names":/);
  const exported = await call('staff', '/api/workbench/' + item.id + '/export');
  assert.doesNotMatch(JSON.stringify(exported), /Confidential Former Client|Private investigative detail|"names":/);
  assert.equal(exported.version.output.clearance, 'conditions');
  await call('foreign', '/api/workbench/' + item.id + '/export', undefined, 404);
});

test('a privilege withdrawal during PDF rendering prevents release of the previously approved version', async t => {
  const { call, matter, upload, create, command, approve } = await setup(t);
  const m = await matter(), doc = await upload(m.id);
  let item = await create('R24', { documents: [{ id: 'E1', documentId: doc.id }] }, { matter: m.id });
  item = (await command('reviewer', item, 'code-document', { id: 'E1', sourceSha256: doc.sha256, designation: 'responsive', reason: 'Initial review cleared release.' })).item;
  item = await approve(item);
  const def = workflows.find(row => row.roleId === 'R24');
  const originalExport = def.exportFile;
  let notifyStarted, release;
  const started = new Promise(resolve => { notifyStarted = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  def.exportFile = async function(...args) { notifyStarted(); await gate; return originalExport.apply(this, args); };
  t.after(() => { def.exportFile = originalExport; release(); });
  const downloading = call('staff', '/api/workbench/' + item.id + '/export?format=pdf', undefined, 409);
  await started;
  await command('reviewer', item, 'code-document', { id: 'E1', sourceSha256: doc.sha256, designation: 'privileged', reason: 'Privilege discovered while export was rendering.' });
  release();
  await downloading;
  def.exportFile = originalExport;
});

test('a source access revocation during rendering prevents file delivery', async t => {
  const { call, matter, upload, create, command, approve } = await setup(t);
  const m = await matter(), doc = await upload(m.id);
  let item = await create('R24', { documents: [{ id: 'E1', documentId: doc.id }] }, { matter: m.id });
  item = (await command('reviewer', item, 'code-document', { id: 'E1', sourceSha256: doc.sha256, designation: 'responsive', reason: 'Cleared release.' })).item;
  item = await approve(item);
  const def = workflows.find(row => row.roleId === 'R24');
  const originalExport = def.exportFile;
  let notifyStarted, release;
  const started = new Promise(resolve => { notifyStarted = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  def.exportFile = async function(...args) { const result = await originalExport.apply(this, args); notifyStarted(); await gate; return result; };
  t.after(() => { def.exportFile = originalExport; release(); });
  const downloading = call('staff', '/api/workbench/' + item.id + '/export?format=pdf', undefined, 404);
  await started;
  await call('owner', '/api/matters/' + m.id + '/team', { action: 'revoke', username: 'staff' });
  release();
  await downloading;
  def.exportFile = originalExport;
});

test('practice reassignment exposes only metadata, cannot grant matter access and invalidates the current submission', async t => {
  const { call, matter, upload, create, command, approve } = await setup(t);
  const m = await matter(), doc = await upload(m.id);
  let target = await create('R24', { documents: [{ id: 'E1', documentId: doc.id }] }, { matter: m.id, title: 'CONFIDENTIAL underlying work title' });
  target = (await command('reviewer', target, 'code-document', { id: 'E1', sourceSha256: doc.sha256, designation: 'responsive', reason: 'PRIVATE source-specific legal review.' })).item;
  target = await approve(target);
  let routing = await create('R34', { reviewLabel: 'Weekly routing', staleHours: 24 }, { assignee: 'manager', reviewer: 'owner' });
  const visible = await call('manager', '/api/workbench/' + routing.id);
  assert.doesNotMatch(JSON.stringify(visible), /CONFIDENTIAL|PRIVATE|Private security fixture matter|Receipt.pdf|documentId/);
  await call('manager', '/api/workbench/' + target.id, undefined, 404);
  const route = (username, expected) => command('manager', routing, 'reassign', { workId: target.id, username, expectedRevision: target.revision, reason: 'Coverage handoff' }, expected);
  await route('reviewer', 422); // Cannot make a reviewer their own preparer.
  await route('manager', 404); // Assignment delegation does not grant source-matter access.
  await route('foreign', 422);
  await command('manager', routing, 'reassign', { workId: target.id, username: 'replacement', expectedRevision: target.revision - 1, reason: 'Stale target' }, 409);
  const unchanged = (await call('staff', '/api/workbench/' + target.id)).item;
  assert.equal(unchanged.revision, target.revision);
  assert.equal(unchanged.status, 'approved');
  routing = (await route('replacement')).item;
  const reassigned = (await call('replacement', '/api/workbench/' + target.id)).item;
  assert.equal(reassigned.assignee, 'replacement');
  assert.equal(reassigned.reviewer, 'reviewer');
  assert.equal(reassigned.status, 'draft');
  assert.equal(reassigned.submission, null);
  await call('replacement', '/api/workbench/' + target.id + '/export', undefined, 409);
  await call('staff', '/api/workbench/' + target.id, undefined, 404);
  await call('staff', '/api/workbench/' + target.id + '/export?version=1', undefined, 404);
  const archived = await call('replacement', '/api/workbench/' + target.id + '/export?version=1');
  assert.equal(archived.version.decision.by, 'reviewer');
  assert.equal(routing.data.handoffs.at(-1).to, 'replacement');
});
