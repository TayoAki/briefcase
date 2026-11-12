export const limits = Object.freeze({ bytes: 25 * 1024 * 1024, pages: 60, events: 250, text: 14000 });

export class ValidationError extends Error {
  constructor(message) { super(message); this.name = 'ValidationError'; }
}

const isoDate = /^\d{4}-\d{2}-\d{2}$/;
const monthNames = 'january february march april may june july august september october november december'.split(' ');
const datePattern = /\b(?:\d{4}-\d{2}-\d{2}|\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}|(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?\s+\d{1,2},?\s+\d{4})\b/i;
const serviceLine = /^(?:date of service|encounter date|service date|treatment date|visit date|study date|exam date|appointment date|performed on|admission date|dos|seen on)\s*[:#-]/i;
const otherDate = /\b(?:date of birth|dob|birth date|printed|generated|signed|received|entered|dictated|report date)\b/i;
const providerLine = /^(?:provider|facility|practice|clinician|physician|treating provider|ordering provider|rendering provider)\s*:\s*(.+)/i;
const summaryLine = /^(?:summary|assessment|impression|findings|subjective|history of present illness|treatment|plan)\s*:\s*(.*)/i;
const titleLine = /^(?:event|encounter type|visit type|record type|document type)\s*:\s*(.+)/i;
const types = [
  [/emergency department|emergency visit|emergency room|\ber visit/i, 'Emergency visit'],
  [/radiograph|x-ray|mri|imaging|\bct scan/i, 'Imaging'],
  [/physical therapy|rehabilitation|physiotherapy/i, 'Physical therapy'],
  [/follow-up|follow up|reassessment/i, 'Follow-up'],
  [/procedure|surgery|injection/i, 'Procedure'],
  [/discharge/i, 'Discharge'],
  [/evaluation|consultation|clinic visit|office visit/i, 'Evaluation'],
];

export const now = () => new Date().toISOString();
export const uid = () => globalThis.crypto.randomUUID();
export const clean = (value, size = 250) => String(value ?? '').trim().slice(0, size);
export const squash = value => String(value ?? '').replace(/\s+/g, ' ').trim();

function parseDate(value) {
  let year, month, day;
  if (isoDate.test(value)) {
    [year, month, day] = value.split('-').map(Number);
  } else if (/^\d/.test(value)) {
    [month, day, year] = value.split(/[/.-]/).map(Number);
    if (year < 100) year += year >= 50 ? 1900 : 2000;
  } else {
    const [name, number, fullYear] = value.replace(/[.,]/g, '').split(/\s+/);
    month = monthNames.findIndex(item => item.startsWith(name.toLowerCase().slice(0, 3))) + 1;
    day = Number(number);
    year = Number(fullYear);
  }
  const date = new Date(Date.UTC(year, month - 1, day));
  if (year < 1900 || year > 2200 || date.getUTCFullYear() !== year ||
      date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return date.toISOString().slice(0, 10);
}

export function printedLabel(text) {
  return clean(String(text).match(/\b(?:bates(?:\s+(?:no\.?|label|number))?|record page|page id)\s*[:#]\s*([A-Z0-9][A-Z0-9._ -]{0,31})/i)?.[1], 32);
}

export function pageHasText(text) {
  return (String(text).match(/[\p{L}\p{N}]/gu) || []).length >= 22;
}

export function makeDocument({ name, sha256, bytes, pages, engine = 'direct', id = uid() }) {
  if (!Array.isArray(pages) || !pages.length || pages.length > limits.pages ||
      !/^[a-f0-9]{64}$/.test(sha256) || !Number.isInteger(bytes) || bytes < 1 || bytes > limits.bytes) {
    throw new ValidationError('The PDF or its page index is invalid.');
  }
  return {
    id, name: clean(name, 180) || 'Medical records.pdf', sha256, bytes, engine: clean(engine, 80), importedAt: now(),
    pages: pages.map((page, index) => {
      const text = clean(page.text, limits.text);
      const method = ['text', 'ocr', 'unreadable'].includes(page.method) ? page.method : 'unreadable';
      return { number: index + 1, label: clean(page.label, 48) || printedLabel(text), text, method };
    }),
  };
}

export function createMatter({ name, reference, jurisdiction, demo = false, id = uid() }) {
  name = clean(name, 110);
  if (!name) throw new ValidationError('Enter a matter name.');
  return {
    id, name, reference: clean(reference, 30), jurisdiction: clean(jurisdiction, 70), demo,
    revision: 0, createdAt: now(), updatedAt: now(), documents: [], events: [], approvals: [], pageReviews: {}, activity: [],
  };
}

function touch(matter, action, actor, details = {}) {
  matter.revision += 1;
  matter.updatedAt = now();
  matter.activity.unshift({ at: matter.updatedAt, action, actor, ...details });
}

function eventType(title) {
  return types.find(([pattern]) => pattern.test(title))?.[1] ?? 'Other';
}

export function suggestionsFor(document) {
  const events = [];
  for (const page of document.pages) {
    if (page.method === 'unreadable') continue;
    const lines = page.text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    const dates = lines.flatMap((line, index) => {
      const hit = line.match(datePattern);
      if (!hit || (!serviceLine.test(line) && otherDate.test(line))) return [];
      const date = parseDate(hit[0]);
      return date ? [{ index, date, explicit: serviceLine.test(line) }] : [];
    });
    const serviceDates = dates.filter(date => date.explicit);
    const anchors = serviceDates.length ? serviceDates : dates.slice(0, 1);
    for (const [index, anchor] of anchors.entries()) {
      const start = index === 0 ? 0 : anchor.index;
      const end = anchors[index + 1]?.index ?? lines.length;
      const section = lines.slice(start, end);
      const heading = section.find(line => titleLine.test(line))?.match(titleLine)?.[1] ??
        section.find(line => line.length >= 5 && line.length <= 85 && eventType(line) !== 'Other' && !summaryLine.test(line));
      const summaryIndex = section.findIndex(line => summaryLine.test(line));
      const summary = summaryIndex >= 0
        ? section[summaryIndex].match(summaryLine)[1] || section[summaryIndex + 1]
        : section.find(line => line.length >= 50 && !otherDate.test(line) && !serviceLine.test(line));
      if (!anchor.explicit && !heading && !summary) continue;
      const title = clean(heading, 120) || 'Dated record';
      const quote = clean(summary || lines[anchor.index], 700);
      const provider = section.find(line => providerLine.test(line))?.match(providerLine)?.[1] ??
        lines.find(line => providerLine.test(line))?.match(providerLine)?.[1];
      if (events.some(event => event.page === page.number && event.date === anchor.date && event.quote === quote)) continue;
      events.push({
        id: uid(), documentId: document.id, page: page.number, date: anchor.date, title, provider: clean(provider, 140),
        summary: quote, quote, category: eventType(title), status: 'needs_review', origin: 'extracted', reason: '', manualSource: false,
      });
    }
  }
  return events;
}

export const supportingPdf = document => document.purpose === 'supporting';
export const sameOriginal = (document, hash, purpose) => document.sha256 === hash &&
  supportingPdf(document) === (purpose === 'supporting');

export function addDocument(matter, document, actor, suggestions) {
  const existing = matter.documents.find(item => sameOriginal(item, document.sha256, document.purpose));
  if (existing) return existing;
  matter.documents.push(document);
  if (supportingPdf(document)) {
    matter.updatedAt = now();
    matter.activity.unshift({ at: matter.updatedAt, action: 'Supporting PDF attached', actor, documentId: document.id });
    return document;
  }
  suggestions ??= suggestionsFor(document);
  const capacity = Math.max(0, limits.events - matter.events.length);
  matter.events.push(...suggestions.slice(0, capacity));
  if (suggestions.length > capacity) {
    document.suggestionLimit = true;
  }
  touch(matter, 'PDF imported', actor, { documentId: document.id });
  return document;
}

export function getPage(matter, documentId, page) {
  const doc = matter.documents.find(item => item.id === documentId);
  return doc?.pages.find(item => item.number === Number(page)) ?? null;
}

function eventFields(matter, input, manualSource) {
  const date = clean(input.date, 10);
  const title = clean(input.title, 120);
  const provider = clean(input.provider, 140);
  const summary = clean(input.summary, 1400);
  const quote = clean(input.quote, 700);
  const documentId = clean(input.documentId, 80);
  const page = Number(input.page);
  const source = getPage(matter, documentId, page);
  if (!isoDate.test(date) || !parseDate(date)) throw new ValidationError('Enter a valid date of service.');
  if (!title || !summary || !quote) throw new ValidationError('An event title, summary, and source excerpt are required.');
  if (!source) throw new ValidationError('Choose a page from an original PDF in this matter.');
  if (!manualSource && !squash(source.text).toLowerCase().includes(squash(quote).toLowerCase())) {
    throw new ValidationError('The excerpt does not match the indexed page. Copy it from the page or confirm that you transcribed it from the original.');
  }
  return { date, title, provider, summary, quote, documentId, page, category: eventType(title), manualSource };
}

export function createEvent(matter, input, actor, origin = 'manual') {
  if (matter.events.length >= limits.events) throw new ValidationError('This matter has reached the event limit.');
  const event = {
    ...eventFields(matter, input, origin === 'manual' && input.manualSource === true),
    id: uid(), status: 'needs_review', reason: '', origin,
  };
  matter.events.push(event);
  touch(matter, 'Event added', actor, { eventId: event.id });
  return event;
}

export function updateEvent(matter, id, input, actor) {
  const event = matter.events.find(item => item.id === id);
  if (!event) throw new ValidationError('That event is no longer in this matter.');
  const action = input.action;
  const details = { eventId: id };
  if (action === 'edit') {
    Object.assign(event, eventFields(matter, input, input.manualSource === true), {
      status: 'needs_review', reason: '', reviewedAt: null, reviewedBy: null,
    });
    touch(matter, 'Event edited', actor, details);
  } else if (action === 'verify') {
    if (event.status === 'verified') return event;
    if (event.status !== 'needs_review') throw new ValidationError('Reopen the event before verifying it.');
    eventFields(matter, event, event.manualSource);
    Object.assign(event, { status: 'verified', reason: '', reviewedAt: now(), reviewedBy: actor });
    touch(matter, 'Event verified', actor, details);
  } else if (action === 'exclude') {
    const reason = clean(input.reason, 500);
    if (!reason) throw new ValidationError('Enter a reason for excluding this event.');
    if (event.status === 'excluded' && event.reason === reason) return event;
    Object.assign(event, { status: 'excluded', reason, reviewedAt: now(), reviewedBy: actor });
    touch(matter, 'Event excluded', actor, { ...details, reason });
  } else if (action === 'reopen') {
    if (event.status === 'needs_review') return event;
    Object.assign(event, { status: 'needs_review', reason: '', reviewedAt: null, reviewedBy: null });
    touch(matter, 'Event reopened', actor, details);
  } else {
    throw new ValidationError('Choose a valid review action.');
  }
  return event;
}

export function reviewPage(matter, input, actor) {
  const doc = matter.documents.find(item => item.id === input.documentId);
  const page = getPage(matter, input.documentId, input.page);
  const reason = clean(input.reason, 500);
  if (!page || page.method !== 'unreadable' || !doc || !reason) {
    throw new ValidationError('Select a flagged page and record how you handled it.');
  }
  matter.pageReviews[doc.id + ':' + page.number] = { reason, actor, at: now() };
  touch(matter, 'OCR gap reviewed', actor, { documentId: doc.id, page: page.number, reason });
}

export function coverage(matter) {
  return matter.documents.filter(doc => !supportingPdf(doc)).flatMap(doc => doc.pages.filter(page => page.method === 'unreadable').map(page => ({
    documentId: doc.id, name: doc.name, number: page.number,
    review: matter.pageReviews[doc.id + ':' + page.number] ?? null,
  })));
}

export function reviewState(matter) {
  const pending = matter.events.filter(event => event.status === 'needs_review').length;
  const verified = matter.events.filter(event => event.status === 'verified').length;
  const gaps = coverage(matter).filter(item => !item.review).length;
  const limited = matter.documents.some(document => document.suggestionLimit);
  return { pending, verified, gaps, limited, current: matter.approvals.find(item => item.revision === matter.revision) ?? null };
}

export function approveMatter(matter, actor, attested) {
  if (attested !== true) throw new ValidationError('Confirm you reviewed the events and their cited pages.');
  const { pending, verified, gaps, limited, current } = reviewState(matter);
  if (current) return current;
  if (pending || gaps || limited || !verified) {
    throw new ValidationError('Resolve open events and page flags and verify at least one event before approval.');
  }
  const events = matter.events.filter(event => event.status === 'verified')
    .sort((a, b) => a.date.localeCompare(b.date) || a.page - b.page)
    .map(event => {
      const doc = matter.documents.find(item => item.id === event.documentId);
      const page = getPage(matter, event.documentId, event.page);
      eventFields(matter, event, event.manualSource);
      return { ...event, sourceName: doc.name, sourceSha256: doc.sha256, printedLabel: page.label, pageMethod: page.method };
    });
  const snapshot = {
    id: uid(), version: matter.approvals.length + 1, revision: matter.revision, approvedAt: now(), approvedBy: actor,
    matter: { id: matter.id, name: matter.name, reference: matter.reference, jurisdiction: matter.jurisdiction },
    events, excluded: matter.events.filter(event => event.status === 'excluded').map(event => ({ ...event })),
    sources: matter.documents.filter(doc => !supportingPdf(doc) || events.some(event => event.documentId === doc.id))
      .map(({ id, name, sha256, bytes, pages }) => ({ id, name, sha256, bytes, pageCount: pages.length })),
    pageReviews: structuredClone(matter.pageReviews),
  };
  matter.approvals.unshift(snapshot);
  matter.activity.unshift({ at: snapshot.approvedAt, action: 'Chronology approved', actor, version: snapshot.version });
  matter.updatedAt = snapshot.approvedAt;
  return snapshot;
}

export function referenceUrl(origin, matterId, documentId, page) {
  const url = new URL(origin);
  url.search = new URLSearchParams({ matter: matterId, document: documentId, page: String(page) });
  url.hash = '';
  return url.href;
}

export function exportSnapshot(snapshot, format, origin) {
  if (!snapshot) throw new ValidationError('Approve a chronology before exporting it.');
  const events = snapshot.events.map(event => ({
    ...event, sourceUrl: referenceUrl(origin, snapshot.matter.id, event.documentId, event.page),
  }));
  if (format === 'json') return JSON.stringify({ ...snapshot, events }, null, 2) + '\n';
  if (format !== 'csv') throw new ValidationError('Choose CSV or source manifest.');
  const headers = ['Date of service', 'Event', 'Provider', 'Summary', 'Source file', 'Original PDF page', 'Printed label', 'Evidence excerpt', 'Source link', 'Source SHA-256', 'Approved version'];
  const csvCell = value => {
    let text = String(value ?? '');
    if (/^[\s]*[=+@-]/.test(text) || /^[\t\r\n]/.test(text)) text = "'" + text;
    return '"' + text.replaceAll('"', '""') + '"';
  };
  return '\uFEFF' + [headers, ...events.map(event => [
    event.date, event.title, event.provider, event.summary, event.sourceName, event.page, event.printedLabel,
    event.quote, event.sourceUrl, event.sourceSha256, snapshot.version,
  ])].map(row => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

export function exportName(snapshot, format) {
  const label = (snapshot.matter.reference || snapshot.matter.name).replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '') || 'matter';
  return label + '-chronology-v' + snapshot.version + (format === 'json' ? '-sources.json' : '.csv');
}
