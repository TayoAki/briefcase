import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { buildApp } from '../server/app.mjs';

const users = [
  ['owner', 'lawyer', ['R04']], ['hr', 'preparer', ['R55']], ['security', 'preparer', ['R61']],
  ['newhire', 'preparer', [], { initiallyDisabled: true }], ['support', 'preparer', ['R60']],
  ['guest', 'lawyer', [], { matterOnly: true }], ['pricing', 'preparer', ['R47']], ['development', 'preparer', ['R57']], ['office', 'preparer', ['R64']],
  ['outsider', 'preparer', ['R60', 'R55', 'R61'], { firm: 'other-firm' }],
].map(([username, role, desk, extra = {}]) => ({ username, role, desk, firm: 'alpha', password: 'synthetic-' + username + '-secret', ...extra }));

async function setup(t) {
  const server = buildApp({ database: ':memory:', users });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const root = 'http://127.0.0.1:' + server.address().port;
  async function call(user, path, body, expected = 200, extra = {}) {
    const pdf = Buffer.isBuffer(body);
    const headers = { Authorization: 'Basic ' + Buffer.from(user + ':synthetic-' + user + '-secret').toString('base64') };
    if (body) Object.assign(headers, { 'X-Briefcase-Request': '1', 'Content-Type': pdf ? 'application/pdf' : 'application/json' });
    const response = await fetch(root + path, { method: body ? 'POST' : 'GET', headers: { ...headers, ...extra },
      body: body && (pdf ? body : JSON.stringify(body)) });
    const result = response.headers.get('content-type')?.includes('application/json') ? await response.json() : await response.arrayBuffer();
    assert.equal(response.status, expected, result?.error);
    return result;
  }
  const firm = (user, action, body, expected) => call(user, '/api/firm-desk', { action, ...body }, expected);
  const activate = () => call('hr', '/api/identity', { action: 'activate', username: 'newhire', revision: 0, reference: 'HR ticket 001' });
  const matter = () => call('owner', '/api/matters', { name: 'Private synthetic matter' }, 201);
  const upload = (path, bytes, expected) => call('owner', path + '/documents', bytes, expected,
    { 'X-PDF-Name': 'Private fixture name.pdf', 'X-PDF-Purpose': 'supporting' });
  return { call, firm, activate, matter, upload };
}
const due = offset => new Date(Date.now() + offset).toISOString();

test('R55 and R61 enforce activation and offboarding across original access and preserve audit evidence', async t => {
  const { call, activate, matter, upload } = await setup(t);
  await call('newhire', '/api/bootstrap', undefined, 401);
  await activate();
  await call('newhire', '/api/bootstrap');
  const source = '/api/matters/' + (await matter()).id;
  const { document } = await upload(source, await readFile(new URL('./fixtures/mixed.pdf', import.meta.url)), 201);
  await call('owner', source + '/team', { action: 'grant', username: 'newhire', access: 'prepare' });
  const original = source + '/documents/' + document.id + '/original';
  await call('newhire', original);
  await call('newhire', original);
  const before = await call('security', '/api/identity');
  assert.equal(before.accessEvents.filter(row => row.actor === 'newhire' && row.action === 'original opened').length, 2);
  const out = await call('security', '/api/identity', { action: 'offboard', username: 'newhire', revision: 1, reference: 'Incident 001' });
  assert.equal(out.item.revokedMatterGrants, 1);
  await call('newhire', original, undefined, 401);
  await call('newhire', source + '/search?q=record', undefined, 401);
  await call('newhire', '/api/role-work', undefined, 401);
  assert.equal((await call('owner', source + '/team')).members[0].username, 'newhire');
  assert.ok((await call('owner', source + '/team')).members[0].revokedAt);
  const after = await call('security', '/api/identity');
  assert.ok(after.accessEvents.some(row => row.action === 'identity access revoked'));
  assert.equal((await call('outsider', '/api/identity')).accessEvents.length, 0);
  await call('hr', '/api/identity', { action: 'activate', username: 'newhire', revision: 2, reference: 'Reused identity' }, 409);
});

test('R57 and R60 expose training totals and failed-import metadata without underlying evidence', async t => {
  const { call, firm, activate, matter, upload } = await setup(t);
  await activate();
  const period = due(0).slice(0, 7);
  const day = due(0).slice(0, 10);
  const assigned = await firm('development', 'training-assign', { username: 'newhire', title: 'Pilot review', due: day });
  await firm('newhire', 'training-complete', { id: assigned.item.id, revision: 1, evidence: 'Confidential evaluation notes' });
  const leadership = await call('owner', '/api/firm-desk?month=' + period);
  assert.deepEqual(leadership.trainingTotals, [{ office: 'main', assigned: 1, completed: 1 }]);
  assert.doesNotMatch(JSON.stringify(leadership), /Confidential evaluation notes/);
  const path = '/api/matters/' + (await matter()).id;
  await upload(path, Buffer.from('bad file'), 422);
  const support = await call('support', '/api/firm-desk');
  assert.equal(support.support[0].status, 'failed');
  assert.doesNotMatch(JSON.stringify(support.support), /Private fixture|matterId|documentId|Private synthetic matter/);
  await firm('support', 'support-triage', { id: support.support[0].id, revision: 0, outcome: 'Retry requested' });
  assert.equal((await call('support', '/api/firm-desk')).support[0].triage.outcome, 'Retry requested');
  await call('support', path, undefined, 404);
  assert.equal((await call('outsider', '/api/firm-desk')).support.length, 0);
});

test('R64 routes a mail delivery, reserves an internal room and escalates a facilities issue', async t => {
  const { call, firm, activate } = await setup(t);
  await activate();
  const common = { office: 'main', delegate: 'newhire', start: due(60_000), end: due(120_000), accessUntil: due(180_000) };
  for (const [type, resource] of [['mail', 'Package ref'], ['room', 'Room 1'], ['facilities', 'Building issue 01']]) {
    const record = (await firm('office', 'service-new', { ...common, type, resource, title: type })).item;
    assert.ok((await call('newhire', '/api/firm-desk')).services.some(row => row.id === record.id));
    await firm('newhire', 'service-ack', { id: record.id, revision: 1 });
    await firm('newhire', 'service-complete', { id: record.id, revision: 2, evidence: 'Recipient confirmed' });
    await firm('office', 'service-verify', { id: record.id, revision: 3, notes: 'Verified receipt' });
  }
  assert.equal((await call('office', '/api/firm-desk')).services.filter(row => row.status === 'verified').length, 3);
});


test('R19 outside counsel can submit a reviewed memo in an assigned matter and loses access when the grant expires', async t => {
  t.mock.timers.enable({ apis: ['Date'] });
  const { call, matter, upload } = await setup(t);
  const assigned = await matter();
  const other = await matter();
  const path = '/api/matters/' + assigned.id;
  const proofPath = '/api/role-work';
  const pdf = await readFile(new URL('./fixtures/mixed.pdf', import.meta.url));
  const { document } = await upload(path, pdf, 201);
  await call('owner', path + '/team', { action: 'grant', username: 'guest', access: 'prepare' }, 422);
  await call('owner', path + '/team', { action: 'grant', username: 'guest', access: 'prepare', expiresAt: due(60_000) });
  assert.deepEqual((await call('guest', '/api/matters')).map(row => row.id), [assigned.id]);
  await call('guest', '/api/matters/' + other.id + '/search?q=record', undefined, 404);
  await call('guest', '/api/firm-desk', undefined, 403);
  const { item } = await call('owner', proofPath, { roleId: 'R19', requestId: 'c8c01370-fce1-4f51-b8fb-0af74c0cd4bc',
    title: 'Assigned legal issue', context: 'Review the identified issue', assignee: 'guest', reviewer: 'owner', matter: assigned.id }, 201);
  await call('guest', proofPath + '/' + item.id, { action: 'submit', revision: 0, output: 'Outside counsel memo',
    evidence: 'Source page reference', outputDocuments: [document.id] });
  await call('owner', proofPath + '/' + item.id, { action: 'approve', revision: 1, notes: 'Reviewed exact memo.', attested: true });
  const file = proofPath + '/' + item.id + '/file/1/' + document.id;
  assert.deepEqual(Buffer.from(await call('guest', file)), pdf);
  t.mock.timers.tick(60_001);
  assert.equal((await call('guest', '/api/matters')).length, 0);
  await call('guest', path + '/search?q=record', undefined, 404);
  await call('guest', file, undefined, 404);
});

test('R47 reconciles two fee and staffing arrangements and pins the selected offer to the reviewed version', async t => {
  const { call, firm, matter } = await setup(t);
  const source = await matter();
  await call('owner', '/api/matters/' + source.id + '/team', { action: 'grant', username: 'pricing', access: 'prepare' });
  const staff = [{ label: 'Associate', minutes: 90, costRate: 12_000, billRate: 30_000 },
    { label: 'Paralegal', minutes: 120, costRate: 6000, billRate: 12_000 }];
  const { item: draft } = await firm('pricing', 'pricing-save', { matterId: source.id, reviewer: 'owner', revision: 0,
    assumptions: 'One associate and one paralegal. Amounts are planning inputs.',
    options: [{ label: 'Flat fee', type: 'fixed', fixedFee: 60_000, expenses: 5000, staff },
      { label: 'Hourly', type: 'hourly', expenses: 5000, staff }] });
  assert.deepEqual(draft.versions[0].options.map(row => [row.fee, row.staffing, row.margin]),
    [[60_000, 30_000, 25_000], [69_000, 30_000, 34_000]]);
  assert.equal((await call('owner', '/api/firm-desk')).pricing.length, 0);
  const sha256 = draft.versions[0].sha256;
  const submitted = (await firm('pricing', 'pricing-submit', { id: draft.id, revision: 1, sha256 })).item;
  await firm('owner', 'pricing-approve', { id: draft.id, revision: submitted.revision, sha256: 'wrong',
    option: 1, notes: 'Reviewed', attested: true }, 409);
  await firm('owner', 'pricing-approve', { id: draft.id, revision: submitted.revision, sha256,
    option: 1, notes: 'Reviewed rates and staffing', attested: true });
  const exportPath = '/api/firm-desk/' + draft.id + '/pricing';
  const proof = await call('owner', exportPath);
  assert.deepEqual([proof.selected.index, proof.selected.sha256, proof.selected.by], [1, sha256, 'owner']);
  await call('outsider', exportPath, undefined, 404);
  await call('owner', '/api/matters/' + source.id + '/team', { action: 'revoke', username: 'pricing' });
  await call('pricing', exportPath, undefined, 404);
});
