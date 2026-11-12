import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { buildApp } from '../server/app.mjs';

const api = '/api/risk-intake';
const users = [
  ['owner', 'lawyer'], ['risk', 'lawyer', 'R10'], ['ethics', 'lawyer', 'R11'], ['desk', 'preparer', 'R12'],
  ['intake', 'preparer', 'R13'], ['analyst', 'preparer', 'R14'], ['counsel', 'lawyer', 'R15'],
  ['opener', 'preparer', 'R16'], ['verifier', 'preparer', 'R17'], ['investigator', 'preparer'], ['restricted', 'lawyer'],
  ['foreign', 'lawyer', 'R13', 'beta'],
].map(([username, role, desk, firm = 'alpha']) => ({ username, role, desk: desk ? [desk] : [], firm, password: 'synthetic-' + username + '-secret' }));
const time = offset => new Date(Date.now() + offset).toISOString();
async function setup(t) {
  const server = buildApp({ database: ':memory:', users });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = 'http://127.0.0.1:' + server.address().port;
  async function call(user, path, body, code = 200, extra = {}) {
    const pdf = Buffer.isBuffer(body);
    const headers = { Authorization: 'Basic ' + Buffer.from(user + ':synthetic-' + user + '-secret').toString('base64') };
    if (body) Object.assign(headers, { 'X-Briefcase-Request': '1', 'Content-Type': pdf ? 'application/pdf' : 'application/json' });
    const result = await fetch(base + path, { method: body ? 'POST' : 'GET', headers: { ...headers, ...extra },
      body: body && (pdf ? body : JSON.stringify(body)) });
    const payload = result.headers.get('content-type')?.includes('application/json') ? await result.json() : await result.arrayBuffer();
    assert.equal(result.status, code, payload?.error);
    return payload;
  }
  const act = async (user, action, fields, code) => (await call(user, api, { action, ...fields }, code)).item;
  const view = user => call(user, api);
  const matter = (user, name) => call(user, '/api/matters', { name }, 201);
  const pdf = async (user, id) => call(user, '/api/matters/' + id + '/documents',
    await readFile(new URL('./fixtures/mixed.pdf', import.meta.url)), 201, { 'X-PDF-Name': 'Signed.pdf', 'X-PDF-Purpose': 'supporting' });
  return { call, act, view, matter, pdf };
}
const key = row => ({ id: row.id, revision: row.revision });

test('R10 restricts incident investigation to assigned material and preserves original access history', async t => {
  const { call, act, view, matter, pdf } = await setup(t);
  const record = await matter('owner', 'Sensitive incident matter');
  const { document } = await pdf('owner', record.id);
  const original = '/api/matters/' + record.id + '/documents/' + document.id + '/original';
  await call('owner', original);
  const incident = await act('owner', 'incident-open', { matterId: record.id, counsel: 'risk', investigator: 'investigator',
    from: time(-3600_000), to: time(3600_000), summary: 'Private counsel misdelivery account', assignment: 'Confirm the recipient callback.' });
  const counsel = (await view('risk')).incidents[0];
  assert.ok(counsel.evidence.some(event => event.action === 'original opened' && event.target === document.id));
  assert.equal(counsel.evidenceSha256, createHash('sha256').update(JSON.stringify(counsel.evidence)).digest('hex'));
  const assigned = (await view('investigator')).incidents[0];
  assert.equal(assigned.assignment, 'Confirm the recipient callback.');
  assert.doesNotMatch(JSON.stringify(assigned), /evidence|matterId|Private counsel/);
  await call('investigator', original, undefined, 404);
  await call('risk', original, undefined, 404);
  const reported = await act('investigator', 'incident-findings', { ...key(incident), findings: 'Callback confirmed.' });
  assert.equal(reported.status, 'reported');
  assert.doesNotMatch(JSON.stringify(reported), /Private counsel|evidence/);
  const closed = await act('risk', 'incident-resolve', { ...key(reported), decision: 'Access history reviewed. Callback confirmed.' });
  assert.equal(closed.status, 'resolved');
  assert.equal((await view('foreign')).incidents.length, 0);
});

test('R12 captures a private callback without granting matter access', async t => {
  const { call, act, view, matter } = await setup(t);
  const active = await matter('owner', 'Private Existing Matter');
  await act('owner', 'callback-route', { matterId: active.id, code: 'opaque-7bd4' });
  const callback = await act('desk', 'callback-new', { code: 'opaque-7bd4', caller: 'Caller', number: '555-0147', note: 'Please call back.' });
  const response = await view('desk');
  assert.deepEqual(Object.keys(response.callbacks[0]).sort(), ['caller', 'id', 'note', 'number', 'status']);
  assert.doesNotMatch(JSON.stringify(response), /Private Existing Matter/);
  await call('desk', '/api/matters/' + active.id, undefined, 404);
  await act('desk', 'callback-ack', key(callback), 404);
  await act('owner', 'callback-ack', key(callback));
  const inquiry = await act('desk', 'inquiry-new', { reference: 'fresh injury', channel: 'Call', contact: 'New caller', notes: 'Reported injury' });
  assert.equal(inquiry.status, 'new');
});

test('R11 and R13–R17 route a duplicate inquiry through conflicts, restricted diligence, and idempotent opening', async t => {
  const { call, act, view, matter, pdf } = await setup(t);
  const indexed = await matter('owner', 'Private precedent');
  const hidden = await matter('owner', 'Screened precedent');
  const entity = { attested: true, name: 'Current Corp', aliases: ['Former Corp'], related: ['Parent Corp'] };
  await act('owner', 'conflict-entity', { ...entity, matterId: indexed.id });
  await act('owner', 'conflict-entity', { ...entity, name: 'Do Not Reveal LLC', matterId: hidden.id });
  for (const username of ['analyst', 'counsel']) await call('owner', '/api/matters/' + hidden.id + '/team', {
    action: 'screen', username, reason: 'Synthetic screen',
  });
  const intake = { reference: 'CRM-101', channel: 'Call', contact: 'Caller', notes: 'Initial inquiry.' };
  const created = await act('desk', 'inquiry-new', intake);
  const merged = await act('intake', 'inquiry-new', { ...intake, reference: 'crm-101', channel: 'Web' });
  assert.equal(merged.id, created.id);
  const current = async user => (await view(user)).inquiries.find(row => row.id === created.id);
  let state = await current('intake');
  assert.deepEqual(state.submissions.map(row => row.via), ['Call', 'Web']);
  state = await act('intake', 'inquiry-assign', { ...key(state), assignee: 'intake', counsel: 'counsel',
    analyst: 'analyst', opener: 'opener', parties: ['Former Corp', 'Parent Corp'], urgency: 'urgent', reviewAt: time(3600_000) });
  assert.equal(state.status, 'assigned');
  state = await act('intake', 'inquiry-submit', { ...key(state), eligibility: 'Review requested.' });
  await act('opener', 'opening-start', { ...key(state) }, 409);
  const scan = await current('analyst');
  assert.deepEqual(scan.candidates.map(row => row.label), ['Current Corp']);
  assert.deepEqual(scan.candidates[0].reasons.map(row => row.reason), ['Former name or alias', 'Parent, subsidiary or related party']);
  state = await act('analyst', 'conflict-submit', { ...key(scan), scanHash: scan.candidateHash });
  state = await act('counsel', 'waiver-assign', { ...key(state), advisor: 'ethics', notes: 'Review proposed screen for related entity.' });
  assert.equal((await view('ethics')).waiverQueue.length, 1);
  state = await act('ethics', 'waiver-record', { ...key(state), reference: 'Signed waiver ref', notes: 'Screen restricted lawyer.' });
  const verification = await act('counsel', 'diligence-assign', { id: state.id, reviewer: 'verifier', reference: 'Sensitive packet ref' });
  let result = await act('verifier', 'diligence-result', { ...key(verification), result: 'escalated',
    receipt: 'Private failed identity receipt', notes: 'Unresolved identity match' });
  const intakeView = await current('intake');
  assert.equal(intakeView.diligenceStatus, 'escalated');
  assert.doesNotMatch(JSON.stringify(intakeView), /Private failed|Sensitive packet/);
  const conditions = { ...key(state), disposition: 'clear', notes: 'Review complete.', screened: ['restricted'],
    requiresDiligence: true, requiresWaiver: true, attested: true };
  await act('counsel', 'conflict-decision', conditions, 409);
  await act('verifier', 'diligence-result', { ...key(result), result: 'verified', receipt: 'Corrected external receipt', notes: 'Reviewed' });
  state = await act('counsel', 'conflict-decision', conditions);
  const opening = { ...key(state), name: 'New matter', code: 'NEW-101', jurisdiction: 'Injury', billingContact: 'Billing desk' };
  state = await act('opener', 'opening-start', opening);
  assert.equal((await act('opener', 'opening-start', opening)).id, state.id);
  await act('opener', 'opening-finalize', key(state), 409);
  const { matterId } = await current('counsel');
  const path = '/api/matters/' + matterId;
  const { document } = await pdf('counsel', matterId);
  await call('restricted', path + '/documents/' + document.id + '/original', undefined, 404);
  await call('restricted', path + '/search?q=injury', undefined, 404);
  await call('restricted', path + '/casework?document=' + document.id, undefined, 404);
  const change = (revision, body) => call('counsel', path + '/practice', body, 200, { 'If-Match': String(revision) });
  await change(0, { action: 'party-save', name: 'New client', role: 'Prospective client' });
  const { matchKey } = await call('counsel', path + '/conflicts');
  await change(1, { action: 'conflict-review', disposition: 'cleared', matchKey, reason: 'Checked', attested: true });
  await change(2, { action: 'intake-decision', status: 'accepted', reason: 'Approved', attested: true });
  await change(3, { action: 'engagement-save', documentId: document.id, date: '2025-01-01', attested: true });
  const finished = await act('opener', 'opening-finalize', key(state));
  assert.equal(finished.status, 'opened');
  const bill = (await current('opener')).billing;
  assert.equal(bill.matterCode, 'NEW-101');
  assert.equal(bill.agreementSha256, document.sha256);
  await act('opener', 'opening-finalize', key(state));
  assert.equal((await current('opener')).billing.id, bill.id);
  assert.equal((await view('foreign')).inquiries.length, 0);
});
