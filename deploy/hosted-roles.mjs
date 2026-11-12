// Hosted run of the shared assignment → submit → review → proof path for all 65 role templates.
// Usage: node deploy/hosted-roles.mjs <base-url> <users.json> [report.json]
// Needs, in the first firm: a lawyer owner, a preparer, a second lawyer (reviewer), an unrelated
// account, plus one account in a second firm. Receipts recorded here are synthetic, typed in by
// the preparer; they do not prove that an external provider ran.
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const [base, usersPath, reportPath] = process.argv.slice(2);
const users = JSON.parse(readFileSync(usersPath, 'utf8'));
const firm = users[0].firm;
const mine = users.filter(user => user.firm === firm);
const lead = mine.find(user => (user.role ?? 'lawyer') === 'lawyer');
const staff = mine.find(user => user.role === 'preparer');
const review = mine.find(user => user !== lead && (user.role ?? 'lawyer') === 'lawyer' && user.desk?.length);
const unrelated = mine.find(user => ![lead, staff, review].includes(user));
const foreign = users.find(user => user.firm !== firm);

async function call(user, path, body) {
  const response = await fetch(base + path, {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: 'Basic ' + Buffer.from(user.username + ':' + user.password).toString('base64'),
      ...(body ? { 'X-Briefcase-Request': '1', 'Content-Type': 'application/json' } : {}) },
    body: body && JSON.stringify(body),
  });
  const data = response.headers.get('content-type')?.includes('application/json') ? await response.json() : null;
  return { status: response.status, data };
}
const expect = (reply, status, what) => { if (reply.status !== status) throw new Error(what + ': expected ' + status + ', got ' + reply.status + ' ' + (reply.data?.error ?? '')); return reply.data; };

const path = '/api/role-work';
const { roles } = expect(await call(lead, path), 200, 'list roles');
const report = [];
for (const role of roles) {
  const row = { role: role.id, title: role.title ?? role.name, external: Boolean(role.external), ok: false };
  try {
    const { item } = expect(await call(lead, path, { roleId: role.id, requestId: randomUUID(), title: 'Hosted ' + role.id,
      context: 'Synthetic staging inputs for ' + role.id, assignee: staff.username, reviewer: review.username }), 201, 'assign');
    const url = path + '/' + item.id;
    for (const outsider of [unrelated, foreign]) {
      expect(await call(outsider, url), 404, 'outsider read');
      expect(await call(outsider, url + '/proof'), 404, 'outsider proof');
    }
    expect(await call(staff, url, { action: 'receipt', revision: 0, provider: 'x', reference: 'x', outcome: 'x' }), 409, 'receipt before submit');
    expect(await call(staff, url, { action: 'submit', revision: 0, output: 'Synthetic output for ' + role.id, evidence: 'Synthetic evidence ' + role.id }), 200, 'submit');
    expect(await call(staff, url, { action: 'approve', revision: 1, notes: 'Self approval', attested: true }), 403, 'preparer self-approval');
    const reviewed = expect(await call(review, url, { action: 'approve', revision: 1, notes: 'Checked against the fixture.', attested: true }), 200, 'approve').item;
    if (role.external) {
      if (reviewed.status !== 'awaiting_receipt') throw new Error('expected awaiting_receipt, got ' + reviewed.status);
      expect(await call(review, url + '/proof'), 409, 'proof before receipt');
      expect(await call(staff, url, { action: 'receipt', revision: 2, provider: 'Synthetic provider', reference: 'Synthetic receipt ' + role.id, outcome: 'Synthetic result accepted' }), 200, 'receipt');
      expect(await call(review, url, { action: 'verify', revision: 3, notes: 'Matched synthetic receipt.', attested: true }), 200, 'verify');
    } else if (reviewed.status !== 'verified') throw new Error('expected verified, got ' + reviewed.status);
    const proof = expect(await call(staff, url + '/proof'), 200, 'proof');
    const { sha256, ...submission } = proof.record.submission;
    if (proof.record.status !== 'verified' || sha256 !== createHash('sha256').update(JSON.stringify(submission)).digest('hex') ||
        proof.record.verification.outputSha256 !== sha256) throw new Error('proof hash mismatch');
    row.ok = true;
  } catch (error) { row.error = error.message; }
  report.push(row);
  console.log((row.ok ? 'PASS ' : 'FAIL ') + row.role + (row.external ? ' (synthetic receipt)' : ' (native)') + (row.error ? ' — ' + row.error : ''));
}
const failed = report.filter(row => !row.ok).length;
console.log('\n' + (report.length - failed) + ' of ' + report.length + ' role templates passed; ' + report.filter(row => row.external).length + ' used a synthetic receipt');
if (reportPath) writeFileSync(reportPath, JSON.stringify({ base, ranAt: new Date().toISOString(), report }, null, 2));
process.exit(failed ? 1 : 0);
