import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { PDFDocument } from '../dist/vendor/packets/pdf-lib.mjs';
import { workflows } from '../server/workflows/specialists.mjs';

const digest = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
const bytes = await readFile(new URL('./fixtures/digital.pdf', import.meta.url));
const otherBytes = await readFile(new URL('./fixtures/untrusted.pdf', import.meta.url));
const evidence = 'Patient reported neck stiffness and right shoulder pain after a rear-end collision.';
const documents = new Map([
  ['doc1', { id: 'doc1', name: 'Clinical original.pdf', bytes, sha256: digest(bytes), pages: [{ number: 1, text: evidence }] }],
  ['doc2', { id: 'doc2', name: 'Second original.pdf', bytes: otherBytes, sha256: digest(otherBytes), pages: [{ number: 1, text: 'A second independent source.' }] }],
]);
const ctx = (review = false, sources = documents) => ({
  user: { username: review ? 'lawyer' : 'specialist', role: review ? 'lawyer' : 'preparer', firm: 'alpha' },
  now: '2026-11-12T12:00:00.000Z', isReviewer: review, matterId: 'matter-alpha', hash: digest,
  fail(status, message) { throw Object.assign(new Error(message), { status }); },
  source(id, page) {
    const doc = sources.get(id);
    if (!doc) this.fail(404, 'Source unavailable.');
    if (page && !doc.pages.some(row => row.number === page)) this.fail(422, 'Page unavailable.');
    return doc;
  },
  sourceBinding(id, page) { const doc = this.source(id, page); return { documentId: id, page, sha256: doc.sha256, name: doc.name }; },
});
const def = roleId => workflows.find(row => row.roleId === roleId);
const source = { documentId: 'doc1', page: 1 };
const otherSource = { documentId: 'doc2', page: 1 };
const run = (workflow, state, action, data, review = false) => workflow.update(structuredClone(state), action, data, ctx(review));
const fails = (fn, status) => assert.throws(fn, error => error.status === status);
const valid = (workflow, state) => assert.deepEqual(workflow.validate(state, ctx(true)).errors, []);

test('R39 claim amendments preserve original/source history and reject stale or inaccessible support', () => {
  const workflow = def('R39');
  let state = workflow.create({ reference: 'APP-1', claims: [{ number: 1, text: 'A device comprising A.', ...source }] }, ctx());
  assert.equal(workflow.validate(state, ctx()).errors.length, 1);
  fails(() => run(workflow, state, 'amend-claim', { number: 1, baseSha256: 'stale', text: 'A device comprising A and B.', reason: 'Narrow the claim', ...source }), 409);
  const base = state.claims[0].versions[0].sha256;
  state = run(workflow, state, 'amend-claim', { number: 1, baseSha256: base, text: 'A device comprising A and B.', reason: 'Narrow the claim', ...otherSource });
  valid(workflow, state);
  const output = workflow.output(state, ctx());
  assert.equal(output.claims[0].original.text, 'A device comprising A.');
  assert.equal(output.claims[0].current.supersedes, base);
  assert.equal(output.claims[0].current.source.sha256, digest(otherBytes));
  fails(() => workflow.validate(state, ctx(false, new Map([['doc1', documents.get('doc1')]]))), 404);
});

test('R40 amended agency notice stays pending until exact reviewer confirmation; stale effective exports are blocked', () => {
  const workflow = def('R40');
  let state = workflow.create({ reference: 'APP-1', agency: 'Agency fixture' }, ctx());
  const notice = { noticeReference: 'NOTICE-1', deadline: '2027-01-15', receivedAt: '2026-11-12T11:00:00.000Z', ...source };
  state = run(workflow, state, 'record-notice', notice);
  assert.equal(workflow.validate(state, ctx()).errors.length, 1);
  fails(() => run(workflow, state, 'confirm-notice', { sha256: state.notices[0].sha256, notes: 'Checked original' }), 403);
  state = run(workflow, state, 'confirm-notice', { sha256: state.notices[0].sha256, notes: 'Checked source date' }, true);
  valid(workflow, state);
  const approved = structuredClone(state);
  state = run(workflow, state, 'record-notice', { ...notice, noticeReference: 'AMENDED-2', deadline: '2027-02-10', ...otherSource });
  assert.equal(state.effective.deadline, '2027-01-15');
  assert.equal(workflow.validate(state, ctx()).errors.length, 1);
  fails(() => workflow.assertExport(state, approved, ctx()), 409);
  fails(() => run(workflow, state, 'confirm-notice', { sha256: state.notices[0].sha256, notes: 'Old notice' }, true), 409);
  state = run(workflow, state, 'confirm-notice', { sha256: state.notices[1].sha256, notes: 'Amended date verified' }, true);
  valid(workflow, state);
  assert.equal(state.effective.deadline, '2027-02-10');
  assert.equal(state.notices[0].source.sha256, digest(bytes));
  assert.equal(state.notices.length, 2);
  assert.equal(run(workflow, state, 'record-notice', notice).notices.length, 2);
  fails(() => run(workflow, state, 'record-notice', { ...notice, deadline: '2027-01-16' }), 409);
  fails(() => run(workflow, state, 'record-notice', { ...notice, noticeReference: 'BAD-DATE', deadline: '2027-02-30' }), 422);
});

test('R41 missing petition evidence blocks export and complete packets preserve actual source pages', async () => {
  const workflow = def('R41');
  let state = workflow.create({ reference: 'PET-1', petitionType: 'Configured petition fixture', requirements: [{ id: 'identity', label: 'Identity evidence' }, { id: 'form', label: 'Signed petition form' }] }, ctx());
  state = run(workflow, state, 'attach-evidence', { id: 'identity', ...source });
  assert.match(workflow.validate(state, ctx()).errors.join(' '), /Signed petition form/);
  await assert.rejects(workflow.exportFile(state, ctx(), 'pdf'), { status: 409 });
  state = run(workflow, state, 'attach-evidence', { id: 'form', ...otherSource });
  valid(workflow, state);
  const packet = await workflow.exportFile(state, ctx(), 'pdf');
  const repeat = await workflow.exportFile(state, ctx(), 'pdf');
  assert.equal(digest(packet.bytes), digest(repeat.bytes));
  assert.equal((await PDFDocument.load(packet.bytes)).getPageCount(), 1 + (await PDFDocument.load(bytes)).getPageCount() + (await PDFDocument.load(otherBytes)).getPageCount());
  const approved = structuredClone(state);
  state = run(workflow, state, 'remove-evidence', { id: 'form', reason: 'Superseded form' });
  assert.match(workflow.validate(state, ctx()).errors.join(' '), /Signed petition form/);
  fails(() => workflow.assertExport(state, approved, ctx()), 409);
  assert.equal(state.evidence[1].versions.length, 2);
});

test('R42 estate schedule reconciles integer cents and retains changed source valuations', () => {
  const workflow = def('R42');
  let state = workflow.create({ reference: 'ESTATE-1' }, ctx());
  state = run(workflow, state, 'record-asset', { id: 'cash', label: 'Cash asset', amountCents: 10001, ...source });
  state = run(workflow, state, 'record-expense', { id: 'expense', label: 'Administration expense', amountCents: 1000, ...otherSource });
  state = run(workflow, state, 'set-distributions', { distributions: [{ id: 'a', name: 'Beneficiary A', amountCents: 4500 }, { id: 'b', name: 'Beneficiary B', amountCents: 4500 }] });
  assert.match(workflow.validate(state, ctx()).errors.join(' '), /reconcile/);
  state = run(workflow, state, 'set-distributions', { distributions: [{ id: 'a', name: 'Beneficiary A', amountCents: 4500 }, { id: 'b', name: 'Beneficiary B', amountCents: 4501 }] });
  valid(workflow, state);
  assert.equal(workflow.output(state, ctx()).totals.differenceCents, 0);
  fails(() => run(workflow, state, 'record-asset', { id: 'fraction', label: 'Fraction', amountCents: 1.5, ...source }), 422);
  state = run(workflow, state, 'record-asset', { id: 'cash', label: 'Revised cash asset', amountCents: 11001, ...source });
  assert.equal(state.assets[0].versions[0].amountCents, 10001);
  assert.equal(state.assets[0].versions.length, 2);
  assert.match(workflow.validate(state, ctx()).errors.join(' '), /reconcile/);
});

test('R43 lender and signature reviews gate closing and changed requirements invalidate evidence acceptance', async () => {
  const workflow = def('R43');
  let state = workflow.create({ reference: 'CLOSE-1', conditions: [{ id: 'funding', label: 'Lender funding authorization' }], documents: [{ id: 'deed', label: 'Executed deed' }] }, ctx());
  assert.equal(workflow.validate(state, ctx()).errors.length, 2);
  state = run(workflow, state, 'record-condition', { id: 'funding', ...source });
  state = run(workflow, state, 'record-document', { id: 'deed', signers: 'Signer fixture', executedAt: '2026-11-12T10:00:00.000Z', ...otherSource });
  await assert.rejects(workflow.exportFile(state, ctx(), 'pdf'), { status: 409 });
  fails(() => run(workflow, state, 'accept-document', { id: 'deed', sha256: state.signedDocuments[0].versions[0].sha256, notes: 'Checked signature' }), 403);
  state = run(workflow, state, 'accept-condition', { id: 'funding', sha256: state.conditionEvidence[0].versions[0].sha256, notes: 'Checked lender authorization' }, true);
  state = run(workflow, state, 'accept-document', { id: 'deed', sha256: state.signedDocuments[0].versions[0].sha256, notes: 'Checked execution in source' }, true);
  valid(workflow, state);
  const artifact = await workflow.exportFile(state, ctx(), 'pdf');
  assert.equal((await PDFDocument.load(artifact.bytes)).getPageCount(), 1 + (await PDFDocument.load(otherBytes)).getPageCount());
  const approved = structuredClone(state);
  state = run(workflow, state, 'revise-requirements', { conditions: [{ id: 'funding', label: 'Updated lender funding authorization' }], documents: [{ id: 'deed', label: 'Executed deed' }] });
  assert.match(workflow.validate(state, ctx()).errors.join(' '), /requires reviewer acceptance/);
  assert.equal(state.conditionEvidence[0].versions[0].review.by, 'lawyer');
  assert.equal(state.conditionEvidence[0].versions.length, 2);
  fails(() => workflow.assertExport(state, approved, ctx()), 409);
});

test('R44 attachment replay creates one receipt, conflicting event IDs reject, and ambiguous provider names stay in review', () => {
  const workflow = def('R44');
  let state = workflow.create({ reference: 'PI-1', providers: [{ id: 'a', name: 'Clinic A', aliases: ['Shared billing'] }, { id: 'b', name: 'Clinic B', aliases: ['Shared billing'] }] }, ctx());
  const delivery = { eventId: 'mail-1', providerHint: 'Shared billing', receivedAt: '2026-11-12T11:00:00.000Z', ...source };
  state = run(workflow, state, 'receive-attachment', delivery);
  const replayed = run(workflow, state, 'receive-attachment', delivery);
  assert.equal(replayed.receipts.length, 1);
  assert.equal(replayed.deliveries.length, 1);
  assert.equal(state.receipts[0].status, 'needs_review');
  assert.equal(workflow.validate(state, ctx()).errors.length, 1);
  fails(() => run(workflow, state, 'receive-attachment', { ...delivery, ...otherSource }), 409);
  fails(() => run(workflow, state, 'resolve-provider', { receiptId: state.receipts[0].id, providerId: 'a', notes: 'Confirmed header' }), 403);
  state = run(workflow, state, 'resolve-provider', { receiptId: state.receipts[0].id, providerId: 'a', notes: 'Reviewed clinic identity on source' }, true);
  valid(workflow, state);
  const approved = structuredClone(state);
  state = run(workflow, state, 'receive-attachment', { ...delivery, eventId: 'mail-2', providerHint: 'Clinic A' });
  assert.equal(state.receipts.length, 1);
  assert.equal(state.deliveries.length, 2);
  valid(workflow, state);
  state = run(workflow, state, 'receive-attachment', { ...delivery, eventId: 'mail-3', providerHint: 'Clinic B' });
  assert.equal(state.receipts[0].status, 'needs_review');
  assert.equal(state.receipts[0].reviewHistory[0].providerId, 'a');
  assert.equal(workflow.validate(state, ctx()).errors.length, 1);
  fails(() => workflow.assertExport(state, approved, ctx()), 409);
});

test('R45 settlement uses cleared receipts, approved payees and latest lien evidence; returns reopen the balance', () => {
  const workflow = def('R45');
  let state = workflow.create({ reference: 'SETTLE-1' }, ctx());
  state = run(workflow, state, 'record-receipt', { id: 'deposit-1', amountCents: 10000, status: 'pending', ...source });
  state = run(workflow, state, 'record-payee', { id: 'client', name: 'Client fixture', category: 'client' });
  state = run(workflow, state, 'record-payee', { id: 'holder', name: 'Lien holder', category: 'lien' });
  state = run(workflow, state, 'record-lien', { id: 'lien-1', payeeId: 'holder', amountCents: 2000, asOf: '2026-11-10', ...otherSource });
  state = run(workflow, state, 'set-allocations', { allocations: [{ payeeId: 'client', amountCents: 8000 }, { payeeId: 'holder', amountCents: 2000 }] });
  assert.match(workflow.validate(state, ctx()).errors.join(' '), /cleared receipt/);
  assert.match(workflow.validate(state, ctx()).errors.join(' '), /reviewer approval/);
  for (const payee of state.payees) state = run(workflow, state, 'approve-payee', { id: payee.id, sha256: payee.versions.at(-1).sha256, notes: 'Reviewed payee evidence' }, true);
  state = run(workflow, state, 'record-receipt', { id: 'deposit-1', amountCents: 10000, status: 'cleared', ...source });
  valid(workflow, state);
  const approved = structuredClone(state);
  assert.equal(workflow.output(state, ctx()).totals.differenceCents, 0);
  state = run(workflow, state, 'record-lien', { id: 'lien-1', payeeId: 'holder', amountCents: 1500, asOf: '2026-11-11', ...otherSource });
  assert.match(workflow.validate(state, ctx()).errors.join(' '), /latest lien/);
  fails(() => run(workflow, state, 'record-lien', { id: 'lien-1', payeeId: 'holder', amountCents: 1600, asOf: '2026-11-09', ...otherSource }), 409);
  state = run(workflow, state, 'set-allocations', { allocations: [{ payeeId: 'client', amountCents: 8500 }, { payeeId: 'holder', amountCents: 1500 }] });
  valid(workflow, state);
  state = run(workflow, state, 'record-receipt', { id: 'deposit-1', amountCents: 10000, status: 'returned', ...source });
  assert.match(workflow.validate(state, ctx()).errors.join(' '), /reconcile/);
  assert.equal(state.receipts[0].versions.length, 3);
  fails(() => workflow.assertExport(state, approved, ctx()), 409);
  fails(() => run(workflow, state, 'record-receipt', { id: 'deposit-2', amountCents: 10000, status: 'cleared', ...source }), 409);
});

test('R46 source-linked statements reject invented quotes and stale revisions while preserving timestamped originals', () => {
  const workflow = def('R46');
  let state = workflow.create({ reference: 'INV-1', objective: 'Document the reported injury timeline' }, ctx());
  const statement = { id: 'witness-1', witnessReference: 'Witness fixture', eventAt: '2026-04-07T12:00:00.000Z', excerpt: evidence, summary: 'Witness reports neck symptoms after collision.', ...source };
  fails(() => run(workflow, state, 'record-statement', { ...statement, excerpt: 'An invented quote.' }), 422);
  state = run(workflow, state, 'record-statement', statement);
  valid(workflow, state);
  const oldSha = state.statements[0].versions[0].sha256;
  fails(() => run(workflow, state, 'record-statement', { ...statement, summary: 'Corrected summary', baseSha256: 'stale' }), 409);
  state = run(workflow, state, 'record-statement', { ...statement, summary: 'Witness reports neck and shoulder symptoms after collision.', baseSha256: oldSha });
  assert.equal(state.statements[0].versions.length, 2);
  const output = workflow.output(state, ctx());
  assert.equal(output.statements[0].eventAt, statement.eventAt);
  assert.equal(output.originals[0].sha256, digest(bytes));
  assert.equal(output.statements[0].supersedes, oldSha);
  fails(() => workflow.validate(state, ctx(false, new Map())), 404);
});

test('R39–R46 complete authenticated source-bound review and export; other firms, preparer approval and revoked access are denied', async t => {
  const { buildApp } = await import('../server/app.mjs');
  const { randomUUID } = await import('node:crypto');
  const users = [
    { username: 'owner', role: 'lawyer', firm: 'alpha' },
    { username: 'specialist', role: 'preparer', firm: 'alpha', desk: workflows.map(row => row.roleId) },
    { username: 'foreign', role: 'lawyer', firm: 'beta' },
  ].map(user => ({ ...user, password: 'synthetic-' + user.username + '-secret' }));
  const server = buildApp({ database: ':memory:', users });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const root = 'http://127.0.0.1:' + server.address().port;
  async function request(who, path, body, expected = 200, extra = {}) {
    const headers = { Authorization: 'Basic ' + Buffer.from(who + ':synthetic-' + who + '-secret').toString('base64'), ...extra };
    if (body) Object.assign(headers, { 'X-Briefcase-Request': '1', 'Content-Type': Buffer.isBuffer(body) ? 'application/pdf' : 'application/json' });
    const response = await fetch(root + path, { method: body ? 'POST' : 'GET', headers, body: body && (Buffer.isBuffer(body) ? body : JSON.stringify(body)) });
    const data = response.headers.get('content-type')?.includes('application/json') ? await response.json() : Buffer.from(await response.arrayBuffer());
    assert.equal(response.status, expected, data.error);
    return data;
  }
  const matter = await request('owner', '/api/matters', { name: 'Specialist scenario fixtures' }, 201);
  const matterPath = '/api/matters/' + matter.id;
  await request('owner', matterPath + '/team', { action: 'grant', username: 'specialist', access: 'prepare' });
  const upload = await request('owner', matterPath + '/documents', bytes, 201, { 'X-PDF-Name': 'Source.pdf', 'X-PDF-Purpose': 'supporting' });
  const second = await request('owner', matterPath + '/documents', otherBytes, 201, { 'X-PDF-Name': 'Second.pdf', 'X-PDF-Purpose': 'supporting' });
  const liveSource = { documentId: upload.document.id, page: 1 }, liveOther = { documentId: second.document.id, page: 1 };
  const seeds = {
    R39: { reference: 'APP-HTTP', claims: [{ number: 1, text: 'A device comprising A.', ...liveSource }] },
    R40: { reference: 'DOCKET-HTTP', agency: 'Fixture agency' },
    R41: { reference: 'PET-HTTP', petitionType: 'Fixture petition', requirements: [{ id: 'form', label: 'Signed form' }] },
    R42: { reference: 'ESTATE-HTTP' },
    R43: { reference: 'CLOSE-HTTP', conditions: [{ id: 'funding', label: 'Lender authorization' }], documents: [{ id: 'deed', label: 'Executed deed' }] },
    R44: { reference: 'PI-HTTP', providers: [{ id: 'clinic', name: 'Harborview', aliases: [] }] },
    R45: { reference: 'SETTLE-HTTP' },
    R46: { reference: 'INV-HTTP', objective: 'Record statement with source trace' },
  };
  const finished = [];
  for (const roleId of workflows.map(row => row.roleId)) {
    let item = (await request('owner', '/api/workbench', { roleId, title: roleId + ' scenario', requestId: randomUUID(), assignee: 'specialist', reviewer: 'owner', matter: matter.id, data: seeds[roleId] }, 201)).item;
    const path = '/api/workbench/' + item.id;
    const act = async (action, data, who = 'specialist') => { item = (await request(who, path, { revision: item.revision, action, data })).item; };
    if (roleId === 'R39') await act('amend-claim', { number: 1, baseSha256: item.data.claims[0].versions[0].sha256, text: 'A device comprising A and B.', reason: 'Source-supported narrowing', ...liveOther });
    if (roleId === 'R40') {
      await act('record-notice', { noticeReference: 'HTTP-NOTICE', deadline: '2027-01-15', receivedAt: '2026-11-12T10:00:00.000Z', ...liveSource });
      await act('confirm-notice', { sha256: item.data.notices[0].sha256, notes: 'Reviewed exact source date' }, 'owner');
    }
    if (roleId === 'R41') await act('attach-evidence', { id: 'form', ...liveSource });
    if (roleId === 'R42') {
      await act('record-asset', { id: 'cash', label: 'Source cash', amountCents: 10000, ...liveSource });
      await act('set-distributions', { distributions: [{ id: 'beneficiary', name: 'Beneficiary fixture', amountCents: 10000 }] });
    }
    if (roleId === 'R43') {
      await act('record-condition', { id: 'funding', ...liveSource });
      await act('record-document', { id: 'deed', signers: 'Fixture signer', executedAt: '2026-11-12T09:00:00.000Z', ...liveOther });
      await act('accept-condition', { id: 'funding', sha256: item.data.conditionEvidence[0].versions[0].sha256, notes: 'Checked lender evidence' }, 'owner');
      await act('accept-document', { id: 'deed', sha256: item.data.signedDocuments[0].versions[0].sha256, notes: 'Checked execution evidence' }, 'owner');
    }
    if (roleId === 'R44') await act('receive-attachment', { eventId: 'DELIVERY-HTTP', providerHint: 'Harborview', receivedAt: '2026-11-12T10:00:00.000Z', ...liveSource });
    if (roleId === 'R45') {
      await act('record-receipt', { id: 'deposit', amountCents: 10000, status: 'cleared', ...liveSource });
      await act('record-payee', { id: 'client', name: 'Client fixture', category: 'client' });
      await act('approve-payee', { id: 'client', sha256: item.data.payees[0].versions[0].sha256, notes: 'Verified payee' }, 'owner');
      await act('set-allocations', { allocations: [{ payeeId: 'client', amountCents: 10000 }] });
    }
    if (roleId === 'R46') await act('record-statement', { id: 'statement', witnessReference: 'Witness fixture', eventAt: '2026-04-07T10:00:00.000Z', excerpt: evidence, summary: 'Source describes collision symptoms.', ...liveSource });
    await request('foreign', path, undefined, 404);
    await request('specialist', path + '/export', undefined, 409);
    item = (await request('specialist', path, { revision: item.revision, action: 'submit' })).item;
    await request('specialist', path, { revision: item.revision, action: 'approve', sha256: item.submission.sha256, notes: 'Attempted self-approval', attested: true }, 403);
    await request('owner', path, { revision: item.revision, action: 'approve', sha256: 'stale', notes: 'Incorrect revision', attested: true }, 409);
    item = (await request('owner', path, { revision: item.revision, action: 'approve', sha256: item.submission.sha256, notes: 'Reviewed exact scenario outputs and sources', attested: true })).item;
    const exported = await request('specialist', path + '/export');
    assert.equal(exported.roleId, roleId);
    assert.equal(exported.version.sha256, item.submission.sha256);
    assert.ok(JSON.stringify(exported.version.output).includes(upload.document.sha256));
    if (['R41', 'R43'].includes(roleId)) {
      const pdf = await request('specialist', path + '/export?format=pdf');
      assert.ok((await PDFDocument.load(pdf)).getPageCount() > 1);
    }
    finished.push(path);
  }
  await request('owner', matterPath + '/team', { action: 'revoke', username: 'specialist' });
  for (const path of finished) {
    await request('specialist', path, undefined, 404);
    await request('specialist', path + '/export', undefined, 404);
  }
});
