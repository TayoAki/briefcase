import { getDocument, GlobalWorkerOptions } from './vendor/pdf/pdf.min.mjs';
import { clean, limits, makeDocument, pageHasText, printedLabel } from './model.mjs';

const pdfAsset = name => new URL('./vendor/pdf/' + name, import.meta.url).href;
const ocrAsset = name => new URL('./vendor/ocr/' + name, import.meta.url).href;
GlobalWorkerOptions.workerSrc = pdfAsset('pdf.worker.min.mjs');

export async function openPdf(bytes) {
  const task = getDocument({
    data: new Uint8Array(bytes.slice(0)), isEvalSupported: false, enableXfa: false,
    standardFontDataUrl: pdfAsset('standard_fonts/'), cMapUrl: pdfAsset('cmaps/'),
    cMapPacked: true, wasmUrl: pdfAsset('wasm/'), iccUrl: pdfAsset('iccs/'),
  });
  try {
    return await task.promise;
  } catch (error) {
    await task.destroy().catch(() => {});
    if (error.name === 'PasswordException') throw new Error('This PDF is password-protected. Import an unlocked copy.');
    throw new Error('This PDF could not be opened. Check the original file and try again.');
  }
}

function textFrom(items) {
  let text = '';
  let previousY = null;
  for (const item of items) {
    if (!('str' in item)) continue;
    const y = item.transform[5];
    if (previousY !== null && Math.abs(y - previousY) > 3 && !text.endsWith('\n')) text += '\n';
    text += item.str + (item.hasEOL ? '\n' : ' ');
    previousY = y;
  }
  return text.trim();
}

function timeLimit(promise, ms) {
  let timer;
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error('OCR timed out')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function ocrWorker() {
  const { createWorker } = await import('./vendor/ocr/tesseract.esm.min.js');
  const worker = await createWorker('eng', 1, {
    corePath: ocrAsset('tesseract-core-lstm.wasm.js'),
    workerPath: ocrAsset('worker.min.js'), langPath: ocrAsset('').replace(/\/$/, ''),
    workerBlobURL: false, cacheMethod: 'none', gzip: true,
  });
  return worker;
}

export async function digest(bytes) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
    byte => byte.toString(16).padStart(2, '0')).join('');
}

export function checkPdfFile(file) {
  if (!file || !/\.pdf$/i.test(file.name)) throw new Error('Choose a PDF file.');
  if (!file.size || file.size > limits.bytes) throw new Error('Choose a PDF up to 25 MB.');
}

export async function readPdf(file, bytes, sha256, progress = () => {}, textOnly = false) {
  const pdf = await openPdf(bytes);
  let worker;
  let ocrFailed = false;
  try {
    if (pdf.numPages > limits.pages) throw new Error('This pilot accepts up to 60 pages per PDF. Import a smaller packet.');
    const labels = await pdf.getPageLabels().catch(() => null);
    const pages = [];
    for (let number = 1; number <= pdf.numPages; number += 1) {
      progress('Reading PDF page ' + number + ' of ' + pdf.numPages);
      let text = '';
      let method = 'unreadable';
      try {
        const page = await pdf.getPage(number);
        text = textFrom((await page.getTextContent()).items);
        method = pageHasText(text) ? 'text' : 'unreadable';
        if (method === 'unreadable' && !ocrFailed && !textOnly) {
          progress('Running OCR on PDF page ' + number + ' of ' + pdf.numPages);
          try {
            if (!worker) worker = await ocrWorker();
            const viewport = page.getViewport({ scale: 1.9 });
            const image = document.createElement('canvas');
            image.width = Math.ceil(viewport.width);
            image.height = Math.ceil(viewport.height);
            await page.render({ canvas: image, viewport }).promise;
            const result = await timeLimit(worker.recognize(image), 35000);
            if (pageHasText(result.data.text)) {
              text = result.data.text;
              method = 'ocr';
            }
          } catch {
            ocrFailed = true;
            if (worker) await worker.terminate().catch(() => {});
            worker = null;
          }
        }
        page.cleanup();
      } catch {
        method = 'unreadable';
      }
      pages.push({ text: clean(text, limits.text), method, label: printedLabel(text) || labels?.[number - 1] || '' });
    }
    return makeDocument({ name: file.name, sha256, bytes: file.size, pages, engine: 'Browser PDF and OCR' });
  } finally {
    if (worker) await worker.terminate().catch(() => {});
    await pdf.destroy().catch(() => {});
  }
}
