import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { get } from 'node:http';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { buildApp } from '../server/app.mjs';
import { copyDatabase } from '../server/maintenance.mjs';

const users = [
  { username: 'owner', password: 'synthetic-owner-pass', firm: 'firm-a', name: 'Owner lawyer' },
  { username: 'staff', password: 'synthetic-staff-pass', firm: 'firm-a', role: 'preparer', name: 'Case manager' },
  { username: 'reviewer', password: 'synthetic-reviewer-pass', firm: 'firm-a', name: 'Assigned lawyer' },
  { username: 'unassigned', password: 'synthetic-other-a-pass', firm: 'firm-a' },
  { username: 'foreign', password: 'synthetic-foreign-pass', firm: 'firm-b' },
];

async function start(database, opts = {}) {
  const server = buildApp({ users, database, ...opts });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const base = 'http://127.0.0.1:' + server.address().port;
  const call = async (account, path, options = {}) => {
    const user = users.find(user => user.username === account);
    const headers = user ? { Authorization: 'Basic ' + Buffer.from(user.username + ':' + user.password).toString('base64') } : {};
    if (options.body || options.pdf) headers['X-Briefcase-Request'] = '1';
    if (options.body) headers['Content-Type'] = 'application/json';
    if (options.pdf) Object.assign(headers, { 'Content-Type': 'application/pdf', 'X-PDF-Name': options.name || 'Records.pdf' });
    if (options.revision !== undefined) headers['If-Match'] = String(options.revision);
    const response = await fetch(base + path, { method: options.body || options.pdf ? 'POST' : 'GET',
      headers: { ...headers, ...options.headers }, body: options.pdf ?? (options.body && JSON.stringify(options.body)) });
    return { status: response.status, data: response.headers.get('content-type')?.includes('json') ?
      await response.json() : Buffer.from(await response.arrayBuffer()) };
  };
  const healthHostStatus = path => new Promise((resolve, reject) => {
    get(base + path, { headers: { Host: 'healthcheck.railway.app' } }, response => {
      response.resume();
      resolve(response.statusCode);
    }).on('error', reject);
  });
  return { call, healthHostStatus, close: () => new Promise(resolve => server.close(resolve)) };
}

test('two synthetic firms exercise the staff-to-lawyer handoff and restore with scoped access', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'briefcase-team-'));
  const db = join(dir, 'initial.sqlite');
  let service = await start(db, { railwayHealth: true });
  const invoke = async (user, route, options, status = 200) => {
    const result = await service.call(user, route, options);
    assert.equal(result.status, status, result.data?.error);
    return result.data;
  };
  const post = (user, route, body, status = 200, revision) => invoke(user, route, { body, revision }, status);
  try {
    assert.equal(await service.healthHostStatus('/health'), 200);
    assert.equal(await service.healthHostStatus('/api/matters'), 421);
    let matter = await post('owner', '/api/matters', { name: 'Shared synthetic PI' }, 201);
    const foreign = await post('foreign', '/api/matters', { name: 'Other firm matter' }, 201);
    const base = '/api/matters/' + matter.id;
    const grant = (username, access = 'prepare', status = 200) =>
      post('owner', base + '/team', { action: 'grant', username, access }, status);
    await grant('foreign', 'prepare', 404);
    await grant('staff', 'review', 422);
    await grant('staff');
    await grant('reviewer', 'review');
    assert.deepEqual((await invoke('staff', '/api/matters')).map(row => row.id), [matter.id]);
    await invoke('staff', '/api/matters/' + foreign.id, undefined, 404);
    await invoke('unassigned', base, undefined, 404);
    await invoke('foreign', base, undefined, 404);
    const pdf = await readFile(new URL('./fixtures/mixed.pdf', import.meta.url));
    const first = await invoke('staff', base + '/documents', { pdf }, 201);
    matter = first.matter;
    assert.equal(first.document.pages.length, 3);
    assert.equal(matter.events.length, 2);
    assert.equal((await invoke('staff', base + '/documents', { pdf })).duplicate, true);
    const foreignId = (await invoke('foreign', '/api/matters/' + foreign.id + '/documents', { pdf }, 201)).document.id;
    const docUrl = base + '/documents/' + first.document.id + '/original';
    assert.deepEqual(await invoke('staff', docUrl), pdf);
    const search = await invoke('staff', base + '/search?q=' + encodeURIComponent('follow-up'));
    assert.ok(search.matches.some(hit => hit.page === 3 && hit.sha256 === first.document.sha256));
    await invoke('foreign', docUrl, undefined, 404);
    await invoke('foreign', base + '/search?q=follow-up', undefined, 404);
    await invoke('unassigned', base + '/casework?document=' + first.document.id, undefined, 404);
    await invoke('staff', base + '/casework?document=' + first.document.id + '&previous=' + foreignId, undefined, 404);
    const request = await post('staff', base + '/practice', { action: 'request-save', provider: 'Harborview Medical Center',
      kind: 'Medical records', followUp: '2026-11-20' }, 200, 0);
    const candidates = await invoke('staff', base + '/casework?document=' + first.document.id);
    assert.equal(candidates.matches[0].requestId, request.matter.practice.requests[0].id);
    assert.equal(candidates.matches[0].evidence.page, 2);
    await post('staff', base + '/practice', { action: 'demand-approve', attested: true }, 403, 1);
    const evidence = { kind: 'Incident report', custodian: 'Synthetic custodian', collected: '2026-11-12', provenance: 'Staff draft' };
    await post('staff', base + '/practice', { action: 'office-save', type: 'evidence', title: 'Prepared evidence',
      fields: evidence, status: 'Received' }, 200, 1);
    await post('staff', base + '/practice', { action: 'office-save', type: 'evidence', title: 'Attempted approval',
      fields: evidence, status: 'Reviewed', attested: true }, 403, 2);
    await post('staff', base + '/approve', { attested: true }, 403, matter.revision);
    const edit = async (event, action, fields = {}) => {
      matter = (await post('staff', base + '/events/' + event.id, { action, ...fields }, 200, matter.revision)).matter;
    };
    for (const event of matter.events) await edit(event, 'verify');
    const send = () => post('staff', base + '/review', { action: 'submit', revision: matter.revision, reviewer: 'reviewer' });
    let submission = (await send()).team.review;
    await post('owner', base + '/review', { action: 'approve', attested: true, id: submission.id, revision: matter.revision }, 403);
    await post('staff', base + '/review', { action: 'approve', attested: true, id: submission.id, revision: matter.revision }, 403);
    const returned = await post('reviewer', base + '/review', { action: 'return', reason: 'Check the date in the original.',
      id: submission.id, revision: matter.revision });
    assert.equal(returned.team.review.status, 'returned');
    await edit(matter.events[0], 'reopen');
    await edit(matter.events[0], 'verify');
    submission = (await send()).team.review;
    await edit(matter.events[0], 'reopen');
    await edit(matter.events[0], 'verify');
    await post('reviewer', base + '/review', { action: 'approve', attested: true, id: submission.id, revision: matter.revision }, 409);
    submission = (await send()).team.review;
    const approvalInput = { action: 'approve', attested: true, id: submission.id, revision: matter.revision };
    const result = await post('reviewer', base + '/review', approvalInput);
    const replay = await post('reviewer', base + '/review', approvalInput);
    assert.equal(replay.team.review.approvalId, result.team.review.approvalId);
    assert.equal(result.matter.approvals.length, 1);
    assert.equal(result.matter.approvals[0].approvedBy, 'Assigned lawyer');
    const approvalPath = base + '/approvals/' + result.team.review.approvalId + '/json';
    await invoke('foreign', approvalPath, undefined, 404);
    const roster = await invoke('owner', base + '/team');
    assert.ok(roster.audit.some(row => row.actor === 'staff' && row.action === 'original imported'));
    assert.ok(roster.reviewHistory.some(row => row.status === 'returned'));
    await post('owner', base + '/team', { action: 'revoke', username: 'staff' });
    await invoke('staff', docUrl, undefined, 404);
    await invoke('staff', base + '/search?q=follow-up', undefined, 404);
    const restored = join(dir, 'restored.sqlite');
    await copyDatabase(db, restored);
    await service.close();
    service = await start(restored);
    assert.deepEqual(await invoke('reviewer', docUrl), pdf);
    assert.equal((await invoke('reviewer', approvalPath)).id, result.team.review.approvalId);
    await invoke('staff', docUrl, undefined, 404);
    await invoke('foreign', base, undefined, 404);
  } finally {
    await service.close();
    await rm(dir, { recursive: true, force: true });
  }
});
