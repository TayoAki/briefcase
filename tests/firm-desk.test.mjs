import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { buildApp } from '../server/app.mjs';

const account = (username, desk = [], settings = {}) => ({
  username, password: 'synthetic-' + username + '-secret', firm: 'alpha', office: 'east', practiceGroup: 'injury', desk, ...settings,
});
const users = [
  account('chair', ['R01'], { offices: ['east', 'west'] }),
  account('partner', ['R02']), account('otherpartner', ['R02'], { office: 'west' }),
  account('leader', ['R04'], { offices: ['east', 'west'] }),
  account('operator', ['R05'], { role: 'preparer', offices: ['east', 'west'] }),
  account('office', ['R06'], { role: 'preparer' }), account('delegate', [], { role: 'preparer' }),
  account('oldlawyer'), account('newlawyer'), account('screened'), account('unrelated'),
  account('foreign', ['R01', 'R02', 'R04', 'R05', 'R06'], { firm: 'beta' }),
];
const now = () => new Date().toISOString();
const period = now().slice(0, 7);
const oldDay = '2024-01-01';
const future = minutes => new Date(Date.now() + minutes * 60_000).toISOString();
const desk = '/api/firm-desk';

async function fixture(t) {
  const server = buildApp({ database: ':memory:', users });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = 'http://127.0.0.1:' + server.address().port;
  async function call(username, url, input, expected = 200, headers = {}) {
    const user = users.find(row => row.username === username);
    const pdf = Buffer.isBuffer(input);
    const auth = user ? { Authorization: 'Basic ' + Buffer.from(username + ':' + user.password).toString('base64') } : {};
    const response = await fetch(base + url, { method: input ? 'POST' : 'GET', headers: {
      ...auth, ...(input ? { 'X-Briefcase-Request': '1', 'Content-Type': pdf ? 'application/pdf' : 'application/json' } : {}), ...headers,
    }, body: pdf ? input : input && JSON.stringify(input) });
    const output = response.headers.get('content-type')?.includes('application/json') ? await response.json() : await response.text();
    assert.equal(response.status, expected, typeof output === 'object' ? output.error : undefined);
    return output;
  }
  const action = async (user, name, input, expected = 200) => (await call(user, desk, { action: name, ...input }, expected)).item;
  const view = user => call(user, desk + '?month=' + period);
  const create = (user, name) => call(user, '/api/matters', { name, jurisdiction: 'Injury' }, 201);
  const path = id => '/api/matters/' + id;
  const access = (user, id, username, action = 'grant', level = 'review', expected = 200) =>
    call(user, path(id) + '/team', { action, username, access: level, reason: 'Synthetic screen check' }, expected);
  const change = (user, id, revision, input) => call(user, path(id) + '/practice', input, 200, { 'If-Match': String(revision) });
  const pdf = async (user, id, bytes, expected = 201) => call(user, path(id) + '/documents', bytes, expected,
    { 'X-PDF-Name': 'Synthetic.pdf', 'X-PDF-Purpose': 'supporting' });
  return { call, action, view, create, path, access, change, pdf };
}

test('R01 reconciles a two-office partner pack and records a decision without screened matter names', async t => {
  const { call, action, view, create, path, access, change } = await fixture(t);
  const east = await create('partner', 'East authorized matter');
  const west = await create('otherpartner', 'West authorized matter');
  const hidden = await create('partner', 'Screened confidential matter');
  const foreign = await create('foreign', 'Foreign confidential matter');
  for (const [owner, matter, budget, revenue] of [
    ['partner', east, 20_000, 18_000], ['otherpartner', west, 40_000, 51_000],
    ['partner', hidden, 900_000, 800_000], ['foreign', foreign, 700_000, 200_000],
  ]) {
    await action(owner, 'ledger-save', { matterId: matter.id, period, revision: 0, budget, revenue, reference: 'Synthetic ledger' });
  }
  await access('partner', east.id, 'chair');
  await access('otherpartner', west.id, 'chair');
  await access('partner', hidden.id, 'chair');
  await access('partner', hidden.id, 'chair', 'screen');
  await call('chair', path(hidden.id), undefined, 404);
  await change('partner', east.id, 0, { action: 'task-save', title: 'Overdue action', due: oldDay,
    basis: 'Synthetic work plan', status: 'unconfirmed' });
  await access('partner', east.id, 'leader');
  const staffing = { matterId: east.id, username: 'oldlawyer', period, hours: 50, revision: 0, notes: 'Coverage' };
  await action('partner', 'staffing-delegate', { matterId: east.id, manager: 'leader', revision: 0 });
  await action('leader', 'capacity-save', { period, username: 'oldlawyer', revision: 0, hours: 40 });
  await action('leader', 'staffing-save', staffing);
  const { pack, packHash } = await view('chair');
  assert.deepEqual(pack.offices.map(row => [row.office, row.budget, row.revenue, row.variance, row.overdue, row.capacityGapHours]),
    [['east', 20_000, 18_000, -2000, 1, 10], ['west', 40_000, 51_000, 11_000, 0, 0]]);
  for (const row of pack.offices) {
    assert.equal(row.revenue, pack.rows.filter(m => m.office === row.office).reduce((sum, m) => sum + m.ledger.revenue, 0));
  }
  assert.equal(packHash, createHash('sha256').update(JSON.stringify(pack)).digest('hex'));
  const exported = await call('chair', desk + '/R01/export?month=' + period);
  assert.deepEqual(exported, { ...pack, sha256: packHash });
  assert.doesNotMatch(JSON.stringify(await view('chair')), /Screened confidential|Foreign confidential/);
  assert.doesNotMatch(JSON.stringify(exported), /Screened confidential|Foreign confidential/);
  const decision = await action('chair', 'decision-save', { period, packHash, decision: 'Move staffing to east office.' });
  const proof = await call('chair', desk + '/' + decision.id + '/decision');
  assert.equal(proof.packHash, packHash);
  assert.equal(proof.history[0].by, 'chair');
  assert.deepEqual(proof.offices, pack.offices);
  await call('foreign', desk + '/' + decision.id + '/decision', undefined, 404);
  await call('unrelated', desk + '/R01/export?month=' + period, undefined, 403);
  await action('partner', 'ledger-save', { matterId: east.id, period, revision: 1, budget: 20_000, revenue: 21_000, reference: 'Updated ledger' });
  await action('chair', 'decision-save', { period, packHash, decision: 'Stale pack' }, 409);
});

test('R02 opens one referral, requires engagement, and reconciles approved origination and commitments', async t => {
  const { call, action, view, path, access, change, pdf } = await fixture(t);
  const input = { reference: 'Ref-001', source: 'Synthetic referring counsel', name: 'Referral matter', fee: 16_500, commitment: 3000 };
  const referral = await action('partner', 'referral-new', input);
  await action('partner', 'referral-new', input, 409);
  await action('otherpartner', 'referral-new', input, 409);
  assert.equal((await view('otherpartner')).referrals.length, 0);
  const opened = await action('partner', 'referral-open', { id: referral.id, revision: 1, due: oldDay, practice: 'Injury' });
  await action('partner', 'referral-open', { id: referral.id, revision: 1, due: oldDay, practice: 'Injury' }, 409);
  const id = opened.matterId;
  await access('partner', id, 'chair');
  const approval = { id: referral.id, revision: 2, notes: 'Reviewed origination record and commitment.' };
  await action('chair', 'referral-approve', approval, 409);
  await change('partner', id, 0, { action: 'party-save', name: 'Synthetic Client', role: 'Prospective client' });
  const { matchKey } = await call('partner', path(id) + '/conflicts');
  await change('partner', id, 1, { action: 'conflict-review', matchKey, disposition: 'cleared', reason: 'Checked candidate list', attested: true });
  await change('partner', id, 2, { action: 'intake-decision', status: 'accepted', reason: 'Engagement accepted', attested: true });
  const bytes = await readFile(new URL('./fixtures/mixed.pdf', import.meta.url));
  const { document } = await pdf('partner', id, bytes);
  await change('partner', id, 3, { action: 'engagement-save', documentId: document.id, date: oldDay, attested: true });
  const approved = await action('chair', 'referral-approve', approval);
  assert.deepEqual([approved.creditedTo, approved.approvedFee, approved.approvedCommitment], ['partner', 16_500, 3000]);
  assert.equal(approved.history.at(-1).by, 'chair');
  assert.equal(approved.engagement.sha256, document.sha256);
  const portfolio = await call('partner', desk + '/R02/export?month=' + period);
  assert.deepEqual(portfolio.totals, { approvedReferrals: 1, fees: 16_500, commitments: 3000 });
  assert.equal(portfolio.referrals[0].matterId, id);
  assert.equal((await call('otherpartner', desk + '/R02/export?month=' + period)).referrals.length, 0);
  assert.equal((await view('foreign')).referrals.length, 0);
});

test('R04 reassigns actual reviewer access, blocks screened targets, and updates next-month load', async t => {
  const { call, action, view, create, path, access } = await fixture(t);
  const next = new Date(period + '-01T00:00:00.000Z');
  next.setUTCMonth(next.getUTCMonth() + 1);
  const nextMonth = next.toISOString().slice(0, 7);
  const matter = await create('partner', 'Coverage matter');
  const hidden = await create('partner', 'Hidden case');
  await access('partner', matter.id, 'leader');
  await access('partner', hidden.id, 'leader', 'screen');
  await access('partner', hidden.id, 'leader', 'grant', 'review', 409);
  assert.doesNotMatch(JSON.stringify(await view('leader')), /Hidden case/);
  const input = { matterId: matter.id, period: nextMonth, hours: 12, notes: 'Redistribute coverage' };
  await action('leader', 'staffing-save', { ...input, revision: 0, username: 'oldlawyer' }, 403);
  await action('partner', 'staffing-delegate', { matterId: matter.id, manager: 'leader', revision: 0 });
  await action('leader', 'capacity-save', { username: 'newlawyer', period: nextMonth, hours: 10, revision: 0 });
  await action('leader', 'staffing-save', { ...input, revision: 0, username: 'oldlawyer' });
  await call('oldlawyer', path(matter.id));
  await access('partner', matter.id, 'screened', 'screen');
  await action('leader', 'staffing-save', { ...input, revision: 1, username: 'screened' }, 409);
  await action('leader', 'staffing-save', { ...input, revision: 1, username: 'newlawyer' });
  await call('oldlawyer', path(matter.id), undefined, 404);
  await call('screened', path(matter.id), undefined, 404);
  await call('newlawyer', path(matter.id));
  assert.equal((await view('newlawyer')).myStaffing[0].matterId, matter.id);
  const report = await call('leader', desk + '/R04/export?month=' + nextMonth);
  assert.deepEqual(report.capacity.filter(row => row.username === 'newlawyer').map(row => [row.available, row.assigned, row.gap]), [[10, 12, 2]]);
  assert.equal(report.staffing[0].history.at(-1).by, 'leader');
  await action('partner', 'staffing-delegate', { matterId: matter.id, enabled: false, revision: 1 });
  await action('leader', 'staffing-save', { ...input, revision: 2, username: 'oldlawyer' }, 403);
});

test('R05 combines real import failures, late intake, and training status across offices', async t => {
  const { call, action, view, create, access, pdf } = await fixture(t);
  const east = await create('partner', 'East intake');
  const west = await create('otherpartner', 'West import');
  await access('partner', east.id, 'operator', 'grant', 'prepare');
  await access('otherpartner', west.id, 'operator', 'grant', 'prepare');
  await action('partner', 'intake-start', { matterId: east.id, due: oldDay });
  await pdf('otherpartner', west.id, Buffer.from('Invalid synthetic PDF'), 422);
  let review = await view('operator');
  assert.deepEqual([review.intake[0].late, review.intake[0].owner], [true, 'partner']);
  assert.deepEqual([review.imports[0].status, review.imports[0].owner], ['failed', 'otherpartner']);
  for (const [kind, item] of [['intake', review.intake[0]], ['import', review.imports[0]]]) {
    assert.ok(item.durationMs >= 0);
    await action('operator', 'exception-note', { id: item.id, revision: item.revision, kind, notes: 'Assigned follow-up.' });
  }
  const training = await action('operator', 'training-assign', { username: 'otherpartner', title: 'Import recovery', due: oldDay });
  await action('unrelated', 'training-complete', { id: training.id, revision: 1, evidence: 'Wrong user' }, 404);
  await action('otherpartner', 'training-complete', { id: training.id, revision: 1, evidence: 'Completed synthetic exercise' });
  review = await call('operator', desk + '/R05/export?month=' + period);
  assert.equal(review.training[0].status, 'complete');
  assert.equal(review.intake[0].history.at(-1).by, 'operator');
  assert.equal(review.imports[0].history.at(-2).action, 'PDF import failed');
  assert.equal(review.imports[0].history.at(-1).action, 'exception follow-up recorded');
  assert.equal((await view('foreign')).imports.length, 0);
});

test('R06 reserves a room, routes renewal and coverage, and verifies scoped delegate completion', async t => {
  const { call, action, view } = await fixture(t);
  const base = { office: 'east', delegate: 'delegate', start: future(30), end: future(60), accessUntil: future(90) };
  for (const [type, title, resource] of [
    ['renewal', 'Vendor renewal', 'Agreement 12'], ['room', 'Partner meeting', 'Room 1'], ['coverage', 'Afternoon coverage', 'Intake desk'],
  ]) {
    const fields = { ...base, type, title, resource };
    const task = await action('office', 'service-new', fields);
    assert.ok((await view('delegate')).services.some(row => row.id === task.id));
    assert.equal((await view('unrelated')).services.length, 0);
    assert.equal((await view('foreign')).services.length, 0);
    if (type === 'room') await action('office', 'service-new', { ...fields, resource: 'room 1' }, 409);
    await action('unrelated', 'service-ack', { id: task.id, revision: 1 }, 404);
    await action('delegate', 'service-complete', { id: task.id, revision: 1, evidence: 'Attempt without acknowledgement' }, 409);
    await action('delegate', 'service-ack', { id: task.id, revision: 1 });
    await action('delegate', 'service-complete', { id: task.id, revision: 2, evidence: 'Verified synthetic work reference' });
    await action('office', 'service-verify', { id: task.id, revision: 3, notes: 'Checked completion reference' });
  }
  const report = await call('office', desk + '/R06/export?month=' + period);
  assert.equal(report.services.length, 3);
  assert.ok(report.services.every(row => row.status === 'verified' && row.history.length === 4));
  const canceled = await action('office', 'service-new', { ...base, type: 'coverage', title: 'Cancel coverage', resource: 'Different queue', start: future(100), end: future(120), accessUntil: future(150) });
  await action('office', 'service-cancel', { id: canceled.id, revision: 1, notes: 'Original staff member returned' });
  assert.ok(!(await view('delegate')).services.some(row => row.id === canceled.id));
  await action('delegate', 'service-ack', { id: canceled.id, revision: 2 }, 404);
});
