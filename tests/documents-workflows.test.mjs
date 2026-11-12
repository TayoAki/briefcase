import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { workflows, readDocxZip } from '../server/workflows/documents.mjs';
import { PDFDocument, StandardFonts } from '../dist/vendor/packets/pdf-lib.mjs';
import { indexPdf } from '../server/pdf.mjs';

const defs = Object.fromEntries(workflows.map(row => [row.roleId, row]));
const sha = value => createHash('sha256').update(value).digest('hex');
const hash = value => sha(typeof value === 'string' ? value : JSON.stringify(value));
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const denied = (callback, status = 409) => assert.throws(callback, error => error.status === status);
const deniedAsync = (callback, status = 409) => assert.rejects(callback, error => error.status === status);

async function setup() {
  const sources = new Map();
  for (const [id, count, label] of [['one', 2, 'First source'], ['two', 1, 'Second source'], ['private', 1, 'Privileged attachment']]) {
    const pdf = await PDFDocument.create(); const font = await pdf.embedFont(StandardFonts.Helvetica);
    for (let page = 1; page <= count; page++) pdf.addPage([612, 792]).drawText(`${label}, physical page ${page}`, { x: 60, y: 700, font, size: 14 });
    const bytes = Buffer.from(await pdf.save());
    sources.set(id, { id, name: id + '.pdf', sha256: sha(bytes), bytes, pages: Array.from({ length: count }, (_, index) => ({ number: index + 1, text: `${label}, physical page ${index + 1}` })), purpose: 'supporting' });
  }
  const ctx = { now: '2026-11-12T12:00:00.000Z', matterId: 'matter-a', roleId: '', user: { username: 'staff', firm: 'alpha', role: 'preparer', desk: [] }, isReviewer: false, hash, fail,
    source(id, page) { const source = sources.get(id); if (!source || (page && !source.pages.some(row => row.number === page))) fail(404, 'Original unavailable.'); return source; },
    sourceBinding(id, page) { const source = this.source(id, page); return { documentId: id, sha256: source.sha256, name: source.name, ...(page ? { page } : {}) }; } };
  const reviewer = { ...ctx, isReviewer: true, user: { username: 'lawyer', firm: 'alpha', role: 'lawyer', desk: [] } };
  return { ctx, reviewer, sources };
}
const items = [{ label: 'Exhibit A', documentId: 'one', page: 2 }, { label: 'Exhibit B', documentId: 'two', page: 1 }];
const decodeZip = async bytes => globalThis.JSZip.loadAsync(bytes);

test('R26 builds a real PDF packet whose index resolves each selected original page and hashes', async () => {
  const { ctx, sources } = await setup(); const def = defs.R26; const state = def.create({ title: 'Motion exhibits', exhibits: items }, ctx);
  assert.deepEqual(def.validate(state, ctx).errors, []);
  assert.deepEqual(def.output(state, ctx).pageIndex.map(row => [row.page, row.packetPageStart]), [[2, 2], [1, 3]]);
  const result = await def.exportFile(state, ctx, 'pdf'); const pdf = await PDFDocument.load(result.bytes);
  assert.equal(pdf.getPageCount(), 3);
  const indexed = await indexPdf(result.bytes, 'packet.pdf', { textOnly: true });
  assert.match(indexed.pages[1].text, /First source, physical page 2/);
  assert.match(indexed.pages[2].text, /Second source, physical page 1/);
  const zip = await decodeZip((await def.exportFile(state, ctx, 'zip')).bytes);
  const manifest = JSON.parse(await zip.file('page-index.json').async('string'));
  assert.equal(manifest.pageIndex[0].sha256, sources.get('one').sha256);
  assert.deepEqual(result.bytes, (await def.exportFile(state, ctx, 'pdf')).bytes, 'Approved exports must reproduce');
  sources.set('one', { ...sources.get('one'), sha256: 'tampered' });
  denied(() => def.validate(state, ctx)); await deniedAsync(() => def.exportFile(state, ctx, 'pdf'));
});

test('R26 refuses unavailable source pages and empty submissions', async () => {
  const { ctx } = await setup(); const def = defs.R26;
  denied(() => def.create({ title: 'Packet', exhibits: [{ label: 'Missing', documentId: 'one', page: 9 }] }, ctx), 404);
  assert.ok(def.validate(def.create({ title: 'Packet', exhibits: [] }, ctx), ctx).errors.length);
});

test('Generated PDF fields reject unsupported fonts and overflowing tokens before submission', async () => {
  const { ctx, reviewer } = await setup();
  const invalidTitle = defs.R26.create({ title: 'Evidence ⚖', exhibits: items }, ctx);
  assert.match(defs.R26.validate(invalidTitle, ctx).errors.join(' '), /unsupported/);
  const invalidLabel = defs.R26.create({ title: 'Evidence', exhibits: [{ ...items[0], label: 'Exhibit 漢字' }] }, ctx);
  assert.match(defs.R26.validate(invalidLabel, ctx).errors.join(' '), /unsupported/);
  const wideTitle = defs.R26.create({ title: 'W'.repeat(100), exhibits: items }, ctx);
  assert.match(defs.R26.validate(wideTitle, ctx).errors.join(' '), /line width/);
  const correspondence = defs.R28.create({ subject: 'Update', body: 'Unsupported ⚖', recipient: 'client@example.test', dates: [] }, ctx);
  defs.R28.update(correspondence, 'authorize-delivery', { notes: 'Review notes' }, reviewer);
  assert.match(defs.R28.validate(correspondence, ctx).errors.join(' '), /unsupported/);
  for (const value of ['Unsupported ⚖', 'W'.repeat(150)]) {
    const document = defs.R65.create({ ...draftInput, sections: [{ heading: 'Argument', text: value }] }, ctx);
    assert.match(defs.R65.validate(document, ctx).errors.join(' '), /unsupported|line width/);
  }
});

test('R27 keeps unsigned approvals outstanding and exports only lawyer-reviewed executed originals', async () => {
  const { ctx, reviewer, sources } = await setup(); const def = defs.R27;
  const state = def.create({ title: 'Closing', requirements: [{ id: 'board', label: 'Board consent' }, { id: 'shareholders', label: 'Shareholder consent' }] }, ctx);
  assert.equal(def.output(state, ctx).outstanding.length, 2);
  const execution = { id: 'board', documentId: 'one', signer: 'Synthetic Director', signedAt: '2026-11-11', signaturePage: 2 };
  denied(() => def.update(state, 'record-execution', execution, ctx), 403);
  def.update(state, 'record-execution', execution, reviewer);
  await deniedAsync(() => def.exportFile(state, ctx, 'zip'));
  assert.match(def.validate(state, ctx).errors.join(' '), /Shareholder/);
  def.update(state, 'record-execution', { ...execution, id: 'shareholders', documentId: 'two', signaturePage: 1 }, reviewer);
  assert.equal(def.output(state, ctx).outstanding.length, 0);
  const zip = await decodeZip((await def.exportFile(state, ctx, 'zip')).bytes);
  assert.deepEqual(Buffer.from(await zip.file('executed/board.pdf').async('uint8array')), sources.get('one').bytes);
  assert.equal((await PDFDocument.load((await def.exportFile(state, ctx, 'pdf')).bytes)).getPageCount(), 4);
  def.update(state, 'add-requirement', { id: 'lender', label: 'Lender approval' }, ctx);
  assert.match(def.validate(state, ctx).errors.join(' '), /Lender/);
});

test('R28 binds correspondence/date sources to lawyer-only delivery authorization and invalidates edits', async () => {
  const { ctx, reviewer } = await setup(); const def = defs.R28;
  const input = { subject: 'Hearing notice', body: 'Please attend the hearing.', recipient: 'client@example.test', dates: [{ label: 'Hearing', date: '2026-12-20', documentId: 'one', page: 1 }] };
  const state = def.create(input, ctx);
  denied(() => def.update(state, 'record-delivery', { reference: 'email-1' }, ctx));
  denied(() => def.update(state, 'authorize-delivery', { notes: 'Approved' }, ctx), 403);
  def.update(state, 'authorize-delivery', { notes: 'Checked recipient and source date.' }, reviewer);
  def.update(state, 'record-delivery', { reference: 'email-1' }, ctx);
  assert.equal(def.output(state).deliveries[0].sha256, hash(state.draft));
  const eml = (await def.exportFile(state, ctx, 'eml')).bytes.toString(); assert.match(eml, /To: client@example.test/); assert.match(eml, /Content-Transfer-Encoding: base64/);
  def.update(state, 'revise-draft', { ...input, recipient: 'changed@example.test' }, ctx);
  assert.equal(state.authorization, null);
  await deniedAsync(() => def.exportFile(state, ctx, 'eml'));
  denied(() => def.create({ ...input, recipient: 'client@example.test\r\nBcc: attacker@example.test' }, ctx), 422);
});

test('R30 preserves both exact filing attempts, deduplicates retries, and blocks service on rejected or changed packets', async () => {
  const { ctx, reviewer, sources } = await setup(); const def = defs.R30;
  const state = def.create({ title: 'Motion', documents: [{ label: 'Motion', documentId: 'one' }] }, ctx);
  const rejected = { requestId: 'first', outcome: 'rejected', receipt: 'court-receipt-1', reason: 'Missing cover sheet.' };
  denied(() => def.update(state, 'record-attempt', rejected, ctx));
  def.update(state, 'authorize-filing', { notes: 'Reviewed PDF.' }, reviewer);
  def.update(state, 'record-attempt', rejected, ctx); def.update(state, 'record-attempt', rejected, ctx);
  assert.equal(state.attempts.length, 1);
  denied(() => def.update(state, 'record-attempt', { ...rejected, reason: 'Different data' }, ctx));
  denied(() => def.update(state, 'record-service', { receipt: 'service-1', recipient: 'Opponent' }, ctx));
  def.update(state, 'revise-packet', { title: 'Corrected motion', documents: [{ label: 'Corrected motion', documentId: 'two' }] }, ctx);
  denied(() => def.update(state, 'record-attempt', { ...rejected, requestId: 'second', outcome: 'accepted' }, ctx));
  def.update(state, 'authorize-filing', { notes: 'Reviewed correction.' }, reviewer);
  def.update(state, 'record-attempt', { requestId: 'second', outcome: 'accepted', receipt: 'court-receipt-2', reason: 'Accepted by clerk.' }, ctx);
  def.update(state, 'record-service', { receipt: 'service-1', recipient: 'Opponent' }, ctx);
  assert.equal(def.validate(state, ctx).errors.length, 0);
  const zip = await decodeZip((await def.exportFile(state, ctx, 'zip')).bytes);
  assert.deepEqual(Buffer.from(await zip.file('attempt-1/1-Motion.pdf').async('uint8array')), sources.get('one').bytes);
  assert.deepEqual(Buffer.from(await zip.file('attempt-2/1-Corrected-motion.pdf').async('uint8array')), sources.get('two').bytes);
  assert.equal(state.services[0].attemptId, 'second');
  const approved = structuredClone(state);
  def.assertExport(state, approved, ctx);
  def.update(state, 'record-attempt', { requestId: 'third', outcome: 'rejected', receipt: 'court-receipt-3', reason: 'Acceptance withdrawn by clerk.' }, ctx);
  denied(() => def.assertExport(state, approved, ctx));
  def.update(state, 'revise-packet', { title: 'Third version', documents: [{ label: 'Motion', documentId: 'one' }] }, ctx);
  denied(() => def.update(state, 'record-service', { receipt: 'service-2', recipient: 'Opponent' }, ctx));
  denied(() => def.assertExport(state, approved, ctx));
});

test('R31 deduplicates by original hash, preserves provenance/review history, and omits privileged files from production', async () => {
  const { ctx, reviewer, sources } = await setup(); const def = defs.R31; const state = def.create({ productionName: 'First production' }, ctx);
  const importOne = { documentId: 'one', label: 'Email', reference: 'Custodian A / first import' };
  def.update(state, 'import-record', importOne, ctx); def.update(state, 'import-record', importOne, ctx);
  def.update(state, 'import-record', { ...importOne, reference: 'Custodian B / second import' }, ctx);
  def.update(state, 'import-record', { documentId: 'private', label: 'Privileged strategy', reference: 'Custodian A / privileged attachment' }, ctx);
  assert.equal(state.evidence.length, 2); assert.equal(state.evidence[0].provenance.length, 2);
  assert.ok(def.validate(state, ctx).errors.length);
  denied(() => def.update(state, 'review-record', { documentId: 'one', disposition: 'release', reason: 'Reviewed' }, ctx), 403);
  def.update(state, 'review-record', { documentId: 'one', disposition: 'release', reason: 'Responsive non-privileged record.' }, reviewer);
  def.update(state, 'review-record', { documentId: 'private', disposition: 'privileged', reason: 'Attorney-client advice.' }, reviewer);
  assert.equal(def.validate(state, ctx).errors.length, 0);
  const approved = structuredClone(state);
  const zip = await decodeZip((await def.exportFile(state, ctx, 'zip')).bytes);
  const names = Object.keys(zip.files); assert.deepEqual(names.sort(), ['PROD-000001.pdf', 'production-manifest.json']);
  assert.deepEqual(Buffer.from(await zip.file('PROD-000001.pdf').async('uint8array')), sources.get('one').bytes);
  assert.doesNotMatch(await zip.file('production-manifest.json').async('string'), /Privileged strategy|private|Attorney-client/);
  assert.equal(def.output(state).reviewHistory[1].history.length, 1);
  def.update(state, 'review-record', { documentId: 'one', disposition: 'privileged', reason: 'New privilege finding.' }, reviewer);
  denied(() => def.assertExport(state, approved, ctx));
  assert.equal(state.evidence[0].reviewHistory.length, 2);
});

// Real 1-second 160x90 VP8 WebM generated with ffmpeg from a synthetic blue frame.
const video = 'GkXfo59ChoEBQveBAULygQRC84EIQoKEd2VibUKHgQJChYECGFOAZwEAAAAAAASIEU2bdLpNu4tTq4QVSalmU6yBoU27i1OrhBZUrmtTrIHWTbuMU6uEElTDZ1OsggEjTbuMU6uEHFO7a1OsggRy7AEAAAAAAABZAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAVSalmsCrXsYMPQkBNgIxMYXZmNjEuNy4xMDNXQYxMYXZmNjEuNy4xMDNEiYhAj0AAAAAAABZUrmvIrgEAAAAAAAA/14EBc8WIH6QTdz2X40CcgQAitZyDdW5kiIEAhoVWX1ZQOIOBASPjg4QCYloA4JCwgaC6gVqagQJVsIRVuYEBElTDZ/tzc59jwIBnyJlFo4dFTkNPREVSRIeMTGF2ZjYxLjcuMTAzc3PWY8CLY8WIH6QTdz2X40BnyKFFo4dFTkNPREVSRIeUTGF2YzYxLjE5LjEwMSBsaWJ2cHhnyKFFo4hEVVJBVElPTkSHkzAwOjAwOjAxLjAwMDAwMDAwMAAfQ7Z1QsnngQCj1oEAAIDwBQCdASqgAFoAAEcIhYWIhYSIAgICdaoD+AIGmhPghqqTXcQ6qk13EOqpNdxDqqTXcQ6qk13EGAD+/00S//xYV/FhX8WFf/FhX/z8zu3F/OYAo5iBACgAEQIAARAQABgAGFgv9AAIgIEAAACjmIEAUAARAgABEBAAGAAYWC/0AAiAgQAAAKOYgQB4ABECAAEQEAAYABhYL/QACICBAAAAo5iBAKAAEQIAARAQABgAGFgv9AAIgIEAAACjmIEAyAARAgABEBAAGAAYWC/0AAiAgQAAAKOYgQDwABECAAEQEAAYABhYL/QACICBAAAAo5eBARgA8QEAARAQFGAAYWC/0AAiAgQAAKOYgQFAABECAAEQEAAYABhYL/QACICBAAAAo5iBAWgAEQIAARAQABgAGFgv9AAIgIEAAACjmIEBkAARAgABEBAAGAAYWC/0AAiAgQAAAKOYgQG4ABECAAEQEAAYABhYL/QACICBAAAAo5iBAeAAEQIAARAQABgAGFgv9AAIgIEAAACjmIECCAARAgABEBAAGAAYWC/0AAiAgQAAAKOYgQIwABECAAEQEAAYABhYL/QACICBAAAAo5iBAlgAEQIAARAQABgAGFgv9AAIgIEAAACjmIECgAARAgABEBAAGAAYWC/0AAiAgQAAAKOYgQKoABECAAEQEAAYABhYL/QACICBAAAAo5eBAtAA8QEAARAQFGAAYWC/0AAiAgQAAKOYgQL4ABECAAEQEAAYABhYL/QACICBAAAAo5iBAyAAEQIAARAQABgAGFgv9AAIgIEAAACjmIEDSAARAgABEBAAGAAYWC/0AAiAgQAAAKOYgQNwABECAAEQEAAYABhYL/QACICBAAAAo5iBA5gAEQIAARAQABgAGFgv9AAIgIEAAACjmIEDwAARAgABEBAAGAAYWC/0AAiAgQAAABxTu2uRu4+zgQC3iveBAfGCAaPwgQM=';

test('R32 offline package retains exact reviewed clip bytes and only selected exhibit pages', async () => {
  const { ctx, reviewer, sources } = await setup(); const def = defs.R32;
  const state = def.create({ title: 'Trial rehearsal', exhibits: items }, ctx);
  def.update(state, 'add-clip', { id: 'witness', label: 'Approved witness segment', mediaBase64: video, start: 0.1, end: 0.8 }, ctx);
  assert.match(def.validate(state, ctx).errors.join(), /approval/);
  denied(() => def.update(state, 'approve-clip', { id: 'witness', notes: 'Reviewed' }, ctx), 403);
  def.update(state, 'approve-clip', { id: 'witness', notes: 'Checked the exact segment.' }, reviewer);
  const zip = await decodeZip((await def.exportFile(state, ctx, 'zip')).bytes);
  assert.deepEqual(Buffer.from(await zip.file('clip-witness.webm').async('uint8array')), Buffer.from(video, 'base64'));
  assert.equal((await PDFDocument.load(await zip.file('exhibit-1.pdf').async('uint8array'))).getPageCount(), 1);
  const manifest = JSON.parse(await zip.file('manifest.json').async('string'));
  assert.equal(manifest.exhibits[0].sha256, sources.get('one').sha256); assert.equal(manifest.exhibits[0].page, 2);
  assert.equal(manifest.clips[0].sha256, sha(Buffer.from(video, 'base64')));
  const html = await zip.file('index.html').async('string'); assert.match(html, /video controls/); assert.match(html, /data-start="0.1" data-end="0.8"/); assert.match(html, /timeupdate/); assert.doesNotMatch(html, /https?:\/\//);
  def.update(state, 'add-clip', { id: 'witness', label: 'Changed segment', mediaBase64: video, start: 0.2, end: 0.9 }, ctx);
  assert.match(def.validate(state, ctx).errors.join(), /approval/);
  denied(() => def.update(state, 'add-clip', { id: 'bad', label: 'Bad file', mediaBase64: Buffer.from('bad data').toString('base64'), start: 0, end: 1 }, ctx), 422);
});

const draftInput = { title: 'Synthetic Motion', sections: [{ heading: 'Introduction', text: 'The requested relief is supported by the record.' }, { heading: 'Argument', text: 'Original argument paragraph.' }], authorities: [{ citation: 'Synthetic Authority 123', documentId: 'one', page: 1 }], exhibits: items };

test('R65 produces reproducible DOCX/PDF with numbering and source indexes and round-trips actual Word XML edits', async () => {
  const { ctx } = await setup(); const def = defs.R65; const state = def.create(draftInput, ctx);
  const word = await def.exportFile(state, ctx, 'docx'); const pdf = await def.exportFile(state, ctx, 'pdf');
  const entries = readDocxZip(word.bytes); const document = entries.get('word/document.xml').toString();
  assert.match(document, /1\. Introduction/); assert.match(document, /2\. Argument/); assert.match(document, /Table of Authorities/); assert.match(document, /Exhibit Index/); assert.match(document, /w:w="12240" w:h="15840"/);
  assert.equal((await PDFDocument.load(pdf.bytes)).getPageCount(), 1);
  const rendered = (await indexPdf(pdf.bytes, 'produced.pdf', { textOnly: true })).pages.map(page => page.text).join('\n');
  for (const expected of ['1. Introduction', '2. Argument', 'Table of Authorities', 'Synthetic Authority 123', 'Exhibit Index', 'Exhibit A']) assert.ok(rendered.includes(expected), 'PDF preserves ' + expected);
  assert.deepEqual(word.bytes, (await def.exportFile(state, ctx, 'docx')).bytes);
  assert.deepEqual(pdf.bytes, (await def.exportFile(state, ctx, 'pdf')).bytes);
  def.update(state, 'import-docx', { docxBase64: word.bytes.toString('base64') }, ctx);
  assert.deepEqual(state.comparisons.at(-1).changes, []);
  const edited = await decodeZip(word.bytes); edited.file('word/document.xml', document.replace('Original argument paragraph.', 'Revised argument with a source-backed conclusion.'));
  const changedBytes = Buffer.from(await edited.generateAsync({ type: 'uint8array', compression: 'DEFLATE' }));
  def.update(state, 'import-docx', { docxBase64: changedBytes.toString('base64') }, ctx);
  assert.equal(state.draft.sections[1].text, 'Revised argument with a source-backed conclusion.');
  assert.equal(state.comparisons.at(-1).changes.length, 1);
  assert.equal(state.comparisons.at(-1).importedDocxSha256, sha(changedBytes));
  assert.equal(def.output(state, ctx).authorityTable[0].source.documentId, 'one');
  assert.equal(def.output(state, ctx).numberedSections[1].number, 2);
  const packageZip = await decodeZip((await def.exportFile(state, ctx, 'zip')).bytes);
  assert.ok(packageZip.file('document.docx')); assert.ok(packageZip.file('document.pdf')); assert.ok(packageZip.file('comparison-and-sources.json'));
});

test('R65 rejects source-index changes, unsupported layouts, invalid ZIPs and changed original hashes', async () => {
  const { ctx, sources } = await setup(); const def = defs.R65; const state = def.create(draftInput, ctx);
  const word = await def.exportFile(state, ctx, 'docx');
  for (const mutate of [document => document.replace('Synthetic Authority 123', 'Unverified replacement'), document => document.replace('w:top="1440"', 'w:top="200"'), document => document.replace('<w:body>', '<w:body><w:tbl/>')]) {
    const zip = await decodeZip(word.bytes); const document = await zip.file('word/document.xml').async('string'); zip.file('word/document.xml', mutate(document));
    const changed = Buffer.from(await zip.generateAsync({ type: 'uint8array' }));
    denied(() => def.update(state, 'import-docx', { docxBase64: changed.toString('base64') }, ctx), 422);
  }
  denied(() => def.update(state, 'import-docx', { docxBase64: Buffer.from('not a zip').toString('base64') }, ctx), 422);
  sources.set('one', { ...sources.get('one'), sha256: 'changed' });
  denied(() => def.validate(state, ctx));
});

test('R26/R27/R28/R30/R31/R32/R65 run through authenticated assignments, lawyer approval, exports and revocation', async t => {
  const { buildApp } = await import('../server/app.mjs');
  const users = [
    { username: 'owner', password: 'synthetic-owner-pass', firm: 'alpha', role: 'lawyer' },
    { username: 'staff', password: 'synthetic-staff-pass', firm: 'alpha', role: 'preparer', desk: ['R26', 'R27', 'R28', 'R30', 'R31', 'R32', 'R65'] },
    { username: 'foreign', password: 'synthetic-foreign-pass', firm: 'beta', role: 'lawyer' },
  ];
  const server = buildApp({ database: ':memory:', users });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const root = 'http://127.0.0.1:' + server.address().port;
  async function request(username, path, body, expected = 200, moreHeaders = {}) {
    const binary = Buffer.isBuffer(body);
    const headers = { Authorization: 'Basic ' + Buffer.from(`${username}:synthetic-${username}-pass`).toString('base64'), ...moreHeaders };
    if (body) Object.assign(headers, { 'Content-Type': binary ? 'application/pdf' : 'application/json', 'X-Briefcase-Request': '1' });
    const result = await fetch(root + path, { method: body ? 'POST' : 'GET', headers, body: body && (binary ? body : JSON.stringify(body)) });
    const data = result.headers.get('content-type')?.includes('application/json') ? await result.json() : Buffer.from(await result.arrayBuffer());
    assert.equal(result.status, expected, data.error ?? `${path}: expected ${expected}, got ${result.status}`); return data;
  }
  const matter = await request('owner', '/api/matters', { name: 'Synthetic specialist document matter' }, 201);
  const first = (await request('owner', `/api/matters/${matter.id}/documents`, await readFile(new URL('./fixtures/mixed.pdf', import.meta.url)), 201, { 'X-PDF-Name': 'Reviewed source.pdf', 'X-PDF-Purpose': 'supporting' })).document;
  const second = (await request('owner', `/api/matters/${matter.id}/documents`, await readFile(new URL('./fixtures/digital.pdf', import.meta.url)), 201, { 'X-PDF-Name': 'Executed original.pdf', 'X-PDF-Purpose': 'supporting' })).document;
  await request('owner', `/api/matters/${matter.id}/team`, { action: 'grant', username: 'staff', access: 'prepare' });
  const sourceItems = [{ label: 'Exhibit A', documentId: first.id, page: 1 }];
  const inputs = {
    R26: { title: 'Motion exhibits', exhibits: sourceItems },
    R27: { title: 'Closing binder', requirements: [{ id: 'consent', label: 'Consent' }] },
    R28: { subject: 'Client update', recipient: 'client@example.test', body: 'A reviewed client update.', dates: [{ label: 'Review', date: '2026-12-12', documentId: first.id, page: 1 }] },
    R30: { title: 'Motion filing', documents: [{ label: 'Motion', documentId: first.id }] },
    R31: { productionName: 'Release 1' },
    R32: { title: 'Trial package', exhibits: sourceItems },
    R65: { title: 'Motion', sections: [{ heading: 'Argument', text: 'A source-supported argument.' }], authorities: [{ citation: 'Synthetic authority', documentId: first.id, page: 1 }], exhibits: sourceItems },
  };
  const records = new Map();
  for (const [roleId, data] of Object.entries(inputs)) {
    let item = (await request('owner', '/api/workbench', { requestId: randomUUID(), roleId, title: roleId + ' acceptance', assignee: 'staff', reviewer: 'owner', matter: matter.id, data }, 201)).item;
    const path = '/api/workbench/' + item.id;
    const action = async (actor, name, data) => { item = (await request(actor, path, { revision: item.revision, action: name, data })).item; };
    if (roleId === 'R27') await action('owner', 'record-execution', { id: 'consent', documentId: second.id, signaturePage: 1, signer: 'Synthetic client', signedAt: '2026-11-11' });
    if (roleId === 'R28') await action('owner', 'authorize-delivery', { notes: 'Reviewed exact draft and source date.' });
    if (roleId === 'R30') {
      await action('owner', 'authorize-filing', { notes: 'Reviewed exact filing PDFs.' });
      await action('staff', 'record-attempt', { requestId: 'first', outcome: 'rejected', receipt: 'reject-1', reason: 'Correction requested.' });
      await request('staff', path, { revision: item.revision, action: 'record-service', data: { receipt: 'invalid', recipient: 'Opponent' } }, 409);
      await action('staff', 'revise-packet', { title: 'Corrected motion', documents: [{ label: 'Corrected motion', documentId: second.id }] });
      await action('owner', 'authorize-filing', { notes: 'Reviewed corrected filing PDF.' });
      await action('staff', 'record-attempt', { requestId: 'second', outcome: 'accepted', receipt: 'accept-1', reason: 'Clerk accepted.' });
    }
    if (roleId === 'R31') {
      await action('staff', 'import-record', { documentId: first.id, reference: 'Custodian export 1', label: 'Public evidence' });
      await action('staff', 'import-record', { documentId: second.id, reference: 'Custodian export 2', label: 'Private attachment' });
      await action('owner', 'review-record', { documentId: first.id, disposition: 'release', reason: 'Responsive non-privileged material.' });
      await action('owner', 'review-record', { documentId: second.id, disposition: 'privileged', reason: 'Attorney-client advice.' });
    }
    if (roleId === 'R32') {
      await action('staff', 'add-clip', { id: 'clip', label: 'Witness clip', mediaBase64: video, start: 0.1, end: 0.8 });
      await action('owner', 'approve-clip', { id: 'clip', notes: 'Reviewed exact bytes and segment.' });
    }
    item = (await request('staff', path, { revision: item.revision, action: 'submit' })).item;
    const approval = { revision: item.revision, action: 'approve', sha256: item.submission.sha256, notes: 'Reviewed the output against original sources.', attested: true };
    await request('staff', path, approval, 403);
    item = (await request('owner', path, approval)).item;
    const proof = await request('staff', path + '/export'); assert.equal(proof.version.sha256, item.submission.sha256);
    await request('foreign', path + '/export', undefined, 404);
    for (const format of defs[roleId].formats) {
      const artifact = await request('staff', path + '/export?format=' + format);
      assert.ok(artifact.length > 100, roleId + ' ' + format + ' creates an actual artifact');
    }
    records.set(roleId, item);
  }
  const packet = records.get('R26');
  await request('staff', '/api/workbench/' + packet.id, { revision: packet.revision, action: 'replace-exhibits', data: { exhibits: [{ label: 'Changed Exhibit', documentId: second.id, page: 1 }] } });
  await request('staff', '/api/workbench/' + packet.id + '/export?format=pdf', undefined, 409);
  await request('staff', '/api/workbench/' + packet.id + '/export?format=pdf&version=1');
  const production = records.get('R31');
  await request('owner', '/api/workbench/' + production.id, { revision: production.revision, action: 'review-record', data: { documentId: first.id, disposition: 'privileged', reason: 'Privilege reclassification.' } });
  await request('staff', '/api/workbench/' + production.id + '/export?format=zip&version=1', undefined, 409);
  const filing = records.get('R30');
  await request('staff', '/api/workbench/' + filing.id, { revision: filing.revision, action: 'record-attempt', data: { requestId: 'third', outcome: 'rejected', receipt: 'rejection-after-acceptance', reason: 'Clerk withdrew acceptance.' } });
  await request('staff', '/api/workbench/' + filing.id + '/export?format=zip&version=1', undefined, 409);
  await request('owner', `/api/matters/${matter.id}/team`, { action: 'revoke', username: 'staff' });
  for (const item of records.values()) await request('staff', '/api/workbench/' + item.id + '/export?version=1', undefined, 404);
});
