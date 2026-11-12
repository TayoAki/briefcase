import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { dueDisposition } from './workflows/technology.mjs';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const policy = data => ({ policyReference: data.policyReference, records: data.records.map(({ binding, retainUntil, authorityReference }) =>
  ({ binding, retainUntil, authorityReference })).sort((a, b) => a.binding.documentId.localeCompare(b.binding.documentId)) });

/** Read-only, bounded cron entry point. Artifacts are proposals, never deletion authorization. */
export async function runRecordsSchedule({ baseUrl, username, password, maxItems = 100, now = new Date().toISOString(), fetchImpl = fetch }) {
  const base = new URL(baseUrl);
  if (base.username || base.password || base.search || base.hash || !['', '/'].includes(base.pathname) ||
      (base.protocol !== 'https:' && !(base.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname)))) {
    throw new Error('Use the configured HTTPS Briefcase origin or a loopback test server.');
  }
  if (typeof username !== 'string' || !username || typeof password !== 'string' || !password ||
      !Number.isSafeInteger(maxItems) || maxItems < 1 || maxItems > 500 || !Number.isFinite(Date.parse(now))) {
    throw new Error('Configure a records-assignee account, a valid capture time, and a batch limit from 1 to 500.');
  }
  const authorization = 'Basic ' + Buffer.from(username + ':' + password).toString('base64');
  async function read(path) {
    const response = await fetchImpl(new URL(path, base.origin), { headers: { Authorization: authorization }, redirect: 'error', signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw Object.assign(new Error('Records schedule evidence is unavailable.'), { status: response.status });
    return response.json();
  }
  const queue = await read('/api/workbench');
  const candidates = queue.items.filter(row => row.roleId === 'R63' && row.assignee === username);
  const jobs = [], skipped = [];
  for (const row of candidates.slice(0, maxItems)) {
    try {
      const detail = await read('/api/workbench/' + encodeURIComponent(row.id));
      const item = detail.item;
      const approved = item.versions.findLast(version => version.decision?.action === 'approve');
      if (!approved || digest(policy(approved.data)) !== digest(policy(item.data))) {
        skipped.push({ workItemId: row.id, reason: 'retention policy needs review' }); continue;
      }
      if (detail.validation.errors.length) {
        skipped.push({ workItemId: row.id, reason: 'current evidence is not valid' }); continue;
      }
      const activeHolds = documentId => detail.externalHolds?.find(row => row.documentId === documentId)?.holds ?? [];
      const due = dueDisposition(item.data, { now, technology: { activeHolds } });
      const safeDue = due.map(({ documentId, sha256, eligible, blockedBy }) => ({ documentId, sha256, eligible, activeHoldCount: blockedBy.length }));
      const proposal = { workItemId: item.id, approvedPolicySha256: approved.sha256, policyDigest: digest(policy(item.data)), candidates: safeDue };
      // A new hold, changed policy, or revoked access during this run invalidates this proposal.
      const current = await read('/api/workbench/' + encodeURIComponent(row.id));
      if (current.item.revision !== item.revision || current.validation.errors.length || digest(current.externalHolds ?? []) !== digest(detail.externalHolds ?? [])) {
        skipped.push({ workItemId: row.id, reason: 'record changed during schedule evaluation' }); continue;
      }
      jobs.push({ ...proposal, jobId: digest(proposal), observedRevision: item.revision,
        status: safeDue.some(entry => !entry.eligible) ? 'held' : safeDue.length ? 'ready_for_review' : 'nothing_due',
        destructiveActionAuthorized: false, nextStep: safeDue.some(entry => !entry.eligible) ? 'Preserve records until all holds are released.' :
          safeDue.length ? 'An assigned reviewer must authorize the current manifest; record and verify the connector receipt afterward.' : 'Wait for a reviewed retention date to become due.' });
    } catch (error) {
      if (![401, 403, 404, 409].includes(error.status)) throw error;
      skipped.push({ workItemId: row.id, reason: 'current access or evidence unavailable' });
    }
  }
  return { capturedAt: now, examined: Math.min(candidates.length, maxItems), remaining: Math.max(0, candidates.length - maxItems), jobs, skipped };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const result = await runRecordsSchedule({ baseUrl: process.env.BRIEFCASE_SCHEDULER_ORIGIN,
      username: process.env.BRIEFCASE_SCHEDULER_USER, password: process.env.BRIEFCASE_SCHEDULER_PASSWORD,
      maxItems: Number(process.env.BRIEFCASE_SCHEDULER_LIMIT || 100) });
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } catch {
    process.stderr.write('Records schedule could not obtain current authorized evidence. Check the origin, account, and server status.\n');
    process.exitCode = 1;
  }
}
