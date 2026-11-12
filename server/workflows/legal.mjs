import { PDFDocument, StandardFonts } from '../../dist/vendor/packets/pdf-lib.mjs';

const f = (name, label, type = 'text', hint, options) => ({ name, label, type, required: true, ...(hint ? { hint } : {}), ...(options ? { options } : {}) });
const fieldSources = f('sources', 'Source references', 'json', '[{"documentId":"original ID","page":1,"quote":"Exact text from that page"}]');
const fieldExhibits = f('exhibits', 'Exhibits', 'json', '[{"label":"Exhibit A","documentId":"original ID","page":1,"quote":"Exact text"}]');
const fail = (ctx, message, code = 422) => ctx.fail(code, message);
const text = (v, label, ctx, max = 20000) => { if (typeof v !== 'string' || !v.trim() || v.length > max) fail(ctx, label + ' is required (maximum ' + max + ' characters).'); return v.trim(); };
const list = (v, label, ctx, max = 100) => { if (!Array.isArray(v) || v.length > max) fail(ctx, label + ' must be an array of at most ' + max + ' rows.'); return v; };
const norm = v => String(v ?? '').replace(/\s+/g, ' ').trim();
const actor = ctx => ({ by: ctx.user.username, at: ctx.now });
const reviewer = ctx => { if (!ctx.isReviewer || ctx.user.role !== 'lawyer') fail(ctx, 'Only the assigned reviewing lawyer can perform this check.', 403); };
const id = (v, label, ctx) => { const s = text(v, label, ctx, 80); if (!/^[A-Za-z0-9._-]+$/.test(s)) fail(ctx, label + ' must use letters, digits, dots, underscores or hyphens.'); return s; };
const unique = (rows, name, ctx) => { if (new Set(rows.map(row => row[name])).size !== rows.length) fail(ctx, 'Each ' + name + ' must be unique.'); return rows; };
function bind(input, ctx, quoteRequired = true) {
  if (!input || typeof input !== 'object') fail(ctx, 'Choose an original document and physical page.');
  const documentId = text(input.documentId, 'Original document ID', ctx, 100);
  const page = Number(input.page);
  if (!Number.isSafeInteger(page) || page < 1) fail(ctx, 'Use a positive physical page number.');
  const doc = ctx.source(documentId, page);
  const source = doc.pages.find(row => row.number === page);
  if (!source) fail(ctx, 'The physical source page does not exist.');
  const quote = quoteRequired ? text(input.quote, 'Source quotation', ctx, 3000) : String(input.quote ?? '').trim();
  if (quote && !norm(source.text).includes(norm(quote))) fail(ctx, 'The quotation is not present on the selected original page.');
  return { documentId, page, sha256: doc.sha256, name: doc.name, ...(quote ? { quote } : {}) };
}
function recheck(binding, ctx, errors) {
  try {
    const doc = ctx.source(binding.documentId, binding.page);
    if (doc.sha256 !== binding.sha256 || (binding.page && !doc.pages.some(p => p.number === binding.page))) errors.push('A source changed or its physical page is unavailable: ' + binding.documentId);
    if (binding.quote && !norm(doc.pages.find(p => p.number === binding.page)?.text).includes(norm(binding.quote))) errors.push('A cited quotation no longer matches its source.');
  } catch (error) { if (error.status === 404 || error.status === 403) throw error; errors.push(error.message); }
}
const check = (bindings, ctx, errors = []) => { for (const b of bindings) recheck(b, ctx, errors); return { errors, warnings: [] }; };
function sources(input, ctx) { return list(input, 'Sources', ctx).map(row => bind(row, ctx)); }
function revised(state, change, ctx) {
  const prior = { revision: state.contentRevision, hash: ctx.hash(state), ...actor(ctx) };
  return { ...state, ...change, contentRevision: state.contentRevision + 1, edits: [...state.edits, prior] };
}
function diff(oldText, newText) {
  const before = oldText.split('\n'), after = newText.split('\n');
  return { removed: before.filter(line => !after.includes(line)), added: after.filter(line => !before.includes(line)) };
}
function rejectAction(ctx) { fail(ctx, 'That action is not available for this legal workflow.'); }
async function reportPdf(title, sections, ctx) {
  const pdf = await PDFDocument.create();
  pdf.setCreationDate(new Date('2000-01-01T00:00:00Z')); pdf.setModificationDate(new Date('2000-01-01T00:00:00Z'));
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  let page, y;
  const newPage = () => { page = pdf.addPage([612, 792]); y = 740; };
  newPage();
  for (const section of [title, ...sections]) {
    for (const paragraph of String(section).split('\n')) {
      let line = '';
      for (const word of paragraph.split(/\s+/)) {
        try { font.encodeText(word); } catch { fail(ctx, 'PDF export cannot represent some characters. Use the exact JSON export or a document-production template with a suitable font.'); }
        if (font.widthOfTextAtSize(word, 10) > 500) fail(ctx, 'A long unbroken word exceeds the PDF page width. Revise its formatting or use the exact JSON export.');
        const candidate = line ? line + ' ' + word : word;
        if (font.widthOfTextAtSize(candidate, 10) > 500 && line) {
          if (y < 55) newPage(); page.drawText(line, { x: 54, y, font, size: 10 }); y -= 15; line = word;
        } else line = candidate;
      }
      if (y < 55) newPage(); page.drawText(line, { x: 54, y, font, size: 10 }); y -= 18;
    }
    y -= 8;
  }
  return { bytes: Buffer.from(await pdf.save()), mime: 'application/pdf', name: 'briefcase-legal-work.pdf' };
}
async function binder(bindings, ctx, title) {
  const pdf = await PDFDocument.create(); pdf.setCreationDate(new Date('2000-01-01T00:00:00Z')); pdf.setModificationDate(new Date('2000-01-01T00:00:00Z'));
  for (const b of bindings) {
    const doc = ctx.source(b.documentId, b.page);
    if (doc.sha256 !== b.sha256) fail(ctx, 'An approved original changed.', 409);
    const original = await PDFDocument.load(doc.bytes);
    const indices = b.page ? [b.page - 1] : original.getPageIndices();
    const pages = await pdf.copyPages(original, indices);
    for (const page of pages) pdf.addPage(page);
  }
  if (!pdf.getPageCount()) fail(ctx, 'There are no releasable pages.', 409);
  return { bytes: Buffer.from(await pdf.save()), mime: 'application/pdf', name: title + '.pdf' };
}

function draftWorkflow(roleId, title, description) {
  return {
    roleId, title, description, matterRequired: true,
    fields: [f('documentTitle', 'Document title'), f('body', 'Draft text', 'textarea'), fieldSources],
    actions: [{ id: 'revise-draft', label: 'Revise draft and sources', fields: [f('body', 'Revised draft', 'textarea'), fieldSources, f('reason', 'Reason for revision')] }],
    create(input, ctx) { return { documentTitle: text(input.documentTitle, 'Document title', ctx, 200), body: text(input.body, 'Draft text', ctx), sources: sources(input.sources, ctx), contentRevision: 1, edits: [], revisions: [], author: actor(ctx) }; },
    update(state, action, input, ctx) {
      if (action !== 'revise-draft') return rejectAction(ctx);
      const body = text(input.body, 'Draft text', ctx), nextSources = sources(input.sources, ctx);
      const previous = { revision: state.contentRevision, body: state.body, sources: state.sources, hash: ctx.hash({ body: state.body, sources: state.sources }) };
      return revised(state, { body, sources: nextSources, revisions: [...state.revisions, previous], change: { reason: text(input.reason, 'Reason', ctx, 1000), ...diff(state.body, body), ...actor(ctx) } }, ctx);
    },
    validate(state, ctx) { return check(state.sources, ctx, state.sources.length ? [] : ['Attach at least one exact original source for supervisor review.']); },
    output(state) { return { documentTitle: state.documentTitle, body: state.body, revision: state.contentRevision, sources: state.sources, change: state.change ?? null, revisionHistory: state.revisions, reviewRequirement: 'Assigned lawyer approves the exact version before export.' }; },
    formats: ['pdf'],
    exportFile(state, ctx) { return reportPdf(state.documentTitle, [state.body, 'Sources', ...state.sources.map(s => s.name + ', physical page ' + s.page + ': ' + s.quote)], ctx); },
  };
}

const supervision = draftWorkflow('R03', 'Partner draft supervision', 'Prepare and revise source-linked work for exact-version approval by the assigned lawyer.');
const clerk = draftWorkflow('R25', 'Supervised clerk research', 'Prepare a source-linked draft; only the assigned supervisor can approve publication.');

const senior = {
  roleId: 'R20', title: 'Deposition and exhibit review', description: 'Revise a deposition outline with pinned source pages and a visible change history.', matterRequired: true,
  fields: [f('witness', 'Witness'), f('outline', 'Deposition outline', 'textarea'), fieldExhibits],
  actions: [{ id: 'revise-outline', label: 'Submit revised outline and exhibits', fields: [f('outline', 'Revised outline', 'textarea'), fieldExhibits, f('reason', 'Reason for revision')] }],
  create(input, ctx) { return { witness: text(input.witness, 'Witness', ctx, 200), outline: text(input.outline, 'Outline', ctx), exhibits: unique(list(input.exhibits, 'Exhibits', ctx).map(row => ({ label: text(row.label, 'Exhibit label', ctx, 100), ...bind(row, ctx) })), 'label', ctx), contentRevision: 1, edits: [], revisions: [] }; },
  update(state, action, input, ctx) {
    if (action !== 'revise-outline') return rejectAction(ctx);
    const next = this.create({ ...input, witness: state.witness }, ctx);
    return revised(state, { outline: next.outline, exhibits: next.exhibits, revisions: [...state.revisions, { revision: state.contentRevision, outline: state.outline, exhibits: state.exhibits }], change: { ...diff(state.outline, next.outline), reason: text(input.reason, 'Reason', ctx, 1000), ...actor(ctx) } }, ctx);
  },
  validate(state, ctx) { return check(state.exhibits, ctx, state.exhibits.length ? [] : ['Select at least one original exhibit page.']); },
  output(state) { return { witness: state.witness, outline: state.outline, exhibitIndex: state.exhibits, change: state.change ?? null, revisionHistory: state.revisions }; },
  formats: ['pdf'], exportFile(state, ctx) { return binder(state.exhibits, ctx, 'reviewed-deposition-exhibits'); },
};

function authorities(rows, ctx) {
  return unique(list(rows, 'Authorities', ctx).map(row => ({ id: id(row.id, 'Authority ID', ctx), citation: text(row.citation, 'Citation', ctx, 400), proposition: text(row.proposition, 'Proposition', ctx, 1200), ...bind(row, ctx), check: null })), 'id', ctx);
}
const motion = {
  roleId: 'R21', title: 'Motion authority review', description: 'Link each [[authority-ID]] in the motion to an exact source quotation and reviewing-lawyer treatment check.', matterRequired: true,
  fields: [f('motionTitle', 'Motion title'), f('body', 'Motion text using [[A1]] authority references', 'textarea'), f('authorities', 'Authority sources', 'json', '[{"id":"A1","citation":"Case citation","proposition":"Supported proposition","documentId":"original ID","page":1,"quote":"Exact quote"}]')],
  actions: [
    { id: 'revise-motion', label: 'Revise motion and authority register', fields: [f('body', 'Motion text', 'textarea'), f('authorities', 'Authority sources', 'json'), f('reason', 'Revision reason')] },
    { id: 'check-authority', label: 'Review authority and treatment', reviewerOnly: true, fields: [f('id', 'Authority ID'), f('sourceSha256', 'Exact original SHA-256'), f('treatment', 'Treatment decision', 'select', undefined, ['current', 'adverse-addressed', 'unsupported']), f('notes', 'Treatment source/date and review notes', 'textarea')] },
  ],
  create(input, ctx) { return { motionTitle: text(input.motionTitle, 'Motion title', ctx, 200), body: text(input.body, 'Motion text', ctx), authorities: authorities(input.authorities, ctx), contentRevision: 1, edits: [], revisions: [] }; },
  update(state, action, input, ctx) {
    if (action === 'revise-motion') return revised(state, { body: text(input.body, 'Motion text', ctx), authorities: authorities(input.authorities, ctx), revisions: [...state.revisions, { body: state.body, authorities: state.authorities, revision: state.contentRevision, reason: text(input.reason, 'Reason', ctx, 1000) }] }, ctx);
    if (action === 'check-authority') {
      reviewer(ctx); const next = structuredClone(state), row = next.authorities.find(a => a.id === input.id);
      if (!row) fail(ctx, 'That authority is unavailable.', 404);
      if (input.sourceSha256 !== row.sha256) fail(ctx, 'Review the current exact original.', 409);
      if (!['current', 'adverse-addressed', 'unsupported'].includes(input.treatment)) fail(ctx, 'Record a treatment decision.');
      row.check = { treatment: input.treatment, notes: text(input.notes, 'Review notes', ctx, 1600), authorityHash: ctx.hash({ id: row.id, citation: row.citation, proposition: row.proposition, documentId: row.documentId, page: row.page, quote: row.quote, sha256: row.sha256 }), ...actor(ctx) };
      return revised(next, {}, ctx);
    }
    return rejectAction(ctx);
  },
  validate(state, ctx) {
    const errors = [];
    const used = [...state.body.matchAll(/\[\[([^\]]+)\]\]/g)].map(m => m[1]);
    if (!used.length) errors.push('Use at least one [[authority-ID]] from the source register.');
    for (const ref of used) if (!state.authorities.some(a => a.id === ref)) errors.push('Unsupported authority reference: ' + ref);
    for (const row of state.authorities) {
      if (!row.check || row.check.treatment === 'unsupported') errors.push('Authority ' + row.id + ' needs a supported reviewing-lawyer treatment check.');
      if (row.check && row.check.authorityHash !== ctx.hash({ id: row.id, citation: row.citation, proposition: row.proposition, documentId: row.documentId, page: row.page, quote: row.quote, sha256: row.sha256 })) errors.push('Authority ' + row.id + ' changed after review.');
    }
    return { ...check(state.authorities, ctx, errors), warnings: ['Treatment is recorded by the reviewing lawyer; a live citator is not connected.'] };
  },
  output(state) { return { title: state.motionTitle, text: state.body.replace(/\[\[([^\]]+)\]\]/g, (_, ref) => state.authorities.find(a => a.id === ref)?.citation ?? '[Unsupported: ' + ref + ']'), authorityTable: state.authorities, revisionHistory: state.revisions }; },
  formats: ['pdf'], exportFile(state, ctx) { const product = this.output(state); return reportPdf(product.title, [product.text, 'Authorities', ...product.authorityTable.map(a => a.citation + '\n' + a.quote + '\nOriginal: ' + a.name + ', physical page ' + a.page)], ctx); },
};

const transactions = {
  roleId: 'R22', title: 'Transaction conditions and signed binder', description: 'Track changing closing conditions, review their evidence, and bind exact executed originals.', matterRequired: true,
  fields: [f('transaction', 'Transaction name'), f('conditions', 'Closing conditions', 'json', '[{"id":"C1","label":"Board consent"}]'), f('documents', 'Documents requiring execution', 'json', '[{"id":"D1","label":"Agreement","documentId":"original ID","requiredSigners":["Client","Counterparty"]}]')],
  actions: [
    { id: 'amend-condition', label: 'Amend or add closing condition', fields: [f('id', 'Condition ID'), f('label', 'Condition text'), f('reason', 'Amendment reason')] },
    { id: 'satisfy-condition', label: 'Review condition evidence', reviewerOnly: true, fields: [f('id', 'Condition ID'), f('documentId', 'Evidence original ID'), f('page', 'Physical page', 'number'), f('quote', 'Exact evidence quote', 'textarea'), f('notes', 'Review notes')] },
    { id: 'replace-document', label: 'Replace document for execution', fields: [f('id', 'Document slot ID'), f('documentId', 'Replacement original ID')] },
    { id: 'verify-execution', label: 'Verify executed original', reviewerOnly: true, fields: [f('id', 'Document slot ID'), f('sourceSha256', 'Exact original SHA-256'), f('signers', 'Observed signers', 'json', '["Client","Counterparty"]'), f('executedAt', 'Execution date', 'date'), f('notes', 'Signature verification notes')] },
  ],
  create(input, ctx) {
    const conditions = unique(list(input.conditions, 'Conditions', ctx).map(c => ({ id: id(c.id, 'Condition ID', ctx), label: text(c.label, 'Condition label', ctx, 1000), status: 'pending', evidence: null, changes: [] })), 'id', ctx);
    const documents = unique(list(input.documents, 'Documents', ctx).map(d => { const doc = ctx.source(text(d.documentId, 'Original ID', ctx, 100)); return { id: id(d.id, 'Document slot ID', ctx), label: text(d.label, 'Document label', ctx, 200), binding: { documentId: doc.id, sha256: doc.sha256, name: doc.name }, requiredSigners: unique(list(d.requiredSigners, 'Required signers', ctx, 20).map(name => ({ name: text(name, 'Signer name', ctx, 200) })), 'name', ctx).map(row => row.name), execution: null, replacements: [] }; }), 'id', ctx);
    if (documents.some(d => !d.requiredSigners.length)) fail(ctx, 'Each document needs at least one required signer.');
    return { transaction: text(input.transaction, 'Transaction', ctx, 200), conditions, documents, contentRevision: 1, edits: [] };
  },
  update(state, action, input, ctx) {
    const next = structuredClone(state);
    if (action === 'amend-condition') {
      const conditionId = id(input.id, 'Condition ID', ctx), row = next.conditions.find(c => c.id === conditionId);
      const label = text(input.label, 'Condition text', ctx, 1000), reason = text(input.reason, 'Reason', ctx, 1000);
      if (row) { row.changes.push({ label: row.label, evidence: row.evidence, status: row.status, reason, ...actor(ctx) }); Object.assign(row, { label, status: 'pending', evidence: null }); }
      else next.conditions.push({ id: conditionId, label, status: 'pending', evidence: null, changes: [{ reason, ...actor(ctx) }] });
    } else if (action === 'satisfy-condition') {
      reviewer(ctx); const row = next.conditions.find(c => c.id === input.id); if (!row) fail(ctx, 'Condition unavailable.', 404);
      row.evidence = { ...bind(input, ctx), notes: text(input.notes, 'Review notes', ctx, 1200), ...actor(ctx) }; row.status = 'satisfied';
    } else if (action === 'replace-document') {
      const row = next.documents.find(d => d.id === input.id); if (!row) fail(ctx, 'Document unavailable.', 404);
      const doc = ctx.source(text(input.documentId, 'Original ID', ctx, 100)); row.replacements.push({ binding: row.binding, execution: row.execution, ...actor(ctx) });
      row.binding = { documentId: doc.id, sha256: doc.sha256, name: doc.name }; row.execution = null;
    } else if (action === 'verify-execution') {
      reviewer(ctx); const row = next.documents.find(d => d.id === input.id); if (!row) fail(ctx, 'Document unavailable.', 404);
      if (input.sourceSha256 !== row.binding.sha256) fail(ctx, 'Verify the current exact original.', 409);
      const signers = list(input.signers, 'Observed signers', ctx, 20).map(v => text(v, 'Signer', ctx, 200));
      if (row.requiredSigners.some(name => !signers.includes(name))) fail(ctx, 'An execution signature is missing.');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(input.executedAt ?? '') || !Number.isFinite(Date.parse(input.executedAt)) || new Date(input.executedAt).toISOString().slice(0, 10) !== input.executedAt) fail(ctx, 'Record the execution date.');
      row.execution = { sourceSha256: row.binding.sha256, signers, executedAt: input.executedAt, notes: text(input.notes, 'Signature verification notes', ctx, 1200), ...actor(ctx) };
    } else return rejectAction(ctx);
    return revised(next, {}, ctx);
  },
  validate(state, ctx) {
    const errors = [];
    if (!state.conditions.length || !state.documents.length) errors.push('Add closing conditions and documents before preparing the binder.');
    for (const c of state.conditions) if (c.status !== 'satisfied' || !c.evidence) errors.push('Unmet closing condition: ' + c.label);
    for (const d of state.documents) if (!d.execution || d.execution.sourceSha256 !== d.binding.sha256) errors.push('Execution not verified: ' + d.label);
    return { ...check([...state.documents.map(d => d.binding), ...state.conditions.flatMap(c => c.evidence ? [c.evidence] : [])], ctx, errors), warnings: ['Execution review records the lawyer’s check of signed originals; it is not cryptographic signature validation.'] };
  },
  output(state, ctx) {
    let start = 1;
    const manifest = state.documents.map(d => { const source = ctx.source(d.binding.documentId), pages = source.pages.length; const entry = { slot: d.id, label: d.label, ...d.binding, pageStart: start, pageEnd: start + pages - 1, execution: d.execution }; start += pages; return entry; });
    return { transaction: state.transaction, conditions: state.conditions, signedBinderManifest: manifest, totalPages: start - 1 };
  },
  formats: ['pdf'], exportFile(state, ctx) { return binder(state.documents.map(d => d.binding), ctx, 'executed-closing-binder'); },
};

function memo(input, ctx) {
  const current = { title: text(input.title, 'Memo title', ctx, 200), question: text(input.question, 'Question presented', ctx, 2000), analysis: text(input.analysis, 'Analysis', ctx), sources: sources(input.sources, ctx), ...actor(ctx) };
  return { id: id(input.id, 'Memo ID', ctx), current: { ...current, sha256: ctx.hash(current) }, revisions: [] };
}
const memos = {
  roleId: 'R23', title: 'Independent research memos', description: 'Compose separate memos with individual versions and exact sources for a partner review bundle.', matterRequired: true,
  fields: [f('memos', 'Research memos', 'json', '[{"id":"M1","title":"Memo title","question":"Question","analysis":"Analysis","sources":[{"documentId":"original ID","page":1,"quote":"Exact quote"}]}]')],
  actions: [ { id: 'add-memo', label: 'Compose another memo', fields: [f('id', 'New memo ID'), f('title', 'Memo title'), f('question', 'Question presented', 'textarea'), f('analysis', 'Analysis', 'textarea'), fieldSources] }, { id: 'revise-memo', label: 'Revise one memo', fields: [f('id', 'Memo ID'), f('title', 'Memo title'), f('question', 'Question presented', 'textarea'), f('analysis', 'Revised analysis', 'textarea'), fieldSources] } ],
  create(input, ctx) { return { memos: unique(list(input.memos, 'Memos', ctx, 30).map(m => memo(m, ctx)), 'id', ctx), contentRevision: 1, edits: [] }; },
  update(state, action, input, ctx) {
    const next = structuredClone(state), entry = memo(input, ctx), pos = next.memos.findIndex(m => m.id === entry.id);
    if (action === 'add-memo') { if (pos !== -1) fail(ctx, 'Use a distinct memo ID; the existing memo is preserved.', 409); if (next.memos.length >= 30) fail(ctx, 'Start another bundle after 30 memos.'); next.memos.push(entry); }
    else if (action === 'revise-memo') { if (pos === -1) fail(ctx, 'Memo unavailable.', 404); entry.revisions = [...next.memos[pos].revisions, next.memos[pos].current]; next.memos[pos] = entry; }
    else return rejectAction(ctx);
    return revised(next, {}, ctx);
  },
  validate(state, ctx) { return check(state.memos.flatMap(m => m.current.sources), ctx, !state.memos.length ? ['Compose at least one memo.'] : state.memos.filter(m => !m.current.sources.length).map(m => 'Memo ' + m.id + ' needs exact sources.')); },
  output(state) { return { memoManifest: state.memos.map(m => ({ id: m.id, title: m.current.title, sha256: m.current.sha256, version: m.revisions.length + 1 })), memos: state.memos }; },
  formats: ['pdf'], exportFile(state, ctx) { return reportPdf('Reviewed research memos', state.memos.flatMap(m => [m.id + ': ' + m.current.title, m.current.question, m.current.analysis, ...m.current.sources.map(s => s.name + ', physical page ' + s.page + ': ' + s.quote)]), ctx); },
};

const review = {
  roleId: 'R24', title: 'Privilege and production review', description: 'Review document families and release only responsive, cleared originals; privileged family members remain withheld.', matterRequired: true,
  fields: [f('documents', 'Review documents and families', 'json', '[{"id":"E1","documentId":"original ID","parentId":""},{"id":"E2","documentId":"attachment original ID","parentId":"E1"}]')],
  actions: [ { id: 'add-document', label: 'Add original to review', fields: [f('id', 'Review item ID'), f('documentId', 'Original document ID'), { ...f('parentId', 'Parent review item ID'), required: false }] }, { id: 'code-document', label: 'Record reviewing-lawyer designation', reviewerOnly: true, fields: [f('id', 'Review item ID'), f('sourceSha256', 'Exact original SHA-256'), f('designation', 'Designation', 'select', undefined, ['responsive', 'nonresponsive', 'privileged']), f('reason', 'Designation reason', 'textarea')] } ],
  create(input, ctx) {
    const docs = unique(list(input.documents, 'Review documents', ctx).map(d => {
      const source = ctx.source(text(d.documentId, 'Original ID', ctx, 100)); return { id: id(d.id, 'Review item ID', ctx), documentId: source.id, sha256: source.sha256, name: source.name, parentId: d.parentId ? id(d.parentId, 'Parent ID', ctx) : null, designation: 'unreviewed', history: [] };
    }), 'id', ctx);
    if (new Set(docs.map(d => d.documentId)).size !== docs.length) fail(ctx, 'An original can appear only once in this review set.');
    for (const d of docs) if (d.parentId && (!docs.some(p => p.id === d.parentId) || d.parentId === d.id)) fail(ctx, 'Each attachment must reference an existing, different parent.');
    for (const d of docs) { const seen = new Set([d.id]); let parent = d.parentId; while (parent) { if (seen.has(parent)) fail(ctx, 'Document families cannot contain cycles.'); seen.add(parent); parent = docs.find(p => p.id === parent)?.parentId; } }
    return { documents: docs, contentRevision: 1, edits: [] };
  },
  update(state, action, input, ctx) {
    const next = structuredClone(state);
    if (action === 'add-document') {
      const entry = this.create({ documents: [{ ...input, parentId: null }] }, ctx).documents[0];
      if (next.documents.some(d => d.id === entry.id || d.documentId === entry.documentId)) fail(ctx, 'The review item or original is already present.', 409);
      if (input.parentId) { if (!next.documents.some(d => d.id === input.parentId)) fail(ctx, 'Parent review item unavailable.'); entry.parentId = input.parentId; }
      if (next.documents.length >= 100) fail(ctx, 'Start another review set after 100 originals.');
      next.documents.push(entry);
    } else if (action === 'code-document') {
      reviewer(ctx); const row = next.documents.find(d => d.id === input.id); if (!row) fail(ctx, 'Review item unavailable.', 404);
      if (input.sourceSha256 !== row.sha256) fail(ctx, 'Review the exact current original.', 409);
      if (!['responsive', 'nonresponsive', 'privileged'].includes(input.designation)) fail(ctx, 'Choose a review designation.');
      row.history.push({ from: row.designation, to: input.designation, reason: text(input.reason, 'Review reason', ctx, 1600), sourceSha256: row.sha256, ...actor(ctx) }); row.designation = input.designation;
    } else return rejectAction(ctx);
    return revised(next, {}, ctx);
  },
  validate(state, ctx) { return check(state.documents, ctx, !state.documents.length ? ['Add documents for review.'] : state.documents.filter(d => d.designation === 'unreviewed').map(d => 'Document ' + d.id + ' has not been reviewed.')); },
  output(state) {
    const root = d => { while (d.parentId) d = state.documents.find(row => row.id === d.parentId); return d.id; };
    const heldFamilies = new Set(state.documents.filter(d => d.designation === 'privileged' || d.designation === 'unreviewed').map(root));
    const production = state.documents.filter(d => d.designation === 'responsive' && !heldFamilies.has(root(d))).map(({ id, documentId, sha256, name }) => ({ id, documentId, sha256, name }));
    const withheld = state.documents.filter(d => !production.some(p => p.id === d.id)).map(d => ({ id: d.id, reason: heldFamilies.has(root(d)) ? 'Family withheld for privilege or unfinished review' : d.designation }));
    return { productionManifest: production, withheld, reviewHistory: state.documents.map(d => ({ id: d.id, history: d.history })) };
  },
  assertExport(currentState, versionState, ctx) {
    const allowed = new Set(this.output(currentState).productionManifest.map(d => d.documentId + ':' + d.sha256));
    if (this.output(versionState).productionManifest.some(d => !allowed.has(d.documentId + ':' + d.sha256))) fail(ctx, 'A later privilege or review change withdrew a document from this production. Review the current release.', 409);
  },
  formats: ['pdf', 'manifest'], exportFile(state, ctx, format) {
    const production = this.output(state).productionManifest;
    if (format === 'manifest') return { bytes: Buffer.from(JSON.stringify({ productionManifest: production }, null, 2)), mime: 'application/json', name: 'production-manifest.json' };
    return binder(production, ctx, 'privilege-screened-production');
  },
};

export const workflows = [supervision, senior, motion, transactions, memos, review, clerk];
