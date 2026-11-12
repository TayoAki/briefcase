import { exportSnapshot } from './model.mjs';
import { packetText, sourceIndex } from './practice.mjs';
import { officeRows } from './office.mjs';

const maximumBytes = 75 * 1024 * 1024;
const fileLabel = value => String(value ?? '').replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^[.-]+/, '').slice(0, 80) || 'matter';

async function original(matter, source, load, budget) {
  const document = matter.documents.find(doc => doc.id === source.documentId && doc.sha256 === source.sha256);
  if (!document) throw new Error('A packet source is no longer available.');
  budget.bytes += document.bytes;
  if (budget.bytes > maximumBytes) throw new Error('This packet exceeds the 75 MB source limit.');
  const bytes = await load(matter, document);
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte =>
    byte.toString(16).padStart(2, '0')).join('');
  if (digest !== document.sha256) throw new Error('An original PDF failed its integrity check.');
  return bytes;
}

async function selectedPages(matter, sources, load, budget) {
  const { PDFDocument, PDFName } = await import('./vendor/packets/pdf-lib.mjs');
  const exhibits = await PDFDocument.create();
  let lastDocumentId, sourcePdf;
  for (const source of sources) {
    if (source.documentId !== lastDocumentId) {
      sourcePdf = await PDFDocument.load(await original(matter, source, load, budget));
      lastDocumentId = source.documentId;
    }
    const leaf = sourcePdf.getPage(source.page - 1).node;
    for (const key of ['Annots', 'AA', 'Metadata', 'PieceInfo', 'StructParents', 'B', 'Thumb']) leaf.delete(PDFName.of(key));
    const [page] = await exhibits.copyPages(sourcePdf, [source.page - 1]);
    exhibits.addPage(page);
  }
  return exhibits.save();
}

export async function buildPacket(kind, matter, snapshot, load, origin, closeoutId) {
  await import('./vendor/packets/jszip.mjs');
  const zip = new globalThis.JSZip();
  const budget = { bytes: 0 };
  const recipient = kind === 'demand-recipient';
  if (kind === 'demand' || recipient) {
    zip.file('Demand-letter.txt', packetText('demand', snapshot));
    zip.file('Selected-exhibits.pdf', await selectedPages(matter, snapshot.contents.exhibits.map(row => row.source), load, budget));
    if (!recipient) zip.file('Approved-chronology.csv', exportSnapshot(snapshot.chronology, 'csv', origin));
  } else {
    const closeout = closeoutId ? snapshot.closeouts?.find(item => item.id === closeoutId) : null;
    if (closeoutId && !closeout) throw new Error('That closeout is unavailable.');
    snapshot = { ...snapshot, closeouts: undefined, selectedCloseout: closeout ?? undefined };
    zip.file('Settlement-statement.txt', packetText(kind, snapshot));
    for (const [index, attachment] of (closeout?.attachments ?? []).entries()) {
      zip.file('Closing-documents/' + (index + 1) + '-' + fileLabel(attachment.name), await original(matter, attachment, load, budget));
    }
  }
  if (!recipient) zip.file('Source-index.json', sourceIndex(matter, snapshot, origin));
  const name = fileLabel(matter.reference || matter.name) + '-' + kind + '-v' + snapshot.version +
    (closeoutId ? '-closeout-' + closeoutId.slice(0, 8) : '') + '.zip';
  return { name, bytes: await zip.generateAsync({ type: 'uint8array' }) };
}

export async function buildOfficePacket(matter, row, load, origin) {
  const filing = row.type === 'filing' && ['Ready', 'Submitted', 'Accepted', 'Rejected'].includes(row.status);
  if (!filing && (!['production', 'hearing'].includes(row.type) || !['Reviewed', 'Prepared', 'Delivered', 'Held', 'Supplemented'].includes(row.status))) {
    throw new Error('Review this packet before downloading it.');
  }
  const exhibits = (row.fields.exhibits ?? []).map(link => {
    const item = officeRows(matter, 'evidence').find(entry => entry.id === link.id);
    const version = item?.versionId === link.versionId ? item : item?.history.find(entry => entry.versionId === link.versionId);
    if (!version?.fields.source || version.status !== 'Reviewed') throw new Error('A selected exhibit has no reviewed source version.');
    const src = version.fields.source;
    const url = new URL(origin);
    url.search = new URLSearchParams({ matter: matter.id, document: src.documentId, page: String(src.page) });
    return { label: version.title, version: link.versionId, source: { ...src, url: url.href } };
  });
  await import('./vendor/packets/jszip.mjs');
  const zip = new globalThis.JSZip();
  const budget = { bytes: 0 };
  if (filing) {
    const link = row.fields.draft;
    const draft = officeRows(matter, link.type).find(entry => entry.id === link.id);
    const version = draft?.versionId === link.versionId ? draft : draft?.history.find(entry => entry.versionId === link.versionId);
    if (version?.status !== 'Approved' || !version.fields.source) throw new Error('Select an approved pleading or motion version first.');
    zip.file('Reviewed-filing.pdf', await original(matter, version.fields.source, load, budget));
    zip.file('Filing-source.json', JSON.stringify({ title: version.title, source: version.fields.source, version: link.versionId }, null, 2));
  }
  zip.file('Packet-index.json', JSON.stringify({ matter: matter.name, reference: matter.reference, record: row, exhibits }, null, 2));
  zip.file('Packet-summary.txt', [row.title, row.status + ' · ' + row.changedBy, row.fields.details ?? row.fields.exclusions ?? '',
    '', ...exhibits.map((item, index) => (index + 1) + '. ' + item.label + ' · ' + item.source.name + ' · page ' + item.source.page),
  ].join('\n'));
  if (exhibits.length) zip.file('Selected-exhibits.pdf', await selectedPages(matter, exhibits.map(item => item.source), load, budget));
  return { name: fileLabel(matter.reference || matter.name) + '-' + row.type + '-v' + (row.history.length + 1) + '.zip',
    bytes: await zip.generateAsync({ type: 'uint8array' }) };
}
