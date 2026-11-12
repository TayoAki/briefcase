import { setTimeout as delay } from 'node:timers/promises';
import { limits } from '../dist/model.mjs';
import { sha256 } from './pdf.mjs';

export class ImportError extends Error {
  constructor(message, status = 502) { super(message); this.status = status; }
}

function numericId(value) {
  return /^\d+$/.test(String(value)) && Number(value) > 0 ? Number(value) : null;
}

function rows(payload) { return Array.isArray(payload) ? payload : payload?.results ?? []; }

export function createPaperless({ base, token, waitMs = 50000, pollMs = 1250 }) {
  if (!base || !token) throw new Error('Set both BRIEFCASE_PAPERLESS_URL and BRIEFCASE_PAPERLESS_TOKEN.');
  const endpoint = new URL(base.replace(/\/+$/, '') + '/');
  if (!['https:', 'http:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error('Use a private Paperless HTTP(S) base URL.');
  }
  async function api(path, { method = 'GET', body, binary = false } = {}) {
    let response;
    try {
      response = await fetch(new URL(path, endpoint), {
        method, body, redirect: 'error', signal: AbortSignal.timeout(16000),
        headers: { Authorization: 'Token ' + token, Accept: binary ? 'application/pdf' : 'application/json; version=10' },
      });
    } catch {
      throw new ImportError('Paperless could not be reached. Check the private service and retry the same file.');
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new ImportError('Paperless returned HTTP ' + response.status + '. Check the service and import job.');
    }
    if (!binary) return response.json();
    const buffers = [];
    let length = 0;
    for await (const chunk of response.body) {
      length += chunk.length;
      if (length > limits.bytes * 4) throw new ImportError('The Paperless derivative exceeds the pilot size limit.');
      buffers.push(Buffer.from(chunk));
    }
    return Buffer.concat(buffers);
  }
  async function findTask(filename) {
    const matches = rows(await api('api/tasks/')).filter(task =>
      (task.input_data?.filename ?? task.task_file_name) === filename);
    if (matches.length !== 1) return null;
    return matches[0].task_id;
  }

  return async function importArchive({ bytes, job, save }) {
    if (job.state === 'failed') {
      throw new ImportError('Paperless marked this import as failed. Inspect the recorded task or use local OCR for this file.');
    }
    if (!job.taskId && job.state === 'uploading') {
      const taskId = await findTask(job.filename);
      if (!taskId) throw new ImportError('Paperless receipt is uncertain. Check whether the existing task received the file before resuming.', 409);
      job = { ...job, taskId, state: 'queued' };
      save(job);
    }
    if (!job.taskId) {
      const form = new FormData();
      form.set('document', new Blob([bytes], { type: 'application/pdf' }), job.filename);
      form.set('title', job.filename.replace(/\.pdf$/, ''));
      job = { ...job, state: 'uploading' };
      save(job);
      const taskId = await api('api/documents/post_document/', { method: 'POST', body: form });
      if (typeof taskId !== 'string' || !/^[a-f\d-]{20,50}$/i.test(taskId)) {
        throw new ImportError('Paperless returned an invalid task receipt.');
      }
      job = { ...job, taskId, state: 'queued' };
      save(job);
    }

    if (!job.paperlessId) {
      const end = Date.now() + waitMs;
      while (Date.now() < end) {
        const tasks = rows(await api('api/tasks/?task_id=' + encodeURIComponent(job.taskId)));
        const task = tasks.find(item => item.task_id === job.taskId);
        const status = String(task?.status ?? '').toLowerCase();
        const id = numericId(task?.related_document_ids?.[0] ?? task?.related_document);
        if (['success', 'succeeded', 'completed'].includes(status) && id) {
          job = { ...job, paperlessId: id, state: 'download' };
          save(job);
          break;
        }
        if (['failure', 'failed', 'revoked', 'cancelled', 'canceled'].includes(status)) {
          save({ ...job, state: 'failed' });
          throw new ImportError('Paperless could not complete the import. Inspect the recorded task or use local OCR.');
        }
        await delay(pollMs);
      }
      if (!job.paperlessId) throw new ImportError('Paperless is still processing. Retry the same PDF to resume its existing task.', 503);
    }

    const route = 'api/documents/' + job.paperlessId + '/download/?version=' + job.paperlessId;
    const downloaded = await api(route + '&original=true', { binary: true });
    if (sha256(bytes) !== sha256(downloaded)) {
      save({ ...job, state: 'failed' });
      throw new ImportError('The original returned by Paperless failed its hash check. No usable document was added.');
    }
    const archive = await api(route, { binary: true });
    save({ ...job, state: 'source verified' });
    return archive;
  };
}
