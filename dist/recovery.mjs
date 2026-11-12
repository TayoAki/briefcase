import { queueItems } from './practice.mjs';

const archiveLimit = 75 * 1024 * 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const magic = encoder.encode('BRIEFCASE-ARCHIVE-1\n');
const idPattern = /^[a-zA-Z0-9_-]{1,100}$/;

async function hash(bytes) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('');
}

async function keyFrom(password, salt) {
  if (typeof password !== 'string' || password.length < 12 || password.length > 512) throw new Error('Use a passphrase of at least 12 characters.');
  const material = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: 310000, hash: 'SHA-256' },
    material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

export async function encryptedArchive(matter, load, password) {
  await import('./vendor/packets/jszip.mjs');
  const zip = new globalThis.JSZip();
  const manifest = { format: 1, matterId: matter.id, originals: [] };
  let size = 0;
  for (const doc of matter.documents) {
    if (!idPattern.test(doc.id)) throw new Error('An original has an invalid identifier.');
    const bytes = await load(matter, doc);
    size += bytes.byteLength;
    if (size > archiveLimit) throw new Error('The matter exceeds the browser archive limit. Use the local database backup path.');
    if (bytes.byteLength !== doc.bytes || await hash(bytes) !== doc.sha256) throw new Error('An original PDF failed its integrity check.');
    const path = 'originals/' + doc.id + '.pdf';
    zip.file(path, bytes);
    manifest.originals.push({ id: doc.id, path, sha256: doc.sha256, bytes: doc.bytes });
  }
  const state = encoder.encode(JSON.stringify(matter));
  manifest.stateSha256 = await hash(state);
  zip.file('matter.json', state);
  zip.file('manifest.json', JSON.stringify(manifest));
  const plaintext = await zip.generateAsync({ type: 'uint8array', compression: 'STORE' });
  if (plaintext.length > archiveLimit) throw new Error('This archive exceeds the browser size limit.');
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await keyFrom(password, salt);
  const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: magic }, key, plaintext));
  const output = new Uint8Array(magic.length + salt.length + iv.length + encrypted.length);
  let at = 0;
  for (const part of [magic, salt, iv, encrypted]) { output.set(part, at); at += part.length; }
  return output;
}

function validateStoredZip(bytes) {
  if (bytes.length < 22) throw new Error('Archive format is invalid.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = bytes.length - 22;
  const count = view.getUint16(end + 10, true);
  const offset = view.getUint32(end + 16, true);
  const length = view.getUint32(end + 12, true);
  if (view.getUint32(end, true) !== 0x06054b50 || count > 3000 || offset + length !== end ||
      view.getUint16(end + 4, true) || view.getUint16(end + 6, true) || view.getUint16(end + 20, true)) {
    throw new Error('Archive format is invalid.');
  }
  let size = 0;
  let position = offset;
  for (let index = 0; index < count; index += 1) {
    if (position + 46 > end || view.getUint32(position, true) !== 0x02014b50 || view.getUint16(position + 10, true) !== 0) {
      throw new Error('Archive entries must use the Briefcase storage format.');
    }
    const compressed = view.getUint32(position + 20, true);
    const original = view.getUint32(position + 24, true);
    if (compressed !== original) throw new Error('Archive entry size is invalid.');
    size += original;
    if (size > archiveLimit) throw new Error('Archive exceeds the verification limit.');
    position += 46 + view.getUint16(position + 28, true) + view.getUint16(position + 30, true) + view.getUint16(position + 32, true);
  }
  if (position !== end) throw new Error('Archive directory is incomplete.');
}

export async function verifyArchive(bytes, password) {
  const data = new Uint8Array(bytes);
  if (data.length < magic.length + 44 || data.length > archiveLimit + 64 || !magic.every((value, index) => value === data[index])) {
    throw new Error('Choose a Briefcase matter archive within the size limit.');
  }
  const key = await keyFrom(password, data.slice(magic.length, magic.length + 16));
  let plaintext;
  try {
    plaintext = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: data.slice(magic.length + 16, magic.length + 28),
      additionalData: magic }, key, data.slice(magic.length + 28)));
  } catch { throw new Error('The passphrase or archive integrity check failed.'); }
  validateStoredZip(plaintext);
  await import('./vendor/packets/jszip.mjs');
  const zip = await globalThis.JSZip.loadAsync(plaintext, { checkCRC32: true });
  const manifest = JSON.parse(await zip.file('manifest.json')?.async('string'));
  const state = await zip.file('matter.json')?.async('uint8array');
  if (manifest?.format !== 1 || !Array.isArray(manifest.originals) || !state || await hash(state) !== manifest.stateSha256) {
    throw new Error('The archive manifest failed verification.');
  }
  const matter = JSON.parse(decoder.decode(state));
  if (matter.id !== manifest.matterId || matter.documents.length !== manifest.originals.length) throw new Error('Matter and manifest counts differ.');
  const ids = new Set();
  for (const original of manifest.originals) {
    if (!idPattern.test(original.id) || ids.has(original.id) || original.path !== 'originals/' + original.id + '.pdf') throw new Error('Invalid original entry.');
    ids.add(original.id);
    const doc = matter.documents.find(item => item.id === original.id);
    const bytes = await zip.file(original.path)?.async('uint8array');
    if (!doc || !bytes || doc.bytes !== bytes.length || bytes.length !== original.bytes ||
        doc.sha256 !== original.sha256 || await hash(bytes) !== original.sha256) throw new Error('An original PDF failed verification.');
  }
  for (const approval of matter.approvals) {
    for (const event of approval.events) {
      const doc = matter.documents.find(item => item.id === event.documentId);
      if (doc?.sha256 !== event.sourceSha256 || !doc.pages.some(page => page.number === event.page)) throw new Error('An approved source is unavailable.');
    }
  }
  return { matter: matter.name, originals: ids.size, approvals: matter.approvals.length };
}

const ical = text => String(text ?? '').replaceAll('\\', '\\\\').replace(/\r?\n/g, '\\n').replaceAll(';', '\\;').replaceAll(',', '\\,');
export function calendarText(matter, clock = new Date()) {
  const stamp = clock.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Briefcase Solo//Confirmed Dates//EN', 'CALSCALE:GREGORIAN'];
  for (const item of queueItems(matter).filter(row => row.status === 'confirmed')) {
    lines.push('BEGIN:VEVENT', 'UID:' + ical(matter.id + '-' + item.id) + '@briefcase.local', 'DTSTAMP:' + stamp,
      'DTSTART;VALUE=DATE:' + item.due.replaceAll('-', ''), 'SUMMARY:' + ical(item.title), 'DESCRIPTION:' + ical(item.basis), 'END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.map(line => {
    let output = '';
    let size = 0;
    for (const character of line) {
      const width = encoder.encode(character).length;
      if (size + width > 73) { output += '\r\n '; size = 1; }
      output += character;
      size += width;
    }
    return output;
  }).join('\r\n') + '\r\n';
}
