import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { buildApp } from '../server/app.mjs';

const base = '/api/client-development';
const users = [
  ['partner', ['R02'], 'lawyer'], ['second', [], 'lawyer'], ['bd', ['R07'], 'preparer'],
  ['marketing', ['R08'], 'preparer'], ['editor', ['R08'], 'preparer'],
  ['relationships', ['R09'], 'preparer'], ['other', [], 'lawyer'],
  ['foreign', ['R07', 'R08', 'R09'], 'lawyer', 'beta'],
].map(([username, desk, role, firm = 'alpha']) => ({ username, desk, role, firm, password: 'synthetic-' + username + '-secret' }));

async function setup(t) {
  const server = buildApp({ database: ':memory:', users });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const root = 'http://127.0.0.1:' + server.address().port;
  async function call(user, path, body, code = 200, extra = {}) {
    const headers = { Authorization: 'Basic ' + Buffer.from(user + ':synthetic-' + user + '-secret').toString('base64') };
    if (body) Object.assign(headers, { 'X-Briefcase-Request': '1',
      'Content-Type': Buffer.isBuffer(body) ? 'application/pdf' : 'application/json' });
    const response = await fetch(root + path, { method: body ? 'POST' : 'GET', headers: { ...headers, ...extra },
      body: body && (Buffer.isBuffer(body) ? body : JSON.stringify(body)) });
    const data = await response.json();
    assert.equal(response.status, code, data.error);
    return data;
  }
  const act = async (user, action, data, code) => (await call(user, base, { action, ...data }, code)).item;
  const view = user => call(user, base);
  const matter = (user, name) => call(user, '/api/matters', { name }, 201);
  const practice = async (user, matter, revision, action, data) => (await call(user, '/api/matters/' + matter.id + '/practice',
    { action, ...data }, 200, { 'If-Match': String(revision) })).matter.practice;
  const exportOf = (user, kind, row, code) => call(user, base + '/' + kind + '/' + row.id + '/export', undefined, code);
  const screen = (user, matter, username) => call(user, '/api/matters/' + matter.id + '/team', {
    action: 'screen', username, reason: 'Synthetic restricted matter',
  });
  return { call, act, view, matter, practice, exportOf, screen };
}
const review = (row, changes = {}) => ({ id: row.id, revision: row.revision, version: row.versions.at(-1).number,
  notes: 'Checked authorized material.', attested: true, ...changes });

test('R07 builds a versioned pitch from a sanitized referral and actual closed-matter experience', async t => {
  const { call, act, view, matter, practice, exportOf, screen } = await setup(t);
  const prior = await matter('second', 'Private Case Name');
  const card = { matterId: prior.id, area: 'Personal injury', service: 'Negotiation', outcome: 'Resolution reached', attested: true };
  await act('second', 'experience-add', card, 422);
  await practice('second', prior, 0, 'settlement-save', { gross: '51375.00', basis: 'Private settlement terms' });
  const settled = await practice('second', prior, 1, 'settlement-approve', { attested: true });
  await practice('second', prior, 2, 'close-matter', { versionId: settled.settlement.versions[0].id,
    check0: true, check1: true, check2: true, notes: 'Private closeout' });
  const experience = await act('second', 'experience-add', card);
  const hidden = await act('second', 'experience-add', { ...card, service: 'Document review' });
  assert.ok((await view('bd')).experience.some(item => item.reference === hidden.id));
  await act('second', 'experience-retire', { id: hidden.id, revision: 1 });

  const { item: referral } = await call('partner', '/api/firm-desk', { action: 'referral-new', reference: 'Synthetic-CRM-01',
    source: 'Confidential referrer', name: 'Private prospective client', fee: 5000, commitment: 1000 });
  const brief = await act('partner', 'referral-share', { referralId: referral.id, manager: 'bd', area: 'Personal injury' });
  assert.doesNotMatch(JSON.stringify(await view('bd')), /Confidential referrer|Private prospective client|Private Case Name|51375/);
  assert.equal((await view('other')).briefs.length, 0);
  await act('bd', 'pitch-save', { brief: brief.id, style: 'introduction', revision: 0, cards: [hidden.id] }, 409);
  const draft = await act('bd', 'pitch-save', { brief: brief.id, style: 'introduction', revision: 0, cards: [experience.id] });
  assert.equal((await view('partner')).pitches.length, 0);
  let sent = await act('bd', 'pitch-submit', review(draft));
  assert.equal((await view('partner')).pitches[0].status, 'submitted');
  await act('bd', 'pitch-approve', review(sent), 403);
  sent = await act('partner', 'pitch-return', review(sent));
  const updated = await act('bd', 'pitch-save', { id: sent.id, revision: sent.revision, brief: brief.id,
    style: 'followup', cards: [experience.id] });
  sent = await act('bd', 'pitch-submit', review(updated));
  await act('partner', 'pitch-approve', review(sent, { version: 1 }), 409);
  const approved = await act('partner', 'pitch-approve', review(sent));
  const result = await exportOf('partner', 'pitch', approved);
  assert.equal(result.version, 2);
  assert.equal(result.artifact.experience[0].reference, experience.id);
  assert.equal(result.sha256, createHash('sha256').update(JSON.stringify(result.artifact)).digest('hex'));
  assert.doesNotMatch(JSON.stringify(result), /Private|Confidential|51375|Synthetic-CRM-01/);
  assert.equal((await view('foreign')).experience.length, 0);
  await exportOf('other', 'pitch', approved, 404);
  await screen('second', prior, 'bd');
  await exportOf('partner', 'pitch', approved, 409);
});

test('R08 restricts a versioned client story by consent and blocks withdrawn drafts and exports', async t => {
  const { call, act, view, matter, exportOf } = await setup(t);
  const source = await matter('partner', 'Private marketing matter');
  const bytes = await readFile(new URL('./fixtures/mixed.pdf', import.meta.url));
  const { document } = await call('partner', '/api/matters/' + source.id + '/documents', bytes, 201,
    { 'X-PDF-Name': 'Signed consent.pdf', 'X-PDF-Purpose': 'supporting' });
  const expires = new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10);
  const consent = await act('partner', 'consent-add', { matterId: source.id, documentId: document.id,
    marketer: 'marketing', reviewer: 'editor', channel: 'Website', expires, excerpt: 'The team kept me informed.', attested: true });
  assert.equal(consent.documentSha256, document.sha256);
  await call('marketing', '/api/matters/' + source.id, undefined, 404);
  assert.equal((await view('other')).consentOptions.length, 0);
  await act('marketing', 'story-save', { consent: consent.id, channel: 'Social', style: 'client', revision: 0 }, 422);
  const create = () => act('marketing', 'story-save', { consent: consent.id, channel: 'Website', style: 'client', revision: 0 });
  let story = await create();
  story = await act('marketing', 'story-submit', review(story));
  await act('marketing', 'story-approve', review(story), 403);
  story = await act('editor', 'story-approve', review(story));
  assert.deepEqual((await exportOf('editor', 'story', story)).artifact,
    { headline: 'A client shares their experience', copy: 'The team kept me informed.', channel: 'Website' });
  const pending = await act('marketing', 'story-submit', review(await create()));
  await act('partner', 'consent-revoke', { id: consent.id, revision: consent.revision, notes: 'Client withdrew permission' });
  await act('editor', 'story-approve', review(pending), 409);
  await exportOf('marketing', 'story', story, 409);
  assert.doesNotMatch(JSON.stringify(await view('marketing')), /kept me informed/);
});

test('R09 shows approved history across matter owners and routes feedback to the correct lead', async t => {
  const { call, act, view, matter, screen } = await setup(t);
  const first = await matter('partner', 'Private first matter');
  const second = await matter('second', 'Private second matter');
  const unrelated = await matter('other', 'Private unrelated matter');
  const account = await act('partner', 'account-add', { label: 'Approved repeat client label', manager: 'relationships' });
  assert.equal((await view('relationships')).clientAccounts.length, 0);
  await act('partner', 'account-invite', { id: account.id, revision: 1, username: 'second' });
  const share = (owner, source, label, code) => act(owner, 'account-link',
    { accountId: account.id, matterId: source.id, label, milestone: 'In progress', revision: 0 }, code);
  await share('partner', first, 'First engagement');
  const link = await share('second', second, 'Second engagement');
  await share('other', unrelated, 'Unauthorized engagement', 404);
  let viewData = await view('relationships');
  assert.deepEqual(viewData.clientHistory.map(row => row.label).sort(), ['First engagement', 'Second engagement']);
  assert.ok(viewData.clientHistory.every(row => !Object.hasOwn(row, 'matterId')));
  assert.doesNotMatch(JSON.stringify(viewData), /Private first matter|Private second matter/);
  await call('relationships', '/api/matters/' + first.id, undefined, 404);
  const row = await act('relationships', 'feedback-new', { linkId: link.id, topic: 'Communication',
    feedback: 'Client would like a callback.', nextStep: 'Assign a callback' });
  assert.equal((await view('partner')).feedback.length, 0);
  assert.equal((await view('second')).feedback[0].id, row.id);
  await act('partner', 'feedback-ack', { id: row.id, revision: 1 }, 404);
  await act('second', 'feedback-ack', { id: row.id, revision: 1 });
  await act('second', 'feedback-resolve', { id: row.id, revision: 2, resolution: 'Callback confirmed by service record 01.' });
  assert.equal((await view('relationships')).feedback[0].status, 'resolved');
  await screen('second', second, 'relationships');
  viewData = await view('relationships');
  assert.deepEqual(viewData.clientHistory.map(row => row.label), ['First engagement']);
  assert.equal(viewData.feedback.length, 0);
  assert.equal((await view('foreign')).clientAccounts.length, 0);
});
