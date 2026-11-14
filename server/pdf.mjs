import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { ValidationError, limits, makeDocument, pageHasText, printedLabel } from '../dist/model.mjs';

const exec = promisify(execFile);
const run = (tool, args, timeout = 20000) => exec(tool, args, { timeout, maxBuffer: 2 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C', OMP_THREAD_LIMIT: process.env.OMP_THREAD_LIMIT ?? '1' } });
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

async function pageCount(file) {
  let info;
  try { info = (await run('pdfinfo', [file])).stdout; }
  catch (error) {
    if (error.code === 'ENOENT') throw new Error('Install Poppler before indexing PDFs.');
    if (/password/i.test(error.stderr)) throw new ValidationError('This PDF is password-protected. Import an unlocked copy.');
    throw new ValidationError('This PDF could not be opened.');
  }
  if (/^Encrypted:\s+yes/m.test(info)) throw new ValidationError('This PDF is encrypted. Import an unlocked copy.');
  const count = Number(info.match(/^Pages:\s+(\d+)/m)?.[1]);
  if (!Number.isInteger(count) || count < 1 || count > limits.pages) {
    throw new ValidationError('This pilot accepts PDFs of 1–60 pages.');
  }
  return count;
}

async function allText(file) {
  try { return (await run('pdftotext', ['-enc', 'UTF-8', '-layout', file, '-'])).stdout.split('\f'); }
  catch { return []; }
}

async function readRaster(file, page, target) {
  await run('pdftoppm', ['-f', String(page), '-l', String(page), '-scale-to', '120', '-gray', '-singlefile', file, target]);
  const data = await readFile(target + '.pgm');
  const header = data.toString('ascii', 0, 64).match(/^P5\s+(\d+)\s+(\d+)\s+255\n/);
  if (!header) throw new Error('A page image could not be verified.');
  return { width: Number(header[1]), height: Number(header[2]), pixels: data.subarray(header[0].length) };
}

function rasterDistance(a, b) {
  if (a.width !== b.width || a.height !== b.height || a.pixels.length !== b.pixels.length) return Infinity;
  let error = 0;
  for (let i = 0; i < a.pixels.length; i += 1) error += Math.abs(a.pixels[i] - b.pixels[i]);
  return error / a.pixels.length;
}

async function align(original, archive, count, dir) {
  if (await pageCount(archive) !== count) return false;
  for (let page = 1; page <= count; page += 1) {
    const [source, derivative] = await Promise.all([
      readRaster(original, page, join(dir, 'source')),
      readRaster(archive, page, join(dir, 'archive')),
    ]);
    if (rasterDistance(source, derivative) > 2.2) return false;
  }
  return true;
}

async function localOcr(file, page, dir) {
  const output = join(dir, 'scan');
  await run('pdftoppm', ['-f', String(page), '-l', String(page), '-r', '175', '-scale-to', '2200', '-png', '-singlefile', file, output]);
  return (await run('tesseract', [output + '.png', 'stdout', '-l', 'eng', '--psm', '6'], 30000)).stdout;
}

export async function indexPdf(bytes, name, { importArchive, textOnly = false } = {}) {
  if (bytes.length < 5 || bytes.length > limits.bytes || !bytes.subarray(0, 1024).includes(Buffer.from('%PDF-'))) {
    throw new ValidationError('Choose a valid PDF up to 25 MB.');
  }
  const dir = await mkdtemp(join(tmpdir(), 'briefcase-pdf-'));
  const original = join(dir, 'original.pdf');
  const archive = join(dir, 'archive.pdf');
  try {
    await writeFile(original, bytes, { mode: 0o600 });
    const count = await pageCount(original);
    const originalText = await allText(original);
    let archiveText = [];
    let engine = 'Local PDF and OCR';
    let importNote = '';
    if (importArchive) {
      const derivative = await importArchive();
      if (derivative && !bytes.equals(derivative)) {
        await writeFile(archive, derivative, { mode: 0o600 });
        const aligned = await align(original, archive, count, dir).catch(() => false);
        if (aligned) archiveText = await allText(archive);
        else importNote = 'Paperless derivative could not be matched to the original pages. Original-page OCR was used.';
      }
      engine = archiveText.length ? 'Paperless archive and original-page OCR' : 'Paperless import and original-page OCR';
    }
    const pages = [];
    for (let number = 1; number <= count; number += 1) {
      let text = originalText[number - 1] ?? '';
      let method = 'text';
      if (!pageHasText(text)) {
        text = archiveText[number - 1] ?? '';
        if (!pageHasText(text) && !textOnly) text = await localOcr(original, number, dir).catch(() => '');
        method = pageHasText(text) ? 'ocr' : 'unreadable';
      }
      pages.push({ text, method, label: printedLabel(text) });
    }
    const document = makeDocument({ name, sha256: sha256(bytes), bytes: bytes.length, pages, engine });
    if (importNote) document.importNote = importNote;
    return document;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
