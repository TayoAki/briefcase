import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { PDFDocument, StandardFonts } from '../dist/vendor/packets/pdf-lib.mjs';
import { workflows } from '../server/workflows/practice-operations.mjs';

const hash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const defs = Object.fromEntries(workflows.map(def => [def.roleId, def]));
const asError = (status, message) => { throw Object.assign(new Error(message), { status }); };
async function makeSource(id, pageText) {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  pdf.addPage().drawText(pageText, { x: 40, y: 700, size: 12, font });
  const bytes = Buffer.from(await pdf.save());
  return { id, name: id + '.pdf', bytes, sha256: createHash('sha256').update(bytes).digest('hex'), pages: [{ number: 1, text: pageText }], purpose: 'supporting' };
}
const documents = new Map(await Promise.all([
  makeSource('order1', 'The hearing is set for December 10, 2026.'),
  makeSource('order2', 'The hearing is continued to December 17, 2026.'),
  makeSource('authority', 'Synthetic authority: this fixture states a test proposition.'),
  makeSource('treatment', 'Synthetic report: no adverse treatment reported as of November 12, 2026.'),
]).then(rows => rows.map(row => [row.id, row])));
function context(extra = {}) {
  const ctx = { now: '2026-11-12T12:00:00.000Z', user: { username: 'specialist', firm: 'alpha', role: 'preparer', desk: [] }, isReviewer: false,
    fail: asError, hash,
    source(id, page) { const doc = documents.get(id); if (!doc || (page && !doc.pages.some(entry => entry.number === page))) asError(404, 'Source unavailable.'); return doc; },
    sourceBinding(id, page) { const doc = this.source(id, page); return { documentId: id, page, sha256: doc.sha256, name: doc.name }; },
    ...extra };
  return ctx;
}
const legal = context({ isReviewer: true, user: { username: 'reviewer', firm: 'alpha', role: 'lawyer', desk: [] } });
const assertBlocked = (fn, status = 422) => assert.throws(fn, error => error.status === status);

// These tests use actual generated source PDFs and exercise specialist domain
// operations. Shared HTTP authorization and exact-version approval are exercised
// in workbench tests; these assertions do not claim live court/provider execution.
test('R29 an amended original withdraws date confirmation and requires a sourced lawyer override', () => {
  const def = defs.R29, ctx = context();
  const input = { event: 'Hearing', noticeRef: 'NOTICE-1', documentId: 'order1', page: 1, dueDate: '2026-12-10', excerpt: 'The hearing is set for December 10, 2026.' };
  assertBlocked(() => def.create({ ...input, excerpt: 'An invented hearing date.' }, ctx));
  let state = def.create(input, ctx);
  assert.equal(def.validate(state, ctx).errors.length, 1);
  assertBlocked(() => def.update(state, 'confirm-date', { candidateHash: state.candidates[0].hash, notes: 'Checked order' }, ctx), 403);
  state = def.update(state, 'confirm-date', { candidateHash: state.candidates[0].hash, notes: 'Checked physical page' }, legal);
  assert.deepEqual(def.validate(state, ctx).errors, []);
  const oldHash = state.candidates[0].hash;
  state = def.update(state, 'amend', { noticeRef: 'NOTICE-2', documentId: 'order2', page: 1, dueDate: '2026-12-17', excerpt: 'The hearing is continued to December 17, 2026.' }, ctx);
  assert.equal(state.confirmation, null);
  assert.equal(state.candidates[0].priorConfirmation.candidateHash, oldHash);
  assertBlocked(() => def.update(state, 'confirm-date', { candidateHash: oldHash, notes: 'Stale review' }, legal), 409);
  assert.equal(def.validate(state, ctx).errors.length, 1);
  state = def.update(state, 'override-date', { candidateHash: state.candidates.at(-1).hash, documentId: 'order2', page: 1, dueDate: '2026-12-18', reason: 'Fixture: authorized scheduling correction recorded in review.' }, legal);
  const output = def.output(state, ctx);
  assert.equal(output.confirmedDate.dueDate, '2026-12-18');
  assert.equal(output.confirmedDate.source.sha256, documents.get('order2').sha256);
  assert.equal(output.supersededCandidates.length, 1);
  assert.deepEqual(def.validate(state, ctx).errors, []);
  const changedContext = context({ source: (id, page) => ({ ...ctx.source(id, page), sha256: 'bad' }) });
  assert.match(def.validate(state, changedContext).errors.join(' '), /source changed/);
});

test('R33 duplicate costs do not inflate spend and new spending invalidates a scope decision', () => {
  const def = defs.R33, ctx = context();
  let state = def.create({ scope: 'Initial investigation', budgetCents: 100000, budgetReference: 'BUDGET-1' }, ctx);
  const cost = { externalId: 'LEDGER-1', cents: 25000, date: '2026-11-10', description: 'Initial review' };
  state = def.update(state, 'cost', cost, ctx);
  state = def.update(state, 'cost', cost, ctx);
  assert.equal(state.costs.length, 1);
  assertBlocked(() => def.update(state, 'cost', { ...cost, cents: 26000 }, ctx), 409);
  assertBlocked(() => def.update(state, 'propose', { scope: 'Expanded review', budgetCents: 20000, reason: 'Cannot cover spend' }, ctx));
  state = def.update(state, 'propose', { scope: 'Expanded discovery', budgetCents: 160000, reason: 'New document production' }, ctx);
  assert.equal(def.output(state).spendToDateCents, 25000);
  assert.equal(def.output(state).proposedRemainingCents, 135000);
  assert.equal(def.validate(state, ctx).errors.length, 1);
  assertBlocked(() => def.update(state, 'accept-change', { proposalHash: state.proposals[0].hash, notes: 'Not a lawyer' }, ctx), 403);
  state = def.update(state, 'accept-change', { proposalHash: state.proposals[0].hash, notes: 'Reviewed spend and new scope' }, legal);
  assert.deepEqual(def.validate(state, ctx).errors, []);
  state = def.update(state, 'cost', { ...cost, externalId: 'LEDGER-2', cents: 1000 }, ctx);
  assert.equal(state.decision, null);
  assertBlocked(() => def.update(state, 'accept-change', { proposalHash: state.proposals[0].hash, notes: 'Old cost snapshot' }, legal), 409);
  state = def.update(state, 'propose', { scope: 'Expanded discovery', budgetCents: 160000, reason: 'Updated spend' }, ctx);
  state = def.update(state, 'accept-change', { proposalHash: state.proposals.at(-1).hash, notes: 'Reviewed latest cost snapshot' }, legal);
  assert.equal(def.output(state).spendToDateCents, 26000);
  assert.deepEqual(def.validate(state, ctx).errors, []);
});

test('R34 routing uses authoritative metadata, reassigns the actual item and never exports private contents', () => {
  const def = defs.R34;
  const records = [{ id: 'work-1', roleId: 'R25', assignee: 'junior', status: 'draft', updatedAt: '2026-11-10T12:00:00.000Z', revision: 2, title: 'SECRET MATTER', matter: 'secret-id', context: 'CONFIDENTIAL' }];
  const ctx = context({ operations: {
    queue: () => structuredClone(records),
    roster: () => [{ username: 'junior', role: 'preparer' }, { username: 'new', role: 'preparer' }],
    reassign(id, username, revision) { const item = records.find(row => row.id === id); if (revision !== item.revision) asError(409, 'Assignment changed.'); item.assignee = username; item.revision++; return structuredClone(item); },
  } });
  assertBlocked(() => def.create({ reviewLabel: 'Daily routing', staleHours: 24 }, context()), 503);
  let state = def.create({ reviewLabel: 'Daily routing', staleHours: 24 }, ctx);
  assert.equal(def.output(state).queue[0].bottleneck, true);
  assert.doesNotMatch(JSON.stringify(state), /SECRET|CONFIDENTIAL|secret-id/);
  assertBlocked(() => def.update(state, 'reassign', { workId: 'work-1', username: 'foreign', expectedRevision: 2, reason: 'Bad recipient' }, ctx));
  assertBlocked(() => def.update(state, 'reassign', { workId: 'work-1', username: 'new', expectedRevision: 1, reason: 'Stale assignment' }, ctx), 409);
  state = def.update(state, 'reassign', { workId: 'work-1', username: 'new', expectedRevision: 2, reason: 'Cover absent preparer' }, ctx);
  assert.equal(records[0].assignee, 'new');
  assert.equal(state.handoffs[0].from, 'junior');
  assert.equal(state.handoffs[0].to, 'new');
  assert.deepEqual(def.validate(state).errors, []);
  assert.doesNotMatch(JSON.stringify(def.output(state)), /SECRET|CONFIDENTIAL|secret-id/);
});

test('R35 only published editions create drafts and earlier outputs reproduce after template changes', () => {
  const def = defs.R35, ctx = context();
  let state = def.create({ name: 'Client letter', body: 'Dear {{client}}, first edition.', changeNote: 'Initial' }, ctx);
  assertBlocked(() => def.update(state, 'draft', { draftRef: 'LETTER-1', values: { client: 'Ada' } }, ctx), 409);
  assertBlocked(() => def.update(state, 'publish-template', { versionHash: state.versions[0].hash, notes: 'Unapproved author' }, ctx), 403);
  state = def.update(state, 'publish-template', { versionHash: state.versions[0].hash, notes: 'Checked template' }, legal);
  state = def.update(state, 'draft', { draftRef: 'LETTER-1', values: { client: 'Ada' } }, ctx);
  const oldDraft = structuredClone(state.drafts[0]);
  state = def.update(state, 'edit-template', { body: 'Dear {{client}}, second edition.', changeNote: 'Clarify wording' }, ctx);
  state = def.update(state, 'draft', { draftRef: 'LETTER-2', values: { client: 'Bo' } }, ctx);
  assert.equal(state.drafts[1].templateEdition, 1);
  assertBlocked(() => def.update(state, 'publish-template', { versionHash: state.versions[0].hash, notes: 'Old edition' }, legal), 409);
  state = def.update(state, 'publish-template', { versionHash: state.versions[1].hash, notes: 'Checked new wording' }, legal);
  state = def.update(state, 'draft', { draftRef: 'LETTER-3', values: { client: 'Chen' } }, ctx);
  assert.equal(state.drafts[2].templateEdition, 2);
  assert.deepEqual(state.drafts[0], oldDraft);
  assert.deepEqual(def.validate(state, ctx).errors, []);
  assertBlocked(() => def.update(state, 'draft', { draftRef: 'LETTER-4', values: { client: 'Dee', privateSecret: 'not a placeholder' } }, ctx));
  const altered = structuredClone(state); altered.drafts[0].body = 'Altered old output';
  assert.match(def.validate(altered, ctx).errors.join(' '), /does not reproduce/);
});

test('R36 every authority carries a real source and treatment is explicitly unavailable or report-backed', () => {
  const def = defs.R36, ctx = context();
  let state = def.create({ question: 'Fixture research question' }, ctx);
  const entry = { id: 'AUTH-1', citation: 'Synthetic Case 1', authorityDate: '2026-01-02', sourceRef: 'Synthetic repository accession 1', url: 'https://example.test/authority/1', documentId: 'authority', page: 1, excerpt: 'Synthetic authority: this fixture states a test proposition.' };
  assertBlocked(() => def.update(state, 'authority', { ...entry, excerpt: 'Invented proposition' }, ctx));
  assertBlocked(() => def.update(state, 'authority', { ...entry, url: 'javascript:alert(1)' }, ctx));
  state = def.update(state, 'authority', entry, ctx);
  assert.equal(def.validate(state, ctx).errors.length, 1);
  state = def.update(state, 'treatment', { id: 'AUTH-1', status: 'unavailable', provider: 'No subscription configured', checkedAt: '2026-11-12', receipt: 'RESEARCH-NOTE-1' }, ctx);
  assert.deepEqual(def.validate(state, ctx).errors, []);
  assert.match(def.output(state).authorities[0].treatmentAvailability, /Unavailable/);
  assertBlocked(() => def.update(state, 'treatment', { id: 'AUTH-1', status: 'no_adverse_treatment_reported', provider: 'Synthetic citator', checkedAt: '2026-11-12', receipt: 'REPORT-1' }, ctx));
  state = def.update(state, 'treatment', { id: 'AUTH-1', status: 'no_adverse_treatment_reported', provider: 'Synthetic citator', checkedAt: '2026-11-12', receipt: 'REPORT-1', reportDocumentId: 'treatment', reportPage: 1 }, ctx);
  const output = def.output(state).authorities[0];
  assert.equal(output.treatment.source.sha256, documents.get('treatment').sha256);
  assert.equal(output.authorityDate, '2026-01-02');
  assert.equal(output.source.sha256, documents.get('authority').sha256);
  assert.equal(output.treatmentHistory.length, 2);
  const replay = def.update(state, 'authority', entry, context({ now: '2026-11-13T12:00:00.000Z' }));
  assert.equal(replay.authorities.length, 1);
  assert.equal(replay.authorities[0].treatment.status, 'no_adverse_treatment_reported');
  assert.deepEqual(def.validate(state, ctx).errors, []);
});

test('R37 executed failing fixtures block promotion and rollback retains prior release approvals', () => {
  const def = defs.R37, ctx = context();
  let state = def.create({ name: 'Greeting', body: 'Hello {{name}}', changeNote: 'Initial', fixtures: [{ id: 'greeting', values: { name: 'Ada' }, expected: 'WRONG' }] }, ctx);
  state = def.update(state, 'run-fixtures', {}, ctx);
  assert.equal(state.runs[0].passed, 0);
  assertBlocked(() => def.update(state, 'promote', { versionHash: state.versions[0].hash, notes: 'Cannot approve failure' }, legal), 409);
  state = def.update(state, 'candidate', { body: 'Hello {{name}}', changeNote: 'Fix fixture', fixtures: [{ id: 'greeting', values: { name: 'Ada' }, expected: 'Hello Ada' }] }, ctx);
  assertBlocked(() => def.update(state, 'promote', { versionHash: state.versions.at(-1).hash, notes: 'Not run yet' }, legal), 409);
  state = def.update(state, 'run-fixtures', {}, ctx);
  state = def.update(state, 'promote', { versionHash: state.versions.at(-1).hash, notes: 'Fixture executed and matched' }, legal);
  const oldVersion = state.activeVersion, oldRelease = structuredClone(state.releases[0]);
  state = def.update(state, 'candidate', { body: 'Welcome {{name}}', changeNote: 'New greeting', fixtures: [{ id: 'greeting', values: { name: 'Ada' }, expected: 'Welcome Ada' }] }, ctx);
  state = def.update(state, 'run-fixtures', {}, ctx);
  state = def.update(state, 'promote', { versionHash: state.versions.at(-1).hash, notes: 'New fixture passed' }, legal);
  assert.notEqual(state.activeVersion, oldVersion);
  assertBlocked(() => def.update(state, 'rollback', { versionHash: state.versions[0].hash, reason: 'Failed version' }, legal), 409);
  state = def.update(state, 'rollback', { versionHash: oldVersion, reason: 'Restore previous wording' }, legal);
  assert.equal(state.activeVersion, oldVersion);
  assert.deepEqual(state.releases[0], oldRelease);
  assert.equal(state.releases[2].approvalHash, hash(oldRelease));
  assert.deepEqual(def.validate(state).errors, []);
});

test('R38 the reviewing lawyer accepts the handoff and exported fields exclude confidential intake data', () => {
  const def = defs.R38, ctx = context();
  let state = def.create({ referralRef: 'REF-1', organizationRef: 'LEGAL-AID-1', issueCategory: 'Housing', contactRoute: 'CRM-55', eligibilityRef: 'MEANS-TEST-PRIVATE', privateNotes: 'CONFIDENTIAL narrative' }, ctx);
  const fields = ['referralRef', 'organizationRef', 'issueCategory', 'contactRoute', 'status', 'assignedLawyer'];
  assert.equal(def.validate(state).errors.length, 1);
  assertBlocked(() => def.update(state, 'accept-referral', { approvedFields: fields, notes: 'Preparer cannot accept' }, ctx), 403);
  assertBlocked(() => def.update(state, 'accept-referral', { approvedFields: [...fields, 'privateNotes'], notes: 'Do not export' }, legal));
  state = def.update(state, 'accept-referral', { approvedFields: fields, notes: 'Accepted into assigned review queue' }, legal);
  const output = def.output(state);
  assert.equal(output.referral.assignedLawyer, 'reviewer');
  assert.equal(output.referral.status, 'accepted');
  assert.deepEqual(Object.keys(output.referral).sort(), [...fields].sort());
  assert.equal(output.delivery, undefined);
  assert.doesNotMatch(JSON.stringify(output), /CONFIDENTIAL|MEANS-TEST-PRIVATE|eligibilityRef|privateNotes/);
  assert.deepEqual(def.validate(state).errors, []);
  state = def.update(state, 'update-referral', { issueCategory: 'Housing appeal', contactRoute: 'CRM-55', eligibilityRef: 'MEANS-TEST-PRIVATE', privateNotes: 'New confidential detail' }, ctx);
  assert.equal(state.acceptance, null);
  assert.equal(def.validate(state).errors.length, 1);
  assert.equal(state.history.length, 1);
  assert.deepEqual(def.output(state).referral, {});
});

async function httpSetup(t) {
  const { buildApp } = await import('../server/app.mjs');
  const users = [
    ['owner', 'lawyer', 'alpha'], ['specialist', 'preparer', 'alpha'], ['manager', 'preparer', 'alpha'],
    ['replacement', 'preparer', 'alpha'], ['receiving', 'lawyer', 'alpha'], ['outsider', 'lawyer', 'beta'],
  ].map(([username, role, firm]) => ({ username, role, firm, password: 'synthetic-' + username + '-secret' }));
  const server = buildApp({ database: ':memory:', users });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const root = 'http://127.0.0.1:' + server.address().port;
  async function call(user, path, body, expected = 200, extra = {}) {
    const binary = Buffer.isBuffer(body);
    const headers = { Authorization: 'Basic ' + Buffer.from(user + ':synthetic-' + user + '-secret').toString('base64') };
    if (body) Object.assign(headers, { 'Content-Type': binary ? 'application/pdf' : 'application/json', 'X-Briefcase-Request': '1' });
    const response = await fetch(root + path, { method: body ? 'POST' : 'GET', headers: { ...headers, ...extra }, body: body && (binary ? body : JSON.stringify(body)) });
    const data = response.headers.get('content-type')?.includes('application/json') ? await response.json() : Buffer.from(await response.arrayBuffer());
    assert.equal(response.status, expected, JSON.stringify(data));
    return data;
  }
  const matter = await call('owner', '/api/matters', { name: 'Private practice-operations fixture' }, 201);
  await call('owner', '/api/matters/' + matter.id + '/team', { action: 'grant', username: 'specialist', access: 'prepare' });
  async function upload(id) {
    const { document } = await call('owner', '/api/matters/' + matter.id + '/documents', documents.get(id).bytes, 201, { 'X-PDF-Name': id + '.pdf', 'X-PDF-Purpose': 'supporting' });
    return document.id;
  }
  async function create(roleId, data, extra = {}) {
    const { randomUUID } = await import('node:crypto');
    return (await call('owner', '/api/workbench', { requestId: randomUUID(), roleId, title: roleId + ' acceptance fixture', assignee: 'specialist', reviewer: 'owner', data, ...extra }, 201)).item;
  }
  const command = async (user, item, action, data = {}, expected = 200) => {
    const response = await call(user, '/api/workbench/' + item.id, { revision: item.revision, action, data }, expected);
    return response.item;
  };
  async function approve(item) {
    item = await command('specialist', item, 'submit');
    await call('specialist', '/api/workbench/' + item.id, { revision: item.revision, action: 'approve', sha256: item.submission.sha256, notes: 'Unauthorized author approval', attested: true }, 403);
    await call('owner', '/api/workbench/' + item.id, { revision: item.revision, action: 'approve', sha256: 'wrong', notes: 'Wrong exact version', attested: true }, 409);
    return (await call('owner', '/api/workbench/' + item.id, { revision: item.revision, action: 'approve', sha256: item.submission.sha256, notes: 'Checked original fixture and derived output', attested: true })).item;
  }
  const exported = async item => {
    await call('outsider', '/api/workbench/' + item.id + '/export', undefined, 404);
    return call('owner', '/api/workbench/' + item.id + '/export');
  };
  return { call, matter, upload, create, command, approve, exported };
}
const exportedOutput = result => result.output ?? result.version?.output;

test('R29 HTTP: amendment blocks stale approved export and a fresh lawyer confirmation binds the new original', async t => {
  const { call, matter, upload, create, command, approve, exported } = await httpSetup(t);
  const first = await upload('order1'), second = await upload('order2');
  let item = await create('R29', { event: 'Hearing', noticeRef: 'N1', documentId: first, page: 1, dueDate: '2026-12-10', excerpt: 'The hearing is set for December 10, 2026.' }, { matter: matter.id });
  await command('specialist', item, 'submit', {}, 422);
  item = await command('owner', item, 'confirm-date', { candidateHash: item.data.candidates[0].hash, notes: 'Read physical order page' });
  item = await approve(item);
  assert.equal(exportedOutput(await exported(item)).confirmedDate.dueDate, '2026-12-10');
  const supersededVersion = item.submission.number;
  item = await command('specialist', item, 'amend', { noticeRef: 'N2', documentId: second, page: 1, dueDate: '2026-12-17', excerpt: 'The hearing is continued to December 17, 2026.' });
  await call('owner', '/api/workbench/' + item.id + '/export', undefined, 409);
  await call('owner', '/api/workbench/' + item.id + '/export?version=' + supersededVersion, undefined, 409);
  await command('specialist', item, 'submit', {}, 422);
  item = await command('owner', item, 'override-date', { candidateHash: item.data.candidates.at(-1).hash, documentId: second, page: 1, dueDate: '2026-12-18', reason: 'Synthetic documented scheduling correction' });
  item = await approve(item);
  const output = exportedOutput(await exported(item));
  assert.equal(output.confirmedDate.source.documentId, second);
  assert.equal(output.supersededCandidates[0].source.documentId, first);
  await call('owner', '/api/matters/' + matter.id + '/team', { action: 'revoke', username: 'specialist' });
  await call('specialist', '/api/workbench/' + item.id + '/export', undefined, 404);
});

test('R33 HTTP: spend-linked scope approvals and exact reviewed versions survive later amendments', async t => {
  const { call, create, command, approve, exported } = await httpSetup(t);
  let item = await create('R33', { scope: 'Initial', budgetCents: 100000, budgetReference: 'APPROVAL-1' });
  item = await command('specialist', item, 'cost', { externalId: 'TX-1', cents: 30000, date: '2026-11-10', description: 'Discovery' });
  item = await command('specialist', item, 'propose', { scope: 'Expanded', budgetCents: 150000, reason: 'Additional discovery' });
  await command('specialist', item, 'submit', {}, 422);
  item = await command('owner', item, 'accept-change', { proposalHash: item.data.proposals.at(-1).hash, notes: 'Checked source ledger references' });
  item = await approve(item);
  assert.equal(exportedOutput(await exported(item)).spendToDateCents, 30000);
  const oldVersion = item.submission.number;
  item = await command('specialist', item, 'cost', { externalId: 'TX-2', cents: 5000, date: '2026-11-11', description: 'Supplemental discovery' });
  await call('owner', '/api/workbench/' + item.id + '/export', undefined, 409);
  const historical = await call('owner', '/api/workbench/' + item.id + '/export?version=' + oldVersion);
  assert.equal(exportedOutput(historical).spendToDateCents, 30000);
  await command('specialist', item, 'submit', {}, 422);
});

test('R34 HTTP: manager sees only metadata and actual reassignment transfers the work queue after access checks', async t => {
  const { call, matter, create, command } = await httpSetup(t);
  const target = await create('R33', { scope: 'CONFIDENTIAL scope', budgetCents: 10000, budgetReference: 'PRIVATE' }, { matter: matter.id, title: 'SECRET MATTER TITLE' });
  let item = await create('R34', { reviewLabel: 'Daily routing', staleHours: 0 }, { assignee: 'manager' });
  assert.doesNotMatch(JSON.stringify(item.data), /CONFIDENTIAL|SECRET MATTER TITLE|PRIVATE|Private practice/);
  await call('manager', '/api/workbench/' + target.id, undefined, 404);
  await command('manager', item, 'reassign', { workId: target.id, username: 'replacement', expectedRevision: target.revision, reason: 'Absent preparer' }, 404);
  await call('owner', '/api/matters/' + matter.id + '/team', { action: 'grant', username: 'replacement', access: 'prepare' });
  item = await command('manager', item, 'reassign', { workId: target.id, username: 'replacement', expectedRevision: target.revision, reason: 'Absent preparer' });
  assert.equal((await call('replacement', '/api/workbench/' + target.id)).item.assignee, 'replacement');
  await call('specialist', '/api/workbench/' + target.id, undefined, 404);
  assert.ok((await call('replacement', '/api/workbench')).items.some(row => row.id === target.id));
  item = await command('manager', item, 'submit');
  item = (await call('owner', '/api/workbench/' + item.id, { revision: item.revision, action: 'approve', sha256: item.submission.sha256, notes: 'Verified handoff', attested: true })).item;
  const output = exportedOutput(await call('owner', '/api/workbench/' + item.id + '/export'));
  assert.equal(output.handoffs[0].to, 'replacement');
  assert.doesNotMatch(JSON.stringify(output), /CONFIDENTIAL|SECRET MATTER TITLE|PRIVATE|Private practice/);
});

test('R35 HTTP: published template revisions feed new drafts and earlier approved drafts reproduce exactly', async t => {
  const { call, create, command, approve, exported } = await httpSetup(t);
  let item = await create('R35', { name: 'Letter', body: 'Dear {{client}}, edition one.', changeNote: 'Initial' });
  item = await command('owner', item, 'publish-template', { versionHash: item.data.versions[0].hash, notes: 'Approved edition' });
  item = await command('specialist', item, 'draft', { draftRef: 'D1', values: { client: 'Ada' } });
  item = await approve(item);
  const oldVersion = item.submission.number, prior = exportedOutput(await exported(item));
  const oldZip = await call('owner', '/api/workbench/' + item.id + '/export?format=zip');
  const oldText = await call('owner', '/api/workbench/' + item.id + '/export?format=txt');
  assert.equal(oldText.toString(), 'Dear Ada, edition one.');
  const archive = await globalThis.JSZip.loadAsync(oldZip);
  const manifest = JSON.parse(await archive.file('manifest.json').async('string'));
  const originalText = await archive.file(manifest.drafts[0].file).async('string');
  assert.equal(hash(originalText), manifest.drafts[0].bodySha256);
  const snapshot = await archive.file(manifest.templates[0].file).async('string');
  assert.equal(hash(snapshot), manifest.templates[0].fileSha256);
  assert.equal(JSON.parse(snapshot).hash, manifest.drafts[0].templateHash);
  item = await command('specialist', item, 'edit-template', { body: 'Dear {{client}}, edition two.', changeNote: 'New wording' });
  item = await command('owner', item, 'publish-template', { versionHash: item.data.versions.at(-1).hash, notes: 'Approved new edition' });
  item = await command('specialist', item, 'draft', { draftRef: 'D2', values: { client: 'Bo' } });
  item = await approve(item);
  assert.equal(exportedOutput(await exported(item)).drafts[1].templateEdition, 2);
  const historical = await call('owner', '/api/workbench/' + item.id + '/export?version=' + oldVersion);
  assert.deepEqual(exportedOutput(historical), prior);
  const historicalZip = await call('owner', '/api/workbench/' + item.id + '/export?format=zip&version=' + oldVersion);
  const historicalText = await call('owner', '/api/workbench/' + item.id + '/export?format=txt&version=' + oldVersion);
  assert.deepEqual(historicalZip, oldZip);
  assert.deepEqual(historicalText, oldText);
  const currentText = await call('owner', '/api/workbench/' + item.id + '/export?format=txt');
  assert.equal(currentText.toString(), 'Dear Bo, edition two.');
});

test('R36 HTTP: reviewed research export identifies source, date and unavailable treatment without implying live verification', async t => {
  const { matter, upload, create, command, approve, exported } = await httpSetup(t);
  const doc = await upload('authority');
  let item = await create('R36', { question: 'Synthetic evidence query' }, { matter: matter.id });
  item = await command('specialist', item, 'authority', { id: 'A1', citation: 'Synthetic authority 1', authorityDate: '2026-01-02', sourceRef: 'REPOSITORY-1', documentId: doc, page: 1, excerpt: 'Synthetic authority: this fixture states a test proposition.' });
  await command('specialist', item, 'submit', {}, 422);
  item = await command('specialist', item, 'treatment', { id: 'A1', status: 'unavailable', provider: 'No licensed citator configured', checkedAt: '2026-11-12', receipt: 'RESEARCH-NOTE-1' });
  item = await approve(item);
  const entry = exportedOutput(await exported(item)).authorities[0];
  assert.equal(entry.source.documentId, doc);
  assert.equal(entry.authorityDate, '2026-01-02');
  assert.match(entry.treatmentAvailability, /Unavailable/);
});

test('R37 HTTP: actual fixture failure blocks promotion, successful release is approved and rollback retains proof', async t => {
  const { create, command, approve, exported } = await httpSetup(t);
  let item = await create('R37', { name: 'Template automation', body: 'Hello {{name}}', changeNote: 'Initial', fixtures: [{ id: 'case1', values: { name: 'Ada' }, expected: 'Wrong' }] });
  item = await command('specialist', item, 'run-fixtures');
  await command('owner', item, 'promote', { versionHash: item.data.versions.at(-1).hash, notes: 'Failed fixture' }, 409);
  item = await command('specialist', item, 'candidate', { body: 'Hello {{name}}', changeNote: 'Correct fixture', fixtures: [{ id: 'case1', values: { name: 'Ada' }, expected: 'Hello Ada' }] });
  item = await command('specialist', item, 'run-fixtures');
  item = await command('owner', item, 'promote', { versionHash: item.data.versions.at(-1).hash, notes: 'Pass' });
  const priorHash = item.data.activeVersion;
  item = await command('specialist', item, 'candidate', { body: 'Welcome {{name}}', changeNote: 'Next version', fixtures: [{ id: 'case1', values: { name: 'Ada' }, expected: 'Welcome Ada' }] });
  item = await command('specialist', item, 'run-fixtures');
  item = await command('owner', item, 'promote', { versionHash: item.data.versions.at(-1).hash, notes: 'Pass new release' });
  item = await command('owner', item, 'rollback', { versionHash: priorHash, reason: 'Restore original wording' });
  item = await approve(item);
  const output = exportedOutput(await exported(item));
  assert.equal(output.activeVersion, priorHash);
  assert.equal(output.releaseHistory.length, 3);
  assert.equal(output.fixtureRuns[0].passed, 0);
});

test('R38 HTTP: accepted referral reaches the assigned lawyer and the downloadable artifact excludes private fields', async t => {
  const { call, create, command, approve, exported } = await httpSetup(t);
  let item = await create('R38', { referralRef: 'REF-1', organizationRef: 'AID-1', issueCategory: 'Housing', contactRoute: 'CRM-1', eligibilityRef: 'PRIVATE-ELIGIBILITY', privateNotes: 'CONFIDENTIAL INTAKE NARRATIVE' }, { reviewer: 'receiving' });
  assert.notEqual(item.creator, item.reviewer);
  assert.ok((await call('receiving', '/api/workbench')).items.some(row => row.id === item.id && row.reviewer === 'receiving'));
  await command('owner', item, 'accept-referral', { approvedFields: ['referralRef'], notes: 'Creator is not the receiving lawyer' }, 403);
  item = await command('receiving', item, 'accept-referral', { approvedFields: ['referralRef', 'issueCategory', 'assignedLawyer'], notes: 'Private acceptance review note' });
  item = await command('specialist', item, 'submit');
  const review = { revision: item.revision, action: 'approve', sha256: item.submission.sha256, notes: 'Receiving lawyer reviewed the exact accepted referral', attested: true };
  await call('owner', '/api/workbench/' + item.id, review, 403);
  item = (await call('receiving', '/api/workbench/' + item.id, review)).item;
  const artifact = await exported(item);
  assert.deepEqual(Object.keys(exportedOutput(artifact).referral).sort(), ['assignedLawyer', 'issueCategory', 'referralRef']);
  assert.equal(exportedOutput(artifact).referral.assignedLawyer, 'receiving');
  assert.equal((await call('receiving', '/api/workbench/' + item.id)).item.data.status, 'accepted');
  assert.doesNotMatch(JSON.stringify(artifact), /PRIVATE-ELIGIBILITY|CONFIDENTIAL INTAKE NARRATIVE|Private acceptance review note|eligibilityRef|privateNotes/);
  const priorRecipientVersion = item.submission.number;
  item = await command('owner', item, 'change-assignment', { assignee: 'specialist', reviewer: 'owner' });
  await command('specialist', item, 'submit', {}, 422);
  await call('owner', '/api/workbench/' + item.id + '/export?version=' + priorRecipientVersion, undefined, 409);
  item = await command('owner', item, 'accept-referral', { approvedFields: ['referralRef', 'issueCategory', 'assignedLawyer'], notes: 'Replacement lawyer accepts the handoff' });
  item = await approve(item);
  assert.equal(exportedOutput(await exported(item)).referral.assignedLawyer, 'owner');
  const oldVersion = item.submission.number;
  item = await command('specialist', item, 'update-referral', { issueCategory: 'Housing appeal', contactRoute: 'CRM-1', eligibilityRef: 'PRIVATE-ELIGIBILITY', privateNotes: 'New intake detail' });
  await call('owner', '/api/workbench/' + item.id + '/export?version=' + oldVersion, undefined, 409);
});
