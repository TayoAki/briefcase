import '../../dist/vendor/packets/jszip.mjs';

// Specialist business rules. Storage, actor assignment and exact-version approval
// are supplied by the authenticated workbench service.
const field = (name, label, type = 'text', extra = {}) => ({ name, label, type, required: true, ...extra });
const action = (id, label, fields = [], reviewerOnly = false) => ({ id, label, fields, ...(reviewerOnly ? { reviewerOnly } : {}) });
const fail = (ctx, message, status = 422) => ctx.fail(status, message);
function text(value, label, ctx, max = 4000) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) fail(ctx, `${label} is required and must be at most ${max} characters.`);
  return value.trim();
}
function integer(value, label, ctx, max = 1_000_000_000_000) {
  if (!Number.isSafeInteger(value) || value < 0 || value > max) fail(ctx, `${label} must be a nonnegative whole number up to ${max}.`);
  return value;
}
function date(value, label, ctx) {
  const result = text(value, label, ctx, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(result) || !Number.isFinite(Date.parse(result + 'T00:00:00.000Z')) || new Date(result + 'T00:00:00.000Z').toISOString().slice(0, 10) !== result) fail(ctx, `Enter a valid ${label}.`);
  return result;
}
function reviewer(ctx) { if (!ctx.isReviewer || ctx.user.role !== 'lawyer') fail(ctx, 'The assigned reviewing lawyer must perform this action.', 403); }
function clone(state) { return structuredClone(state); }
function bound(input, ctx, prefix = '') {
  const id = text(input[prefix + 'documentId'], 'Source document', ctx, 100);
  const page = integer(input[prefix + 'page'], 'Source page', ctx, 100000);
  if (page < 1) fail(ctx, 'Choose a physical source page.');
  return ctx.sourceBinding(id, page);
}
function source(binding, ctx) {
  const result = ctx.source(binding.documentId, binding.page);
  if (result.sha256 !== binding.sha256) fail(ctx, 'The source changed. Bind and review the current original.', 409);
  if (binding.page && !result.pages.some(page => page.number === binding.page)) fail(ctx, 'The bound physical source page is missing.', 409);
  return result;
}
function sourceErrors(bindings, ctx) {
  const errors = [];
  for (const binding of bindings.filter(Boolean)) {
    try { source(binding, ctx); } catch (error) { errors.push(error.message); }
  }
  return errors;
}
function unknown(ctx) { fail(ctx, 'Choose an available workflow action.'); }
const sourceFields = [field('documentId', 'Original document ID'), field('page', 'Physical page', 'number')];
const result = (errors = [], warnings = []) => ({ errors, warnings });
const summaryDate = value => value.slice(0, 10);

// R29: Every amendment produces a new candidate and withdraws the old confirmation.
function docketCandidate(input, ctx, sequence) {
  const binding = bound(input, ctx);
  const document = source(binding, ctx);
  const dueDate = date(input.dueDate, 'proposed due date', ctx);
  const excerpt = text(input.excerpt, 'Order excerpt', ctx, 3000);
  const pageText = document.pages.find(page => page.number === binding.page)?.text ?? '';
  if (!pageText.includes(excerpt)) fail(ctx, 'The order excerpt must occur on the selected physical source page.');
  const candidate = { sequence, noticeRef: text(input.noticeRef, 'Notice reference', ctx, 180), dueDate, excerpt, source: binding, createdAt: ctx.now, by: ctx.user.username };
  candidate.hash = ctx.hash(candidate);
  return candidate;
}
const docket = {
  roleId: 'R29', title: 'Reviewed docket amendments', matterRequired: true,
  description: 'Bind an order to its original page, replace amended dates, and require a fresh lawyer confirmation.',
  fields: [field('event', 'Calendar event'), field('noticeRef', 'Notice reference'), ...sourceFields, field('dueDate', 'Proposed due date', 'date'), field('excerpt', 'Exact order excerpt', 'textarea')],
  actions: [
    action('amend', 'Record amended order', [field('noticeRef', 'New notice reference'), ...sourceFields, field('dueDate', 'New proposed due date', 'date'), field('excerpt', 'Exact amended excerpt', 'textarea')]),
    action('confirm-date', 'Confirm current date', [field('candidateHash', 'Current candidate hash'), field('notes', 'Source and date review', 'textarea')], true),
    action('override-date', 'Confirm a sourced override', [field('candidateHash', 'Current candidate hash'), ...sourceFields, field('dueDate', 'Override due date', 'date'), field('reason', 'Override rationale', 'textarea')], true),
  ],
  create(input, ctx) { return { event: text(input.event, 'Calendar event', ctx, 180), candidates: [docketCandidate(input, ctx, 1)], confirmation: null }; },
  update(state, actionId, input, ctx) {
    const next = clone(state), current = next.candidates.at(-1);
    if (actionId === 'amend') {
      const candidate = docketCandidate(input, ctx, current.sequence + 1);
      if (candidate.noticeRef === current.noticeRef && candidate.source.sha256 === current.source.sha256 && candidate.dueDate === current.dueDate && candidate.excerpt === current.excerpt) fail(ctx, 'This notice is already the current candidate.', 409);
      current.supersededAt = ctx.now;
      current.priorConfirmation = next.confirmation;
      next.candidates.push(candidate); next.confirmation = null;
    } else if (['confirm-date', 'override-date'].includes(actionId)) {
      reviewer(ctx);
      if (input.candidateHash !== current.hash) fail(ctx, 'The candidate changed. Review the current amended order.', 409);
      source(current.source, ctx);
      const override = actionId === 'override-date';
      const evidence = override ? bound(input, ctx) : current.source;
      source(evidence, ctx);
      next.confirmation = { candidateHash: current.hash, dueDate: override ? date(input.dueDate, 'override date', ctx) : current.dueDate,
        source: evidence, reason: text(override ? input.reason : input.notes, override ? 'Override rationale' : 'Review notes', ctx), override, by: ctx.user.username, at: ctx.now };
    } else unknown(ctx);
    return next;
  },
  validate(state, ctx) {
    const current = state.candidates.at(-1);
    const errors = sourceErrors([current.source, state.confirmation?.source], ctx);
    if (!state.confirmation || state.confirmation.candidateHash !== current.hash) errors.push('The current order requires a fresh lawyer date confirmation.');
    return result(errors, ['Dates are reviewed from supplied orders; jurisdictional rules are not calculated automatically.']);
  },
  output(state) { return { event: state.event, currentCandidate: state.candidates.at(-1), confirmedDate: state.confirmation, supersededCandidates: state.candidates.slice(0, -1) }; },
  assertExport(current, submitted, ctx) {
    if (current.candidates.at(-1).hash !== submitted.candidates.at(-1).hash || ctx.hash(current.confirmation) !== ctx.hash(submitted.confirmation)) fail(ctx, 'This docket version was superseded. Review and export the current confirmed date.', 409);
  },
};

// R33: Money is integer cents and every imported cost has a stable external ID.
const spent = state => state.costs.reduce((sum, row) => sum + row.cents, 0);
const costHash = (state, ctx) => ctx.hash(state.costs);
const project = {
  roleId: 'R33', title: 'Scope and spending control',
  description: 'Reconcile cost records, propose a scope/budget change, and wait for a lawyer decision on the current spending snapshot.',
  fields: [field('scope', 'Current approved scope', 'textarea'), field('budgetCents', 'Approved budget (cents)', 'number'), field('budgetReference', 'Budget approval reference')],
  actions: [
    action('cost', 'Import a cost record', [field('externalId', 'Stable ledger transaction ID'), field('cents', 'Cost (cents)', 'number'), field('date', 'Cost date', 'date'), field('description', 'Cost description')]),
    action('propose', 'Propose a scope change', [field('scope', 'Proposed scope', 'textarea'), field('budgetCents', 'Proposed budget (cents)', 'number'), field('reason', 'Reason', 'textarea')]),
    action('accept-change', 'Approve current scope change', [field('proposalHash', 'Current proposal hash'), field('notes', 'Lawyer review notes', 'textarea')], true),
  ],
  create(input, ctx) { return { baseline: { scope: text(input.scope, 'Scope', ctx), budgetCents: integer(input.budgetCents, 'Budget cents', ctx), reference: text(input.budgetReference, 'Budget approval reference', ctx, 180) }, costs: [], proposals: [], decision: null }; },
  update(state, actionId, input, ctx) {
    const next = clone(state);
    if (actionId === 'cost') {
      const row = { externalId: text(input.externalId, 'Ledger transaction ID', ctx, 180), cents: integer(input.cents, 'Cost cents', ctx), date: date(input.date, 'cost date', ctx), description: text(input.description, 'Cost description', ctx, 400) };
      const previous = next.costs.find(entry => entry.externalId === row.externalId);
      if (previous) { if (ctx.hash(previous) !== ctx.hash(row)) fail(ctx, 'This ledger transaction ID was already used for different data.', 409); return next; }
      if (!Number.isSafeInteger(spent(next) + row.cents)) fail(ctx, 'Cost total exceeds safe integer cents.');
      next.costs.push(row); next.decision = null;
    } else if (actionId === 'propose') {
      const proposal = { sequence: next.proposals.length + 1, scope: text(input.scope, 'Proposed scope', ctx), budgetCents: integer(input.budgetCents, 'Proposed budget', ctx), reason: text(input.reason, 'Change reason', ctx), spendToDateCents: spent(next), costsHash: costHash(next, ctx), at: ctx.now };
      if (proposal.budgetCents < proposal.spendToDateCents) fail(ctx, 'The proposed budget cannot be below recorded spend.');
      proposal.hash = ctx.hash(proposal); next.proposals.push(proposal); next.decision = null;
    } else if (actionId === 'accept-change') {
      reviewer(ctx);
      const proposal = next.proposals.at(-1);
      if (!proposal || input.proposalHash !== proposal.hash || proposal.costsHash !== costHash(next, ctx)) fail(ctx, 'The proposal or spending changed. Create and review a current proposal.', 409);
      next.decision = { proposalHash: proposal.hash, costsHash: costHash(next, ctx), by: ctx.user.username, at: ctx.now, notes: text(input.notes, 'Lawyer review notes', ctx) };
    } else unknown(ctx);
    return next;
  },
  validate(state, ctx) {
    const proposal = state.proposals.at(-1);
    return result(!proposal || !state.decision || state.decision.proposalHash !== proposal.hash || state.decision.costsHash !== costHash(state, ctx) ? ['A lawyer must approve a proposal reconciled to the current spending records.'] : [], ['Ledger costs are imported records; this workflow does not initiate payments.']);
  },
  output(state) { const proposed = state.proposals.at(-1); return { baseline: state.baseline, spendToDateCents: spent(state), remainingBaselineCents: state.baseline.budgetCents - spent(state), proposed, proposedRemainingCents: proposed ? proposed.budgetCents - spent(state) : null, decision: state.decision, costs: state.costs, history: state.proposals }; },
};

// R34: Operational data is loaded from actual workbench assignments, never from
// user supplied matter names. Root limits this capability to creator-owned work.
function operations(ctx) { if (!ctx.operations) fail(ctx, 'The authorized operational queue is unavailable.', 503); return ctx.operations; }
function routingQueue(ctx) {
  return operations(ctx).queue().map(({ id, roleId, assignee, status, updatedAt, revision }) => ({ id, roleId, assignee, status, updatedAt, revision }));
}
const management = {
  roleId: 'R34', title: 'Practice work routing',
  description: 'Inspect a metadata-only queue and route delegated assignments without receiving matter contents.',
  fields: [field('reviewLabel', 'Operations review label'), field('staleHours', 'Bottleneck threshold (hours)', 'number')],
  actions: [action('refresh-queue', 'Refresh delegated queue'), action('reassign', 'Reassign a delegated item', [field('workId', 'Work item ID'), field('username', 'New assignee username'), field('expectedRevision', 'Work item revision', 'number'), field('reason', 'Routing reason', 'textarea')])],
  create(input, ctx) { return { reviewLabel: text(input.reviewLabel, 'Review label', ctx, 180), staleHours: integer(input.staleHours, 'Bottleneck threshold', ctx, 8760), queue: routingQueue(ctx), capturedAt: ctx.now, handoffs: [] }; },
  update(state, actionId, input, ctx) {
    const next = clone(state);
    if (actionId === 'reassign') {
      const workId = text(input.workId, 'Work item ID', ctx, 100), username = text(input.username, 'New assignee', ctx, 60);
      const current = routingQueue(ctx).find(row => row.id === workId);
      if (!current) fail(ctx, 'That delegated assignment is unavailable.', 404);
      if (current.assignee === username) fail(ctx, 'Choose a different assignee.');
      if (!operations(ctx).roster().some(person => person.username === username)) fail(ctx, 'Choose an active person from this firm.', 422);
      const reason = text(input.reason, 'Routing reason', ctx, 1000);
      const updated = operations(ctx).reassign(workId, username, integer(input.expectedRevision, 'Work item revision', ctx));
      next.handoffs.push({ workId, from: current.assignee, to: username, revision: updated.revision, reason, by: ctx.user.username, at: ctx.now });
    } else if (actionId !== 'refresh-queue') unknown(ctx);
    next.queue = routingQueue(ctx); next.capturedAt = ctx.now;
    return next;
  },
  validate(state) { return result(state.handoffs.length ? [] : ['Record a delegated reassignment to complete this routing review.']); },
  output(state) {
    const at = Date.parse(state.capturedAt);
    return { reviewLabel: state.reviewLabel, capturedAt: state.capturedAt, queue: state.queue.map(row => ({ ...row, ageHours: Math.max(0, Math.floor((at - Date.parse(row.updatedAt)) / 3_600_000)), bottleneck: !['approved', 'canceled'].includes(row.status) && at - Date.parse(row.updatedAt) >= state.staleHours * 3_600_000 })), handoffs: state.handoffs };
  },
};

// R35/R37 share a deliberately bounded template language. No user code executes.
function template(value, ctx) {
  const body = text(value, 'Template body', ctx, 24000);
  const variables = [...body.matchAll(/\{\{\s*([a-zA-Z][a-zA-Z0-9_]{0,59})\s*\}\}/g)].map(match => match[1]);
  if (body.replace(/\{\{\s*[a-zA-Z][a-zA-Z0-9_]{0,59}\s*\}\}/g, '').match(/\{\{|\}\}/)) fail(ctx, 'Use only named {{field}} placeholders.');
  return { body, variables: [...new Set(variables)].sort() };
}
function renderTemplate(version, values, ctx) {
  if (!values || typeof values !== 'object' || Array.isArray(values)) fail(ctx, 'Supply an object of template values.');
  const keys = Object.keys(values);
  if (keys.some(key => !version.variables.includes(key))) fail(ctx, 'Template values contain an unrecognized field.');
  if (version.variables.some(key => typeof values[key] !== 'string' || !values[key].trim() || values[key].length > 4000)) fail(ctx, 'Every required template field needs a nonempty text value.');
  const output = version.body.replace(/\{\{\s*([a-zA-Z][a-zA-Z0-9_]{0,59})\s*\}\}/g, (_, name) => values[name]);
  if (output.length > 60000) fail(ctx, 'The generated text is too large.');
  return output;
}
function templateVersion(input, ctx, index) {
  const item = { number: index, ...template(input.body, ctx), changeNote: text(input.changeNote, 'Change note', ctx, 1200), createdBy: ctx.user.username, at: ctx.now };
  return { ...item, hash: ctx.hash(item) };
}
const knowledge = {
  roleId: 'R35', title: 'Governed template editions',
  description: 'Publish exact template editions and pin generated drafts to the edition used. TXT downloads the latest draft; ZIP contains all drafts with template snapshots and hashes.',
  fields: [field('name', 'Template name'), field('body', 'Template body with {{fields}}', 'textarea'), field('changeNote', 'Edition note')],
  actions: [action('edit-template', 'Create a template edition', [field('body', 'Template body', 'textarea'), field('changeNote', 'Change note')]), action('publish-template', 'Approve and publish an edition', [field('versionHash', 'Edition hash'), field('notes', 'Review notes', 'textarea')], true), action('draft', 'Create a draft from the current edition', [field('draftRef', 'Unique draft reference'), field('values', 'Template values', 'json', { hint: '{"client":"Example client"}' })])],
  create(input, ctx) { return { name: text(input.name, 'Template name', ctx, 180), versions: [templateVersion(input, ctx, 1)], publications: [], drafts: [] }; },
  update(state, actionId, input, ctx) {
    const next = clone(state);
    if (actionId === 'edit-template') next.versions.push(templateVersion(input, ctx, next.versions.length + 1));
    else if (actionId === 'publish-template') {
      reviewer(ctx);
      const version = next.versions.at(-1);
      if (input.versionHash !== version.hash) fail(ctx, 'Review the latest template edition.', 409);
      if (next.publications.at(-1)?.versionHash === version.hash) fail(ctx, 'This edition is already published.', 409);
      next.publications.push({ versionHash: version.hash, number: version.number, by: ctx.user.username, at: ctx.now, notes: text(input.notes, 'Review notes', ctx) });
    } else if (actionId === 'draft') {
      const publication = next.publications.at(-1);
      if (!publication) fail(ctx, 'Publish an approved template edition before generating a draft.', 409);
      const version = next.versions.find(row => row.hash === publication.versionHash);
      const draftRef = text(input.draftRef, 'Draft reference', ctx, 180), body = renderTemplate(version, input.values, ctx);
      const draft = { draftRef, templateHash: version.hash, templateEdition: version.number, values: input.values, body, bodyHash: ctx.hash(body) };
      const prior = next.drafts.find(row => row.draftRef === draftRef);
      if (prior) { if (ctx.hash(prior) !== ctx.hash(draft)) fail(ctx, 'That draft reference already identifies a different exact draft.', 409); return next; }
      next.drafts.push(draft);
    } else unknown(ctx);
    return next;
  },
  validate(state, ctx) {
    const errors = [];
    if (!state.publications.length) errors.push('An edition needs lawyer publication approval.');
    if (!state.drafts.length) errors.push('Create at least one draft from an approved edition.');
    for (const draft of state.drafts) {
      const version = state.versions.find(row => row.hash === draft.templateHash);
      if (!version || !state.publications.some(row => row.versionHash === version.hash) || renderTemplate(version, draft.values, ctx) !== draft.body || ctx.hash(draft.body) !== draft.bodyHash) errors.push(`Draft ${draft.draftRef} does not reproduce from its approved template.`);
    }
    return result(errors, ['This governed library is scoped to its assigned workbench participants.']);
  },
  output(state) { return { name: state.name, currentPublication: state.publications.at(-1) ?? null, editions: state.versions, publicationHistory: state.publications, drafts: state.drafts }; },
  formats: ['txt', 'zip'],
  async exportFile(state, ctx, format) {
    const checks = this.validate(state, ctx);
    if (checks.errors.length) fail(ctx, checks.errors.join(' '), 409);
    const latest = state.drafts.at(-1);
    const safeName = value => value.replace(/[^a-zA-Z0-9-]/g, '-').slice(0, 60) || 'draft';
    if (format === 'txt') return { bytes: Buffer.from(latest.body, 'utf8'), mime: 'text/plain; charset=utf-8', name: 'briefcase-' + safeName(latest.draftRef) + '.txt' };
    if (format !== 'zip') fail(ctx, 'Choose TXT for the latest draft or ZIP for every exact draft and template.');
    const zip = new globalThis.JSZip();
    const put = (path, content) => zip.file(path, content, { date: new Date('2000-01-01T00:00:00.000Z') });
    const drafts = state.drafts.map((draft, index) => {
      const file = `drafts/${String(index + 1).padStart(3, '0')}-${safeName(draft.draftRef)}.txt`;
      put(file, Buffer.from(draft.body, 'utf8'));
      return { reference: draft.draftRef, file, bodySha256: draft.bodyHash, templateEdition: draft.templateEdition, templateHash: draft.templateHash };
    });
    const templates = state.versions.filter(version => drafts.some(draft => draft.templateHash === version.hash)).map(version => {
      const file = `templates/edition-${version.number}.json`, content = JSON.stringify(version, null, 2);
      put(file, content);
      return { file, edition: version.number, templateHash: version.hash, fileSha256: ctx.hash(content) };
    });
    put('manifest.json', JSON.stringify({ name: state.name, currentPublishedTemplateHash: state.publications.at(-1)?.versionHash, drafts, templates, publications: state.publications }, null, 2));
    put('README.txt', 'Each draft TXT file contains the exact approved UTF-8 text, without added headers.\nmanifest.json binds draft byte hashes to the published template edition.\nTemplate snapshots preserve the body and named fields used to reproduce each draft.\nThis is a text-template package; Word and PDF layout are handled by Document production.\n');
    return { bytes: Buffer.from(await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', compressionOptions: { level: 6 }, platform: 'UNIX' })), mime: 'application/zip', name: 'briefcase-template-drafts.zip' };
  },
};

// R36: Authority records distinguish uploaded evidence from unavailable treatment.
const treatmentStatuses = ['not_checked', 'unavailable', 'no_adverse_treatment_reported', 'questioned', 'distinguished', 'overruled'];
function authority(input, ctx) {
  const binding = bound(input, ctx), document = source(binding, ctx);
  const excerpt = text(input.excerpt, 'Authority excerpt', ctx, 4000);
  if (!(document.pages.find(page => page.number === binding.page)?.text ?? '').includes(excerpt)) fail(ctx, 'The authority excerpt must occur on the source page.');
  const authorityDate = date(input.authorityDate, 'authority date', ctx);
  if (authorityDate > summaryDate(ctx.now)) fail(ctx, 'An authority date cannot be in the future.');
  const citation = text(input.citation, 'Citation', ctx, 500), sourceRef = text(input.sourceRef, 'Publisher or repository reference', ctx, 500);
  const url = typeof input.url === 'string' ? input.url.trim() : '';
  if (url) { let parsed; try { parsed = new URL(url); } catch { fail(ctx, 'Enter a valid source URL.'); } if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) fail(ctx, 'Use an HTTP(S) source URL without credentials.'); }
  return { id: text(input.id, 'Authority reference', ctx, 100), citation, authorityDate, sourceRef, url, excerpt, source: binding, capturedAt: ctx.now, treatment: { status: 'not_checked', provider: null, checkedAt: null, receipt: null } };
}
const research = {
  roleId: 'R36', title: 'Authority and treatment register', matterRequired: true,
  description: 'Return source-bound authorities with decision dates and explicit treatment evidence or an unavailable label.',
  fields: [field('question', 'Research question', 'textarea')],
  actions: [action('authority', 'Add a sourced authority', [field('id', 'Authority reference'), field('citation', 'Citation'), field('authorityDate', 'Decision/publication date', 'date'), field('sourceRef', 'Publisher or repository reference'), field('url', 'Source URL', 'text', { required: false }), ...sourceFields, field('excerpt', 'Exact source excerpt', 'textarea')]), action('treatment', 'Record treatment evidence', [field('id', 'Authority reference'), field('status', 'Treatment status', 'select', { options: treatmentStatuses }), field('provider', 'Provider or unavailability reason'), field('checkedAt', 'Checked date', 'date'), field('receipt', 'Provider report reference'), field('reportDocumentId', 'Treatment report original ID', 'text', { required: false }), field('reportPage', 'Treatment report page', 'number', { required: false })])],
  create(input, ctx) { return { question: text(input.question, 'Research question', ctx), authorities: [] }; },
  update(state, actionId, input, ctx) {
    const next = clone(state);
    if (actionId === 'authority') {
      const row = authority(input, ctx);
      const previous = next.authorities.find(entry => entry.id === row.id);
      if (previous) {
        const identity = entry => Object.fromEntries(['id', 'citation', 'authorityDate', 'sourceRef', 'url', 'excerpt', 'source'].map(key => [key, entry[key]]));
        if (ctx.hash(identity(previous)) !== ctx.hash(identity(row))) fail(ctx, 'That authority reference already identifies different source data.', 409);
        return next;
      }
      next.authorities.push(row);
    } else if (actionId === 'treatment') {
      const row = next.authorities.find(entry => entry.id === input.id);
      if (!row) fail(ctx, 'Choose an existing authority.', 404);
      if (!treatmentStatuses.includes(input.status) || input.status === 'not_checked') fail(ctx, 'Choose an observed treatment or unavailable status.');
      const checkedAt = date(input.checkedAt, 'treatment check date', ctx);
      if (checkedAt > summaryDate(ctx.now)) fail(ctx, 'The treatment check cannot be in the future.');
      if (checkedAt < row.authorityDate) fail(ctx, 'The treatment check cannot precede the authority date.');
      const reported = input.status !== 'unavailable';
      const report = reported ? bound({ documentId: input.reportDocumentId, page: input.reportPage }, ctx) : null;
      const treatment = { status: input.status, provider: text(input.provider, reported ? 'Treatment provider' : 'Unavailability reason', ctx, 300), checkedAt, receipt: text(input.receipt, 'Treatment report reference', ctx, 500), source: report, recordedBy: ctx.user.username };
      row.treatmentHistory ??= []; row.treatmentHistory.push(row.treatment); row.treatment = treatment;
    } else unknown(ctx);
    return next;
  },
  validate(state, ctx) {
    const errors = sourceErrors(state.authorities.flatMap(row => [row.source, row.treatment.source]), ctx);
    if (!state.authorities.length) errors.push('Add a source-bound authority.');
    for (const row of state.authorities) if (row.treatment.status === 'not_checked') errors.push(`Record treatment evidence or an explicit unavailable result for ${row.id}.`);
    return result(errors, ['Treatment is supplied from referenced research reports; Briefcase does not represent an uploaded report as a live citator query.']);
  },
  output(state) { return { question: state.question, authorities: state.authorities.map(row => ({ ...row, treatmentAvailability: row.treatment.status === 'unavailable' ? 'Unavailable — do not infer current validity' : row.treatment.status === 'not_checked' ? 'Not checked' : 'Referenced report supplied' })) }; },
};

function fixtures(input, ctx) {
  if (!Array.isArray(input) || input.length < 1 || input.length > 100) fail(ctx, 'Supply 1–100 fixture cases.');
  const seen = new Set();
  return input.map(item => {
    const id = text(item?.id, 'Fixture ID', ctx, 100);
    if (seen.has(id)) fail(ctx, 'Fixture IDs must be unique.'); seen.add(id);
    if (typeof item.expected !== 'string' || item.expected.length > 60000) fail(ctx, 'Each fixture needs an expected output string.');
    if (!item.values || typeof item.values !== 'object' || Array.isArray(item.values)) fail(ctx, 'Fixture values must be an object.');
    return { id, values: item.values, expected: item.expected };
  });
}
const automation = {
  roleId: 'R37', title: 'Tested automation releases',
  description: 'Execute bounded template fixtures, block failed releases, and roll back to prior approved editions.',
  fields: [field('name', 'Automation name'), field('body', 'Template body with {{fields}}', 'textarea'), field('changeNote', 'Initial release note'), field('fixtures', 'Fixture cases', 'json', { hint: '[{"id":"case1","values":{"name":"Ada"},"expected":"Hello Ada"}]' })],
  actions: [action('candidate', 'Create a release candidate', [field('body', 'Template body', 'textarea'), field('changeNote', 'Release note'), field('fixtures', 'Fixture cases', 'json', { hint: '[{"id":"case1","values":{"name":"Ada"},"expected":"Hello Ada"}]' })]), action('run-fixtures', 'Run current fixtures'), action('promote', 'Approve and promote tested release', [field('versionHash', 'Candidate hash'), field('notes', 'Release review notes', 'textarea')], true), action('rollback', 'Roll back to an approved release', [field('versionHash', 'Previously promoted version hash'), field('reason', 'Rollback reason', 'textarea')], true)],
  create(input, ctx) { const version = templateVersion(input, ctx, 1); version.fixtures = fixtures(input.fixtures, ctx); version.hash = ctx.hash({ ...version, hash: undefined }); return { name: text(input.name, 'Automation name', ctx, 180), versions: [version], runs: [], releases: [], activeVersion: null }; },
  update(state, actionId, input, ctx) {
    const next = clone(state);
    if (actionId === 'candidate') {
      const version = templateVersion(input, ctx, next.versions.length + 1); version.fixtures = fixtures(input.fixtures, ctx); version.hash = ctx.hash({ ...version, hash: undefined }); next.versions.push(version);
    } else if (actionId === 'run-fixtures') {
      const version = next.versions.at(-1);
      const rows = version.fixtures.map(fixture => {
        try { const actual = renderTemplate(version, fixture.values, ctx); return { id: fixture.id, pass: actual === fixture.expected, expectedHash: ctx.hash(fixture.expected), actualHash: ctx.hash(actual), actual }; }
        catch (error) { return { id: fixture.id, pass: false, error: error.message }; }
      });
      next.runs.push({ versionHash: version.hash, fixturesHash: ctx.hash(version.fixtures), at: ctx.now, by: ctx.user.username, passed: rows.filter(row => row.pass).length, total: rows.length, rows });
    } else if (actionId === 'promote') {
      reviewer(ctx);
      const version = next.versions.at(-1), run = next.runs.findLast(row => row.versionHash === version.hash);
      if (input.versionHash !== version.hash || !run || run.fixturesHash !== ctx.hash(version.fixtures) || run.passed !== run.total || !run.total) fail(ctx, 'Only the current candidate with all executed fixtures passing can be promoted.', 409);
      next.releases.push({ action: 'promote', versionHash: version.hash, runHash: ctx.hash(run), notes: text(input.notes, 'Release review notes', ctx), by: ctx.user.username, at: ctx.now }); next.activeVersion = version.hash;
    } else if (actionId === 'rollback') {
      reviewer(ctx);
      const previous = next.releases.find(row => row.action === 'promote' && row.versionHash === input.versionHash);
      if (!previous || previous.versionHash === next.activeVersion) fail(ctx, 'Choose a different previously approved release.', 409);
      next.releases.push({ action: 'rollback', versionHash: previous.versionHash, from: next.activeVersion, approvalHash: ctx.hash(previous), reason: text(input.reason, 'Rollback reason', ctx), by: ctx.user.username, at: ctx.now }); next.activeVersion = previous.versionHash;
    } else unknown(ctx);
    return next;
  },
  validate(state) { return result(state.activeVersion ? [] : ['Run the fixtures and obtain lawyer release approval.'], ['Only the bounded template automation is executed. Arbitrary connector automations need their own adapters and fixture runners.']); },
  output(state) { return { name: state.name, activeVersion: state.activeVersion, activeTemplate: state.versions.find(row => row.hash === state.activeVersion) ?? null, releaseHistory: state.releases, fixtureRuns: state.runs }; },
};

const referralFields = ['referralRef', 'organizationRef', 'issueCategory', 'contactRoute', 'status', 'assignedLawyer', 'acceptedAt'];
const proBono = {
  roleId: 'R38', title: 'Pro bono referral and acceptance',
  description: 'Route a referral to its reviewing lawyer and export only explicitly approved fields.',
  fields: [field('referralRef', 'Referral reference'), field('organizationRef', 'Referring organization reference'), field('issueCategory', 'Issue category'), field('contactRoute', 'Restricted contact-system reference'), field('eligibilityRef', 'Eligibility review reference'), field('privateNotes', 'Internal notes', 'textarea', { required: false })],
  actions: [action('update-referral', 'Revise referral', [field('issueCategory', 'Issue category'), field('contactRoute', 'Contact-system reference'), field('eligibilityRef', 'Eligibility review reference'), field('privateNotes', 'Internal notes', 'textarea', { required: false })]), action('accept-referral', 'Accept assigned referral', [field('approvedFields', 'Approved export field names', 'json', { hint: JSON.stringify(referralFields) }), field('notes', 'Lawyer acceptance notes', 'textarea')], true)],
  create(input, ctx) { return { referralRef: text(input.referralRef, 'Referral reference', ctx, 180), organizationRef: text(input.organizationRef, 'Organization reference', ctx, 180), issueCategory: text(input.issueCategory, 'Issue category', ctx, 200), contactRoute: text(input.contactRoute, 'Contact-system reference', ctx, 180), eligibilityRef: text(input.eligibilityRef, 'Eligibility review reference', ctx, 180), privateNotes: typeof input.privateNotes === 'string' ? input.privateNotes.slice(0, 4000) : '', status: 'awaiting_acceptance', acceptedAt: null, assignedLawyer: null, acceptance: null, history: [] }; },
  update(state, actionId, input, ctx) {
    const next = clone(state);
    if (actionId === 'update-referral') {
      if (next.acceptance) next.history.push(next.acceptance);
      Object.assign(next, { issueCategory: text(input.issueCategory, 'Issue category', ctx, 200), contactRoute: text(input.contactRoute, 'Contact-system reference', ctx, 180), eligibilityRef: text(input.eligibilityRef, 'Eligibility review reference', ctx, 180), privateNotes: typeof input.privateNotes === 'string' ? input.privateNotes.slice(0, 4000) : '', status: 'awaiting_acceptance', acceptedAt: null, assignedLawyer: null, acceptance: null });
    } else if (actionId === 'accept-referral') {
      reviewer(ctx);
      if (!Array.isArray(input.approvedFields) || !input.approvedFields.length || input.approvedFields.some(name => !referralFields.includes(name)) || new Set(input.approvedFields).size !== input.approvedFields.length) fail(ctx, 'Choose only unique allowed referral export fields. Private notes and eligibility records cannot be exported.');
      next.status = 'accepted'; next.acceptedAt = ctx.now; next.assignedLawyer = ctx.user.username;
      next.acceptance = { approvedFields: [...input.approvedFields], by: ctx.user.username, at: ctx.now, notes: text(input.notes, 'Acceptance notes', ctx), referralHash: ctx.hash({ referralRef: next.referralRef, organizationRef: next.organizationRef, issueCategory: next.issueCategory, contactRoute: next.contactRoute, eligibilityRef: next.eligibilityRef }) };
    } else unknown(ctx);
    return next;
  },
  validate(state, ctx = {}) {
    const assignedReviewer = ctx.reviewer ?? (ctx.isReviewer ? ctx.user?.username : null);
    const currentRecipient = !assignedReviewer || state.assignedLawyer === assignedReviewer;
    return result(state.status === 'accepted' && state.acceptance && currentRecipient ? [] : ['The current assigned reviewing lawyer must accept the referral and approve its export fields.']);
  },
  output(state) { return { referral: Object.fromEntries((state.acceptance?.approvedFields ?? []).map(name => [name, state[name]])), fieldApproval: state.acceptance ? { by: state.acceptance.by, at: state.acceptance.at, approvedFields: state.acceptance.approvedFields, referralHash: state.acceptance.referralHash } : null }; },
  assertExport(current, submitted, ctx) {
    if (!current.acceptance || (ctx.reviewer && current.assignedLawyer !== ctx.reviewer) || ctx.hash(current.acceptance) !== ctx.hash(submitted.acceptance)) fail(ctx, 'This referral acceptance or assigned lawyer was changed. Review the current referral before exporting.', 409);
  },
};

export const workflows = [docket, project, management, knowledge, research, automation, proBono];
