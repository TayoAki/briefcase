import { addDocument, approveMatter, createEvent, createMatter, reviewPage, sameOriginal, updateEvent } from './model.mjs';
import { checkPdfFile, digest, readPdf } from './pdf.mjs';
import { changePractice, conflictResult, practice, queueItems } from './practice.mjs';

const demoId = 'ellis-sample';
const demoDocumentId = 'ellis-medical-records';
const demoUrl = new URL('./sample/Ellis_Medical_Records.pdf', import.meta.url);

function request(work) {
  return new Promise((resolve, reject) => {
    work.onsuccess = () => resolve(work.result);
    work.onerror = () => reject(work.error);
  });
}

function transaction(db, names, mode) {
  const tx = db.transaction(names, mode);
  const done = new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onabort = () => reject(tx.error ?? new Error('The browser did not save this change.'));
    tx.onerror = () => reject(tx.error);
  });
  done.catch(() => {});
  return { tx, done };
}

function openDb() {
  const opening = indexedDB.open('briefcase-solo-pilot-v1', 1);
  opening.onupgradeneeded = () => {
    opening.result.createObjectStore('matters', { keyPath: 'id' });
    opening.result.createObjectStore('pdfs');
  };
  return request(opening);
}

async function getResponse(response) {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || 'The request could not be completed.');
    error.status = response.status;
    throw error;
  }
  return data;
}

class ServerStore {
  constructor(info) { this.info = info; }
  async call(path, { method = 'GET', data, file, revision, purpose } = {}) {
    const headers = {};
    if (method !== 'GET') headers['X-Briefcase-Request'] = '1';
    if (data) headers['Content-Type'] = 'application/json';
    if (file) {
      headers['Content-Type'] = 'application/pdf';
      headers['X-PDF-Name'] = encodeURIComponent(file.name);
      if (purpose) headers['X-PDF-Purpose'] = purpose;
    }
    if (revision !== undefined) headers['If-Match'] = String(revision);
    return getResponse(await fetch('/api/' + path, {
      method, headers, credentials: 'same-origin',
      body: file || (data ? JSON.stringify(data) : undefined),
    }));
  }
  list() { return this.call('matters'); }
  matter(id) { return this.call('matters/' + id); }
  create(data) { return this.call('matters', { method: 'POST', data }); }
  mutate(matter, command, data) {
    return this.call('matters/' + matter.id + '/' + command, { method: 'POST', data, revision: matter.revision });
  }
  workflow(matter, data) {
    return this.call('matters/' + matter.id + '/practice', { method: 'POST', data, revision: practice(matter).revision });
  }
  conflicts(matter) { return this.call('matters/' + matter.id + '/conflicts'); }
  diagnostics() { return this.call('diagnostics'); }
  team(matter, data) { return this.call('matters/' + matter.id + '/team', data ? { method: 'POST', data } : {}); }
  teamReview(matter, data) { return this.call('matters/' + matter.id + '/review', { method: 'POST', data }); }
  search(matter, query) { return this.call('matters/' + matter.id + '/search?' + new URLSearchParams({ q: query })); }
  casework(matter, document, previous) {
    return this.call('matters/' + matter.id + '/casework?' + new URLSearchParams({ document, ...(previous ? { previous } : {}) }));
  }
  portal(matter, path = '', data) {
    return this.call('matters/' + matter.id + '/portal' + path, data ? { method: 'POST', data } : {});
  }
  async upload(matter, file, progress, purpose) {
    checkPdfFile(file);
    progress('Indexing pages and preserving the original PDF…');
    return this.call('matters/' + matter.id + '/documents', { method: 'POST', file, purpose });
  }
  async original(matter, doc) {
    const response = await fetch('/api/matters/' + matter.id + '/documents/' + doc.id + '/original');
    if (!response.ok) throw new Error('The original PDF is unavailable.');
    return response.arrayBuffer();
  }
  async approvedExport(matter, snapshot, format) {
    const response = await fetch('/api/matters/' + matter.id + '/approvals/' + snapshot.id + '/' + format);
    if (!response.ok) throw new Error('The approved export is unavailable.');
    return response.blob();
  }
}

class BrowserStore {
  constructor(db) {
    this.db = db;
    this.info = { mode: 'browser', actor: 'Workspace lawyer', engine: 'On-device PDF and OCR' };
  }
  async initialize() {
    const existing = await this.matter(demoId).catch(() => null);
    if (existing) return;
    const response = await fetch(new URL('./sample/index.json', import.meta.url));
    if (!response.ok) throw new Error('The sample matter could not be loaded.');
    const source = await response.json();
    const demo = createMatter({
      id: demoId, name: 'Ellis v. Northline Logistics', reference: 'PI-2026-014',
      jurisdiction: 'Personal injury', demo: true,
    });
    addDocument(demo, { ...source, id: demoDocumentId }, 'Sample import');
    for (const event of demo.events.filter(item => [3, 5].includes(item.page))) {
      updateEvent(demo, event.id, { action: 'verify' }, 'Sample reviewer');
    }
    const { tx, done } = transaction(this.db, ['matters'], 'readwrite');
    const store = tx.objectStore('matters');
    if (!await request(store.get(demoId))) store.add(demo);
    await done;
  }
  async list() {
    const { tx } = transaction(this.db, ['matters'], 'readonly');
    const items = await request(tx.objectStore('matters').getAll());
    return items.map(item => ({
      id: item.id, name: item.name, reference: item.reference, demo: item.demo,
      count: item.documents.length, updatedAt: item.updatedAt, queue: queueItems(item),
    })).sort((a, b) => Number(b.demo) - Number(a.demo) || b.updatedAt.localeCompare(a.updatedAt));
  }
  async matter(id) {
    const { tx } = transaction(this.db, ['matters'], 'readonly');
    const matter = await request(tx.objectStore('matters').get(id));
    if (!matter) throw new Error('That matter is unavailable in this browser.');
    return matter;
  }
  async create(data) {
    const matter = createMatter(data);
    const { tx, done } = transaction(this.db, ['matters'], 'readwrite');
    tx.objectStore('matters').add(matter);
    await done;
    return matter;
  }
  async change(id, revision, apply, { withPdf = false, workflow = false, allMatters = false } = {}) {
    const { tx, done } = transaction(this.db, withPdf ? ['matters', 'pdfs'] : ['matters'], 'readwrite');
    try {
      const store = tx.objectStore('matters');
      const matter = await request(store.get(id));
      if (!matter) throw new Error('That matter is unavailable in this browser.');
      if (revision !== undefined && (workflow ? practice(matter).revision : matter.revision) !== revision) {
        const error = new Error('The draft changed in another tab. It has been refreshed.');
        error.status = 409;
        throw error;
      }
      const others = allMatters ? await request(store.getAll()) : [];
      const result = apply(matter, tx, others);
      store.put(matter);
      await done;
      return { matter, ...result };
    } catch (error) {
      try { tx.abort(); } catch { /* The transaction already ended. */ }
      throw error;
    }
  }
  mutate(matter, command, data) {
    return this.change(matter.id, matter.revision, current => {
      const actor = this.info.actor;
      if (command === 'events') return { event: createEvent(current, data, actor) };
      if (command.startsWith('events/')) return { event: updateEvent(current, command.split('/')[1], data, actor) };
      if (command === 'page-review') return { review: reviewPage(current, data, actor) };
      if (command === 'approve') return { approval: approveMatter(current, actor, data.attested) };
      throw new Error('Unknown review action.');
    });
  }
  workflow(matter, data) {
    const allMatters = ['conflict-review', 'intake-decision', 'engagement-save'].includes(data.action);
    return this.change(matter.id, practice(matter).revision, (current, tx, others) =>
      changePractice(current, data, this.info.actor, others), { workflow: true, allMatters });
  }
  async conflicts(matter) {
    const { tx } = transaction(this.db, ['matters'], 'readonly');
    const items = await request(tx.objectStore('matters').getAll());
    return conflictResult(items.find(item => item.id === matter.id) ?? matter, items);
  }
  async upload(matter, file, progress, purpose) {
    checkPdfFile(file);
    progress('Checking the original PDF…');
    const bytes = await file.arrayBuffer();
    const sha256 = await digest(bytes);
    const refreshed = await this.matter(matter.id);
    const existing = refreshed.documents.find(doc => sameOriginal(doc, sha256, purpose));
    if (existing) return { matter: refreshed, document: existing, duplicate: true };
    const doc = await readPdf(file, bytes, sha256, progress, purpose === 'supporting');
    if (purpose === 'supporting') doc.purpose = purpose;
    return this.change(matter.id, undefined, (current, tx) => {
      const existing = current.documents.find(item => sameOriginal(item, sha256, purpose));
      if (existing) return { document: existing, duplicate: true };
      addDocument(current, doc, this.info.actor);
      tx.objectStore('pdfs').add(bytes, current.id + '/' + doc.id);
      return { document: doc };
    }, { withPdf: true });
  }
  async original(matter, doc) {
    if (matter.id === demoId && doc.id === demoDocumentId) {
      const response = await fetch(demoUrl);
      if (!response.ok) throw new Error('The sample PDF is unavailable.');
      return response.arrayBuffer();
    }
    const { tx } = transaction(this.db, ['pdfs'], 'readonly');
    const bytes = await request(tx.objectStore('pdfs').get(matter.id + '/' + doc.id));
    if (!bytes) throw new Error('The original PDF is unavailable in this browser.');
    return bytes;
  }
}

export async function openStore() {
  const response = await fetch('/api/bootstrap', { headers: { Accept: 'application/json' } });
  if (response.ok && response.headers.get('Content-Type')?.includes('application/json')) {
    return new ServerStore(await getResponse(response));
  }
  if (![200, 404, 405].includes(response.status)) {
    throw new Error('The workspace could not connect. Refresh to try again.');
  }
  const store = new BrowserStore(await openDb());
  await store.initialize();
  return store;
}
