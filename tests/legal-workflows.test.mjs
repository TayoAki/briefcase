import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { PDFDocument, StandardFonts } from '../dist/vendor/packets/pdf-lib.mjs';
import { workflows } from '../server/workflows/legal.mjs';

const hash = v => createHash('sha256').update(typeof v === 'string' || Buffer.isBuffer(v) ? v : JSON.stringify(v)).digest('hex');
const defs = new Map(workflows.map(d => [d.roleId, d]));
async function source(id, paragraphs) {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (const paragraph of paragraphs) pdf.addPage([612, 792]).drawText(paragraph, { x: 54, y: 740, font, size: 12 });
  const bytes = Buffer.from(await pdf.save());
  return { id, name: id + '.pdf', bytes, sha256: hash(bytes), pages: paragraphs.map((text, i) => ({ number: i + 1, text })), purpose: 'supporting' };
}
const originals = new Map(await Promise.all([
  source('evidence', ['The witness saw the delivery arrive at noon.', 'The delivery receipt bears the client signature.']),
  source('authority', ['A party must establish the required elements with admissible evidence.']),
  source('signed', ['Agreement executed by Client and Counterparty.']),
  source('privileged', ['Private advice from counsel about litigation strategy.']),
  source('clean', ['The public purchase order totals one hundred dollars.']),
]).then(rows => rows.map(row => [row.id, row])));
function context(extra = {}) {
  return { user: { username: 'staff', firm: 'alpha', role: 'preparer', desk: [] }, now: '2026-11-12T12:00:00.000Z', matterId: 'matter-1', hash, isReviewer: false,
    fail(status, message) { throw Object.assign(new Error(message), { status }); },
    source(id, page) { const value = originals.get(id); if (!value || page && !value.pages.some(p => p.number === page)) this.fail(404, 'Original unavailable.'); return value; }, ...extra };
}
const ctx = context();
const lawyer = context({ user: { username: 'lawyer', firm: 'alpha', role: 'lawyer', desk: [] }, isReviewer: true });
const b = (documentId = 'evidence', page = 1) => ({ documentId, page, quote: originals.get(documentId).pages[page - 1].text });
const valid = (def, state, c = ctx) => assert.deepEqual(def.validate(state, c).errors, []);

for (const roleId of ['R03', 'R25']) test(roleId + ' preserves exact-source drafts and exposes changed revisions without publishing controls', async () => {
  const def = defs.get(roleId);
  const first = def.create({ documentTitle: 'Delivery evidence memo', body: 'Initial interpretation', sources: [b()] }, ctx);
  valid(def, first);
  const next = def.update(first, 'revise-draft', { body: 'Corrected interpretation\nEvidence arrived at noon.', sources: [b('evidence', 2)], reason: 'Supervisor requested delivery proof' }, ctx);
  valid(def, next);
  assert.equal(first.body, 'Initial interpretation');
  assert.equal(next.revisions[0].body, first.body);
  assert.equal(next.revisions[0].sources[0].sha256, originals.get('evidence').sha256);
  assert.equal(next.contentRevision, 2);
  assert.ok(def.output(next).change.added.includes('Corrected interpretation'));
  assert.throws(() => def.update(next, 'publish', {}, ctx), /not available/);
  assert.throws(() => def.create({ documentTitle: 'Bad', body: 'Claim', sources: [{ ...b(), quote: 'Invented source content' }] }, ctx), /not present/);
  const noSource = def.create({ documentTitle: 'Unsourced', body: 'Claim', sources: [] }, ctx);
  assert.ok(def.validate(noSource, ctx).errors.length);
  const pdf = await def.exportFile(next, ctx, 'pdf');
  assert.ok((await PDFDocument.load(pdf.bytes)).getPageCount() > 0);
  assert.deepEqual(pdf.bytes, (await def.exportFile(next, ctx, 'pdf')).bytes);
});

test('R20 junior outline revisions retain precise exhibit pages and readable changes', async () => {
  const def = defs.get('R20');
  const first = def.create({ witness: 'Delivery witness', outline: 'What time did delivery arrive?', exhibits: [{ label: 'Exhibit A', ...b() }] }, ctx);
  const next = def.update(first, 'revise-outline', { outline: 'Who signed the delivery receipt?', exhibits: [{ label: 'Exhibit B', ...b('evidence', 2) }], reason: 'Address witness memory gap' }, ctx);
  valid(def, next);
  assert.equal(next.revisions[0].exhibits[0].page, 1);
  assert.equal(def.output(next).exhibitIndex[0].page, 2);
  assert.deepEqual(def.output(next).change.removed, ['What time did delivery arrive?']);
  const pdf = await def.exportFile(next, ctx, 'pdf');
  assert.equal((await PDFDocument.load(pdf.bytes)).getPageCount(), 1);
  assert.throws(() => def.create({ witness: 'X', outline: 'Y', exhibits: [{ label: 'A', ...b() }, { label: 'A', ...b() }] }, ctx), /unique/);
  assert.throws(() => def.create({ witness: 'X', outline: 'Y', exhibits: [{ label: 'A', ...b(), page: 99 }] }, ctx), /unavailable/);
});

const authorityInput = () => [{ id: 'A1', citation: 'Synthetic Case, 1 Test 1', proposition: 'Evidence supports every required element.', ...b('authority') }];
test('R21 unsupported motion citations cannot pass and authority changes erase treatment checks', async () => {
  const def = defs.get('R21');
  let state = def.create({ motionTitle: 'Motion for relief', body: 'The required elements need proof. [[A1]]', authorities: authorityInput() }, ctx);
  assert.ok(def.validate(state, ctx).errors.some(e => e.includes('reviewing-lawyer')));
  assert.throws(() => def.update(state, 'check-authority', { id: 'A1', sourceSha256: originals.get('authority').sha256, treatment: 'current', notes: 'Reviewed authority' }, ctx), e => e.status === 403);
  assert.throws(() => def.update(state, 'check-authority', { id: 'A1', sourceSha256: 'old', treatment: 'current', notes: 'Reviewed authority' }, lawyer), e => e.status === 409);
  state = def.update(state, 'check-authority', { id: 'A1', sourceSha256: originals.get('authority').sha256, treatment: 'unsupported', notes: 'Proposition is unsupported.' }, lawyer);
  assert.ok(def.validate(state, ctx).errors.length);
  state = def.update(state, 'check-authority', { id: 'A1', sourceSha256: originals.get('authority').sha256, treatment: 'current', notes: 'Source reviewed 2026-11-12, no negative treatment in supplied record.' }, lawyer);
  valid(def, state);
  assert.match(def.output(state).text, /Synthetic Case/);
  assert.ok((await PDFDocument.load((await def.exportFile(state, ctx)).bytes)).getPageCount());
  const old = structuredClone(state);
  state = def.update(state, 'revise-motion', { body: 'The required elements need proof. [[MISSING]]', authorities: authorityInput(), reason: 'New proposition' }, ctx);
  assert.equal(state.authorities[0].check, null);
  assert.ok(def.validate(state, ctx).errors.some(e => e.includes('MISSING')));
  assert.equal(old.authorities[0].check.treatment, 'current');
  assert.throws(() => def.create({ motionTitle: 'Fabricated quote', body: '[[A1]]', authorities: [{ ...authorityInput()[0], quote: 'Court held the opposite' }] }, ctx), /not present/);
});

test('R22 changed conditions reopen review and only exact executed PDFs enter closing binder', async () => {
  const def = defs.get('R22');
  let state = def.create({ transaction: 'Synthetic acquisition', conditions: [{ id: 'C1', label: 'Delivery receipt required' }], documents: [{ id: 'D1', label: 'Agreement', documentId: 'signed', requiredSigners: ['Client', 'Counterparty'] }] }, ctx);
  assert.equal(def.validate(state, ctx).errors.length, 2);
  assert.throws(() => def.update(state, 'verify-execution', { id: 'D1', sourceSha256: originals.get('signed').sha256, signers: ['Client'], executedAt: '2026-11-11', notes: 'Checked signatures' }, lawyer), /missing/);
  assert.throws(() => def.update(state, 'satisfy-condition', { id: 'C1', ...b('evidence', 2), notes: 'Matched receipt' }, ctx), e => e.status === 403);
  state = def.update(state, 'satisfy-condition', { id: 'C1', ...b('evidence', 2), notes: 'Matched receipt' }, lawyer);
  state = def.update(state, 'verify-execution', { id: 'D1', sourceSha256: originals.get('signed').sha256, signers: ['Client', 'Counterparty'], executedAt: '2026-11-11', notes: 'Matched visible execution signatures' }, lawyer);
  valid(def, state);
  assert.equal(def.output(state, ctx).signedBinderManifest[0].sha256, originals.get('signed').sha256);
  assert.equal(def.output(state, ctx).totalPages, 1);
  assert.equal((await PDFDocument.load((await def.exportFile(state, ctx)).bytes)).getPageCount(), 1);
  const reviewed = structuredClone(state);
  state = def.update(state, 'amend-condition', { id: 'C1', label: 'Counterparty consent also required', reason: 'Amended agreement' }, ctx);
  assert.equal(state.conditions[0].status, 'pending');
  assert.ok(def.validate(state, ctx).errors.some(e => e.includes('Unmet')));
  assert.equal(reviewed.conditions[0].status, 'satisfied');
  assert.equal(state.conditions[0].changes[0].evidence.sha256, originals.get('evidence').sha256);
  state = def.update(state, 'replace-document', { id: 'D1', documentId: 'evidence' }, ctx);
  assert.equal(state.documents[0].execution, null);
  assert.equal(state.documents[0].replacements[0].binding.documentId, 'signed');
  assert.ok(def.validate(state, ctx).errors.some(e => e.includes('Execution')));
});

const memoInput = (id, analysis) => ({ id, title: id + ' research', question: 'What does the receipt show?', analysis, sources: [b('evidence', 2)] });
test('R23 separately composed memos preserve identity and reviewed source revisions', async () => {
  const def = defs.get('R23');
  let state = def.create({ memos: [memoInput('M1', 'First analysis')] }, ctx);
  state = def.update(state, 'add-memo', memoInput('M2', 'Second analysis'), ctx);
  const firstHash = state.memos[0].current.sha256;
  const secondHash = state.memos[1].current.sha256;
  state = def.update(state, 'revise-memo', memoInput('M1', 'Revised first analysis'), ctx);
  valid(def, state);
  assert.equal(state.memos[1].current.sha256, secondHash);
  assert.equal(state.memos[0].revisions[0].sha256, firstHash);
  assert.notEqual(state.memos[0].current.sha256, firstHash);
  assert.deepEqual(def.output(state).memoManifest.map(m => [m.id, m.version]), [['M1', 2], ['M2', 1]]);
  assert.throws(() => def.update(state, 'add-memo', memoInput('M2', 'Overwrite'), ctx), e => e.status === 409);
  assert.throws(() => def.update(state, 'revise-memo', memoInput('missing', 'Wrong memo'), ctx), e => e.status === 404);
  assert.ok((await PDFDocument.load((await def.exportFile(state, ctx)).bytes)).getPageCount());
});

test('R24 privileged attachments withhold entire families and release only cleared originals', async () => {
  const def = defs.get('R24');
  let state = def.create({ documents: [{ id: 'E1', documentId: 'evidence' }, { id: 'E2', documentId: 'privileged', parentId: 'E1' }, { id: 'E3', documentId: 'clean' }] }, ctx);
  assert.equal(def.validate(state, ctx).errors.length, 3);
  const designate = (id, documentId, designation, c = lawyer) => def.update(state, 'code-document', { id, sourceSha256: originals.get(documentId).sha256, designation, reason: 'Reviewed original for relevance and privilege' }, c);
  assert.throws(() => designate('E2', 'privileged', 'privileged', ctx), e => e.status === 403);
  state = designate('E1', 'evidence', 'responsive');
  state = designate('E2', 'privileged', 'privileged');
  state = designate('E3', 'clean', 'responsive');
  valid(def, state);
  const product = def.output(state);
  assert.deepEqual(product.productionManifest.map(d => d.documentId), ['clean']);
  assert.equal(product.withheld.length, 2);
  const releaseManifest = JSON.parse((await def.exportFile(state, ctx, 'manifest')).bytes.toString());
  assert.doesNotMatch(JSON.stringify(releaseManifest), /privileged|evidence|Private advice|history/);
  assert.deepEqual(releaseManifest.productionManifest.map(d => d.documentId), ['clean']);
  assert.equal(product.reviewHistory.find(d => d.id === 'E2').history[0].to, 'privileged');
  assert.equal((await PDFDocument.load((await def.exportFile(state, ctx)).bytes)).getPageCount(), 1);
  assert.throws(() => def.update(state, 'add-document', { id: 'E4', documentId: 'clean' }, ctx), e => e.status === 409);
  assert.throws(() => def.create({ documents: [{ id: 'A', documentId: 'clean', parentId: 'B' }, { id: 'B', documentId: 'signed', parentId: 'A' }] }, ctx), /cycles/);
  const approved = structuredClone(state);
  state = designate('E3', 'clean', 'privileged');
  assert.throws(() => def.assertExport(state, approved, ctx), e => e.status === 409);
  const tampered = context({ source(documentId) { const doc = originals.get(documentId); return { ...doc, sha256: 'changed' }; } });
  assert.ok(def.validate(state, tampered).errors.length);
});

test('all seven legal specialist scenarios enforce authenticated review, exact artifacts and source revocation', async t => {
  const { buildApp } = await import('../server/app.mjs');
  const { randomUUID } = await import('node:crypto');
  const users = [
    { username: 'lead', role: 'lawyer', desk: [] },
    { username: 'staff', role: 'preparer', desk: workflows.map(w => w.roleId) },
    { username: 'unrelated', role: 'lawyer', desk: [] },
    { username: 'foreign', role: 'lawyer', desk: [], firm: 'beta' },
  ].map(u => ({ firm: 'alpha', password: 'legal-synthetic-' + u.username, ...u }));
  const server = buildApp({ database: ':memory:', users });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = 'http://127.0.0.1:' + server.address().port;
  async function call(username, path, body, expected = 200, extra = {}) {
    const headers = { Authorization: 'Basic ' + Buffer.from(username + ':legal-synthetic-' + username).toString('base64') };
    const pdf = Buffer.isBuffer(body);
    if (body) Object.assign(headers, { 'X-Briefcase-Request': '1', 'Content-Type': pdf ? 'application/pdf' : 'application/json' });
    const response = await fetch(base + path, { method: body ? 'POST' : 'GET', headers: { ...headers, ...extra }, body: body && (pdf ? body : JSON.stringify(body)) });
    const data = response.headers.get('content-type')?.includes('application/json') ? await response.json() : Buffer.from(await response.arrayBuffer());
    assert.equal(response.status, expected, data.error);
    return data;
  }
  const matter = await call('lead', '/api/matters', { name: 'Legal specialist acceptance matter' }, 201);
  const matterPath = '/api/matters/' + matter.id;
  await call('lead', matterPath + '/team', { action: 'grant', username: 'staff', access: 'prepare' });
  const imported = new Map();
  for (const [key, doc] of originals) {
    const result = await call('lead', matterPath + '/documents', doc.bytes, 201, { 'X-PDF-Name': doc.name, 'X-PDF-Purpose': 'supporting' });
    imported.set(key, result.document);
  }
  const ref = (key = 'evidence', page = 1) => ({ documentId: imported.get(key).id, page, quote: originals.get(key).pages[page - 1].text });
  const created = [];
  async function make(roleId, data) {
    const body = { roleId, title: 'Acceptance ' + roleId, requestId: randomUUID(), assignee: 'staff', reviewer: 'lead', matter: matter.id, data };
    const { item } = await call('lead', '/api/workbench', body, 201);
    const replay = await call('lead', '/api/workbench', body);
    assert.equal(replay.item.id, item.id);
    created.push(item.id);
    await call('unrelated', '/api/workbench/' + item.id, undefined, 404);
    await call('foreign', '/api/workbench/' + item.id, undefined, 404);
    return item;
  }
  async function command(item, action, data, username = 'staff') {
    return (await call(username, '/api/workbench/' + item.id, { action, revision: item.revision, data })).item;
  }
  async function approve(item) {
    const path = '/api/workbench/' + item.id;
    await call('staff', path + '/export', undefined, 409);
    item = await command(item, 'submit', {});
    await call('staff', path, { action: 'approve', revision: item.revision, sha256: item.submission.sha256, notes: 'Not authorized', attested: true }, 403);
    await call('lead', path, { action: 'approve', revision: item.revision, sha256: 'stale', notes: 'Old submission', attested: true }, 409);
    item = (await call('lead', path, { action: 'approve', revision: item.revision, sha256: item.submission.sha256, notes: 'Checked the exact work product and original sources.', attested: true })).item;
    const proof = await call('staff', path + '/export');
    assert.equal(proof.version.sha256, item.submission.sha256);
    assert.equal(proof.version.decision.by, 'lead');
    const pdf = await call('staff', path + '/export?format=pdf');
    assert.ok((await PDFDocument.load(pdf)).getPageCount() > 0);
    return item;
  }
  for (const roleId of ['R03', 'R25']) {
    let item = await make(roleId, { documentTitle: 'Supervised memo', body: 'Receipt evidence supports the timeline.', sources: [ref()] });
    item = await approve(item);
    const proof = await call('staff', '/api/workbench/' + item.id + '/export');
    item = await command(item, 'revise-draft', { body: 'Corrected receipt analysis.', sources: [ref('evidence', 2)], reason: 'Supervisor requested signed receipt discussion' });
    await call('staff', '/api/workbench/' + item.id + '/export', undefined, 409);
    const historical = await call('staff', '/api/workbench/' + item.id + '/export?version=1');
    assert.equal(historical.version.sha256, proof.version.sha256);
    assert.equal(historical.version.output.body, 'Receipt evidence supports the timeline.');
    await approve(item);
  }
  let seniorItem = await make('R20', { witness: 'Delivery witness', outline: 'Who received the package?', exhibits: [{ label: 'A', ...ref() }] });
  seniorItem = await command(seniorItem, 'revise-outline', { outline: 'Who signed the receipt?', exhibits: [{ label: 'B', ...ref('evidence', 2) }], reason: 'Follow-up issue' });
  seniorItem = await approve(seniorItem);
  assert.equal((await call('lead', '/api/workbench/' + seniorItem.id + '/export')).version.output.revisionHistory.length, 1);

  let motionItem = await make('R21', { motionTitle: 'Evidence motion', body: 'Each element requires evidence. [[A1]]', authorities: [{ id: 'A1', citation: 'Synthetic Case, 1 Test 1', proposition: 'Proof required', ...ref('authority') }] });
  await call('staff', '/api/workbench/' + motionItem.id, { action: 'submit', revision: motionItem.revision }, 422);
  motionItem = await command(motionItem, 'check-authority', { id: 'A1', sourceSha256: imported.get('authority').sha256, treatment: 'current', notes: 'Checked supplied authority on 2026-11-12.' }, 'lead');
  await approve(motionItem);

  let closing = await make('R22', { transaction: 'Synthetic transaction', conditions: [{ id: 'C1', label: 'Delivery receipt' }], documents: [{ id: 'D1', label: 'Signed agreement', documentId: imported.get('signed').id, requiredSigners: ['Client', 'Counterparty'] }] });
  await call('staff', '/api/workbench/' + closing.id, { action: 'submit', revision: closing.revision }, 422);
  closing = await command(closing, 'satisfy-condition', { id: 'C1', ...ref('evidence', 2), notes: 'Source receipt matched.' }, 'lead');
  closing = await command(closing, 'verify-execution', { id: 'D1', sourceSha256: imported.get('signed').sha256, signers: ['Client', 'Counterparty'], executedAt: '2026-11-11', notes: 'Checked signed original.' }, 'lead');
  closing = await approve(closing);
  const manifest = (await call('lead', '/api/workbench/' + closing.id + '/export')).version.output.signedBinderManifest;
  assert.equal(manifest[0].sha256, imported.get('signed').sha256);
  closing = await command(closing, 'amend-condition', { id: 'C1', label: 'Additional consent', reason: 'Amended transaction terms' });
  await call('staff', '/api/workbench/' + closing.id, { action: 'submit', revision: closing.revision }, 422);

  let memoItem = await make('R23', { memos: [{ id: 'M1', title: 'First research memo', question: 'What happened?', analysis: 'Delivery occurred at noon.', sources: [ref()] }] });
  memoItem = await command(memoItem, 'add-memo', { id: 'M2', title: 'Second research memo', question: 'Who signed?', analysis: 'Client signed receipt.', sources: [ref('evidence', 2)] });
  memoItem = await approve(memoItem);
  assert.equal((await call('lead', '/api/workbench/' + memoItem.id + '/export')).version.output.memoManifest.length, 2);

  let production = await make('R24', { documents: [{ id: 'E1', documentId: imported.get('evidence').id }, { id: 'E2', documentId: imported.get('privileged').id, parentId: 'E1' }, { id: 'E3', documentId: imported.get('clean').id }] });
  for (const [id, key, designation] of [['E1', 'evidence', 'responsive'], ['E2', 'privileged', 'privileged'], ['E3', 'clean', 'responsive']]) {
    production = await command(production, 'code-document', { id, sourceSha256: imported.get(key).sha256, designation, reason: 'Source-specific privilege review' }, 'lead');
  }
  production = await approve(production);
  const product = (await call('staff', '/api/workbench/' + production.id + '/export')).version.output;
  assert.deepEqual(product.productionManifest.map(d => d.documentId), [imported.get('clean').id]);
  production = await command(production, 'code-document', { id: 'E3', sourceSha256: imported.get('clean').sha256, designation: 'privileged', reason: 'New privilege information' }, 'lead');
  await call('staff', '/api/workbench/' + production.id + '/export?version=1', undefined, 409);
  await call('staff', '/api/workbench/' + production.id + '/export?version=1&format=pdf', undefined, 409);

  await call('lead', matterPath + '/team', { action: 'revoke', username: 'staff' });
  for (const itemId of created) {
    await call('staff', '/api/workbench/' + itemId, undefined, 404);
    await call('staff', '/api/workbench/' + itemId + '/export?version=1', undefined, 404);
  }
});
