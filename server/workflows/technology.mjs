import { createHash, createPublicKey, verify } from 'node:crypto';

const field = (name, label, type = 'text', extra = {}) => ({ name, label, type, ...extra });
const sha = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
const fail = (ctx, message, status = 422) => ctx.fail(status, message);
const required = (value, label, ctx, max = 300) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) fail(ctx, label + ' is required.');
  return value.trim();
};
const array = (value, label, ctx, max = 500) => {
  if (!Array.isArray(value) || value.length > max) fail(ctx, label + ' must be a bounded list.');
  return value;
};
const integer = (value, label, ctx, min = 0) => {
  if (!Number.isSafeInteger(value) || value < min) fail(ctx, label + ' must be a whole number.');
  return value;
};
const timestamp = (value, label, ctx) => {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) fail(ctx, label + ' must be an ISO timestamp.');
  return value;
};
const reviewer = ctx => { if (!ctx.isReviewer) fail(ctx, 'The assigned reviewer must perform this action.', 403); };
const live = (ctx, method, ...args) => {
  if (typeof ctx.technology?.[method] !== 'function') fail(ctx, 'The server has not enabled the required operational evidence source.', 409);
  return ctx.technology[method](...args);
};
const event = (state, ctx, action, detail) => {
  state.events ??= [];
  if (state.events.length >= 500) fail(ctx, 'Start a follow-up work item after 500 events.', 409);
  state.events.push({ action, actor: ctx.user.username, at: ctx.now, ...detail });
};
const checkBinding = (binding, ctx) => {
  const doc = ctx.source(binding.documentId, binding.page);
  if (doc.sha256 !== binding.sha256) fail(ctx, 'A bound original changed. Reconcile the source before continuing.', 409);
  return doc;
};
const bind = (documentId, ctx) => ctx.sourceBinding(required(documentId, 'Document ID', ctx, 100));
const result = (errors = [], warnings = []) => ({ errors, warnings });
const allowedKeys = (value, keys, ctx) => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) fail(ctx, 'The record contains unsupported fields.');
};

export function verifyDiligenceEnvelope(envelope, expected, ctx) {
  allowedKeys(envelope, ['payload', 'signature', 'keyId'], ctx);
  const keyId = required(envelope.keyId, 'Provider key ID', ctx, 80);
  const publicKey = ctx.diligenceKeys?.[keyId];
  if (!publicKey) fail(ctx, 'This identity provider has no trusted verification key configured.', 409);
  const payload = envelope.payload;
  allowedKeys(payload, ['firm', 'caseReference', 'requestReference', 'provider', 'sequence', 'status', 'issuedAt', 'expiresAt', 'evidenceHash'], ctx);
  const signature = required(envelope.signature, 'Provider signature', ctx, 500);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(signature)) fail(ctx, 'The provider signature is not valid base64.');
  let valid = false;
  try {
    const key = createPublicKey(publicKey);
    valid = key.asymmetricKeyType === 'ed25519' && verify(null, Buffer.from(JSON.stringify(payload)), key, Buffer.from(signature, 'base64'));
  } catch { valid = false; }
  if (!valid) fail(ctx, 'The provider response signature could not be verified.', 409);
  if (payload.firm !== ctx.user.firm || payload.caseReference !== expected.caseReference || payload.requestReference !== expected.requestReference) {
    fail(ctx, 'The response belongs to a different firm or verification request.', 409);
  }
  if (!['clear', 'review', 'failed'].includes(payload.status)) fail(ctx, 'The provider status is not supported.');
  const issuedAt = timestamp(payload.issuedAt, 'Provider issue time', ctx);
  const expiresAt = timestamp(payload.expiresAt, 'Provider expiry', ctx);
  if (issuedAt > ctx.now || expiresAt <= ctx.now || expiresAt <= issuedAt) fail(ctx, 'The provider response is not current.', 409);
  integer(payload.sequence, 'Provider sequence', ctx, 1);
  required(payload.provider, 'Provider', ctx, 120);
  if (!/^[a-f0-9]{64}$/.test(payload.evidenceHash ?? '')) fail(ctx, 'A provider evidence digest is required.');
  return { ...payload, keyId, receiptHash: sha(envelope), verifiedAt: ctx.now, signedEnvelope: structuredClone(envelope) };
}

const diligence = {
  roleId: 'R17', title: 'Client identity verification',
  description: 'Verify signed provider status without storing identity documents. Unresolved or expired checks remain escalated.',
  fields: [field('caseReference', 'Restricted case reference'), field('requestReference', 'Provider request reference')],
  actions: [
    { id: 'provider-response', label: 'Verify provider response', fields: [field('envelope', 'Signed provider response', 'json', { hint: 'Trusted-key Ed25519 envelope: {keyId,payload:{firm,caseReference,requestReference,provider,sequence,status,issuedAt,expiresAt,evidenceHash},signature}. The server administrator configures public keys.' })] },
    { id: 'escalate', label: 'Route unresolved verification', fields: [field('owner', 'Escalation owner'), field('reason', 'Escalation reason')] },
  ],
  create(input, ctx) { return { caseReference: required(input.caseReference, 'Case reference', ctx), requestReference: required(input.requestReference, 'Request reference', ctx), status: 'pending', receipts: [], escalation: null, events: [] }; },
  update(state, action, input, ctx) {
    if (action === 'provider-response') {
      const receipt = verifyDiligenceEnvelope(input.envelope, state, ctx);
      const prior = state.receipts.find(row => row.sequence === receipt.sequence);
      if (prior) { if (prior.receiptHash !== receipt.receiptHash) fail(ctx, 'A conflicting provider replay was rejected.', 409); return state; }
      if (receipt.sequence <= (state.receipts.at(-1)?.sequence ?? 0)) fail(ctx, 'An older provider response cannot replace the current result.', 409);
      state.receipts.push(receipt); state.status = receipt.status;
      if (receipt.status === 'clear') state.escalation = null;
      event(state, ctx, 'provider response verified', { sequence: receipt.sequence, status: receipt.status, receiptHash: receipt.receiptHash });
    } else if (action === 'escalate') {
      if (state.status === 'clear' && state.receipts.at(-1)?.expiresAt > ctx.now) fail(ctx, 'A current clear result does not need an unresolved escalation.', 409);
      if (ctx.reviewer && input.owner !== ctx.reviewer) fail(ctx, 'Route this unresolved check to its assigned reviewing lawyer.', 422);
      state.escalation = { owner: required(input.owner, 'Escalation owner', ctx, 100), reason: required(input.reason, 'Escalation reason', ctx, 1000), at: ctx.now };
      event(state, ctx, 'verification escalated', { owner: state.escalation.owner });
    } else fail(ctx, 'Choose a verification action.');
    return state;
  },
  validate(state, ctx) {
    const latest = state.receipts.at(-1);
    if (latest) {
      const verified = verifyDiligenceEnvelope(latest.signedEnvelope, state, ctx);
      if (verified.receiptHash !== latest.receiptHash || verified.status !== latest.status || verified.sequence !== latest.sequence || verified.expiresAt !== latest.expiresAt) fail(ctx, 'The stored verification receipt failed its integrity check.', 409);
    }
    return result(!latest || latest.status !== 'clear' || latest.expiresAt <= ctx.now ? ['A current signed clear result is required before intake clearance.'] : [],
      ['Identity and beneficial-owner checks are performed by the configured provider; this workspace verifies its signed result.']);
  },
  output(state, ctx) { const latest = state.receipts.at(-1); return { caseReference: state.caseReference, status: latest?.expiresAt <= ctx.now ? 'expired' : state.status, clearanceAllowed: latest?.status === 'clear' && latest.expiresAt > ctx.now, provider: latest?.provider ?? null, verifiedAt: latest?.verifiedAt ?? null, receiptHash: latest?.receiptHash ?? null, escalationOwner: state.escalation?.owner ?? null }; },
};

function manifest(input, ctx) {
  allowedKeys(input, ['firm', 'capturedAt', 'originals', 'counts'], ctx);
  if (input.firm !== ctx.user.firm) fail(ctx, 'Recovery evidence belongs to another firm.', 409);
  timestamp(input.capturedAt, 'Manifest capture time', ctx);
  const originals = array(input.originals, 'Original manifest', ctx, 10000).map(row => {
    allowedKeys(row, ['id', 'sha256'], ctx);
    const id = required(row.id, 'Opaque source ID', ctx, 200);
    if (!/^[a-f0-9]{64}$/.test(row.sha256 ?? '')) fail(ctx, 'Every original needs a SHA-256 digest.');
    return { id, sha256: row.sha256 };
  }).sort((a, b) => a.id.localeCompare(b.id));
  if (new Set(originals.map(row => row.id)).size !== originals.length) fail(ctx, 'Original manifest contains duplicate source IDs.');
  if (!input.counts || typeof input.counts !== 'object' || Array.isArray(input.counts) || Object.keys(input.counts).length > 50) fail(ctx, 'Bounded table counts are required.');
  const counts = Object.fromEntries(Object.entries(input.counts).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => {
    if (!/^[a-z_]{1,60}$/.test(key)) fail(ctx, 'Invalid manifest table name.');
    return [key, integer(value, 'Table count', ctx)];
  }));
  return { firm: input.firm, capturedAt: input.capturedAt, originals, counts };
}
const manifestData = value => ({ firm: value.firm, originals: value.originals, counts: value.counts });
const recovery = {
  roleId: 'R59', title: 'Tenant recovery and integration review',
  description: 'Pin a server-generated tenant manifest, reconcile an isolated restore, and record the operator decision against those exact hashes.',
  fields: [field('environment', 'Recovery environment label'), field('inventory', 'Integration inventory', 'json', { hint: '[{"name":"Archive","owner":"operator","mode":"disabled|manual|connected","reference":"config/change reference"}]' })],
  actions: [
    { id: 'capture', label: 'Capture tenant recovery manifest', fields: [] },
    { id: 'restore-result', label: 'Reconcile isolated restore result', fields: [field('manifest', 'Restored tenant manifest', 'json', { hint: '{"firm":"your-firm-id","capturedAt":"2026-11-12T12:00:00.000Z","originals":[{"id":"opaque-source-id","sha256":"64-character-original-hash"}],"counts":{"matters":1,"originals":1}} — use evidence captured on the restored host.' }), field('runReference', 'Restore run reference'), field('environment', 'Isolated restore environment')] },
    { id: 'operator-review', label: 'Review recovery and integration inventory', reviewerOnly: true, fields: [field('notes', 'Operator review notes')] },
  ],
  create(input, ctx) {
    const inventory = array(input.inventory, 'Integration inventory', ctx, 50).map(row => {
      allowedKeys(row, ['name', 'owner', 'mode', 'reference'], ctx);
      if (!['disabled', 'manual', 'connected'].includes(row.mode)) fail(ctx, 'Choose disabled, manual, or connected for each integration.');
      return { name: required(row.name, 'Integration name', ctx), owner: required(row.owner, 'Integration owner', ctx), mode: row.mode, reference: required(row.reference, 'Configuration reference', ctx) };
    });
    if (!inventory.length || new Set(inventory.map(row => row.name)).size !== inventory.length) fail(ctx, 'Provide a nonempty inventory with unique integration names.');
    return { environment: required(input.environment, 'Environment', ctx), inventory, baseline: null, restore: null, operator: null, events: [] };
  },
  update(state, action, input, ctx) {
    if (action === 'capture') {
      state.baseline = manifest(live(ctx, 'recoveryManifest'), ctx); state.restore = null; state.operator = null;
      event(state, ctx, 'tenant manifest captured', { digest: sha(manifestData(state.baseline)) });
    } else if (action === 'restore-result') {
      if (!state.baseline) fail(ctx, 'Capture the source manifest first.', 409);
      const restored = manifest(input.manifest, ctx);
      const environment = required(input.environment, 'Restore environment', ctx);
      if (environment === state.environment) fail(ctx, 'Use a distinct isolated restore environment.', 409);
      if (sha(manifestData(restored)) !== sha(manifestData(state.baseline))) fail(ctx, 'The restored hashes or tenant table counts do not match.', 409);
      state.restore = { manifest: restored, environment, runReference: required(input.runReference, 'Restore run reference', ctx), digest: sha(manifestData(restored)) };
      state.operator = null; event(state, ctx, 'restore reconciled', { digest: state.restore.digest });
    } else if (action === 'operator-review') {
      reviewer(ctx); if (!state.restore) fail(ctx, 'A reconciled restore is required.', 409);
      state.operator = { by: ctx.user.username, at: ctx.now, notes: required(input.notes, 'Operator notes', ctx, 1200), digest: sha({ restore: state.restore, inventory: state.inventory }) };
      event(state, ctx, 'operator recovery review', { digest: state.operator.digest });
    } else fail(ctx, 'Choose a recovery action.');
    return state;
  },
  validate(state) { return result([!state.restore && 'Reconcile the restored tenant manifest.', !state.operator && 'The assigned operator must review recovery and integrations.'].filter(Boolean), ['Restore execution uses the maintenance CLI; a manually supplied manifest is evidence, not an automatic hosted deployment test.']); },
  output(state) { return { environment: state.environment, inventory: state.inventory, sourceDigest: state.baseline && sha(manifestData(state.baseline)), restore: state.restore, operator: state.operator, events: state.events }; },
};

const support = {
  roleId: 'R60', title: 'Import support and retry coordination',
  description: 'Diagnose actual import-job metadata, detect a stalled lease, and track retry completion without exposing original files.',
  fields: [field('jobId', 'Import job ID'), field('caseReference', 'Support case reference')],
  actions: [
    { id: 'refresh-job', label: 'Refresh server job evidence', fields: [] },
    { id: 'request-retry', label: 'Request a controlled retry', fields: [field('requestId', 'Unique retry request ID'), field('owner', 'Assigned reviewing lawyer for retry coordination'), field('reason', 'Diagnostic reason')] },
    { id: 'confirm-retry', label: 'Verify the replacement import', fields: [field('replacementJobId', 'Replacement import job ID')] },
  ],
  create(input, ctx) { return { jobId: required(input.jobId, 'Import job ID', ctx, 100), caseReference: required(input.caseReference, 'Support reference', ctx), job: null, retry: null, events: [] }; },
  update(state, action, input, ctx) {
    const jobs = live(ctx, 'supportJobs');
    const job = jobs.find(row => row.id === state.jobId);
    if (!job) fail(ctx, 'That import job is unavailable to this support account.', 404);
    const safe = row => ({ id: row.id, scopeKey: row.scopeKey, status: row.status, startedAt: row.startedAt ?? null, finishedAt: row.finishedAt ?? null, durationMs: row.durationMs ?? null });
    state.job = safe(job);
    if (action === 'refresh-job') event(state, ctx, 'job metadata refreshed', { status: job.status });
    else if (action === 'request-retry') {
      const requestId = required(input.requestId, 'Retry request ID', ctx, 100);
      if (ctx.reviewer && input.owner !== ctx.reviewer) fail(ctx, 'Route the retry request to the assigned reviewing lawyer.', 422);
      if (state.retry?.requestId === requestId) {
        if (state.retry.owner !== input.owner || state.retry.reason !== input.reason) fail(ctx, 'This retry ID was used with different inputs.', 409);
        return state;
      }
      if (state.retry && !state.retry.completed) fail(ctx, 'A retry is already outstanding.', 409);
      const started = Date.parse(job.startedAt);
      if (!['failed', 'stalled'].includes(job.status) && !(job.status === 'running' && Number.isFinite(started) && Date.parse(ctx.now) - started >= 15 * 60_000)) {
        fail(ctx, 'Only a failed or demonstrably stalled job can be retried.', 409);
      }
      state.retry = { requestId, owner: required(input.owner, 'Retry owner', ctx, 100), reason: required(input.reason, 'Diagnostic reason', ctx, 1000), at: ctx.now, completed: null };
      event(state, ctx, 'controlled retry requested', { requestId });
    } else if (action === 'confirm-retry') {
      if (!state.retry) fail(ctx, 'Request a retry first.', 409);
      const replacement = jobs.find(row => row.id === input.replacementJobId);
      if (!replacement || !job.scopeKey || replacement.scopeKey !== job.scopeKey || replacement.id === job.id || replacement.status !== 'complete' || !replacement.startedAt || replacement.startedAt < state.retry.at) fail(ctx, 'Choose a completed replacement job started after this retry request.', 409);
      state.retry.completed = { job: safe(replacement), checkedAt: ctx.now };
      event(state, ctx, 'replacement import verified', { replacementJobId: replacement.id });
    } else fail(ctx, 'Choose a support action.');
    return state;
  },
  validate(state, ctx) { const replacement = state.retry?.completed && live(ctx, 'supportJobs').find(row => row.id === state.retry.completed.job.id); return result(replacement?.status === 'complete' && replacement.scopeKey === state.job?.scopeKey ? [] : ['Verify a completed replacement import before closing the support case.'], ['Retry execution is performed by the authorized matter owner; support sees metadata only.']); },
  output(state) { return { caseReference: state.caseReference, job: state.job, retry: state.retry, events: state.events }; },
};

const security = {
  roleId: 'R61', title: 'Access revocation verification',
  description: 'Reconcile actual download and revocation events and confirm the account is inactive before closing the incident.',
  fields: [field('username', 'Account under investigation'), field('incidentReference', 'Incident reference')],
  actions: [
    { id: 'capture-evidence', label: 'Capture current access evidence', fields: [] },
    { id: 'verify-revocation', label: 'Verify current account revocation', fields: [] },
  ],
  create(input, ctx) { return { username: required(input.username, 'Account', ctx, 60), incidentReference: required(input.incidentReference, 'Incident reference', ctx), evidence: [], revoked: null, events: [] }; },
  update(state, action, _input, ctx) {
    const active = live(ctx, 'accountActive', state.username);
    if (action === 'capture-evidence') {
      state.evidence = live(ctx, 'securityEvents').filter(row => row.actor === state.username).map(({ id, actor, action, at }) => ({ id, actor, action, at }));
      state.revoked = null; event(state, ctx, 'access evidence captured', { count: state.evidence.length, active });
    } else if (action === 'verify-revocation') {
      if (active) fail(ctx, 'The account remains active. Revoke it through Identity and access first.', 409);
      if (!state.evidence.some(row => row.actor === state.username)) fail(ctx, 'Capture activity evidence for this account before closing the incident.', 409);
      state.revoked = { at: ctx.now, by: ctx.user.username, evidenceHash: sha(state.evidence), active: false };
      event(state, ctx, 'account revocation verified', { evidenceHash: state.revoked.evidenceHash });
    } else fail(ctx, 'Choose a security action.');
    return state;
  },
  validate(state, ctx) { return result(!state.revoked || live(ctx, 'accountActive', state.username) ? ['Current account revocation must be verified.'] : [], ['Provider-side cancellation requires its own integration; Briefcase rechecks access before committing an in-flight import.']); },
  output(state) { return { incidentReference: state.incidentReference, username: state.username, evidence: state.evidence, revocation: state.revoked, events: state.events }; },
};

export function searchDmsIndex(state, ctx, query) {
  const needle = String(query ?? '').trim().toLowerCase();
  if (!needle) return [];
  return state.entries.filter(entry => {
    try { const source = checkBinding(entry.binding, ctx); return source.name.toLowerCase().includes(needle) || source.pages.some(page => String(page.text ?? '').toLowerCase().includes(needle)); }
    catch (error) { if ([403, 404].includes(error.status)) return false; throw error; }
  }).map(entry => ({ externalId: entry.externalId, documentId: entry.binding.documentId, sha256: entry.binding.sha256, importedAt: entry.importedAt }));
}
const dms = {
  roleId: 'R62', title: 'Document source synchronization',
  description: 'Bind imported originals to external document IDs, reject conflicting replays, and recheck current source access before search and export.',
  matterRequired: true,
  fields: [field('connector', 'Document system reference')],
  actions: [
    { id: 'import-source', label: 'Bind imported original', fields: [field('externalId', 'External document ID'), field('documentId', 'Imported Briefcase document ID'), field('sourceVersion', 'External source version')] },
    { id: 'search', label: 'Search currently accessible originals', fields: [field('query', 'Search text')] },
    { id: 'reconcile', label: 'Recheck all source permissions and hashes', fields: [] },
  ],
  create(input, ctx) { return { connector: required(input.connector, 'Document system reference', ctx), entries: [], results: [], checkedAt: null, events: [] }; },
  update(state, action, input, ctx) {
    if (action === 'import-source') {
      const externalId = required(input.externalId, 'External ID', ctx);
      const binding = bind(input.documentId, ctx);
      const sourceVersion = required(input.sourceVersion, 'Source version', ctx, 100);
      const prior = state.entries.find(row => row.externalId === externalId && row.sourceVersion === sourceVersion);
      if (prior) { if (prior.binding.sha256 !== binding.sha256) fail(ctx, 'A source version cannot change its original hash.', 409); return state; }
      if (state.entries.length >= 500) fail(ctx, 'Use a separate synchronization batch after 500 originals.', 409);
      state.entries.push({ externalId, sourceVersion, binding, importedAt: ctx.now }); state.checkedAt = null;
      event(state, ctx, 'original bound', { externalId, sourceVersion, sha256: binding.sha256 });
    } else if (action === 'search') {
      state.results = searchDmsIndex(state, ctx, required(input.query, 'Query', ctx, 200));
      event(state, ctx, 'current-access search', { count: state.results.length });
    } else if (action === 'reconcile') {
      for (const entry of state.entries) checkBinding(entry.binding, ctx);
      state.checkedAt = ctx.now; event(state, ctx, 'original hashes reconciled', { count: state.entries.length });
    } else fail(ctx, 'Choose a document synchronization action.');
    return state;
  },
  validate(state, ctx) {
    for (const entry of state.entries) checkBinding(entry.binding, ctx);
    return result(!state.entries.length || !state.checkedAt ? ['Import and reconcile at least one source original.'] : [], ['The document-system upload/import is explicit; no enterprise DMS connection is inferred from a source reference.']);
  },
  output(state, ctx) {
    const entries = state.entries.filter(entry => { try { checkBinding(entry.binding, ctx); return true; } catch (error) { if ([403, 404].includes(error.status)) return false; throw error; } });
    return { connector: state.connector, entries, checkedAt: state.checkedAt, events: state.events };
  },
};

export function dueDisposition(state, ctx) {
  const holds = state.holds.filter(hold => !hold.released);
  return state.records.filter(record => !record.disposed && record.retainUntil <= ctx.now).map(record => {
    const blockedBy = [...new Set([...holds.map(hold => hold.reference), ...(ctx.technology?.activeHolds?.(record.binding.documentId) ?? [])])].sort();
    return { documentId: record.binding.documentId, sha256: record.binding.sha256, eligible: blockedBy.length === 0, blockedBy };
  });
}
const records = {
  roleId: 'R63', title: 'Retention holds and disposition',
  description: 'Preserve source-bound holds across restores and gate a scheduled disposition manifest on reviewed retention dates and released holds.',
  matterRequired: true,
  fields: [field('policyReference', 'Reviewed retention policy reference')],
  actions: [
    { id: 'schedule', label: 'Schedule a reviewed retention date', fields: [field('documentId', 'Original document ID'), field('retainUntil', 'Retain until (ISO timestamp)'), field('authorityReference', 'Retention authority reference')] },
    { id: 'hold', label: 'Place a preservation hold', fields: [field('reference', 'Hold reference'), field('reason', 'Hold reason')] },
    { id: 'release-hold', label: 'Authorize hold release', reviewerOnly: true, fields: [field('reference', 'Hold reference'), field('authorityReference', 'Release authority reference')] },
    { id: 'run-schedule', label: 'Evaluate scheduled disposition', fields: [] },
    { id: 'authorize-disposition', label: 'Authorize exact disposition manifest', reviewerOnly: true, fields: [field('manifestHash', 'Current disposition manifest hash'), field('reason', 'Authorization reason')] },
    { id: 'record-disposition', label: 'Record connector disposition receipt', fields: [field('manifestHash', 'Authorized manifest hash'), field('receiptReference', 'Connector receipt reference'), field('documentIds', 'Disposed document IDs', 'json', { hint: '["document-id-from-authorized-manifest"] — only IDs listed in the exact approved manifest.' })] },
  ],
  create(input, ctx) { return { policyReference: required(input.policyReference, 'Retention policy', ctx), records: [], holds: [], evaluation: null, authorization: null, receipts: [], events: [] }; },
  update(state, action, input, ctx) {
    if (action === 'schedule') {
      const binding = bind(input.documentId, ctx);
      if (state.records.some(row => row.binding.documentId === binding.documentId)) fail(ctx, 'That original already has a retention schedule.', 409);
      state.records.push({ binding, retainUntil: timestamp(input.retainUntil, 'Retention date', ctx), authorityReference: required(input.authorityReference, 'Retention authority', ctx), disposed: null });
      state.evaluation = null; state.authorization = null;
      event(state, ctx, 'retention scheduled', { documentId: binding.documentId });
    } else if (action === 'hold') {
      const reference = required(input.reference, 'Hold reference', ctx);
      if (state.holds.some(row => row.reference === reference && !row.released)) return state;
      state.holds.push({ reference, reason: required(input.reason, 'Hold reason', ctx, 1000), at: ctx.now, by: ctx.user.username, released: null });
      state.evaluation = null; state.authorization = null; event(state, ctx, 'preservation hold placed', { reference });
    } else if (action === 'release-hold') {
      reviewer(ctx);
      const hold = state.holds.find(row => row.reference === input.reference && !row.released);
      if (!hold) fail(ctx, 'That active hold is unavailable.', 404);
      hold.released = { by: ctx.user.username, at: ctx.now, authorityReference: required(input.authorityReference, 'Release authority', ctx) };
      state.evaluation = null; state.authorization = null; event(state, ctx, 'hold release authorized', { reference: hold.reference });
    } else if (action === 'run-schedule') {
      for (const row of state.records.filter(row => !row.disposed)) checkBinding(row.binding, ctx);
      const candidates = dueDisposition(state, ctx);
      state.evaluation = { at: ctx.now, candidates, manifestHash: sha(candidates) }; state.authorization = null;
      event(state, ctx, 'disposition schedule evaluated', { manifestHash: state.evaluation.manifestHash });
    } else if (action === 'authorize-disposition') {
      reviewer(ctx);
      const candidates = dueDisposition(state, ctx);
      if (!state.evaluation || state.evaluation.manifestHash !== input.manifestHash || sha(candidates) !== input.manifestHash || !candidates.length || candidates.some(row => !row.eligible)) fail(ctx, 'Current eligible candidates without active holds are required.', 409);
      state.authorization = { manifestHash: input.manifestHash, at: ctx.now, by: ctx.user.username, reason: required(input.reason, 'Disposition reason', ctx, 1000) };
      event(state, ctx, 'exact disposition authorized', { manifestHash: input.manifestHash });
    } else if (action === 'record-disposition') {
      const candidates = dueDisposition(state, ctx);
      if (!state.authorization || state.authorization.manifestHash !== input.manifestHash || sha(candidates) !== input.manifestHash || candidates.some(row => !row.eligible)) fail(ctx, 'An active hold or changed manifest prevents disposition.', 409);
      const ids = array(input.documentIds, 'Disposed document IDs', ctx).map(id => required(id, 'Document ID', ctx, 100));
      if (!ids.length || new Set(ids).size !== ids.length || ids.some(id => !candidates.some(row => row.documentId === id))) fail(ctx, 'Receipt IDs must be distinct members of the authorized manifest.');
      const receiptReference = required(input.receiptReference, 'Connector receipt reference', ctx);
      if (state.receipts.some(row => row.receiptReference === receiptReference)) fail(ctx, 'That connector receipt was already recorded.', 409);
      const receipt = { receiptReference, manifestHash: input.manifestHash, documentIds: ids, at: ctx.now, by: ctx.user.username };
      state.receipts.push(receipt);
      for (const row of state.records.filter(row => ids.includes(row.binding.documentId))) row.disposed = receiptReference;
      state.evaluation = null; state.authorization = null;
      event(state, ctx, 'connector disposition receipt recorded', { receiptReference, count: ids.length });
    } else fail(ctx, 'Choose a records action.');
    return state;
  },
  validate(state, ctx) {
    for (const row of state.records.filter(row => !row.disposed)) checkBinding(row.binding, ctx);
    const errors = [];
    if (!state.records.length) errors.push('Schedule at least one source original.');
    if (!state.evaluation && !state.receipts.length) errors.push('Evaluate the retention schedule or record the authorized connector result.');
    return result(errors, ['A connector receipt records externally executed disposition. Briefcase does not delete retained originals from this workbench.']);
  },
  output(state, ctx) { return { policyReference: state.policyReference, records: state.records, holds: state.holds, due: dueDisposition(state, ctx), evaluation: state.evaluation, authorization: state.authorization, receipts: state.receipts, events: state.events }; },
};

diligence.assertExport = (current, _version, ctx) => { if (diligence.validate(current, ctx).errors.length) fail(ctx, 'The current provider status does not permit clearance export.', 409); };
security.assertExport = (current, _version, ctx) => { if (security.validate(current, ctx).errors.length) fail(ctx, 'Current account revocation must be verified before export.', 409); };
dms.assertExport = (current, version, ctx) => { for (const entry of [...current.entries, ...version.entries]) checkBinding(entry.binding, ctx); };
records.assertExport = (current, version, ctx) => {
  if (version.authorization && (dueDisposition(current, ctx).some(row => !row.eligible) || !current.authorization || current.authorization.manifestHash !== version.authorization.manifestHash)) fail(ctx, 'The old disposition authorization is no longer current.', 409);
  for (const record of current.records.filter(record => !record.disposed)) checkBinding(record.binding, ctx);
};

export const workflows = [diligence, recovery, support, security, dms, records];
