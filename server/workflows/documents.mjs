import { createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { PDFDocument, StandardFontEmbedder, StandardFonts, PDFName, rgb } from '../../dist/vendor/packets/pdf-lib.mjs';
import '../../dist/vendor/packets/jszip.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const crcTable = Uint32Array.from({ length: 256 }, (_, value) => { let crc = value; for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1; return crc >>> 0; });
const crc32 = bytes => { let crc = 0xffffffff; for (const value of bytes) crc = crcTable[(crc ^ value) & 255] ^ (crc >>> 8); return (crc ^ 0xffffffff) >>> 0; };
const text = (value, name, ctx, max = 8000) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) ctx.fail(422, `${name} is required (maximum ${max} characters).`);
  return value.trim();
};
const optional = value => typeof value === 'string' ? value.trim() : '';
const rows = (value, name, ctx, max = 100) => {
  if (!Array.isArray(value) || value.length > max) ctx.fail(422, `${name} must be an array with at most ${max} rows.`);
  return value;
};
const oneOf = (value, choices, name, ctx) => { if (!choices.includes(value)) ctx.fail(422, `Choose ${name}.`); return value; };
const date = (value, name, ctx) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value ?? '') || !Number.isFinite(Date.parse(value + 'T00:00:00Z')) || new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) !== value) ctx.fail(422, `Enter a valid ${name}.`);
  return value;
};
const field = (name, label, type = 'text', hint) => ({ name, label, type, required: true, ...(hint ? { hint } : {}) });
const jsonField = (name, label, hint) => field(name, label, 'json', hint);
const command = (id, label, fields, reviewerOnly = false) => ({ id, label, fields, ...(reviewerOnly ? { reviewerOnly } : {}) });
const reviewer = ctx => { if (!ctx.isReviewer) ctx.fail(403, 'The assigned reviewing lawyer must make this decision.'); };
const check = errors => ({ errors, warnings: [] });
const valid = (definition, state, ctx) => { const result = definition.validate(state, ctx); if (result.errors.length) ctx.fail(409, result.errors.join(' ')); };
const unsupported = ctx => ctx.fail(422, 'That document workflow action is unavailable.');
const filename = value => optional(value).replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 80) || 'briefcase';
const xml = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);
const unxml = value => value.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[\da-f]+);/gi, (_, key) => key[0] === '#' ? String.fromCodePoint(key[1] === 'x' ? parseInt(key.slice(2), 16) : Number(key.slice(1))) : ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" })[key]);
const nowHistory = (state, action, ctx, details = {}) => { state.history ??= []; state.history.push({ action, by: ctx.user.username, at: ctx.now, ...details }); };
const fontMetrics = {
  body: StandardFontEmbedder.for(StandardFonts.TimesRoman),
  packet: StandardFontEmbedder.for(StandardFonts.Helvetica),
};
function layoutErrors(lines, { font = fontMetrics.body, size = 12, width = 468, wrap = true, label = 'Document text' } = {}) {
  for (const value of lines) {
    const pieces = wrap ? String(value).split(/\s+/) : [String(value)];
    for (const piece of pieces) {
      let measured;
      try { measured = font.widthOfTextAtSize(piece, size); }
      catch { return [`${label} contains a character unsupported by this PDF font. Replace it before submitting.`]; }
      if (measured > width) return [`${label} ${wrap ? 'contains a word that exceeds' : 'exceeds'} the available PDF line width. ${wrap ? 'Add a word break' : 'Shorten it'} before submitting.`];
    }
  }
  return [];
}
function packetLayoutErrors(title, items, ctx) {
  return [
    ...layoutErrors([title], { font: fontMetrics.packet, size: 16, width: 512, wrap: false, label: 'Packet title' }),
    ...layoutErrors(manifest(items, ctx).map(row => `${row.label}  |  pages ${row.packetPageStart}-${row.packetPageEnd}`), { font: fontMetrics.packet, size: 10, width: 512, wrap: false, label: 'Exhibit label and page reference' }),
  ];
}

function binding(input, ctx, whole = false) {
  const id = text(input.documentId, 'Original document ID', ctx, 100);
  const page = whole ? undefined : Number(input.page);
  if (!whole && (!Number.isSafeInteger(page) || page < 1)) ctx.fail(422, 'Choose a physical original page.');
  const source = ctx.source(id, page);
  if (page && !source.pages.some(item => item.number === page)) ctx.fail(422, 'The original page does not exist.');
  return { documentId: id, sha256: source.sha256, name: source.name, ...(page ? { page } : {}) };
}
function readBinding(ref, ctx) {
  const source = ctx.source(ref.documentId, ref.page);
  if (source.sha256 !== ref.sha256 || (ref.page && !source.pages.some(page => page.number === ref.page))) ctx.fail(409, 'A bound original changed or is unavailable.');
  return source;
}
function exhibits(input, ctx, whole = false) {
  const result = rows(input, 'Exhibits', ctx).map((row, i) => ({ label: text(row.label, 'Exhibit label', ctx, 120), source: binding(row, ctx, whole), order: i + 1 }));
  if (new Set(result.map(row => row.label.toLowerCase())).size !== result.length) ctx.fail(422, 'Exhibit labels must be unique.');
  return result;
}
function manifest(items, ctx, coverPages = 1) {
  let page = coverPages + 1;
  return items.map(row => {
    const source = readBinding(row.source, ctx);
    const count = row.source.page ? 1 : source.pages.length;
    const item = { label: row.label, ...row.source, packetPageStart: page, packetPageEnd: page + count - 1 };
    page += count;
    return item;
  });
}
async function newPdf() {
  const pdf = await PDFDocument.create();
  pdf.setProducer('Briefcase document workflows'); pdf.setCreator('Briefcase');
  pdf.setCreationDate(new Date('2000-01-01T00:00:00Z')); pdf.setModificationDate(new Date('2000-01-01T00:00:00Z'));
  return pdf;
}
async function plainPdf(lines, title = 'Briefcase', ctx) {
  const pdf = await newPdf(); pdf.setTitle(title);
  const font = await pdf.embedFont(StandardFonts.TimesRoman);
  const bold = await pdf.embedFont(StandardFonts.TimesRomanBold);
  let page, y;
  const addPage = () => { page = pdf.addPage([612, 792]); y = 720; };
  addPage();
  for (const entry of lines) {
    const str = typeof entry === 'string' ? entry : entry.text;
    const size = typeof entry === 'object' && entry.heading ? 14 : 12;
    const face = typeof entry === 'object' && entry.heading ? bold : font;
    for (const paragraph of str.split('\n')) {
      let line = '';
      for (const word of paragraph.split(/\s+/)) {
        let width;
        try { width = face.widthOfTextAtSize((line ? line + ' ' : '') + word, size); }
        catch { ctx.fail(422, 'This template supports the PDF standard Latin character set. Replace unsupported characters before export.'); }
        if (width > 468 && line) { if (y < 72) addPage(); page.drawText(line, { x: 72, y, size, font: face }); y -= 17; line = ''; }
        if (face.widthOfTextAtSize(word, size) > 468) ctx.fail(422, 'A word is too long for the fixed-width document template. Add a word break before export.');
        line += (line ? ' ' : '') + word;
      }
      if (y < 72) addPage();
      if (line) page.drawText(line, { x: 72, y, size, font: face });
      y -= 21;
    }
  }
  for (const [index, leaf] of pdf.getPages().entries()) leaf.drawText(`${index + 1} / ${pdf.getPageCount()}`, { x: 280, y: 36, font, size: 10 });
  return { pdf, font };
}
async function packetPdf(title, items, ctx) {
  // One cover page is reserved so manifest page references remain stable.
  if (items.length > 26) ctx.fail(422, 'Split this packet into volumes of at most 26 exhibits.');
  const errors = packetLayoutErrors(title, items, ctx);
  if (errors.length) ctx.fail(422, errors.join(' '));
  const pdf = await newPdf(); const font = await pdf.embedFont(StandardFonts.Helvetica);
  const cover = pdf.addPage([612, 792]); cover.drawText(title, { x: 50, y: 740, size: 16, font });
  const map = manifest(items, ctx);
  let y = 705;
  for (const row of map) { cover.drawText(`${row.label}  |  pages ${row.packetPageStart}-${row.packetPageEnd}`, { x: 50, y, size: 10, font }); y -= 22; }
  let bytesUsed = 0;
  for (const item of items) {
    const original = readBinding(item.source, ctx); bytesUsed += original.bytes.length;
    if (bytesUsed > 75 * 1024 * 1024) ctx.fail(422, 'Split this packet into volumes below 75 MB.');
    const doc = await PDFDocument.load(original.bytes);
    const selected = item.source.page ? [item.source.page - 1] : doc.getPageIndices();
    for (const pageIndex of selected) {
      const leaf = doc.getPage(pageIndex).node;
      for (const key of ['Annots', 'AA', 'Metadata', 'PieceInfo', 'StructParents', 'B', 'Thumb']) leaf.delete(PDFName.of(key));
    }
    for (const page of await pdf.copyPages(doc, selected)) pdf.addPage(page);
  }
  for (const [i, page] of pdf.getPages().entries()) {
    page.drawRectangle({ x: 20, y: 7, width: 100, height: 15, color: rgb(1, 1, 1) });
    page.drawText(`Packet page ${i + 1}`, { x: 24, y: 11, size: 8, font });
  }
  return Buffer.from(await pdf.save());
}
function zipper() { return new globalThis.JSZip(); }
function zipFile(zip, name, bytes) { zip.file(name, bytes, { date: new Date('2000-01-01T00:00:00Z') }); }
const zipped = async zip => Buffer.from(await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', compressionOptions: { level: 6 } }));
const fileResult = (bytes, name, mime) => ({ bytes: Buffer.from(bytes), name, mime });
const zipResult = async (zip, name) => fileResult(await zipped(zip), name, 'application/zip');
const sourceFields = [field('documentId', 'Original document ID'), field('page', 'Physical source page', 'number')];
const exhibitHint = '[{"label":"Exhibit A","documentId":"original-id","page":1}]';

const litigationPacket = {
  roleId: 'R26', title: 'Litigation packet builder', matterRequired: true,
  description: 'Assemble source-bound exhibits, review the exact packet, and export a PDF with a physical page index.',
  fields: [field('title', 'Packet title'), jsonField('exhibits', 'Exhibits in packet order', exhibitHint)],
  actions: [command('replace-exhibits', 'Revise exhibit packet', [jsonField('exhibits', 'Exhibits in packet order', exhibitHint)])],
  create(input, ctx) { return { title: text(input.title, 'Packet title', ctx, 120), exhibits: exhibits(input.exhibits, ctx), history: [] }; },
  update(state, action, input, ctx) { if (action !== 'replace-exhibits') return unsupported(ctx); state.exhibits = exhibits(input.exhibits, ctx); nowHistory(state, action, ctx); return state; },
  validate(state, ctx) { state.exhibits.forEach(item => readBinding(item.source, ctx)); return check([...(!state.exhibits.length ? ['Add at least one source exhibit.'] : state.exhibits.length > 26 ? ['Split into volumes of at most 26 exhibits.'] : []), ...packetLayoutErrors(state.title, state.exhibits, ctx)]); },
  output(state, ctx) { return { title: state.title, pageIndex: manifest(state.exhibits, ctx), originalHashPolicy: 'Exact source hashes; packet annotations do not alter originals.' }; },
  formats: ['pdf', 'zip'],
  async exportFile(state, ctx, format) {
    valid(this, state, ctx); const bytes = await packetPdf(state.title, state.exhibits, ctx);
    if (format === 'pdf') return fileResult(bytes, 'litigation-packet.pdf', 'application/pdf');
    const zip = zipper(); zipFile(zip, 'packet.pdf', bytes); zipFile(zip, 'page-index.json', JSON.stringify(this.output(state, ctx), null, 2)); return zipResult(zip, 'litigation-packet.zip');
  },
};

const corporateBinder = {
  roleId: 'R27', title: 'Executed closing binder', matterRequired: true,
  description: 'Keep unsigned requirements visible, record lawyer inspection of execution, and bind only executed original PDFs.',
  fields: [field('title', 'Closing title'), jsonField('requirements', 'Required approvals', '[{"id":"board","label":"Board consent"}]')],
  actions: [command('add-requirement', 'Add closing requirement', [field('id', 'Requirement ID'), field('label', 'Required approval')]),
    command('record-execution', 'Review executed original', [field('id', 'Requirement ID'), field('documentId', 'Executed original document ID'), field('signer', 'Observed signer'), field('signedAt', 'Execution date', 'date'), field('signaturePage', 'Physical signature page', 'number')], true)],
  create(input, ctx) { const requirements = rows(input.requirements, 'Requirements', ctx).map(row => ({ id: text(row.id, 'Requirement ID', ctx, 60), label: text(row.label, 'Required approval', ctx, 150), execution: null })); if (new Set(requirements.map(row => row.id)).size !== requirements.length) ctx.fail(422, 'Requirement IDs must be unique.'); return { title: text(input.title, 'Closing title', ctx, 120), requirements, history: [] }; },
  update(state, action, input, ctx) {
    if (action === 'add-requirement') { const id = text(input.id, 'Requirement ID', ctx, 60); if (state.requirements.some(row => row.id === id)) ctx.fail(409, 'That requirement already exists.'); state.requirements.push({ id, label: text(input.label, 'Required approval', ctx, 150), execution: null }); }
    else if (action === 'record-execution') {
      reviewer(ctx); const row = state.requirements.find(item => item.id === input.id); if (!row) ctx.fail(404, 'Choose a closing requirement.');
      const source = binding(input, ctx, true); const signature = binding({ documentId: input.documentId, page: input.signaturePage }, ctx);
      row.execution = { source, signaturePage: signature.page, signer: text(input.signer, 'Observed signer', ctx, 120), signedAt: date(input.signedAt, 'execution date', ctx), reviewedBy: ctx.user.username, reviewedAt: ctx.now };
    } else return unsupported(ctx);
    nowHistory(state, action, ctx, { requirement: input.id }); return state;
  },
  validate(state, ctx) { const errors = []; if (!state.requirements.length) errors.push('Add required approvals.'); for (const row of state.requirements) { if (!row.execution) errors.push(`${row.label} is unsigned or has not been reviewed.`); else readBinding(row.execution.source, ctx); } errors.push(...packetLayoutErrors(state.title, state.requirements.filter(row => row.execution).map(row => ({ label: row.label, source: row.execution.source })), ctx)); return check(errors); },
  output(state, ctx) { return { title: state.title, outstanding: state.requirements.filter(row => !row.execution).map(({ id, label }) => ({ id, label })), executed: state.requirements.filter(row => row.execution).map(row => ({ id: row.id, label: row.label, ...row.execution })), pageIndex: manifest(state.requirements.filter(row => row.execution).map(row => ({ label: row.label, source: row.execution.source })), ctx) }; },
  formats: ['pdf', 'zip'],
  async exportFile(state, ctx, format) {
    valid(this, state, ctx); const items = state.requirements.map(row => ({ label: row.label, source: row.execution.source }));
    if (format === 'pdf') return fileResult(await packetPdf(state.title, items, ctx), 'closing-binder.pdf', 'application/pdf');
    const zip = zipper(); zipFile(zip, 'closing-register.json', JSON.stringify(this.output(state, ctx), null, 2));
    for (const row of state.requirements) zipFile(zip, `executed/${filename(row.id)}.pdf`, readBinding(row.execution.source, ctx).bytes);
    return zipResult(zip, 'executed-originals.zip');
  },
};

const email = (value, ctx) => { if (typeof value !== 'string' || !/^[^\s@<>\r\n]+@[^\s@<>\r\n]+\.[^\s@<>\r\n]+$/.test(value) || value.length > 250) ctx.fail(422, 'Enter a recipient email address.'); return value; };
function correspondenceDraft(input, ctx) {
  return { subject: text(input.subject, 'Subject', ctx, 150).replace(/[\r\n]/g, ' '), body: text(input.body, 'Draft correspondence', ctx, 20000),
    recipient: email(input.recipient, ctx), dates: rows(input.dates ?? [], 'Dates', ctx, 30).map(row => ({ label: text(row.label, 'Date label', ctx, 120), date: date(row.date, 'date', ctx), source: binding(row, ctx) })) };
}
const correspondence = {
  roleId: 'R28', title: 'Correspondence and date handoff', matterRequired: true,
  description: 'Prepare correspondence and source-linked dates; only the assigned lawyer can authorize the exact delivery version.',
  fields: [field('subject', 'Subject'), field('body', 'Draft correspondence', 'textarea'), field('recipient', 'Recipient email'), jsonField('dates', 'Dates with sources', '[{"label":"Hearing","date":"2026-12-20","documentId":"notice-id","page":1}]')],
  actions: [command('revise-draft', 'Revise correspondence', [field('subject', 'Subject'), field('body', 'Draft correspondence', 'textarea'), field('recipient', 'Recipient email'), jsonField('dates', 'Dates with sources', '[]')]), command('authorize-delivery', 'Authorize exact delivery', [field('notes', 'Review and authorization notes', 'textarea')], true), command('record-delivery', 'Record external delivery receipt', [field('reference', 'External delivery reference')])],
  create(input, ctx) { return { draft: correspondenceDraft(input, ctx), authorization: null, deliveries: [], history: [] }; },
  update(state, action, input, ctx) {
    if (action === 'revise-draft') { state.draft = correspondenceDraft(input, ctx); state.authorization = null; }
    else if (action === 'authorize-delivery') { reviewer(ctx); state.draft.dates.forEach(row => readBinding(row.source, ctx)); state.authorization = { sha256: ctx.hash(state.draft), by: ctx.user.username, at: ctx.now, notes: text(input.notes, 'Authorization notes', ctx, 1500) }; }
    else if (action === 'record-delivery') { if (state.authorization?.sha256 !== ctx.hash(state.draft)) ctx.fail(409, 'A reviewing lawyer must authorize this exact correspondence before delivery can be recorded.'); state.deliveries.push({ reference: text(input.reference, 'External delivery receipt', ctx, 250), sha256: ctx.hash(state.draft), recordedBy: ctx.user.username, at: ctx.now }); }
    else return unsupported(ctx);
    nowHistory(state, action, ctx); return state;
  },
  validate(state, ctx) { state.draft.dates.forEach(row => readBinding(row.source, ctx)); return check([...(state.authorization?.sha256 === ctx.hash(state.draft) ? [] : ['The current correspondence needs lawyer delivery authorization.']), ...layoutErrors([state.draft.subject, `To: ${state.draft.recipient}`, state.draft.body])]); },
  assertExport(current, snapshot, ctx) { if (ctx.hash(current.draft) !== ctx.hash(snapshot.draft) || current.authorization?.sha256 !== ctx.hash(current.draft)) ctx.fail(409, 'This correspondence was changed or its delivery authorization was withdrawn. Review the current version before export.'); },
  output(state) { return { ...state.draft, authorization: state.authorization, deliveries: state.deliveries, deliveryMode: 'Download the authorized email and send through your firm email service; receipts are manually recorded.' }; },
  formats: ['eml', 'pdf'],
  async exportFile(state, ctx, format) {
    valid(this, state, ctx);
    if (format === 'eml') return fileResult(Buffer.from(`To: ${state.draft.recipient}\r\nSubject: ${state.draft.subject}\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${Buffer.from(state.draft.body).toString('base64').match(/.{1,76}/g).join('\r\n')}\r\n`), 'authorized-correspondence.eml', 'message/rfc822');
    const { pdf } = await plainPdf([state.draft.subject, `To: ${state.draft.recipient}`, state.draft.body], state.draft.subject, ctx); return fileResult(await pdf.save(), 'authorized-correspondence.pdf', 'application/pdf');
  },
};

function filingPacket(input, ctx) { return { title: text(input.title, 'Filing title', ctx, 150), documents: exhibits(input.documents, ctx, true) }; }
const filing = {
  roleId: 'R30', title: 'Filing attempts and service', matterRequired: true,
  description: 'Preserve the exact original PDFs for each authorized attempt, retain rejection receipts, and gate service on acceptance.',
  fields: [field('title', 'Filing title'), jsonField('documents', 'Filing PDF originals', '[{"label":"Motion","documentId":"motion-id"}]')],
  actions: [command('revise-packet', 'Prepare corrected filing', [field('title', 'Filing title'), jsonField('documents', 'Filing PDF originals', '[{"label":"Motion","documentId":"motion-id"}]')]), command('authorize-filing', 'Authorize exact filing packet', [field('notes', 'Authorization notes', 'textarea')], true), command('record-attempt', 'Record filing receipt', [field('requestId', 'Attempt ID (reuse for a retry)'), { ...field('outcome', 'Court receipt outcome', 'select'), options: ['accepted', 'rejected'] }, field('receipt', 'Court receipt reference'), field('reason', 'Receipt description', 'textarea')]), command('record-service', 'Record service after acceptance', [field('receipt', 'Service receipt reference'), field('recipient', 'Served recipient')])],
  create(input, ctx) { return { packet: filingPacket(input, ctx), authorization: null, attempts: [], services: [], history: [] }; },
  update(state, action, input, ctx) {
    if (action === 'revise-packet') { state.packet = filingPacket(input, ctx); state.authorization = null; }
    else if (action === 'authorize-filing') { reviewer(ctx); if (!state.packet.documents.length) ctx.fail(422, 'Attach filing PDFs.'); state.packet.documents.forEach(row => readBinding(row.source, ctx)); state.authorization = { sha256: ctx.hash(state.packet), by: ctx.user.username, at: ctx.now, notes: text(input.notes, 'Authorization notes', ctx, 1200) }; }
    else if (action === 'record-attempt') {
      if (state.authorization?.sha256 !== ctx.hash(state.packet)) ctx.fail(409, 'Authorize this exact filing packet before recording a submission.');
      state.packet.documents.forEach(row => readBinding(row.source, ctx));
      const entry = { requestId: text(input.requestId, 'Attempt ID', ctx, 120), outcome: oneOf(input.outcome, ['accepted', 'rejected'], 'a receipt outcome', ctx), receipt: text(input.receipt, 'Court receipt reference', ctx, 250), reason: text(input.reason, 'Receipt description', ctx, 2000), packet: structuredClone(state.packet), authorization: structuredClone(state.authorization) };
      const previous = state.attempts.find(row => row.requestId === entry.requestId);
      if (previous) { const { at, by, ...prior } = previous; if (ctx.hash(prior) !== ctx.hash(entry)) ctx.fail(409, 'This attempt ID was used with different receipt or PDF content.'); return state; }
      state.attempts.push({ ...entry, at: ctx.now, by: ctx.user.username });
    } else if (action === 'record-service') {
      const latest = state.attempts.at(-1); if (!latest || latest.outcome !== 'accepted' || latest.authorization.sha256 !== ctx.hash(state.packet)) ctx.fail(409, 'Service is blocked until the current filing is accepted.');
      state.services.push({ receipt: text(input.receipt, 'Service receipt', ctx, 250), recipient: text(input.recipient, 'Served recipient', ctx, 150), attemptId: latest.requestId, packetSha256: latest.authorization.sha256, by: ctx.user.username, at: ctx.now });
    } else return unsupported(ctx);
    nowHistory(state, action, ctx); return state;
  },
  validate(state, ctx) { for (const row of [...state.packet.documents, ...state.attempts.flatMap(attempt => attempt.packet.documents)]) readBinding(row.source, ctx); const latest = state.attempts.at(-1); return check(latest?.outcome === 'accepted' && latest.authorization.sha256 === ctx.hash(state.packet) ? [] : ['The current filing lacks an accepted court receipt.']); },
  output(state) { return { packet: state.packet, attempts: state.attempts, services: state.services, serviceAllowed: state.attempts.at(-1)?.outcome === 'accepted' && state.attempts.at(-1)?.authorization.sha256 === state.authorization?.sha256, execution: 'Court and service receipts are recorded from your external filing provider.' }; },
  assertExport(current, snapshot, ctx) {
    const latest = current.attempts.at(-1), approved = snapshot.attempts.at(-1);
    if (!latest || latest.outcome !== 'accepted' || latest.authorization.sha256 !== ctx.hash(current.packet) || current.authorization?.sha256 !== ctx.hash(current.packet) || approved?.requestId !== latest.requestId || ctx.hash(snapshot.packet) !== ctx.hash(current.packet)) ctx.fail(409, 'This filing packet has been superseded or lacks a current accepted receipt. Filing history remains available inside the work record.');
  },
  formats: ['zip'],
  async exportFile(state, ctx) { valid(this, state, ctx); const zip = zipper(); zipFile(zip, 'filing-history.json', JSON.stringify(this.output(state), null, 2)); for (const [index, attempt] of state.attempts.entries()) for (const [j, doc] of attempt.packet.documents.entries()) zipFile(zip, `attempt-${index + 1}/${j + 1}-${filename(doc.label)}.pdf`, readBinding(doc.source, ctx).bytes); return zipResult(zip, 'filing-attempts.zip'); },
};

const discovery = {
  roleId: 'R31', title: 'Discovery ingestion and production', matterRequired: true,
  description: 'Deduplicate exact originals while retaining import provenance; lawyer review controls release and privilege exclusions.',
  fields: [field('productionName', 'Production name')],
  actions: [command('import-record', 'Import original with provenance', [field('documentId', 'Original document ID'), field('reference', 'Custodian/import reference'), field('label', 'Evidence label')]), command('review-record', 'Review production eligibility', [field('documentId', 'Original document ID'), { ...field('disposition', 'Review disposition', 'select'), options: ['release', 'privileged', 'withhold'] }, field('reason', 'Review reason', 'textarea')], true)],
  create(input, ctx) { return { productionName: text(input.productionName, 'Production name', ctx, 150), evidence: [], history: [] }; },
  update(state, action, input, ctx) {
    if (action === 'import-record') {
      const source = binding(input, ctx, true); const reference = text(input.reference, 'Custodian/import reference', ctx, 250);
      let row = state.evidence.find(item => item.source.sha256 === source.sha256);
      if (!row) { row = { label: text(input.label, 'Evidence label', ctx, 150), source, aliases: [source.documentId], provenance: [], disposition: 'pending', reviewHistory: [] }; state.evidence.push(row); }
      if (!row.aliases.includes(source.documentId)) row.aliases.push(source.documentId);
      if (!row.provenance.some(item => item.reference === reference && item.documentId === source.documentId)) row.provenance.push({ reference, documentId: source.documentId, at: ctx.now, by: ctx.user.username });
    } else if (action === 'review-record') {
      reviewer(ctx); const row = state.evidence.find(item => item.aliases.includes(input.documentId)); if (!row) ctx.fail(404, 'Import the original before reviewing it.'); readBinding(row.source, ctx);
      const decision = { disposition: oneOf(input.disposition, ['release', 'privileged', 'withhold'], 'a disposition', ctx), reason: text(input.reason, 'Review reason', ctx, 1500), by: ctx.user.username, at: ctx.now, sha256: row.source.sha256 };
      row.disposition = decision.disposition; row.reviewHistory.push(decision);
    } else return unsupported(ctx);
    nowHistory(state, action, ctx); return state;
  },
  validate(state, ctx) { state.evidence.forEach(row => readBinding(row.source, ctx)); const errors = []; if (!state.evidence.length) errors.push('Import evidence.'); if (state.evidence.some(row => row.disposition === 'pending')) errors.push('Every evidence record requires a production disposition.'); if (!state.evidence.some(row => row.disposition === 'release')) errors.push('No reviewed evidence is eligible for release.'); return check(errors); },
  output(state) { return { productionName: state.productionName, production: state.evidence.filter(row => row.disposition === 'release').map((row, i) => ({ productionId: `PROD-${String(i + 1).padStart(6, '0')}`, label: row.label, source: row.source })), withheldCount: state.evidence.filter(row => row.disposition !== 'release').length, reviewHistory: state.evidence.map(row => ({ source: row.source, history: row.reviewHistory, provenance: row.provenance })) }; },
  assertExport(current, snapshot, ctx) { for (const row of snapshot.evidence.filter(item => item.disposition === 'release')) { const live = current.evidence.find(item => item.source.sha256 === row.source.sha256); if (live?.disposition !== 'release') ctx.fail(409, 'A production record was withheld after this approval. Review the current production before export.'); } },
  formats: ['zip'],
  async exportFile(state, ctx) { valid(this, state, ctx); const zip = zipper(); const production = this.output(state).production; zipFile(zip, 'production-manifest.json', JSON.stringify({ productionName: state.productionName, production }, null, 2)); for (const row of production) zipFile(zip, row.productionId + '.pdf', readBinding(row.source, ctx).bytes); return zipResult(zip, 'discovery-production.zip'); },
};

function decodeFile(value, max, ctx) {
  if (typeof value !== 'string' || value.length > Math.ceil(max / 3) * 4 + 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 !== 0) ctx.fail(422, 'Choose a supported file within the size limit.');
  const bytes = Buffer.from(value, 'base64'); if (!bytes.length || bytes.length > max || bytes.toString('base64') !== value) ctx.fail(422, 'The file encoding or size is invalid.'); return bytes;
}
const mediaInfo = (bytes, ctx) => {
  if (bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) return { mime: 'video/webm', extension: 'webm' };
  if (bytes.subarray(4, 8).toString() === 'ftyp') return { mime: 'video/mp4', extension: 'mp4' };
  ctx.fail(422, 'Use an MP4 or WebM video file.');
};
const trial = {
  roleId: 'R32', title: 'Offline trial presentation', matterRequired: true,
  description: 'Package exact exhibit pages and reviewed video files into an offline player with a hash manifest.',
  fields: [field('title', 'Rehearsal title'), jsonField('exhibits', 'Exhibit pages', exhibitHint)],
  actions: [command('replace-exhibits', 'Revise trial exhibits', [jsonField('exhibits', 'Exhibit pages', exhibitHint)]), command('add-clip', 'Add presentation video', [field('id', 'Clip ID'), field('label', 'Clip title'), { name: 'mediaBase64', label: 'MP4 or WebM (maximum 3 MB)', type: 'file', accept: 'video/mp4,video/webm', encoding: 'base64', required: true }, field('start', 'Start seconds', 'number'), field('end', 'End seconds', 'number')]), command('approve-clip', 'Approve exact video and segment', [field('id', 'Clip ID'), field('notes', 'Video review notes', 'textarea')], true)],
  create(input, ctx) { return { title: text(input.title, 'Rehearsal title', ctx, 100), exhibits: exhibits(input.exhibits, ctx), clips: [], history: [] }; },
  update(state, action, input, ctx) {
    if (action === 'replace-exhibits') state.exhibits = exhibits(input.exhibits, ctx);
    else if (action === 'add-clip') {
      const id = text(input.id, 'Clip ID', ctx, 60); if (!/^[a-zA-Z0-9_-]+$/.test(id)) ctx.fail(422, 'Clip IDs use letters, numbers, hyphens, and underscores.');
      const bytes = decodeFile(input.mediaBase64, 3 * 1024 * 1024, ctx); const media = mediaInfo(bytes, ctx);
      const start = Number(input.start), end = Number(input.end); if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || end - start > 3600) ctx.fail(422, 'Choose a valid segment up to one hour.');
      const clip = { id, label: text(input.label, 'Clip title', ctx, 120), ...media, mediaBase64: input.mediaBase64, sha256: digest(bytes), start, end, approval: null };
      const previous = state.clips.findIndex(row => row.id === id); if (previous >= 0) state.clips[previous] = clip; else state.clips.push(clip);
      if (state.clips.reduce((sum, row) => sum + row.mediaBase64.length, 0) > 4 * 1024 * 1024) ctx.fail(422, 'Keep offline clips below 3 MB combined so reviewed versions fit in the work record.');
    } else if (action === 'approve-clip') { reviewer(ctx); const clip = state.clips.find(row => row.id === input.id); if (!clip) ctx.fail(404, 'Choose a video clip.'); clip.approval = { sha256: ctx.hash({ sha256: clip.sha256, start: clip.start, end: clip.end }), by: ctx.user.username, at: ctx.now, notes: text(input.notes, 'Review notes', ctx, 1000) }; }
    else return unsupported(ctx);
    nowHistory(state, action, ctx); return state;
  },
  validate(state, ctx) { state.exhibits.forEach(row => readBinding(row.source, ctx)); const errors = []; if (!state.exhibits.length) errors.push('Select trial exhibits.'); if (!state.clips.length) errors.push('Add a reviewed presentation clip.'); for (const clip of state.clips) { if (digest(Buffer.from(clip.mediaBase64, 'base64')) !== clip.sha256) errors.push(`Clip ${clip.id} failed its hash check.`); if (clip.approval?.sha256 !== ctx.hash({ sha256: clip.sha256, start: clip.start, end: clip.end })) errors.push(`Clip ${clip.id} needs exact-segment approval.`); } return check(errors); },
  output(state, ctx) { return { title: state.title, exhibits: manifest(state.exhibits, ctx), clips: state.clips.map(({ mediaBase64, ...clip }) => clip), offlineInstructions: 'Extract all files together. Open index.html. Play each clip and verify exhibit pages in the actual courtroom browser before use.' }; },
  formats: ['zip'],
  async exportFile(state, ctx) {
    valid(this, state, ctx); const zip = zipper(); const html = ['<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Briefcase offline trial</title><style>body{font:18px system-ui;max-width:960px;margin:40px auto;padding:20px}video{width:100%}li{margin:12px 0}code{overflow-wrap:anywhere}</style>', `<h1>${xml(state.title)}</h1><p>Offline approved exhibit and clip package. Exhibit and media hashes are in manifest.json.</p><h2>Exhibits</h2><ol>`];
    for (const [i, exhibit] of state.exhibits.entries()) { const source = readBinding(exhibit.source, ctx); const name = `exhibit-${i + 1}.pdf`; const selected = await newPdf(); const original = await PDFDocument.load(source.bytes); const leaf = original.getPage(exhibit.source.page - 1).node; for (const key of ['Annots', 'AA', 'Metadata', 'PieceInfo', 'StructParents', 'B', 'Thumb']) leaf.delete(PDFName.of(key)); selected.addPage((await selected.copyPages(original, [exhibit.source.page - 1]))[0]); zipFile(zip, name, await selected.save()); html.push(`<li><a href="${name}#page=1">${xml(exhibit.label)} · original page ${exhibit.source.page}</a></li>`); }
    html.push('</ol><h2>Approved video segments</h2>');
    for (const clip of state.clips) { const name = `clip-${clip.id}.${clip.extension}`; zipFile(zip, name, Buffer.from(clip.mediaBase64, 'base64')); html.push(`<section><h3>${xml(clip.label)}</h3><p>Approved range: ${clip.start}–${clip.end} seconds.</p><video controls preload="metadata" data-start="${clip.start}" data-end="${clip.end}" src="${name}#t=${clip.start},${clip.end}"></video></section>`); }
    html.push('<script>for(const v of document.querySelectorAll("video")){v.addEventListener("loadedmetadata",()=>{v.currentTime=Number(v.dataset.start)});v.addEventListener("play",()=>{if(v.currentTime<Number(v.dataset.start)||v.currentTime>=Number(v.dataset.end))v.currentTime=Number(v.dataset.start)});v.addEventListener("timeupdate",()=>{if(v.currentTime>=Number(v.dataset.end))v.pause()})}</script></html>');
    zipFile(zip, 'index.html', html.join('\n')); zipFile(zip, 'manifest.json', JSON.stringify(this.output(state, ctx), null, 2)); return zipResult(zip, 'offline-trial.zip');
  },
};

// Bounded ZIP reader used for synchronous, transactional DOCX imports. It never
// extracts to disk and rejects encryption, ZIP64, traversal, and expansion bombs.
export function readDocxZip(bytes) {
  if (!Buffer.isBuffer(bytes)) bytes = Buffer.from(bytes);
  if (bytes.length > 4 * 1024 * 1024) throw new Error('DOCX exceeds 4 MB.');
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) if (bytes.readUInt32LE(i) === 0x06054b50) { end = i; break; }
  if (end < 0 || bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6)) throw new Error('Use a single-volume DOCX ZIP.');
  const count = bytes.readUInt16LE(end + 10), offset = bytes.readUInt32LE(end + 16), centralSize = bytes.readUInt32LE(end + 12);
  if (count > 128 || offset + centralSize !== end || end + 22 + bytes.readUInt16LE(end + 20) !== bytes.length) throw new Error('Unsupported DOCX archive.');
  let p = offset, total = 0; const entries = new Map();
  for (let i = 0; i < count; i++) {
    if (p + 46 > end || bytes.readUInt32LE(p) !== 0x02014b50) throw new Error('Invalid DOCX directory.');
    const flags = bytes.readUInt16LE(p + 8), method = bytes.readUInt16LE(p + 10), compressed = bytes.readUInt32LE(p + 20), uncompressed = bytes.readUInt32LE(p + 24), nameLength = bytes.readUInt16LE(p + 28), extraLength = bytes.readUInt16LE(p + 30), commentLength = bytes.readUInt16LE(p + 32), local = bytes.readUInt32LE(p + 42);
    const name = bytes.subarray(p + 46, p + 46 + nameLength).toString('utf8');
    if (flags & 1 || ![0, 8].includes(method) || /(^\/|\.\.|\\|\0)/.test(name) || entries.has(name) || uncompressed > 2 * 1024 * 1024 || (total += uncompressed) > 8 * 1024 * 1024) throw new Error('Unsafe or unsupported DOCX entry.');
    if (local + 30 > offset || bytes.readUInt32LE(local) !== 0x04034b50) throw new Error('Invalid DOCX local entry.');
    const localNameLength = bytes.readUInt16LE(local + 26), localExtraLength = bytes.readUInt16LE(local + 28), start = local + 30 + localNameLength + localExtraLength;
    if (start + compressed > offset || bytes.subarray(local + 30, local + 30 + localNameLength).toString('utf8') !== name || bytes.readUInt16LE(local + 8) !== method) throw new Error('Invalid DOCX entry range.');
    const content = method === 0 ? bytes.subarray(start, start + compressed) : inflateRawSync(bytes.subarray(start, start + compressed), { maxOutputLength: 2 * 1024 * 1024 });
    if (content.length !== uncompressed || crc32(content) !== bytes.readUInt32LE(p + 16)) throw new Error('DOCX entry failed its length or CRC integrity check.');
    entries.set(name, Buffer.from(content)); p += 46 + nameLength + extraLength + commentLength;
  }
  if (p !== end || !entries.has('[Content_Types].xml') || !entries.has('word/document.xml')) throw new Error('This file is not a supported DOCX.');
  return entries;
}
function documentInput(input, ctx) {
  const sections = rows(input.sections, 'Document sections', ctx, 40).map(row => ({ heading: text(row.heading, 'Section heading', ctx, 100), text: text(row.text, 'Section text', ctx, 10000) }));
  const authorities = rows(input.authorities ?? [], 'Authorities', ctx, 60).map(row => ({ citation: text(row.citation, 'Citation', ctx, 250), source: binding(row, ctx) }));
  return { title: text(input.title, 'Document title', ctx, 120), sections, authorities, exhibits: exhibits(input.exhibits ?? [], ctx) };
}
function logicalParagraphs(draft) {
  return [draft.title, ...draft.sections.flatMap((row, i) => [`${i + 1}. ${row.heading}`, ...row.text.split('\n')]), 'Table of Authorities', ...draft.authorities.map((row, i) => `${i + 1}. ${row.citation} — source ${row.source.documentId}, page ${row.source.page}`), 'Exhibit Index', ...draft.exhibits.map(row => `${row.label} — source ${row.source.documentId}, page ${row.source.page}`)];
}
const wordParagraph = (line, style = 'Normal') => `<w:p><w:pPr><w:pStyle w:val="${style}"/><w:spacing w:after="120" w:line="280" w:lineRule="auto"/></w:pPr><w:r><w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman"/><w:sz w:val="24"/></w:rPr><w:t xml:space="preserve">${xml(line)}</w:t></w:r></w:p>`;
async function docxBytes(draft) {
  const zip = zipper();
  zipFile(zip, '[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/></Types>');
  zipFile(zip, '_rels/.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zipFile(zip, 'word/_rels/document.xml.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/></Relationships>');
  zipFile(zip, 'word/styles.xml', '<?xml version="1.0"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman"/><w:sz w:val="24"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:rPr><w:b/></w:rPr></w:style></w:styles>');
  zipFile(zip, 'word/footer1.xml', '<?xml version="1.0"?><w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText>PAGE</w:instrText></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p></w:ftr>');
  zipFile(zip, 'word/document.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body>' + logicalParagraphs(draft).map((line, i) => wordParagraph(line, i === 0 ? 'Title' : 'Normal')).join('') + '<w:sectPr><w:footerReference w:type="default" r:id="rId2"/><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body></w:document>');
  return zipped(zip);
}
function importParagraphs(bytes, ctx) {
  let entries;
  try { entries = readDocxZip(bytes); } catch (error) { ctx.fail(422, error.message); }
  const document = entries.get('word/document.xml').toString('utf8');
  if (entries.has('word/vbaProject.bin') || [...entries.keys()].some(name => /^word\/(media|embeddings)\//.test(name)) || /<!DOCTYPE|<!ENTITY|<w:(?:tbl|drawing|object|ins|del|altChunk|hyperlink|fldChar|numPr|tab|br|sym|footnoteReference|endnoteReference|sdt|subDoc|vanish)\b|<m:/.test(document)) ctx.fail(422, 'This editor supports text paragraphs in the Briefcase template. Resolve tracked changes, tables, fields, images, or embedded objects in Word before importing.');
  for (const [name, contents] of entries) if (name.endsWith('.rels') && /TargetMode\s*=\s*["']External["']/i.test(contents.toString())) ctx.fail(422, 'External document relationships are not supported.');
  if (!/<w:pgSz\b[^>]*w:w="12240"[^>]*w:h="15840"/.test(document) || !/<w:pgMar\b[^>]*w:top="1440"[^>]*w:right="1440"[^>]*w:bottom="1440"[^>]*w:left="1440"/.test(document)) ctx.fail(422, 'Preserve US Letter paper and one-inch margins in the supported template.');
  let paragraphs;
  try { paragraphs = [...document.matchAll(/<w:p\b[^>]*>([\s\S]*?)<\/w:p>/g)].map(match => [...match[1].matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)].map(row => unxml(row[1])).join('')); }
  catch { ctx.fail(422, 'The Word document contains an invalid character reference.'); }
  if (!paragraphs.length) ctx.fail(422, 'The document contains no supported paragraphs.');
  return paragraphs;
}
function roundTrip(draft, paragraphs, ctx) {
  const previous = logicalParagraphs(draft); const firstAuthorities = paragraphs.indexOf('Table of Authorities'); const firstExhibits = paragraphs.indexOf('Exhibit Index');
  if (firstAuthorities < 1 || firstExhibits <= firstAuthorities || paragraphs.slice(firstAuthorities).join('\n') !== previous.slice(previous.indexOf('Table of Authorities')).join('\n')) ctx.fail(422, 'Keep the authority table and exhibit index intact; edit their source references inside Briefcase.');
  let index = 1; const sections = [];
  for (let i = 0; i < draft.sections.length; i++) {
    if (!paragraphs[index]?.startsWith(`${i + 1}. `)) ctx.fail(422, 'Preserve the numbered section headings.');
    const heading = text(paragraphs[index++].slice(String(i + 1).length + 2), 'Section heading', ctx, 100); const parts = [];
    while (index < firstAuthorities && (i === draft.sections.length - 1 || !paragraphs[index].startsWith(`${i + 2}. `))) parts.push(paragraphs[index++]);
    sections.push({ heading, text: text(parts.join('\n'), 'Section text', ctx, 10000) });
  }
  if (index !== firstAuthorities) ctx.fail(422, 'The edited document does not match the supported section structure.');
  return { ...draft, title: text(paragraphs[0], 'Document title', ctx, 120), sections };
}
const production = {
  roleId: 'R65', title: 'Document production and comparison', matterRequired: true,
  description: 'Edit numbered sections, preserve source-backed authority and exhibit indexes, compare revisions, and export the supported Word/PDF template.',
  fields: [field('title', 'Document title'), jsonField('sections', 'Numbered sections', '[{"heading":"Introduction","text":"Draft text."}]'), jsonField('authorities', 'Source-backed authorities', '[{"citation":"Authority citation","documentId":"authority-id","page":1}]'), jsonField('exhibits', 'Exhibit index', exhibitHint)],
  actions: [command('edit-document', 'Revise structured document', [field('title', 'Document title'), jsonField('sections', 'Numbered sections', '[{"heading":"Introduction","text":"Revised text."}]'), jsonField('authorities', 'Source-backed authorities', '[]'), jsonField('exhibits', 'Exhibit index', '[]')]), command('import-docx', 'Import edited Briefcase Word document', [{ name: 'docxBase64', label: 'Edited Briefcase DOCX (maximum 4 MB)', type: 'file', accept: '.docx', encoding: 'base64', required: true }])],
  create(input, ctx) { return { draft: documentInput(input, ctx), comparisons: [], history: [] }; },
  update(state, action, input, ctx) {
    const prior = structuredClone(state.draft); let next; let sourceSha256;
    if (action === 'edit-document') next = documentInput(input, ctx);
    else if (action === 'import-docx') { const bytes = decodeFile(input.docxBase64, 4 * 1024 * 1024, ctx); next = roundTrip(state.draft, importParagraphs(bytes, ctx), ctx); sourceSha256 = digest(bytes); }
    else return unsupported(ctx);
    const before = logicalParagraphs(prior), after = logicalParagraphs(next);
    state.comparisons.push({ beforeSha256: ctx.hash(prior), afterSha256: ctx.hash(next), at: ctx.now, by: ctx.user.username, ...(sourceSha256 ? { importedDocxSha256: sourceSha256 } : {}), changes: Array.from({ length: Math.max(before.length, after.length) }, (_, i) => ({ paragraph: i + 1, before: before[i] ?? '', after: after[i] ?? '' })).filter(row => row.before !== row.after) });
    state.draft = next; nowHistory(state, action, ctx); return state;
  },
  validate(state, ctx) {
    const errors = []; if (!state.draft.sections.length) errors.push('Add numbered document sections.');
    for (const row of [...state.draft.authorities, ...state.draft.exhibits]) readBinding(row.source, ctx);
    errors.push(...layoutErrors(logicalParagraphs(state.draft)));
    return { errors, warnings: ['Word import supports the Briefcase paragraph template, US Letter pages and one-inch margins. Arbitrary Word layouts, tracked changes and embedded objects are not imported. Word/PDF page breaks can differ; preview the final PDF before filing.'] };
  },
  output(state, ctx) { return { title: state.draft.title, documentSha256: ctx.hash(state.draft), numberedSections: state.draft.sections.map((row, i) => ({ number: i + 1, ...row })), authorityTable: state.draft.authorities, exhibitIndex: state.draft.exhibits, comparisons: state.comparisons, format: { paper: 'US Letter', marginsInches: 1, font: 'Times New Roman', fontPoints: 12, pageNumbers: true }, scope: 'Structured Briefcase template; arbitrary Word formatting requires external review.' }; },
  formats: ['docx', 'pdf', 'zip'],
  async exportFile(state, ctx, format) {
    valid(this, state, ctx);
    if (format === 'docx') return fileResult(await docxBytes(state.draft), 'briefcase-document.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    const { pdf } = await plainPdf(logicalParagraphs(state.draft), state.draft.title, ctx); const pdfBytes = await pdf.save();
    if (format === 'pdf') return fileResult(pdfBytes, 'briefcase-document.pdf', 'application/pdf');
    const zip = zipper(); zipFile(zip, 'document.docx', await docxBytes(state.draft)); zipFile(zip, 'document.pdf', pdfBytes); zipFile(zip, 'comparison-and-sources.json', JSON.stringify(this.output(state, ctx), null, 2)); return zipResult(zip, 'document-production.zip');
  },
};

export const workflows = [litigationPacket, corporateBinder, correspondence, filing, discovery, trial, production];
