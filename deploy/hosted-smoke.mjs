// Hosted acceptance smoke test for a Briefcase deployment (synthetic data only).
// Usage: node deploy/hosted-smoke.mjs <base-url> <users.json> [state.json]
//   First run creates a matter and writes state.json; a second run with the same
//   state file (after a redeploy) verifies that originals and approvals persisted.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const [base, usersPath, statePath] = process.argv.slice(2);
if (!base || !usersPath) { console.error('usage: hosted-smoke.mjs <base-url> <users.json> [state.json]'); process.exit(2); }
const users = JSON.parse(readFileSync(usersPath, 'utf8'));
const fixture = name => readFileSync(new URL('../tests/fixtures/' + name, import.meta.url));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? ' — ' + detail : '')); };

function client(user) {
  return async (path, { body, pdf, revision, origin, noHeader } = {}) => {
    const headers = {};
    if (user) headers.Authorization = 'Basic ' + Buffer.from(user.username + ':' + user.password).toString('base64');
    if (body || pdf) {
      headers['Content-Type'] = pdf ? 'application/pdf' : 'application/json';
      if (!noHeader) headers['X-Briefcase-Request'] = '1';
    }
    if (pdf) headers['X-PDF-Name'] = encodeURIComponent('Synthetic.pdf');
    if (revision !== undefined) headers['If-Match'] = String(revision);
    if (origin) headers.Origin = origin;
    const response = await fetch(base + path, { method: body || pdf ? 'POST' : 'GET', headers, body: pdf ?? (body ? JSON.stringify(body) : undefined) });
    const data = response.headers.get('content-type')?.includes('application/json') ? await response.json() : Buffer.from(await response.arrayBuffer());
    return { status: response.status, data };
  };
}

const firms = [...new Set(users.map(user => user.firm))];
const owner = users.find(user => user.firm === firms[0] && (user.role ?? 'lawyer') === 'lawyer');
const sameFirm = users.find(user => user.firm === firms[0] && user !== owner && (user.role ?? 'lawyer') === 'lawyer' && !user.desk?.length) ?? users.find(user => user.firm === firms[0] && user !== owner);
const otherFirm = users.find(user => user.firm !== firms[0]);
const call = client(owner);
const bytes = fixture('mixed.pdf');

check('health responds on the public host', (await client(null)('/health')).status === 200);
check('unauthenticated API request is refused', (await client(null)('/api/matters')).status === 401);
check('unauthenticated page request is refused', (await client(null)('/')).status === 401);
for (const user of users) {
  const boot = await client(user)('/api/bootstrap');
  check('bootstrap is server mode for ' + user.username, boot.status === 200 && boot.data.mode === 'server' && boot.data.username === user.username);
}
check('cross-origin write is refused', (await call('/api/matters', { body: { name: 'x' }, origin: 'https://example.org' })).status === 403);
check('write without request header is refused', (await call('/api/matters', { body: { name: 'x' }, noHeader: true })).status === 403);

if (statePath && existsSync(statePath)) {
  const state = JSON.parse(readFileSync(statePath, 'utf8'));
  const matter = await call(state.path);
  check('matter persisted across redeploy', matter.status === 200 && matter.data.documents?.length === 1);
  const original = await call(state.originalPath);
  check('original bytes persisted with the same hash', original.status === 200 && sha(original.data) === state.sha256);
  const manifest = await call(state.versionPath + '/json');
  check('approved export persisted', manifest.status === 200 && manifest.data.events?.[1]?.sourceSha256 === state.sha256);
  check('other firm still denied after redeploy', (await client(otherFirm)(state.originalPath)).status === 404);
} else {
  const created = await call('/api/matters', { body: { name: 'Hosted smoke matter', reference: 'SMOKE-' + Date.now() } });
  check('owner creates a matter', created.status === 201);
  const path = '/api/matters/' + created.data.id;
  check('corrupt PDF is rejected', (await call(path + '/documents', { pdf: fixture('corrupt.pdf') })).status === 422);
  const attempts = await Promise.all([call(path + '/documents', { pdf: bytes }), call(path + '/documents', { pdf: bytes })]);
  check('concurrent duplicate import stores one document', attempts.map(reply => reply.status).sort().join() === '200,201' && attempts[0].data.matter.documents.length === 1, attempts.map(reply => reply.status).join());
  let matter = attempts[0].data.matter;
  const doc = matter.documents[0];
  check('scanned page was read by hosted OCR', JSON.stringify(doc.pages?.map(page => page.method ?? page.source ?? page.kind)).includes('ocr'), JSON.stringify(doc.pages?.map(page => page.method ?? page.source ?? page.kind)));
  const originalPath = path + '/documents/' + doc.id + '/original';
  const original = await call(originalPath);
  check('original download matches uploaded bytes', original.status === 200 && sha(original.data) === sha(bytes));
  check('same-firm unrelated user cannot read the matter', (await client(sameFirm)(path)).status === 404);
  check('same-firm unrelated user cannot download the original', (await client(sameFirm)(originalPath)).status === 404);
  check('other firm cannot read the matter', (await client(otherFirm)(path)).status === 404);
  check('other firm cannot download the original', (await client(otherFirm)(originalPath)).status === 404);
  check('other firm cannot upload into the matter', (await client(otherFirm)(path + '/documents', { pdf: fixture('digital.pdf') })).status === 404);
  check('fabricated quote is rejected', (await call(path + '/events', { body: { ...matter.events[0], quote: 'fabricated quote' }, revision: matter.revision })).status === 422);
  check('approval is blocked while items are unverified', (await call(path + '/approve', { body: { attested: true }, revision: matter.revision })).status === 422);
  const staleRevision = matter.revision;
  for (const event of matter.events) {
    const updated = await call(path + '/events/' + event.id, { body: { action: 'verify' }, revision: matter.revision });
    matter = updated.data.matter ?? matter;
  }
  check('stale revision approval is refused', (await call(path + '/approve', { body: { attested: true }, revision: staleRevision })).status === 409);
  const approved = await call(path + '/approve', { body: { attested: true }, revision: matter.revision });
  check('owner approves the exact revision', approved.status === 200 && Boolean(approved.data.approval?.id));
  const versionPath = path + '/approvals/' + approved.data.approval.id;
  const manifest = await call(versionPath + '/json');
  check('approved export cites the original hash', manifest.status === 200 && manifest.data.events?.[1]?.sourceSha256 === sha(bytes));
  check('approved CSV export downloads', (await call(versionPath + '/csv')).status === 200);
  check('other firm cannot download the approved export', (await client(otherFirm)(versionPath + '/json')).status === 404);
  if (statePath) writeFileSync(statePath, JSON.stringify({ path, originalPath, versionPath, sha256: sha(bytes) }));
}
const failed = results.filter(result => !result.ok).length;
console.log('\n' + (results.length - failed) + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
