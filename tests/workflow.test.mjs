import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildApp } from '../server/app.mjs';
import { indexPdf, sha256 } from '../server/pdf.mjs';
import { createPaperless } from '../server/paperless.mjs';
import { modelSuggestions } from '../server/llm.mjs';
import { suggestionsFor } from '../dist/model.mjs';
import { demandText, practice, queueItems, updateText } from '../dist/practice.mjs';
import { buildPacket } from '../dist/packets.mjs';
import { workflowUI } from '../dist/practice-ui.mjs';

const file = name => readFile(new URL('./fixtures/' + name, import.meta.url));
const users = [
  { username: 'lawyer', password: 'synthetic-only-password', firm: 'firm-a', name: 'Test lawyer' },
  { username: 'colleague', password: 'synthetic-colleague-pass', firm: 'firm-a' },
  { username: 'other', password: 'different-firm-password', firm: 'firm-b' },
];

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return 'http://127.0.0.1:' + server.address().port;
}

async function stop(server) {
  await new Promise(resolve => server.close(resolve));
}

function client(base, user = users[0]) {
  return async (path, { body, pdf, name = 'Synthetic.pdf', revision, noHeader, origin, purpose } = {}) => {
    const headers = {};
    if (user) headers.Authorization = 'Basic ' + Buffer.from(user.username + ':' + user.password).toString('base64');
    if (body || pdf) {
      headers['Content-Type'] = pdf ? 'application/pdf' : 'application/json';
      if (!noHeader) headers['X-Briefcase-Request'] = '1';
    }
    if (pdf) headers['X-PDF-Name'] = encodeURIComponent(name);
    if (purpose) headers['X-PDF-Purpose'] = purpose;
    if (revision !== undefined) headers['If-Match'] = String(revision);
    if (origin) headers.Origin = origin;
    const response = await fetch(base + path, { method: body || pdf ? 'POST' : 'GET', headers, body: pdf ?? (body ? JSON.stringify(body) : undefined) });
    let data;
    if (response.headers.get('content-type')?.includes('application/json')) data = await response.json();
    else data = Buffer.from(await response.arrayBuffer());
    return { status: response.status, data };
  };
}

test('indexes a mixed PDF against original page positions and flags unreadable pages', async () => {
  const bytes = await file('mixed.pdf');
  const doc = await indexPdf(bytes, 'Mixed.pdf');
  assert.equal(doc.sha256, sha256(bytes));
  assert.deepEqual(doc.pages.map(page => page.method), ['text', 'text', 'ocr']);
  assert.equal(doc.pages[1].label, 'ELLIS-0001');
  assert.equal(doc.pages[2].label, 'ELLIS-0003');
  assert.deepEqual(suggestionsFor(doc).map(event => [event.date, event.page]), [['2026-04-07', 2], ['2026-04-14', 3]]);
  assert.equal((await indexPdf(await file('blank.pdf'), 'Blank.pdf')).pages[0].method, 'unreadable');
  await assert.rejects(async () => indexPdf(await file('locked.pdf'), 'Locked.pdf'), /password|encrypted/i);
  await assert.rejects(async () => indexPdf(await file('corrupt.pdf'), 'Corrupt.pdf'), /could not be opened/);
});

test('rejects a reordered OCR derivative and falls back to the physical original pages', async () => {
  const doc = await indexPdf(await file('mixed.pdf'), 'Mixed.pdf', { importArchive: () => file('swapped.pdf') });
  assert.match(doc.importNote, /could not be matched/);
  assert.equal(doc.pages[2].label, 'ELLIS-0003');
  assert.equal(suggestionsFor(doc).find(event => event.page === 3).date, '2026-04-14');
});

test('imports, verifies, approves and exports exact revisions with matter and account checks', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'briefcase-test-'));
  const database = join(dir, 'records.sqlite');
  let server = buildApp({ database, users });
  try {
    const base = await listen(server);
    const call = client(base);
    assert.equal((await client(base, null)('/api/matters')).status, 401);
    assert.equal((await call('/api/matters', { body: { name: 'Invalid cross-origin' }, origin: 'https://example.org' })).status, 403);
    assert.equal((await call('/api/matters', { body: { name: 'Invalid cross-origin' }, noHeader: true })).status, 403);
    const initial = await call('/api/matters');
    assert.equal(initial.data[0].demo, true);
    const samplePath = '/api/matters/ellis-sample';
    assert.equal((await call(samplePath)).data.events.length, 5);
    assert.equal((await call(samplePath + '/documents/ellis-medical-records/original')).status, 200);
    const created = await call('/api/matters', { body: { name: 'Synthetic matter', reference: 'PI-001' } });
    assert.equal(created.status, 201);
    const path = '/api/matters/' + created.data.id;
    const another = await call('/api/matters', { body: { name: 'Another synthetic matter' } });
    const anotherPath = '/api/matters/' + another.data.id;
    for (const user of users.slice(1)) {
      assert.equal((await client(base, user)(path)).status, 404);
      assert.equal((await client(base, user)(path + '/documents', { pdf: await file('digital.pdf') })).status, 404);
    }
    assert.equal((await call(path + '/documents', { pdf: await file('corrupt.pdf') })).status, 422);
    assert.equal((await call(path)).data.documents.length, 0);
    const bytes = await file('mixed.pdf');
    const attempts = await Promise.all([call(path + '/documents', { pdf: bytes }), call(path + '/documents', { pdf: bytes })]);
    assert.deepEqual(attempts.map(reply => reply.status).sort(), [200, 201]);
    let matter = attempts[0].data.matter;
    const doc = matter.documents[0];
    const originalPath = path + '/documents/' + doc.id + '/original';
    assert.equal(matter.documents.length, 1);
    assert.deepEqual((await call(originalPath)).data, bytes);
    assert.equal((await call(anotherPath + '/documents/' + doc.id + '/original')).status, 404);
    assert.equal((await client(base, users[2])(originalPath)).status, 404);
    assert.equal((await call(path + '/approvals/missing/csv')).status, 404);
    assert.equal((await call(path + '/approve', { body: { attested: true }, revision: matter.revision })).status, 422);
    const invalid = await call(path + '/events', { body: { ...matter.events[0], quote: 'fabricated quote' }, revision: matter.revision });
    assert.equal(invalid.status, 422);
    assert.equal((await call(anotherPath + '/events', { body: matter.events[0], revision: another.data.revision })).status, 422);
    const originalRevision = matter.revision;
    for (const event of matter.events) {
      const updated = await call(path + '/events/' + event.id, { body: { action: 'verify' }, revision: matter.revision });
      assert.equal(updated.status, 200);
      matter = updated.data.matter;
    }
    assert.equal((await call(path + '/approve', { body: { attested: true }, revision: originalRevision })).status, 409);
    assert.equal((await call(path + '/approve', { body: {}, revision: matter.revision })).status, 422);
    const approved = await call(path + '/approve', { body: { attested: true }, revision: matter.revision });
    assert.equal(approved.status, 200);
    const version = approved.data.approval;
    assert.equal(version.approvedBy, 'Test lawyer');
    const repeated = await call(path + '/approve', { body: { attested: true }, revision: matter.revision });
    assert.equal(repeated.data.approval.id, version.id);
    const versionPath = path + '/approvals/' + version.id;
    const manifest = (await call(versionPath + '/json')).data;
    assert.deepEqual(manifest.events.map(event => event.page), [2, 3]);
    assert.equal(new URL(manifest.events[1].sourceUrl).searchParams.get('page'), '3');
    assert.equal(manifest.events[1].sourceSha256, sha256(bytes));
    const csv = (await call(versionPath + '/csv')).data;
    assert.match(csv.toString(), /Original PDF page/);
    assert.match(csv.toString(), /ELLIS-0003/);
    assert.equal((await client(base, users[1])(versionPath + '/csv')).status, 404);

    const edit = await call(path + '/events/' + matter.events[0].id, {
      body: { ...matter.events[0], action: 'edit', summary: 'Edited for a later review.' }, revision: matter.revision,
    });
    matter = edit.data.matter;
    assert.equal(matter.events[0].status, 'needs_review');
    assert.equal((await call(path + '/approve', { body: { attested: true }, revision: matter.revision })).status, 422);
    assert.deepEqual((await call(versionPath + '/csv')).data, csv);
    const blank = await call(path + '/documents', { pdf: await file('blank.pdf'), name: 'Blank.pdf' });
    assert.equal(blank.data.document.pages[0].method, 'unreadable');
    matter = blank.data.matter;
    const reviewed = await call(path + '/page-review', {
      body: { documentId: blank.data.document.id, page: 1, reason: 'Checked the blank original page.' }, revision: matter.revision,
    });
    assert.equal(reviewed.status, 200);
    assert.equal(reviewed.data.matter.activity[0].action, 'OCR gap reviewed');

    await stop(server);
    server = buildApp({ database, users });
    const restarted = client(await listen(server));
    assert.deepEqual((await restarted(originalPath)).data, bytes);
    assert.equal((await restarted(versionPath + '/json')).data.approvedBy, 'Test lawyer');
    assert.equal((await restarted(path)).data.events[0].status, 'needs_review');
  } finally {
    if (server.listening) await stop(server);
    await rm(dir, { recursive: true, force: true });
  }
});

test('Paperless adapter resumes a task and verifies the original before using the archive', async () => {
  const taskId = 'bbf6bb01-6c17-456c-a6f0-56dabbe3def2';
  const original = await file('mixed.pdf');
  let posts = 0;
  let ready = false;
  let wrongHash = false;
  const seen = [];
  const upstream = createServer(async (req, res) => {
    seen.push(req.url);
    assert.equal(req.headers.authorization, 'Token test-only-token');
    if (req.url === '/api/documents/post_document/') {
      posts += 1;
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const raw = Buffer.concat(chunks);
      assert.ok(raw.includes(Buffer.from('filename="briefcase-synthetic.pdf"')));
      assert.ok(raw.includes(original));
      res.end(JSON.stringify(taskId));
    } else if (req.url.startsWith('/api/tasks/')) {
      res.end(JSON.stringify([{ task_id: taskId, status: ready ? 'success' : 'pending', related_document_ids: ready ? [42] : [] }]));
    } else if (req.url === '/api/documents/42/download/?version=42&original=true') {
      res.end(wrongHash ? Buffer.from('mismatch') : original);
    } else if (req.url === '/api/documents/42/download/?version=42') {
      res.end(original);
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  const base = await listen(upstream);
  try {
    const importer = createPaperless({ base, token: 'test-only-token', waitMs: 60, pollMs: 5 });
    let job = { filename: 'briefcase-synthetic.pdf', state: 'new' };
    const submit = () => importer({ bytes: original, job, save: value => { job = value; } });
    await assert.rejects(submit(), /still processing/);
    assert.equal(job.taskId, taskId);
    assert.equal(posts, 1);
    ready = true;
    assert.deepEqual(await submit(), original);
    assert.equal(posts, 1);
    assert.ok(seen.indexOf('/api/documents/42/download/?version=42&original=true') < seen.indexOf('/api/documents/42/download/?version=42'));
    wrongHash = true;
    await assert.rejects(submit(), /hash check/);
    assert.equal(job.state, 'failed');
  } finally { await stop(upstream); }
});

test('model adapter discards fabricated pages and accepts only excerpts found on the scoped page', async () => {
  const doc = await indexPdf(await file('untrusted.pdf'), 'Untrusted.pdf');
  const evidence = 'Fictional record for testing instruction isolation.';
  const upstream = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks));
    assert.match(body.messages[0].content, /untrusted text/);
    assert.equal(body.tools, undefined);
    assert.equal(JSON.parse(body.messages[1].content).length, 1);
    const event = { date: '2026-04-07', page: 1, title: 'Evaluation', summary: evidence, quote: evidence };
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
      events: [event, { ...event, page: 900 }, { ...event, quote: 'Fabricated text' }],
    }) } }] }));
  });
  const base = await listen(upstream);
  try {
    const events = await modelSuggestions(doc, { url: base + '/v1/chat/completions', model: 'fixture' });
    assert.equal(events.length, 1);
    assert.equal(events[0].origin, 'model');
    assert.equal(events[0].status, 'needs_review');
    assert.equal(events[0].documentId, doc.id);
    assert.equal(events[0].quote, evidence);
  } finally { await stop(upstream); }
});

test('runs all five practice workflows through the scoped server and produces both approved ZIPs', async () => {
  const server = buildApp({ database: ':memory:', users });
  const base = await listen(server);
  const call = client(base);
  const other = client(base, users[2]);
  try {
    const add = async (name, who = call) => (await who('/api/matters', { body: { name, reference: 'QA-01' } })).data;
    let matter = await add('Lifecycle test');
    let related = await add('Existing inquiry');
    let hidden = await add('Different firm', other);
    const path = '/api/matters/' + matter.id;
    const change = (entry, action, fields = {}, who = call, revision = practice(entry).revision) =>
      who('/api/matters/' + entry.id + '/practice', { body: { action, ...fields }, revision });
    const apply = async (action, fields = {}) => {
      const result = await change(matter, action, fields);
      assert.equal(result.status, 200, result.data.error);
      matter = result.data.matter;
      return practice(matter);
    };
    const loadOriginal = async (_matter, document) => (await call(path + '/documents/' + document.id + '/original')).data;
    assert.equal((await other(path + '/conflicts')).status, 404);
    assert.equal((await other(path + '/practice', { body: { action: 'intake-details' }, revision: 0 })).status, 404);
    await apply('intake-details', { contact: 'synthetic@example.test', inquiry: 'Synthetic rear-end collision' });
    await apply('party-save', { name: 'Morgan Ellis', role: 'Prospective client' });
    await apply('party-save', { name: 'Juniper Logistics', role: 'Adverse party' });
    related = (await change(related, 'party-save', { name: 'Juniper  Logistics', role: 'Related party' })).data.matter;
    hidden = (await change(hidden, 'party-save', { name: 'Juniper Logistics', role: 'Related party' }, other)).data.matter;
    assert.equal(practice(hidden).intake.parties.length, 1);
    let conflict = (await call(path + '/conflicts')).data;
    assert.deepEqual(conflict.matches.map(row => row.matterId), [related.id]);
    assert.equal((await change(matter, 'intake-decision', { status: 'accepted', reason: 'Reviewed', attested: true })).status, 422);
    await apply('conflict-review', { matchKey: conflict.matchKey, disposition: 'cleared', reason: 'Reviewed the fictional overlap.', attested: true });
    related = (await change(related, 'party-save', { name: 'Morgan Ellis', role: 'Related party' })).data.matter;
    assert.equal((await change(matter, 'intake-decision', { status: 'accepted', reason: 'Reviewed', attested: true })).status, 422);
    conflict = (await call(path + '/conflicts')).data;
    await apply('conflict-review', { matchKey: conflict.matchKey, disposition: 'cleared', reason: 'Reviewed both synthetic candidates.', attested: true });
    assert.equal((await change(matter, 'intake-details', { inquiry: 'Stale edit' }, call, 1)).status, 409);
    await apply('intake-decision', { status: 'accepted', reason: 'Within synthetic pilot scope.', attested: true });

    const supporting = await call(path + '/documents', { pdf: await file('digital.pdf'), name: 'Sample signed agreement.pdf', purpose: 'supporting' });
    assert.equal(supporting.status, 201);
    assert.equal(supporting.data.document.purpose, 'supporting');
    assert.equal(supporting.data.matter.events.length, 0);
    const agreement = supporting.data.document;
    matter = supporting.data.matter;
    assert.equal((await apply('engagement-save', { documentId: agreement.id, date: '2026-04-10', attested: true })).intake.status, 'engaged');
    const requestData = { provider: 'Sample Medical', kind: 'Records and bills', from: '2026-04-07', to: '2026-04-30', followUp: '2026-05-11' };
    const request = (await apply('request-save', requestData)).requests[0];
    await apply('request-sent', { id: request.id, date: '2026-04-12' });
    assert.ok(queueItems(matter).some(row => row.id === request.id && row.screen === 'records'));
    const records = await call(path + '/documents', { pdf: await file('mixed.pdf'), name: 'Clinical packet.pdf' });
    assert.equal(records.status, 201);
    const clinical = records.data.document;
    matter = records.data.matter;
    assert.equal(matter.events.length, 2);
    await apply('request-receipt', { id: request.id, documentId: clinical.id, date: '2026-04-20', status: 'partial', notes: 'Itemized bill outstanding.' });
    const receipt = await apply('request-receipt', { id: request.id, documentId: agreement.id, date: '2026-04-23', status: 'complete' });
    assert.equal(receipt.requests[0].received.length, 2);
    assert.equal(queueItems(matter).length, 0);
    const rescope = await apply('request-save', { ...requestData, id: request.id, to: '2026-05-08' });
    assert.equal(rescope.requests[0].status, 'partial');
    assert.equal(queueItems(matter)[0].id, request.id);

    for (const event of matter.events) {
      const verified = await call(path + '/events/' + event.id, { body: { action: 'verify' }, revision: matter.revision });
      assert.equal(verified.status, 200);
      matter = verified.data.matter;
    }
    const approved = await call(path + '/approve', { body: { attested: true }, revision: matter.revision });
    assert.equal(approved.status, 200);
    matter = approved.data.matter;
    const chronologyId = approved.data.approval.id;
    assert.equal(approved.data.approval.sources.length, 1);
    await apply('bill-save', { label: 'Synthetic service charge', amount: '200.05', documentId: agreement.id, page: 1 });
    await apply('exhibit-save', { label: 'Selected follow-up', documentId: clinical.id, page: 3 });
    assert.match(demandText(matter), /\$200\.05/);
    assert.equal((await change(matter, 'exhibit-save', { label: 'Invalid', documentId: clinical.id, page: 900 })).status, 422);
    assert.equal((await change(matter, 'exhibit-save', { label: 'Duplicate', documentId: clinical.id, page: 3 })).status, 422);
    await apply('demand-save', { recipient: 'Sample Adjuster', body: 'Reviewed synthetic demand letter with attached exhibit.' });
    assert.equal((await change(matter, 'demand-approve', { billTotal: 999, chronologyId, attested: true })).status, 422);
    const demand = (await apply('demand-approve', { billTotal: 20005, chronologyId, attested: true })).demand.versions[0];
    await apply('demand-save', { recipient: 'Sample Adjuster', body: 'Second, unapproved draft.' });
    assert.equal(practice(matter).demand.versions[0].contents.body, demand.contents.body);
    const demandPacket = await buildPacket('demand', matter, demand, loadOriginal, base);
    const demandZip = await globalThis.JSZip.loadAsync(demandPacket.bytes);
    assert.equal(await demandZip.file('Demand-letter.txt').async('string'), demand.contents.body + '\n');
    const { PDFDocument } = await import('../dist/vendor/packets/pdf-lib.mjs');
    assert.equal((await PDFDocument.load(await demandZip.file('Selected-exhibits.pdf').async('uint8array'))).getPageCount(), 1);
    const manifest = JSON.parse(await demandZip.file('Source-index.json').async('string'));
    assert.equal(manifest.contents.exhibits[0].source.page, 3);
    assert.equal(manifest.contents.exhibits[0].source.sha256, clinical.sha256);
    assert.match(await demandZip.file('Approved-chronology.csv').async('string'), /ELLIS-0003/);
    const revised = await call(path + '/events/' + matter.events[0].id, { body: { action: 'reopen' }, revision: matter.revision });
    matter = revised.data.matter;
    assert.equal((await change(matter, 'demand-approve', { billTotal: 20005, chronologyId, attested: true })).status, 422);

    const deadline = (await apply('task-save', { title: 'Prepare synthetic exhibit', due: '2026-05-12', basis: 'Internal target' })).tasks[0];
    assert.equal((await change(matter, 'task-status', { id: deadline.id, status: 'done' })).status, 422);
    await apply('task-status', { id: deadline.id, status: 'confirmed', attested: true });
    const summary = (await call('/api/matters')).data.find(item => item.id === matter.id);
    assert.deepEqual(summary.queue.map(item => item.due), ['2026-05-11', '2026-05-12']);
    await apply('task-status', { id: deadline.id, status: 'done' });
    assert.match(updateText(matter), /1 outstanding/);
    const update = (await apply('update-save', { recipient: 'synthetic@example.test', subject: 'Matter update', body: 'I am waiting on one bill.' })).updates[0];
    await apply('update-approve', { id: update.id, attested: true });
    await apply('update-sent', { id: update.id, date: '2026-05-13' });
    assert.equal((await change(matter, 'update-save', { ...update, body: 'Attempt to alter delivery history.' })).status, 422);

    await apply('settlement-save', { gross: '1000.10', basis: 'Fictional agreed terms' });
    const feeData = { kind: 'Attorney fee', label: 'Fixture fee', amount: '200.05', status: 'confirmed' };
    const lienData = { kind: 'Medical lien', label: 'Fixture lien', amount: '50.03', status: 'pending', documentId: agreement.id, page: 1 };
    await apply('deduction-save', feeData);
    const lien = (await apply('deduction-save', lienData)).settlement.deductions[1];
    assert.equal((await change(matter, 'settlement-approve', { attested: true })).status, 422);
    await apply('deduction-save', { ...lienData, id: lien.id, status: 'confirmed' });
    const settlement = (await apply('settlement-approve', { attested: true })).settlement.versions[0];
    assert.equal(settlement.contents.totals.net, 75002);
    assert.equal((await change(matter, 'close-matter', { versionId: settlement.id, check0: true })).status, 422);
    const closed = (await apply('close-matter', {
      versionId: settlement.id, check0: true, check1: true, check2: true, releaseId: agreement.id, notes: 'Synthetic closeout',
    })).settlement;
    const closingPacket = await buildPacket('settlement', matter, closed.versions[0], loadOriginal, base, closed.closeout.id);
    const closingZip = await globalThis.JSZip.loadAsync(closingPacket.bytes);
    assert.match(await closingZip.file('Settlement-statement.txt').async('string'), /Net to client: \$750\.02/);
    assert.deepEqual(await closingZip.file('Closing-documents/1-Sample-signed-agreement.pdf').async('nodebuffer'), await file('digital.pdf'));
    assert.equal((await change(matter, 'settlement-save', { gross: '2000.00', basis: 'Try to change closed matter' })).status, 422);
    const reopened = await apply('close-reopen', { reason: 'Check supplemental synthetic documentation.' });
    assert.equal(reopened.settlement.closeout, null);
    assert.equal(reopened.settlement.versions[0].closeouts.length, 1);
  } finally { await stop(server); }
});

test('renders each practice screen for a matter created before the workflow upgrade', () => {
  const state = { matter: { id: 'old', name: 'Old matter', demo: true, revision: 0,
    approvals: [], events: [], documents: [], pageReviews: {} } };
  const blank = () => '';
  const ui = workflowUI({ state, button: label => '<button>' + label + '</button>', pill: blank, attribute: blank,
    escape: value => String(value ?? '').replace(/</g, '&lt;'), field: blank, option: blank,
    icon: blank, render: blank, toast: blank, download: blank });
  for (const [screen, expected] of Object.entries({
    intake: 'Parties and conflict review', records: 'Alder Physical Therapy', demand: 'Approve the current chronology',
    queue: 'Review the treatment record packet', closing: 'Net to client',
  })) assert.ok(ui.render(screen).includes(expected), screen);
  assert.equal(state.matter.practice, undefined);
});
