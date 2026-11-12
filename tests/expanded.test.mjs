import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { createMatter } from '../dist/model.mjs';
import { officeSections } from '../dist/office-schema.mjs';
import { dueCandidate, financialSummary, office, officeRows } from '../dist/office.mjs';
import { officeUI } from '../dist/office-ui.mjs';
import { buildOfficePacket, buildPacket } from '../dist/packets.mjs';
import { changePractice, conflictMatches, practice, queueItems } from '../dist/practice.mjs';
import { calendarText, encryptedArchive, verifyArchive } from '../dist/recovery.mjs';
import { redactionBox } from '../dist/tools-ui.mjs';
import { buildApp } from '../server/app.mjs';
import { copyDatabase, copyTenantDatabase, verifyDatabase } from '../server/maintenance.mjs';

const users = [
  { username: 'tester', password: 'fixture-lawyer-test', firm: 'fixture-a', name: 'Synthetic lawyer' },
  { username: 'another', password: 'fixture-other-test', firm: 'fixture-b' },
];
const fixture = name => readFile(new URL('./fixtures/' + name, import.meta.url));

async function setup(t, options = {}) {
  const server = buildApp({ database: ':memory:', users, ...options });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = 'http://127.0.0.1:' + server.address().port;
  const call = async (path, { body, revision, pdf, purpose, name = 'Synthetic.pdf', user = 0 } = {}) => {
    const account = users[user];
    const headers = { Authorization: 'Basic ' + Buffer.from(account.username + ':' + account.password).toString('base64') };
    if (body || pdf) headers['X-Briefcase-Request'] = '1';
    if (body) headers['Content-Type'] = 'application/json';
    if (pdf) Object.assign(headers, { 'Content-Type': 'application/pdf', 'X-PDF-Name': encodeURIComponent(name) });
    if (purpose) headers['X-PDF-Purpose'] = purpose;
    if (revision !== undefined) headers['If-Match'] = String(revision);
    const response = await fetch(base + path, { method: body || pdf ? 'POST' : 'GET', headers, body: pdf ?? (body && JSON.stringify(body)) });
    const data = response.headers.get('Content-Type')?.includes('application/json') ? await response.json() : Buffer.from(await response.arrayBuffer());
    return { status: response.status, data };
  };
  return { base, call };
}

function driver(call, initial) {
  const path = '/api/matters/' + initial.id;
  let matter = initial;
  return {
    path, get matter() { return matter; }, set matter(value) { matter = value; },
    async action(action, fields = {}, expected = 200) {
      const result = await call(path + '/practice', { body: { action, ...fields }, revision: practice(matter).revision });
      assert.equal(result.status, expected, result.data.error);
      if (expected === 200) matter = result.data.matter;
      return result.data;
    },
    async save(type, title, status, fields, prior, expected = 200, extra = {}) {
      await this.action('office-save', { type, title, status, fields, id: prior?.id, versionId: prior?.versionId,
        attested: true, ...extra }, expected);
      return officeRows(matter, type).find(row => prior ? row.id === prior.id : row.title === title);
    },
    async upload(pdf, purpose) {
      const uploaded = await call(path + '/documents', { pdf, purpose });
      assert.equal(uploaded.status, 201, uploaded.data.error);
      matter = uploaded.data.matter;
      return uploaded.data.document;
    },
    async original(_matter, doc) { return (await call(path + '/documents/' + doc.id + '/original')).data; },
  };
}

test('approved demand, delivery, revised offers, exact authority and settlement funds form one scoped lifecycle', async t => {
  const { base, call } = await setup(t);
  await call('/api/matters');
  const d = driver(call, (await call('/api/matters/ellis-sample')).data);
  const original = d.matter.documents[0];
  const source = { documentId: original.id, page: '2' };
  for (const event of d.matter.events.filter(row => row.status !== 'verified')) {
    const r = await call(d.path + '/events/' + event.id, { body: { action: 'verify' }, revision: d.matter.revision });
    d.matter = r.data.matter;
  }
  const approval = await call(d.path + '/approve', { body: { attested: true }, revision: d.matter.revision });
  d.matter = approval.data.matter;
  await d.action('exhibit-save', { label: 'Selected page', ...source });
  await d.action('demand-save', { recipient: 'Synthetic carrier', body: 'Reviewed synthetic demand.' });
  await d.action('demand-approve', { chronologyId: approval.data.approval.id, billTotal: 0, attested: true });
  const demand = practice(d.matter).demand.versions[0];
  const recipient = await buildPacket('demand-recipient', d.matter, demand, d.original, base);
  const zip = await globalThis.JSZip.loadAsync(recipient.bytes);
  assert.deepEqual(Object.keys(zip.files), ['Demand-letter.txt', 'Selected-exhibits.pdf']);
  const attempt = { demand: demand.id, recipient: 'Synthetic carrier', channel: 'Email', date: '2024-06-01', followUp: '2024-06-17' };
  const sent = await d.save('delivery', 'Demand send', 'Sent', attempt);
  await d.save('delivery', 'Demand send', 'Sent', attempt);
  assert.equal(officeRows(d.matter, 'delivery').length, 1);
  await d.save('delivery', 'Demand send', 'Confirmed', { ...attempt, recipient: 'Wrong recipient', details: 'Acknowledged' }, sent, 422);
  await d.save('delivery', 'Demand send', 'Confirmed', { ...attempt, details: 'Acknowledged' }, sent);
  const terms = { payer: 'Synthetic carrier', direction: 'Incoming offer', amount: '1000.10',
    received: '2024-06-02T12:00:00Z', expires: '2024-07-02T12:00:00Z', terms: 'Single cleared payment', source };
  await d.save('offer', 'Earlier offer', 'Open', { ...terms, amount: '750.00' });
  let offer = await d.save('offer', 'Second offer', 'Open', terms);
  const instruction = { offer: offer.id, person: 'Morgan Ellis', capacity: 'Client', decision: 'Accept exact terms',
    recorded: '2024-06-03T12:00:00Z', advice: 'Reviewed the synthetic offer and its estimated net.', conditions: 'Written release', source };
  const older = await d.save('authority', 'Original instruction', 'Recorded', instruction);
  offer = await d.save('offer', 'Second offer', 'Open', { ...terms, terms: 'Updated payment terms' }, offer);
  const accept = { id: offer.id, versionId: offer.versionId, authorityId: older.id, authorityVersion: older.versionId,
    acceptedAt: '2024-06-04T12:00:00Z', attested: true, conditionsMet: true };
  await d.action('office-accept', accept, 422);
  await d.save('authority', 'Original instruction', 'Revoked', {}, older, 200, { reason: 'Terms changed' });
  const authority = await d.save('authority', 'Current instruction', 'Recorded', instruction);
  Object.assign(accept, { authorityId: authority.id, authorityVersion: authority.versionId });
  await d.action('office-accept', { ...accept, conditionsMet: false }, 422);
  await d.action('office-accept', { ...accept, acceptedAt: '2024-07-03T12:00:00Z' }, 422);
  await d.action('office-accept', accept);
  await d.action('office-accept', accept);
  assert.equal(practice(d.matter).settlement.gross, 100010);
  assert.equal(practice(d.matter).settlement.negotiated.offerVersionId, offer.versionId);
  assert.equal(practice(d.matter).settlement.negotiated.authorityVersionId, authority.versionId);
  assert.equal(officeRows(d.matter, 'offer').filter(row => row.status === 'Accepted').length, 1);
  assert.equal((await call(d.path, { user: 1 })).status, 404);
  await d.action('settlement-save', { gross: '1000.11', basis: 'Changed' }, 422);
  const reviewedOffer = officeRows(d.matter, 'offer').find(row => row.id === offer.id);
  let agreement = await d.save('agreement', 'Release', 'Draft', { offer: reviewedOffer.id, amount: '1000.10', signers: 'Synthetic parties', terms: 'Single payment', source });
  agreement = await d.save('agreement', 'Release', 'Reviewed', { offer: reviewedOffer.id, amount: '1000.10', signers: 'Synthetic parties', terms: 'Single payment', source }, agreement);
  agreement = await d.save('agreement', 'Release', 'Executed', { offer: reviewedOffer.id, amount: '1000.10', signers: 'Synthetic parties', terms: 'Single payment', source, executed: '2024-06-06' }, agreement);
  const expectedPayment = { agreement: agreement.id, party: 'Synthetic carrier', kind: 'Payment', amount: '1000.10', due: '2024-06-17', details: 'Cleared deposit' };
  const obligation = await d.save('obligation', 'Payment due', 'Open', expectedPayment);
  await d.save('obligation', 'Payment due', 'Complete', expectedPayment, obligation, 422);
  const ledger = { payer: 'Synthetic carrier', externalId: 'ENTRY-1', date: '2024-06-10', amount: '1000.10', obligation: obligation.id };
  const pending = await d.save('receipt', 'Receipt', 'Pending', ledger);
  await d.save('receipt', 'Duplicate receipt', 'Pending', ledger, null, 422);
  await d.save('receipt', 'Receipt', 'Cleared', ledger, pending);
  await d.save('obligation', 'Payment due', 'Complete', expectedPayment, obligation);
  await d.action('settlement-approve', { attested: true });
  const statement = practice(d.matter).settlement.versions[0];
  const allocation = { settlement: statement.id, payee: 'Morgan Ellis', kind: 'Client net', amount: '1000.10', basis: 'Synthetic payee confirmed' };
  let payee = await d.save('allocation', 'Client allocation', 'Draft', allocation);
  payee = await d.save('allocation', 'Client allocation', 'Approved', allocation, payee);
  const tx = { allocation: payee.id, externalId: 'ENTRY-2', date: '2024-06-11', amount: '1000.10' };
  const disbursed = await d.save('disbursement', 'External payment', 'Cleared', tx);
  assert.equal(financialSummary(office(d.matter)).balance, 0);
  await d.save('reconciliation', 'Mismatch', 'Reviewed', { date: '2024-06-11', balance: '2', reference: 'S-1', details: 'Synthetic' }, null, 422);
  await d.save('reconciliation', 'Month end', 'Reviewed', { date: '2024-06-11', balance: '0', reference: 'S-1', details: 'Synthetic' });
  await d.save('disbursement', 'External payment', 'Returned', tx, disbursed);
  assert.equal(financialSummary(office(d.matter)).balance, 100010);
});

test('court dates require reviewed sources and production excludes unreviewed evidence', async t => {
  const { base, call } = await setup(t);
  const created = await call('/api/matters', { body: { name: 'Synthetic court case' } });
  const d = driver(call, created.data);
  const doc = await d.upload(await fixture('digital.pdf'), 'supporting');
  const source = { documentId: doc.id, page: '1' };
  const c = await d.save('courtcase', 'Sample case', 'Preparing', { forum: 'Sample district', opened: '2026-11-12', issues: 'Synthetic dispute' });
  const pleadingFields = { case: c.id, kind: 'Complaint', source, issues: 'Synthetic pleading reviewed' };
  const pleading = await d.save('pleading', 'Complaint', 'Approved', pleadingFields);
  const filingFields = { draft: pleading.id, date: '2026-11-12', details: 'Filing review' };
  let filing = await d.save('filing', 'File complaint', 'Ready', filingFields);
  filing = await d.save('filing', 'File complaint', 'Submitted', filingFields, filing);
  await d.save('pleading', 'Complaint', 'Superseded', pleadingFields, pleading);
  filing = await d.save('filing', 'File complaint', 'Accepted', { ...filingFields, receipt: 'COURT-1' }, filing);
  assert.equal(filing.fields.draft.versionId, pleading.versionId);
  const filingZip = await buildOfficePacket(d.matter, filing, d.original, base);
  assert.deepEqual(await (await globalThis.JSZip.loadAsync(filingZip.bytes)).file('Reviewed-filing.pdf').async('nodebuffer'), await fixture('digital.pdf'));
  const notice = await d.save('notice', 'Scheduling order', 'Reviewed', { case: c.id, received: '2026-11-13', trigger: '2026-11-13', source, details: 'Synthetic date' });
  const ruleFields = { forum: 'Sample district', citation: 'https://www.uscourts.gov/forms-rules/current-rules-practice-procedure',
    version: 'Synthetic', method: 'Business days', offset: '2', roll: 'Move to next working day', holidays: '2026-11-16',
    exceptions: 'Synthetic test, order overrides checked' };
  const rule = await d.save('rule', 'Reviewed test rule', 'Reviewed', ruleFields);
  const date = await d.save('deadline', 'Response', 'Proposed', { notice: notice.id, rule: rule.id, basis: 'Synthetic calculation' });
  assert.equal(date.fields.candidate, '2026-11-18');
  assert.doesNotMatch(calendarText(d.matter), /DTSTART/);
  await d.save('deadline', 'Response', 'Confirmed', { notice: notice.id, rule: rule.id, confirmed: '2026-11-18', basis: 'Lawyer reviewed' }, date);
  assert.match(calendarText(d.matter), /DTSTART;VALUE=DATE:20261118/);
  await d.save('rule', 'Reviewed test rule', 'Reviewed', { ...ruleFields, offset: '3' }, rule);
  assert.ok(!queueItems(d.matter).some(item => item.id === date.id));
  assert.doesNotMatch(calendarText(d.matter), /DTSTART/);
  assert.equal(dueCandidate('2026-02-30', ruleFields), null);
  const query = await d.save('discovery', 'Request one', 'Draft', { case: c.id, direction: 'Incoming', party: 'Synthetic party', details: 'Produce one approved item' });
  const evidence = { kind: 'Incident report', custodian: 'Synthetic custodian', collected: '2026-11-12', source, provenance: 'Intake PDF' };
  let exhibit = await d.save('evidence', 'First exhibit', 'Received', evidence);
  const production = { request: query.id, exhibits: [exhibit.id], range: 'S-0001', exclusions: 'Review synthetic privilege and excluded pages' };
  await d.save('production', 'Production one', 'Reviewed', production, null, 422);
  exhibit = await d.save('evidence', 'First exhibit', 'Reviewed', evidence, exhibit);
  const reviewed = await d.save('production', 'Production one', 'Reviewed', production);
  const result = await buildOfficePacket(d.matter, reviewed, d.original, base);
  const zip = await globalThis.JSZip.loadAsync(result.bytes);
  assert.ok(zip.file('Selected-exhibits.pdf'));
  assert.equal(JSON.parse(await zip.file('Packet-index.json').async('string')).exhibits[0].source.sha256, doc.sha256);
});

test('local portal limits downloads, quarantines repeat uploads and enforces revocation', async t => {
  const { base, call } = await setup(t, { portal: true });
  const d = driver(call, (await call('/api/matters', { body: { name: 'Synthetic portal matter' } })).data);
  const share = await d.upload(await fixture('digital.pdf'), 'supporting');
  const privateDoc = await d.upload(await fixture('mixed.pdf'), 'supporting');
  const port = d.path + '/portal';
  const grant = await call(port, { body: { recipient: 'Synthetic recipient', days: 5, documents: [share.id], canUpload: true, attested: true } });
  assert.equal(grant.status, 201);
  const token = new URL(grant.data.created.link).hash.slice(1);
  const headers = { Authorization: 'Bearer ' + token, 'X-Portal-Code': grant.data.created.code };
  const guest = (path, options = {}) => fetch(base + '/api/portal/' + path, { ...options, headers: { ...headers, ...options.headers } });
  assert.equal((await guest('info', { headers: { 'X-Portal-Code': '00000000' } })).status, 401);
  const info = await guest('info');
  assert.deepEqual((await info.json()).files.map(row => row.id), [share.id]);
  assert.equal((await guest('files/' + privateDoc.id)).status, 404);
  assert.deepEqual(Buffer.from(await (await guest('files/' + share.id)).arrayBuffer()), await fixture('digital.pdf'));
  const upload = { method: 'POST', body: await fixture('scan.pdf'), headers: { 'Content-Type': 'application/pdf', 'X-PDF-Name': 'Client.pdf' } };
  const first = await guest('upload', upload);
  const entry = await first.json();
  assert.equal(first.status, 201);
  assert.equal((await (await guest('upload', upload)).json()).receipt, entry.receipt);
  assert.equal((await call(d.path)).data.documents.length, 2);
  assert.equal((await call(port + '/' + entry.receipt + '/pdf', { user: 1 })).status, 404);
  const reviewed = await call(port + '/' + entry.receipt + '/review', { body: { accept: true, attested: true } });
  assert.equal(reviewed.data.matter.documents.length, 3);
  assert.equal(reviewed.data.matter.events.length, 0);
  await call(port + '/' + grant.data.created.id + '/revoke', { body: {} });
  assert.equal((await guest('info')).status, 401);
  assert.equal((await guest('files/' + share.id)).status, 401);
});

test('recovery verifies encrypted matter archives and restores a distinct database with original hashes', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'briefcase-recovery-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const source = join(dir, 'live.sqlite');
  const backup = join(dir, 'verified.sqlite');
  const restored = join(dir, 'restored.sqlite');
  const { call } = await setup(t, { database: source });
  const d = driver(call, (await call('/api/matters', { body: { name: 'Synthetic archive' } })).data);
  await d.upload(await fixture('digital.pdf'), 'supporting');
  const holdFields = { owner: 'Records owner', date: '2026-11-12', scope: 'All original files' };
  await d.save('hold', 'Active recovery hold', 'Active', holdFields);
  const bytes = await encryptedArchive(d.matter, d.original, 'synthetic archive passphrase');
  const verified = await verifyArchive(bytes, 'synthetic archive passphrase');
  assert.deepEqual(verified, { matter: 'Synthetic archive', originals: 1, approvals: 0 });
  await assert.rejects(verifyArchive(bytes, 'wrong archive passphrase'), /integrity/);
  bytes[bytes.length - 1] ^= 1;
  await assert.rejects(verifyArchive(bytes, 'synthetic archive passphrase'), /integrity/);
  assert.equal((await copyDatabase(source, backup)).originals, 1);
  await copyDatabase(backup, restored);
  assert.deepEqual(await verifyDatabase(restored), { matters: 1, originals: 1, chronologyApprovals: 0 });
  await assert.rejects(copyDatabase(backup, restored), error => error.code === 'EEXIST');
  const restoredServer = await setup(t, { database: restored });
  const restoredMatter = driver(restoredServer.call, (await restoredServer.call(d.path)).data);
  const hold = officeRows(restoredMatter.matter, 'hold')[0];
  assert.equal(hold.status, 'Active');
  const disposition = { due: '2026-11-12', policy: 'Policy 1', scope: 'All originals' };
  await restoredMatter.save('retention', 'Disposition', 'Cleared for disposition', disposition, null, 422);
  assert.deepEqual(await restoredMatter.original(restoredMatter.matter, restoredMatter.matter.documents[0]), await fixture('digital.pdf'));
  await restoredMatter.save('hold', 'Active recovery hold', 'Released', holdFields, hold);
  await restoredMatter.save('retention', 'Disposition', 'Cleared for disposition', disposition);
  assert.deepEqual(redactionBox({ left: '10', top: '20', width: '30', height: '40' }), { left: 10, top: 20, width: 30, height: 40 });
  assert.throws(() => redactionBox({ left: '80', top: '20', width: '30', height: '40' }), /fit inside/);
});

test('R59 exports a verified tenant-only database and leaves foreign records behind', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'briefcase-tenant-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const live = join(directory, 'live.sqlite');
  const tenant = join(directory, 'tenant.sqlite');
  const { call } = await setup(t, { database: live });
  const own = driver(call, (await call('/api/matters', { body: { name: 'Authorized tenant fixture' } })).data);
  const bytes = await fixture('digital.pdf');
  const doc = await own.upload(bytes, 'supporting');
  const foreign = (await call('/api/matters', { user: 1, body: { name: 'ForeignOnlySentinelX23' } })).data;
  assert.equal((await call('/api/matters/' + foreign.id + '/documents', { user: 1, pdf: bytes, purpose: 'supporting' })).status, 201);
  const evidence = await copyTenantDatabase(live, tenant, 'fixture-a');
  assert.deepEqual(evidence, { firm: 'fixture-a', matters: 1, originals: 1, chronologyApprovals: 0 });
  assert.ok(!(await readFile(tenant)).includes(Buffer.from('ForeignOnlySentinelX23')));
  const isolated = await setup(t, { database: tenant });
  assert.deepEqual((await isolated.call(own.path + '/documents/' + doc.id + '/original')).data, bytes);
  assert.equal((await isolated.call(own.path, { user: 1 })).status, 404);
  assert.equal((await isolated.call('/api/matters/' + foreign.id, { user: 1 })).status, 404);
});

test('all new section templates render against legacy matters and holds block disposition', () => {
  const matter = createMatter({ name: 'Legacy matter' });
  const none = () => '';
  const ui = officeUI({ state: { matter }, escape: String, option: none, field: none, button: none, pill: none, attribute: none });
  for (const section of officeSections) assert.match(ui.render(section.id), new RegExp(section.name.replaceAll('&', '\\&')));
  assert.equal(matter.practice, undefined);
  changePractice(matter, { action: 'office-save', type: 'hold', title: 'Hold', status: 'Active',
    fields: { owner: 'Synthetic lawyer', date: '2026-11-12', scope: 'All original files' } }, 'Synthetic lawyer');
  assert.throws(() => changePractice(matter, { action: 'office-save', type: 'retention', title: 'Disposition', status: 'Cleared for disposition',
    fields: { due: '2026-11-12', policy: 'Test policy', scope: 'All original files' }, attested: true }, 'Synthetic lawyer'), /active records hold/);
  const another = createMatter({ name: 'Another matter' });
  changePractice(matter, { action: 'party-save', name: 'Morgan Ellis', role: 'Prospective client' }, 'Synthetic lawyer');
  changePractice(another, { action: 'party-save', name: 'Morgan S. Smith', aliases: 'Morgan Ellis', role: 'Adverse party' }, 'Synthetic lawyer');
  assert.equal(conflictMatches(matter, [another])[0].matchedName, 'Morgan Ellis');
});
