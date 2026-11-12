import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { copyDatabase, verifyDatabase } from '../server/maintenance.mjs';
import { buildApp } from '../server/app.mjs';

const users = [
  { username: 'lead', password: 'synthetic-lead-secret', firm: 'a' },
  { username: 'staff', password: 'synthetic-staff-secret', firm: 'a', role: 'preparer' },
  { username: 'review', password: 'synthetic-review-secret', firm: 'a' },
  { username: 'unrelated', password: 'synthetic-unrelated-secret', firm: 'a' },
  { username: 'foreign', password: 'synthetic-foreign-secret', firm: 'b' },
];

async function start(t, database = ':memory:') {
  const server = buildApp({ database, users });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = 'http://127.0.0.1:' + server.address().port;
  return async function call(username, path, body, expected = 200, extra = {}) {
    const account = users.find(user => user.username === username);
    const headers = account ? { Authorization: 'Basic ' + Buffer.from(username + ':' + account.password).toString('base64') } : {};
    const pdf = Buffer.isBuffer(body);
    const response = await fetch(base + path, {
      method: body ? 'POST' : 'GET',
      headers: { ...headers, ...(body ? { 'X-Briefcase-Request': '1', 'Content-Type': pdf ? 'application/pdf' : 'application/json' } : {}), ...extra },
      body: pdf ? body : body && JSON.stringify(body),
    });
    const data = response.headers.get('content-type')?.includes('application/json') ?
      await response.json() : Buffer.from(await response.arrayBuffer());
    assert.equal(response.status, expected, data.error);
    return data;
  };
}

const path = '/api/role-work';
const assignment = (roleId, extras = {}) => ({
  roleId, requestId: randomUUID(), title: 'Synthetic ' + roleId, context: 'Fixture inputs for ' + roleId,
  assignee: 'staff', reviewer: 'review', ...extras,
});
const submit = revision => ({ action: 'submit', revision, output: 'Fixture output', evidence: 'Fixture evidence ID' });
const approve = revision => ({ action: 'approve', revision, notes: 'Checked against the fixture.', attested: true });
const receipt = revision => ({ action: 'receipt', revision, provider: 'Synthetic provider', reference: 'Fixture receipt ID',
  outcome: 'Fixture result accepted' });

test('all 65 role templates reach verified state through authenticated HTTP', async t => {
  const call = await start(t);
  const { roles, roster } = await call('lead', path);
  assert.deepEqual(roles.map(role => role.id), Array.from({ length: 65 }, (_, i) => 'R' + String(i + 1).padStart(2, '0')));
  assert.ok(!roster.find(user => user.username === 'foreign'));
  assert.deepEqual((await call('staff', path)).roster, []);
  let native = 0;
  let hybrid = 0;
  for (const role of roles) {
    assert.ok(role.input && role.output && role.check, role.id);
    const { item } = await call('lead', path, assignment(role.id), 201);
    const url = path + '/' + item.id;
    await call('staff', url, submit(0));
    const reviewed = (await call('review', url, approve(1))).item;
    if (role.external) {
      hybrid += 1;
      assert.equal(reviewed.status, 'awaiting_receipt', role.id);
      await call('review', url + '/proof', undefined, 409);
      await call('staff', url, receipt(2));
      await call('review', url, { action: 'verify', revision: 3, notes: 'Matched fixture receipt.', attested: true });
    } else {
      native += 1;
      assert.equal(reviewed.status, 'verified', role.id);
    }
    const proof = await call('staff', url + '/proof');
    const { sha256, ...submission } = proof.record.submission;
    assert.equal(proof.record.status, 'verified', role.id);
    assert.equal(sha256, createHash('sha256').update(JSON.stringify(submission)).digest('hex'), role.id);
    assert.equal(proof.record.verification.outputSha256, sha256, role.id);
    if (role.external) assert.equal(proof.record.verification.receiptSha256, proof.record.receipt.sha256, role.id);
    assert.equal(proof.history.length, role.external ? 5 : 3, role.id);
  }
  assert.deepEqual({ native, hybrid }, { native: 22, hybrid: 43 });
  const first = await call('staff', path);
  const second = await call('staff', path + '?offset=50');
  assert.equal(first.items.length, 50);
  assert.equal(first.hasMore, true);
  assert.equal(second.items.length, 15);
  assert.equal(second.hasMore, false);
});

test('role workflow guards access, assignment replay, rework, and provider verification', async t => {
  const call = await start(t);
  await call(null, path, undefined, 401);
  await call('staff', path, assignment('R30'), 403);
  await call('lead', path, assignment('R30', { assignee: 'foreign' }), 422);
  await call('lead', path, assignment('R30', { reviewer: 'staff', assignee: 'lead' }), 422);
  await call('lead', path, assignment('R30', { reviewer: 'lead', assignee: 'lead' }), 422);
  const input = assignment('R30');
  await call('lead', path, input, 403, { Origin: 'https://another.example' });
  const { item } = await call('lead', path, input, 201);
  assert.equal((await call('lead', path, input)).item.id, item.id);
  await call('lead', path, { ...input, title: 'Changed' }, 409);
  const url = path + '/' + item.id;
  for (const outsider of ['unrelated', 'foreign']) {
    assert.equal((await call(outsider, path)).items.length, 0);
    await call(outsider, url, undefined, 404);
    await call(outsider, url + '/proof', undefined, 404);
    await call(outsider, url, submit(0), 404);
  }
  await call('staff', url, receipt(0), 409);
  await call('staff', url, { ...submit(0), evidence: '' }, 422);
  await call('staff', url, submit(0));
  await call('staff', url, approve(1), 403);
  await call('lead', url, approve(1), 403);
  await call('review', url, approve(0), 409);
  await call('review', url, { ...approve(1), attested: false }, 422);
  await call('review', url, { action: 'return', revision: 1, notes: 'Correct the venue.' });
  await call('staff', url, { ...submit(2), output: 'Corrected fixture' });
  await call('review', url, approve(3));
  const verify = revision => ({ action: 'verify', revision, notes: 'Checked the accepted receipt.', attested: true });
  await call('review', url, verify(4), 409);
  await call('staff', url, receipt(4));
  await call('review', url, { action: 'return', revision: 5, notes: 'The provider rejected this submission.' });
  await call('staff', url, { ...receipt(6), reference: 'Corrected receipt' });
  await call('review', url, { action: 'revise', revision: 7, notes: 'Use the new required version.' });
  await call('staff', url, { ...submit(8), output: 'New reviewed filing version' });
  await call('staff', url, receipt(9), 409);
  await call('review', url, approve(9));
  await call('staff', url, { ...receipt(10), reference: 'Accepted final receipt' });
  await call('review', url, verify(11));
  const proof = await call('lead', url + '/proof');
  assert.equal(proof.record.attempts[0].decision.notes, 'Correct the venue.');
  assert.equal(proof.record.attempts[1].receiptReturns[0].receipt.reference, 'Fixture receipt ID');
  assert.equal(proof.record.attempts[1].receipt.reference, 'Corrected receipt');
  assert.equal(proof.record.receipt.reference, 'Accepted final receipt');
  await call('staff', url, receipt(12), 409);
  await call('lead', url, { action: 'cancel', revision: 12, notes: 'Already verified.' }, 409);
  const cancelled = (await call('lead', path, assignment('R10'), 201)).item;
  const cancel = { action: 'cancel', revision: 0, notes: 'Reviewer replaced. Open a new assignment.' };
  await call('staff', path + '/' + cancelled.id, cancel, 403);
  assert.equal((await call('lead', path + '/' + cancelled.id, cancel)).item.status, 'canceled');
  await call('staff', path + '/' + cancelled.id, submit(1), 409);
});

test('linked matter permissions govern role queue, updates, and proof after revocation', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'briefcase-role-proof-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const database = join(directory, 'live.sqlite');
  const backup = join(directory, 'backup.sqlite');
  const call = await start(t, database);
  const matter = await call('lead', '/api/matters', { name: 'Synthetic restricted matter' }, 201);
  const matterTeam = '/api/matters/' + matter.id + '/team';
  const input = assignment('R03', { matter: matter.id });
  await call('lead', path, input, 404);
  await call('lead', matterTeam, { action: 'grant', username: 'staff', access: 'prepare' });
  await call('lead', matterTeam, { action: 'grant', username: 'review', access: 'review' });
  const { item } = await call('lead', path, input, 201);
  const url = path + '/' + item.id;
  const pdf = await readFile(new URL('./fixtures/mixed.pdf', import.meta.url));
  const { document } = await call('staff', '/api/matters/' + matter.id + '/documents', pdf, 201,
    { 'X-PDF-Name': 'Synthetic.pdf', 'X-PDF-Purpose': 'supporting' });
  await call('staff', url, { ...submit(0), sourceId: document.id, sourcePage: 900 }, 422);
  await call('staff', url, { ...submit(0), outputDocuments: ['invalid'] }, 422);
  assert.deepEqual((await call('staff', url)).outputDocuments, [{ id: document.id, name: document.name }]);
  await call('staff', url, { ...submit(0), sourceId: document.id, sourcePage: 2, outputDocuments: [document.id] });
  const file = url + '/file/1/' + document.id;
  assert.deepEqual(await call('review', file), pdf);
  await call('foreign', file, undefined, 404);
  await call('review', url, approve(1));
  const proof = await call('staff', url + '/proof');
  assert.deepEqual(proof.record.submission.source, { documentId: document.id, page: 2, originalSha256: document.sha256 });
  await call('lead', matterTeam, { action: 'revoke', username: 'staff' });
  assert.equal((await call('staff', path)).items.length, 0);
  await call('staff', url + '/proof', undefined, 404);
  await call('staff', file, undefined, 404);
  await call('staff', url, submit(2), 404);
  await call('review', url + '/proof');
  await copyDatabase(database, backup);
  await verifyDatabase(backup);
  const restored = new DatabaseSync(backup);
  try {
    const record = restored.prepare('SELECT state FROM role_work WHERE firm=? AND id=?').get('a', item.id);
    const bad = JSON.parse(record.state);
    bad.submission.output = 'Tampered output';
    restored.prepare('UPDATE role_work SET state=? WHERE firm=? AND id=?').run(JSON.stringify(bad), 'a', item.id);
  } finally {
    restored.close();
  }
  await assert.rejects(verifyDatabase(backup), /role-work verification record failed/);
});

test('a sole lawyer can complete a self-reviewed workflow with explicit attribution', async t => {
  const call = await start(t);
  const { item } = await call('foreign', path, assignment('R01', { assignee: 'foreign', reviewer: 'foreign' }), 201);
  const url = path + '/' + item.id;
  await call('foreign', url, submit(0));
  await call('foreign', url, approve(1));
  assert.equal((await call('foreign', url + '/proof')).record.reviewMode, 'self-review');
});
