import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import test from 'node:test';
import { buildApp } from '../server/app.mjs';
import { workflows, verifyDiligenceEnvelope, searchDmsIndex, dueDisposition } from '../server/workflows/technology.mjs';

const defs = Object.fromEntries(workflows.map(row => [row.roleId, row]));
const hash = value => createHash('sha256').update(Buffer.isBuffer(value) || typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const now = '2026-11-12T12:00:00.000Z';
const original = await readFile(new URL('./fixtures/digital.pdf', import.meta.url));
const doc = { id: 'source-1', name: 'Notice.pdf', sha256: hash(original), bytes: original, purpose: 'supporting', pages: [{ number: 1, text: 'Verified source notice and records.' }] };
function context(extra = {}) {
  return {
    user: { username: 'operator', firm: 'alpha', role: 'preparer', desk: ['R17', 'R59', 'R60', 'R61', 'R62', 'R63'] }, now, isReviewer: false,
    fail(status, message) { throw Object.assign(new Error(message), { status }); }, hash,
    source(id) { if (id !== doc.id) this.fail(404, 'Source unavailable'); return doc; },
    sourceBinding(id) { const source = this.source(id); return { documentId: id, name: source.name, sha256: source.sha256 }; },
    ...extra,
  };
}
const reviewer = ctx => ({ ...ctx, user: { ...ctx.user, username: 'reviewer', role: 'lawyer' }, isReviewer: true });
const change = (definition, state, action, input, ctx) => definition.update(structuredClone(state), action, input, ctx);
const rejected = (fn, status) => assert.throws(fn, error => error.status === status);
const keys = generateKeyPairSync('ed25519');
const keyConfig = { trusted: keys.publicKey.export({ type: 'spki', format: 'pem' }) };
function envelope(overrides = {}, signingKey = keys.privateKey) {
  const payload = { firm: 'alpha', caseReference: 'case-17', requestReference: 'req-1', provider: 'Identity provider fixture', sequence: 1,
    status: 'clear', issuedAt: '2026-11-12T11:00:00.000Z', expiresAt: '2026-11-13T11:00:00.000Z', evidenceHash: hash('restricted provider evidence'), ...overrides };
  return { keyId: 'trusted', payload, signature: sign(null, Buffer.from(JSON.stringify(payload)), signingKey).toString('base64') };
}

test('R17 verifies trusted provider signatures, tenant/request binding, sequence replay, expiry and unresolved escalation', () => {
  const def = defs.R17, ctx = context({ diligenceKeys: keyConfig });
  let state = def.create({ caseReference: 'case-17', requestReference: 'req-1' }, ctx);
  assert.equal(def.validate(state, ctx).errors.length, 1);
  state = change(def, state, 'escalate', { owner: 'risk-counsel', reason: 'Provider has not completed verification' }, ctx);
  assert.equal(def.output(state, ctx).escalationOwner, 'risk-counsel');
  rejected(() => change(def, state, 'provider-response', { envelope: envelope() }, context()), 409);
  rejected(() => change(def, state, 'provider-response', { envelope: envelope({ firm: 'beta' }) }, ctx), 409);
  rejected(() => change(def, state, 'provider-response', { envelope: envelope({ requestReference: 'another-request' }) }, ctx), 409);
  const tampered = envelope(); tampered.payload.status = 'failed';
  rejected(() => change(def, state, 'provider-response', { envelope: tampered }, ctx), 409);
  state = change(def, state, 'provider-response', { envelope: envelope() }, ctx);
  assert.equal(def.validate(state, ctx).errors.length, 0);
  assert.equal(def.output(state, ctx).clearanceAllowed, true);
  assert.equal(change(def, state, 'provider-response', { envelope: envelope() }, ctx).receipts.length, 1);
  rejected(() => change(def, state, 'provider-response', { envelope: envelope({ status: 'review' }) }, ctx), 409);
  const passed = structuredClone(state);
  state = change(def, state, 'provider-response', { envelope: envelope({ status: 'review', sequence: 2 }) }, ctx);
  assert.equal(def.validate(state, ctx).errors.length, 1);
  rejected(() => def.assertExport(state, passed, ctx), 409);
  rejected(() => verifyDiligenceEnvelope(envelope({ expiresAt: '2026-11-12T11:30:00.000Z' }), state, ctx), 409);
  rejected(() => def.validate(passed, { ...ctx, now: '2026-11-14T00:00:00.000Z' }), 409);
  rejected(() => def.validate(passed, { ...ctx, diligenceKeys: {} }), 409);
  assert.doesNotMatch(JSON.stringify(def.output(passed, ctx)), /evidenceHash|signature|reason/);
});

test('R59 reconciles real manifest digests, rejects foreign or changed restore and requires independent operator review', () => {
  const source = { firm: 'alpha', capturedAt: now, originals: [{ id: 'opaque-1', sha256: doc.sha256 }], counts: { matters: 1, originals: 1 } };
  const ctx = context({ technology: { recoveryManifest: () => source } }), def = defs.R59;
  let state = def.create({ environment: 'production', inventory: [{ name: 'DMS', mode: 'manual', owner: 'operator', reference: 'CONFIG-1' }] }, ctx);
  state = change(def, state, 'capture', {}, ctx);
  rejected(() => change(def, state, 'restore-result', { environment: 'production', runReference: 'RUN-1', manifest: source }, ctx), 409);
  rejected(() => change(def, state, 'restore-result', { environment: 'isolated', runReference: 'RUN-1', manifest: { ...source, firm: 'beta' } }, ctx), 409);
  rejected(() => change(def, state, 'restore-result', { environment: 'isolated', runReference: 'RUN-1', manifest: { ...source, originals: [{ id: 'opaque-1', sha256: hash('changed') }] } }, ctx), 409);
  state = change(def, state, 'restore-result', { environment: 'isolated', runReference: 'RUN-1', manifest: source }, ctx);
  assert.equal(def.validate(state, ctx).errors.length, 1);
  rejected(() => change(def, state, 'operator-review', { notes: 'Reconciled CLI restore against source manifest' }, ctx), 403);
  state = change(def, state, 'operator-review', { notes: 'Reconciled CLI restore against source manifest' }, reviewer(ctx));
  assert.equal(def.validate(state, ctx).errors.length, 0);
  const prior = structuredClone(state);
  state = change(def, state, 'capture', {}, ctx);
  assert.equal(state.operator, null);
  assert.ok(def.output(prior, ctx).operator.digest);
});

test('R60 diagnoses a stalled actual job, prevents duplicate retries and pairs a completed retry to the original opaque scope', () => {
  const jobs = [
    { id: 'job-1', scopeKey: hash('scope-A'), status: 'running', startedAt: '2026-11-12T11:00:00.000Z', filename: 'MUST NOT LEAK', matterId: 'private' },
    { id: 'job-2', scopeKey: hash('scope-A'), status: 'complete', startedAt: '2026-11-12T12:01:00.000Z', finishedAt: '2026-11-12T12:02:00.000Z' },
    { id: 'job-other', scopeKey: hash('scope-B'), status: 'complete', startedAt: '2026-11-12T12:01:00.000Z' },
  ];
  const ctx = context({ technology: { supportJobs: () => jobs } }), def = defs.R60;
  let state = def.create({ jobId: 'job-1', caseReference: 'SUP-1' }, ctx);
  state = change(def, state, 'refresh-job', {}, ctx);
  const retry = { requestId: 'retry-1', owner: 'matter-owner', reason: 'Lease exceeded fifteen minutes' };
  state = change(def, state, 'request-retry', retry, ctx);
  assert.equal(change(def, state, 'request-retry', retry, ctx).events.length, state.events.length);
  rejected(() => change(def, state, 'request-retry', { ...retry, requestId: 'retry-2' }, ctx), 409);
  rejected(() => change(def, state, 'confirm-retry', { replacementJobId: 'job-other' }, ctx), 409);
  state = change(def, state, 'confirm-retry', { replacementJobId: 'job-2' }, ctx);
  assert.equal(def.validate(state, ctx).errors.length, 0);
  assert.doesNotMatch(JSON.stringify(def.output(state, ctx)), /MUST NOT LEAK|matterId/);
  jobs[1].status = 'failed';
  assert.equal(def.validate(state, ctx).errors.length, 1);
  rejected(() => change(def, state, 'refresh-job', {}, context({ technology: { supportJobs: () => [] } })), 404);
});

test('R61 pins actual activity evidence and refuses closure or old export while account is active', () => {
  let active = true;
  const ctx = context({ technology: { accountActive: () => active,
    securityEvents: () => [{ id: 1, actor: 'departing', action: 'original opened', at: now, originalName: 'private' }] } }), def = defs.R61;
  let state = def.create({ username: 'departing', incidentReference: 'SEC-1' }, ctx);
  rejected(() => change(def, state, 'verify-revocation', {}, ctx), 409);
  state = change(def, state, 'capture-evidence', {}, ctx);
  assert.doesNotMatch(JSON.stringify(state), /originalName/);
  active = false;
  state = change(def, state, 'verify-revocation', {}, ctx);
  assert.equal(def.validate(state, ctx).errors.length, 0);
  active = true;
  assert.equal(def.validate(state, ctx).errors.length, 1);
  rejected(() => def.assertExport(state, state, ctx), 409);
});

test('R62 pins the imported bytes, rejects conflicting source replay and removes search results after access revocation', () => {
  const ctx = context(), def = defs.R62;
  let state = def.create({ connector: 'DMS-import-batch-1' }, ctx);
  const input = { externalId: 'external-1', documentId: doc.id, sourceVersion: 'v1' };
  state = change(def, state, 'import-source', input, ctx);
  assert.equal(change(def, state, 'import-source', input, ctx).entries.length, 1);
  state = change(def, state, 'reconcile', {}, ctx);
  assert.equal(def.validate(state, ctx).errors.length, 0);
  assert.equal(searchDmsIndex(state, ctx, 'source notice').length, 1);
  const changed = context({ source: () => ({ ...doc, sha256: hash('tampered original') }) });
  rejected(() => def.validate(state, changed), 409);
  const revoked = context({ source() { this.fail(404, 'Source unavailable'); } });
  assert.deepEqual(searchDmsIndex(state, revoked, 'notice'), []);
  assert.deepEqual(def.output(state, revoked).entries, []);
  rejected(() => def.assertExport(state, state, revoked), 404);
  const replay = context({ sourceBinding: () => ({ documentId: doc.id, sha256: hash('different source') }) });
  rejected(() => change(def, state, 'import-source', input, replay), 409);
});

test('R63 preserves active holds through serialization, blocks scheduled and historical disposition, and requires reviewed exact receipts', () => {
  const ctx = context(), review = reviewer(ctx), def = defs.R63;
  let state = def.create({ policyReference: 'Approved retention schedule RET-1' }, ctx);
  state = change(def, state, 'schedule', { documentId: doc.id, retainUntil: '2026-01-01T00:00:00.000Z', authorityReference: 'POLICY-1' }, ctx);
  state = change(def, state, 'hold', { reference: 'HOLD-1', reason: 'Preservation order' }, ctx);
  state = JSON.parse(JSON.stringify(state));
  assert.equal(dueDisposition(state, ctx)[0].eligible, false);
  state = change(def, state, 'run-schedule', {}, ctx);
  rejected(() => change(def, state, 'authorize-disposition', { manifestHash: state.evaluation.manifestHash, reason: 'Release' }, review), 409);
  rejected(() => change(def, state, 'release-hold', { reference: 'HOLD-1', authorityReference: 'Release order' }, ctx), 403);
  state = change(def, state, 'release-hold', { reference: 'HOLD-1', authorityReference: 'RELEASE-1' }, review);
  state = change(def, state, 'run-schedule', {}, ctx);
  const digest = state.evaluation.manifestHash;
  rejected(() => change(def, state, 'authorize-disposition', { manifestHash: hash('wrong'), reason: 'Reviewed' }, review), 409);
  state = change(def, state, 'authorize-disposition', { manifestHash: digest, reason: 'Reviewed the released hold and due source list' }, review);
  const approved = structuredClone(state);
  state = change(def, state, 'hold', { reference: 'HOLD-2', reason: 'New preservation requirement' }, ctx);
  rejected(() => def.assertExport(state, approved, ctx), 409);
  rejected(() => change(def, state, 'record-disposition', { manifestHash: digest, receiptReference: 'DELETE-1', documentIds: [doc.id] }, ctx), 409);
  state = change(def, approved, 'record-disposition', { manifestHash: digest, receiptReference: 'DELETE-1', documentIds: [doc.id] }, ctx);
  assert.equal(state.records[0].disposed, 'DELETE-1');
  assert.equal(def.validate(state, ctx).errors.length, 0);
  assert.equal(state.holds[0].released.authorityReference, 'RELEASE-1');
  assert.equal(def.output(state, ctx).receipts[0].manifestHash, digest);
});

async function listening(server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return 'http://127.0.0.1:' + server.address().port;
}
async function close(server) {
  server.closeAllConnections?.();
  await new Promise(resolve => server.close(resolve));
}

test('R61 real authenticated import cannot commit after account is revoked while model provider response is in flight', async t => {
  let signalProvider, releaseProvider;
  const reachedProvider = new Promise(resolve => { signalProvider = resolve; });
  const release = new Promise(resolve => { releaseProvider = resolve; });
  const provider = createServer(async (req, res) => {
    for await (const _part of req) { /* drain provider request */ }
    signalProvider(); await release;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: '{"events":[]}' } }] }));
  });
  const providerRoot = await listening(provider);
  t.after(() => close(provider));
  const users = [
    { username: 'owner', role: 'lawyer', desk: [] },
    { username: 'staff', role: 'preparer', desk: [] },
    { username: 'security', role: 'preparer', desk: ['R61'] },
    { username: 'foreign', role: 'preparer', desk: ['R61'], firm: 'beta' },
  ].map(row => ({ password: 'synthetic-' + row.username + '-secret', firm: 'alpha', ...row }));
  const server = buildApp({ database: ':memory:', users, model: { url: new URL(providerRoot), model: 'controlled-fixture' } });
  const root = await listening(server);
  t.after(() => close(server));
  async function call(who, path, body, expected = 200, extras = {}) {
    const headers = { Authorization: 'Basic ' + Buffer.from(who + ':synthetic-' + who + '-secret').toString('base64'), ...extras };
    if (body) Object.assign(headers, { 'X-Briefcase-Request': '1', 'Content-Type': Buffer.isBuffer(body) ? 'application/pdf' : 'application/json' });
    const response = await fetch(root + path, { method: body ? 'POST' : 'GET', headers, body: body && (Buffer.isBuffer(body) ? body : JSON.stringify(body)) });
    const result = await response.json(); assert.equal(response.status, expected, result.error); return result;
  }
  const matter = await call('owner', '/api/matters', { name: 'Revocation synthetic matter' }, 201);
  const base = '/api/matters/' + matter.id;
  await call('owner', base + '/team', { action: 'grant', username: 'staff', access: 'prepare' });
  const importing = call('staff', base + '/documents', original, 404, { 'X-PDF-Name': 'Fixture.pdf' });
  let timeout;
  try {
    await Promise.race([reachedProvider, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Provider was not reached')), 10000); })]);
    await call('security', '/api/identity', { action: 'offboard', username: 'staff', revision: 0, reference: 'SEC-INFLIGHT-1' });
    releaseProvider();
    await importing;
    assert.equal((await call('owner', base)).documents.length, 0);
    await call('staff', base + '/search?q=record', undefined, 401);
    await call('foreign', base, undefined, 404);
    const evidence = await call('security', '/api/identity');
    assert.ok(evidence.accessEvents.some(row => row.action === 'identity access revoked'));
  } finally { clearTimeout(timeout); releaseProvider(); }
});

async function workbenchServer(t, { database = ':memory:', keys: diligenceKeys = keyConfig } = {}) {
  const users = [
    { username: 'owner', role: 'lawyer', desk: ['R15'] },
    { username: 'operator', role: 'preparer', desk: ['R13', 'R14', 'R16', 'R17', 'R59', 'R60', 'R61', 'R62', 'R63'] },
    { username: 'departing', role: 'preparer', desk: [] },
    { username: 'foreign', role: 'lawyer', desk: [], firm: 'beta' },
  ].map(row => ({ password: 'synthetic-' + row.username + '-secret', firm: 'alpha', ...row }));
  const server = buildApp({ database, users, workbench: { diligenceKeys } });
  const root = await listening(server);
  t.after(() => close(server));
  async function call(who, path, body, expected = 200, extras = {}) {
    const headers = { Authorization: 'Basic ' + Buffer.from(who + ':synthetic-' + who + '-secret').toString('base64'), ...extras };
    if (body) Object.assign(headers, { 'X-Briefcase-Request': '1', 'Content-Type': Buffer.isBuffer(body) ? 'application/pdf' : 'application/json' });
    const response = await fetch(root + path, { method: body ? 'POST' : 'GET', headers, body: body && (Buffer.isBuffer(body) ? body : JSON.stringify(body)) });
    const data = response.headers.get('content-type')?.includes('application/json') ? await response.json() : Buffer.from(await response.arrayBuffer());
    assert.equal(response.status, expected, data.error); return data;
  }
  async function create(roleId, data, matter) {
    const { randomUUID } = await import('node:crypto');
    return (await call('owner', '/api/workbench', { requestId: randomUUID(), roleId, title: roleId + ' integrated scenario', assignee: 'operator', reviewer: 'owner', matter, data }, 201)).item;
  }
  async function command(item, action, data = {}, who = 'operator', expected = 200) {
    const result = await call(who, '/api/workbench/' + item.id, { revision: item.revision, action, data }, expected);
    return result.item;
  }
  async function approve(item) {
    let row = await command(item, 'submit');
    const body = { revision: row.revision, action: 'approve', sha256: row.submission.sha256, notes: 'Checked exact output, sources and current operational evidence.', attested: true };
    await call('operator', '/api/workbench/' + row.id, body, 403);
    await call('owner', '/api/workbench/' + row.id, { ...body, sha256: hash('wrong-version') }, 409);
    row = (await call('owner', '/api/workbench/' + row.id, body)).item;
    await call('foreign', '/api/workbench/' + row.id, undefined, 404);
    const exported = await call('operator', '/api/workbench/' + row.id + '/export');
    assert.equal(exported.version.sha256, row.submission.sha256);
    return row;
  }
  async function upload(matter, bytes = original, expected = 201) {
    return call('owner', '/api/matters/' + matter + '/documents', bytes, expected, { 'X-PDF-Name': 'Operational evidence.pdf', 'X-PDF-Purpose': 'supporting' });
  }
  async function makeMatter() {
    const matter = await call('owner', '/api/matters', { name: 'Technology synthetic evidence' }, 201);
    await call('owner', '/api/matters/' + matter.id + '/team', { action: 'grant', username: 'operator', access: 'prepare' });
    return matter;
  }
  return { server, root, call, create, command, approve, upload, makeMatter };
}

test('R17 signed provider result completes authenticated independent review and newer unresolved response blocks prior clearance export', async t => {
  const { call, create, command, approve } = await workbenchServer(t);
  let item = await create('R17', { caseReference: 'case-17', requestReference: 'req-1' });
  await command(item, 'submit', {}, 'operator', 422);
  const receipt = envelope({ issuedAt: new Date(Date.now() - 60_000).toISOString(), expiresAt: new Date(Date.now() + 3600_000).toISOString() });
  item = await command(item, 'provider-response', { envelope: receipt });
  item = await approve(item);
  const exported = await call('operator', '/api/workbench/' + item.id + '/export');
  assert.equal(exported.version.output.clearanceAllowed, true);
  item = await command(item, 'provider-response', { envelope: envelope({ ...receipt.payload, sequence: 2, status: 'review' }) });
  await call('operator', '/api/workbench/' + item.id + '/export?version=1', undefined, 409);
  item = await command(item, 'escalate', { owner: 'owner', reason: 'Provider requires beneficial-owner review' });
  assert.equal(item.data.escalation.owner, 'owner');
  await command(item, 'submit', {}, 'operator', 422);
});

test('R60 and R61 use actual redacted import metadata and account events through authenticated review', async t => {
  const { call, create, command, approve, upload, makeMatter } = await workbenchServer(t);
  const matter = await makeMatter();
  const { document } = await upload(matter.id);
  await upload(matter.id, Buffer.from('not a PDF'), 422);
  let supportJobs = (await call('operator', '/api/firm-desk')).support;
  const failed = supportJobs.find(row => row.status === 'failed'); assert.ok(failed);
  let supportItem = await create('R60', { jobId: failed.id, caseReference: 'SUP-ACTUAL-1' });
  supportItem = await command(supportItem, 'refresh-job');
  await command(supportItem, 'request-retry', { requestId: 'unrouted-retry', owner: 'fictional-owner', reason: 'Must be an actual assigned reviewer' }, 'operator', 422);
  supportItem = await command(supportItem, 'request-retry', { requestId: 'retry-once', owner: 'owner', reason: 'Owner must upload a valid original' });
  await upload(matter.id, await readFile(new URL('./fixtures/mixed.pdf', import.meta.url)));
  supportJobs = (await call('operator', '/api/firm-desk')).support;
  const replacement = supportJobs.filter(row => row.status === 'complete' && row.startedAt >= supportItem.data.retry.at).at(-1); assert.ok(replacement);
  supportItem = await command(supportItem, 'confirm-retry', { replacementJobId: replacement.id });
  supportItem = await approve(supportItem);
  assert.doesNotMatch(JSON.stringify((await call('operator', '/api/workbench/' + supportItem.id + '/export')).version.output), /Technology synthetic|Operational evidence\.pdf|matterId/);
  const base = '/api/matters/' + matter.id;
  await call('owner', base + '/team', { action: 'grant', username: 'departing', access: 'prepare' });
  await call('departing', base + '/documents/' + document.id + '/original');
  let securityItem = await create('R61', { username: 'departing', incidentReference: 'SEC-ACTUAL-1' });
  securityItem = await command(securityItem, 'capture-evidence');
  assert.ok(securityItem.data.evidence.some(row => row.actor === 'departing' && row.action === 'original opened'));
  await command(securityItem, 'verify-revocation', {}, 'operator', 409);
  await call('operator', '/api/identity', { action: 'offboard', username: 'departing', revision: 0, reference: 'SEC-ACTUAL-1' });
  securityItem = await command(securityItem, 'verify-revocation');
  await approve(securityItem);
  await call('departing', base + '/search?q=source', undefined, 401);
});

test('R62 original hashes and searches follow real matter access, including revoked export and cross-firm denial', async t => {
  const { call, create, command, approve, upload, makeMatter } = await workbenchServer(t);
  const matter = await makeMatter();
  const { document } = await upload(matter.id);
  let item = await create('R62', { connector: 'Authorized DMS manual import' }, matter.id);
  item = await command(item, 'import-source', { externalId: 'DOC-1', sourceVersion: 'v1', documentId: document.id });
  item = await command(item, 'search', { query: 'Operational evidence' });
  assert.equal(item.data.results.length, 1);
  assert.equal(item.data.results[0].sha256, hash(original));
  item = await command(item, 'reconcile');
  item = await approve(item);
  await call('owner', '/api/matters/' + matter.id + '/team', { action: 'revoke', username: 'operator' });
  await call('operator', '/api/workbench/' + item.id + '/export?version=1', undefined, 404);
  await call('operator', '/api/matters/' + matter.id + '/search?q=record', undefined, 404);
  assert.equal((await call('operator', '/api/workbench')).items.some(row => row.id === item.id), false);
});

test('R59 and R63 perform a real tenant-only SQLite recovery with preserved held sources and independent operator signoff', async t => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const { copyTenantDatabase, verifyDatabase } = await import('../server/maintenance.mjs');
  const directory = await mkdtemp(join(tmpdir(), 'briefcase-technology-recovery-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = join(directory, 'source.sqlite'), destination = join(directory, 'restored.sqlite');
  const live = await workbenchServer(t, { database: source });
  const matter = await live.makeMatter();
  const { document } = await live.upload(matter.id);
  await live.call('foreign', '/api/matters', { name: 'Foreign matter must not survive export' }, 201);
  let recordsItem = await live.create('R63', { policyReference: 'RET-REVIEWED-1' }, matter.id);
  recordsItem = await live.command(recordsItem, 'schedule', { documentId: document.id, retainUntil: '2026-01-01T00:00:00.000Z', authorityReference: 'AUTH-1' });
  recordsItem = await live.command(recordsItem, 'hold', { reference: 'HOLD-RESTORE', reason: 'Active preservation obligation' });
  recordsItem = await live.command(recordsItem, 'run-schedule');
  recordsItem = await live.approve(recordsItem);
  let recoveryItem = await live.create('R59', { environment: 'source-host', inventory: [{ name: 'Archive', owner: 'owner', mode: 'manual', reference: 'CONFIG-1' }] });
  recoveryItem = await live.command(recoveryItem, 'capture');
  const evidence = await copyTenantDatabase(source, destination, 'alpha');
  assert.equal(evidence.originals, 1); assert.equal(evidence.matters, 1);
  assert.equal((await verifyDatabase(destination)).originals, 1);
  const restored = await workbenchServer(t, { database: destination });
  const restoredRecords = (await restored.call('operator', '/api/workbench/' + recordsItem.id)).item;
  assert.equal(restoredRecords.data.holds[0].reference, 'HOLD-RESTORE');
  const { runRecordsSchedule } = await import('../server/records-scheduler.mjs');
  const scheduleOptions = { baseUrl: restored.root, username: 'operator', password: 'synthetic-operator-secret' };
  const firstRun = await runRecordsSchedule(scheduleOptions);
  const repeatedRun = await runRecordsSchedule(scheduleOptions);
  assert.equal(firstRun.jobs.length, 1);
  assert.equal(firstRun.jobs[0].status, 'held');
  assert.equal(firstRun.jobs[0].destructiveActionAuthorized, false);
  assert.equal(firstRun.jobs[0].candidates[0].activeHoldCount, 1);
  assert.equal(firstRun.jobs[0].jobId, repeatedRun.jobs[0].jobId);
  assert.equal((await restored.call('operator', '/api/workbench/' + recordsItem.id)).item.revision, restoredRecords.revision);
  await assert.rejects(runRecordsSchedule({ ...scheduleOptions, baseUrl: 'http://example.com' }), /HTTPS/);
  let due = await restored.command(restoredRecords, 'run-schedule');
  assert.equal(due.data.evaluation.candidates[0].eligible, false);
  await restored.command(due, 'authorize-disposition', { manifestHash: due.data.evaluation.manifestHash, reason: 'Attempt to bypass preserved hold' }, 'owner', 409);
  await restored.call('foreign', '/api/workbench/' + recordsItem.id, undefined, 404);
  let restoredRecovery = (await restored.call('operator', '/api/workbench/' + recoveryItem.id)).item;
  restoredRecovery = await restored.command(restoredRecovery, 'capture');
  recoveryItem = await live.command(recoveryItem, 'restore-result', { manifest: restoredRecovery.data.baseline, environment: 'isolated-restore-host', runReference: 'ACTUAL-SQLITE-RESTORE-1' });
  await live.command(recoveryItem, 'operator-review', { notes: 'Review attempt by preparer' }, 'operator', 403);
  recoveryItem = await live.command(recoveryItem, 'operator-review', { notes: 'Verified tenant-only SQLite restore with matching original hashes and active held-source gate.' }, 'owner');
  await live.approve(recoveryItem);
  const after = await restored.call('operator', '/api/matters/' + matter.id + '/documents/' + document.id + '/original');
  assert.equal(hash(after), hash(original));
});

test('R17 signed verification is a live intake gate through conflict clearance, matter opening and signed engagement finalization', async t => {
  const { call, create, command, approve, upload } = await workbenchServer(t);
  const act = async (who, action, input, expected = 200) => (await call(who, '/api/risk-intake', { action, ...input }, expected)).item;
  const key = row => ({ id: row.id, revision: row.revision });
  let inquiry = await act('operator', 'inquiry-new', { reference: 'SIGNED-INTAKE-1', channel: 'Web', contact: 'Synthetic caller', notes: 'Signed provider verification required.' });
  const current = async (who = 'operator') => (await call(who, '/api/risk-intake')).inquiries.find(row => row.id === inquiry.id);
  inquiry = await current();
  inquiry = await act('operator', 'inquiry-assign', { ...key(inquiry), assignee: 'operator', counsel: 'owner', analyst: 'operator', opener: 'operator',
    parties: ['Synthetic New Client'], reviewAt: new Date(Date.now() + 3600_000).toISOString(), urgency: 'routine' });
  inquiry = await act('operator', 'inquiry-submit', { ...key(inquiry), eligibility: 'Counsel review requested.' });
  const scan = (await call('operator', '/api/risk-intake')).inquiries.find(row => row.id === inquiry.id);
  inquiry = await act('operator', 'conflict-submit', { ...key(scan), scanHash: scan.candidateHash });
  let diligence = await act('owner', 'diligence-assign', { id: inquiry.id, reviewer: 'operator', reference: 'SIGNED-REQ-1' });
  let work = await create('R17', { caseReference: inquiry.id, requestReference: 'SIGNED-REQ-1' });
  diligence = await act('operator', 'diligence-link', { ...key(diligence), workItemId: work.id });
  assert.equal((await current()).diligenceStatus, 'pending');
  const conditions = { ...key(inquiry), disposition: 'clear', notes: 'Reviewed current conflict candidates.', screened: [], requiresDiligence: true, attested: true };
  await act('owner', 'conflict-decision', conditions, 409);
  const issue = async (status, sequence) => {
    work = await command(work, 'provider-response', { envelope: envelope({ caseReference: inquiry.id, requestReference: 'SIGNED-REQ-1', status, sequence,
      issuedAt: new Date(Date.now() - 60_000).toISOString(), expiresAt: new Date(Date.now() + 3600_000).toISOString() }) });
    if (status === 'clear') work = await approve(work);
  };
  await issue('clear', 1);
  assert.equal((await current()).diligenceStatus, 'verified');
  inquiry = await act('owner', 'conflict-decision', conditions);
  await issue('review', 2);
  const opening = { ...key(inquiry), name: 'Signed-verification matter', code: 'SIGNED-01', jurisdiction: 'Review required', billingContact: 'Billing coordinator' };
  await act('operator', 'opening-start', opening, 409);
  await act('operator', 'diligence-result', { ...key(diligence), result: 'verified', receipt: 'Manual bypass', notes: 'Not permitted' }, 409);
  await issue('clear', 3);
  inquiry = await act('operator', 'opening-start', opening);
  const matterId = (await current('owner')).matterId;
  const { document } = await upload(matterId);
  const base = '/api/matters/' + matterId;
  const practice = (revision, body) => call('owner', base + '/practice', body, 200, { 'If-Match': String(revision) });
  await practice(0, { action: 'party-save', name: 'Synthetic New Client', role: 'Prospective client' });
  const { matchKey } = await call('owner', base + '/conflicts');
  await practice(1, { action: 'conflict-review', disposition: 'cleared', matchKey, reason: 'Current signed intake clearance', attested: true });
  await practice(2, { action: 'intake-decision', status: 'accepted', reason: 'Reviewed and accepted', attested: true });
  await practice(3, { action: 'engagement-save', documentId: document.id, date: '2026-11-12', attested: true });
  await issue('failed', 4);
  await act('operator', 'opening-finalize', key(inquiry), 409);
  await issue('clear', 5);
  inquiry = await act('operator', 'opening-finalize', key(inquiry));
  assert.equal(inquiry.status, 'opened');
  const view = await current();
  assert.equal(view.diligenceMode, 'signed-provider');
  assert.equal(view.diligenceStatus, 'verified');
  assert.doesNotMatch(JSON.stringify(view), /signedEnvelope|evidenceHash|signature|Identity provider fixture/);
});

test('R63 holds protect the same matter across assignments, native retention actions, historical exports and concurrent cron reads', async t => {
  const { root, call, create, command, approve, upload, makeMatter } = await workbenchServer(t);
  const { runRecordsSchedule } = await import('../server/records-scheduler.mjs');
  const matter = await makeMatter();
  const { document } = await upload(matter.id);
  const scheduleInput = { documentId: document.id, retainUntil: '2026-01-01T00:00:00.000Z', authorityReference: 'RET-AUTH' };
  let first = await create('R63', { policyReference: 'RET-1' }, matter.id);
  first = await command(first, 'schedule', scheduleInput);
  first = await command(first, 'run-schedule');
  first = await command(first, 'authorize-disposition', { manifestHash: first.data.evaluation.manifestHash, reason: 'Reviewed source and due date' }, 'owner');
  first = await approve(first);
  let second = await create('R63', { policyReference: 'RET-1' }, matter.id);
  second = await command(second, 'schedule', scheduleInput);
  second = await command(second, 'hold', { reference: 'SEPARATE-HOLD', reason: 'Must protect the source across every work item' });
  await call('operator', '/api/workbench/' + first.id + '/export?version=1', undefined, 409);
  const options = { baseUrl: root, username: 'operator', password: 'synthetic-operator-secret' };
  const held = await runRecordsSchedule(options);
  assert.equal(held.jobs.find(row => row.workItemId === first.id).status, 'held');
  const nativePath = '/api/matters/' + matter.id + '/practice';
  await call('owner', nativePath, { action: 'office-save', type: 'retention', title: 'Blocked native disposition', status: 'Cleared for disposition',
    fields: { due: '2026-11-12', policy: 'RET-1', scope: 'All originals' }, attested: true }, 422, { 'If-Match': '0' });
  second = await command(second, 'release-hold', { reference: 'SEPARATE-HOLD', authorityReference: 'RELEASE-AUTH' }, 'owner');
  let seen = 0;
  const raced = await runRecordsSchedule({ ...options, fetchImpl: async (url, init) => {
    if (new URL(url).pathname === '/api/workbench/' + first.id && ++seen === 2) {
      second = await command(second, 'hold', { reference: 'RACING-HOLD', reason: 'Placed after scheduler first read' });
    }
    return fetch(url, init);
  } });
  assert.ok(raced.skipped.some(row => row.workItemId === first.id && row.reason === 'record changed during schedule evaluation'));
  second = await command(second, 'release-hold', { reference: 'RACING-HOLD', authorityReference: 'RELEASE-RACE' }, 'owner');
  await call('owner', nativePath, { action: 'office-save', type: 'hold', title: 'Native preservation', status: 'Active',
    fields: { owner: 'owner', date: '2026-11-12', scope: 'All originals' } }, 200, { 'If-Match': '0' });
  first = await command(first, 'run-schedule');
  assert.equal(first.data.evaluation.candidates[0].eligible, false);
  assert.ok(first.data.evaluation.candidates[0].blockedBy.some(reference => reference.startsWith('matter-hold:')));
  await command(first, 'authorize-disposition', { manifestHash: first.data.evaluation.manifestHash, reason: 'Attempt native hold bypass' }, 'owner', 409);
});
