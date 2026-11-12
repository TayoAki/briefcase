import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { basename } from 'node:path';
import { addDocument, clean, limits, sameOriginal, uid } from '../dist/model.mjs';
import { indexPdf, sha256 } from './pdf.mjs';

const digest = value => createHash('sha256').update(value).digest();
const lifetime = 86400000;
const unknown = digest('invalid portal code');

export function portalService({ db, HttpError, json, jsonInput, payload, transact, getMatter, save, original, originalAdd }) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS portal_grants (
      id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, code_hash BLOB NOT NULL,
      firm TEXT NOT NULL, owner TEXT NOT NULL, matter TEXT NOT NULL, recipient TEXT NOT NULL,
      documents TEXT NOT NULL, can_upload INTEGER NOT NULL, expires INTEGER NOT NULL,
      revoked_at TEXT, FOREIGN KEY(firm, owner, matter) REFERENCES matters(firm, owner, id)
    );
    CREATE TABLE IF NOT EXISTS portal_submissions (
      id TEXT PRIMARY KEY, grant_id TEXT NOT NULL REFERENCES portal_grants(id), name TEXT NOT NULL,
      sha TEXT NOT NULL, data TEXT NOT NULL, bytes BLOB NOT NULL, status TEXT NOT NULL,
      created TEXT NOT NULL, document_id TEXT, UNIQUE(grant_id, sha)
    );
  `);
  const q = sql => db.prepare(sql);
  const add = q('INSERT INTO portal_grants (id, token_hash, code_hash, firm, owner, matter, recipient, documents, can_upload, expires) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const lookup = q('SELECT * FROM portal_grants WHERE token_hash = ?');
  const revoke = q('UPDATE portal_grants SET revoked_at = ? WHERE id = ? AND firm = ? AND owner = ? AND matter = ? AND revoked_at IS NULL');
  const grants = q('SELECT id, recipient, documents, can_upload, expires, revoked_at FROM portal_grants WHERE firm = ? AND owner = ? AND matter = ? ORDER BY expires DESC');
  const pendingCount = q("SELECT COUNT(*) AS count FROM portal_submissions WHERE grant_id = ? AND status = 'pending'");
  const duplicate = q('SELECT id, status FROM portal_submissions WHERE grant_id = ? AND sha = ?');
  const submissions = q(`SELECT s.id, s.name, s.sha, s.status, s.created, s.document_id, g.recipient
    FROM portal_submissions s JOIN portal_grants g ON g.id = s.grant_id
    WHERE g.firm = ? AND g.owner = ? AND g.matter = ? ORDER BY s.created DESC`);
  const scoped = q(`SELECT s.* FROM portal_submissions s JOIN portal_grants g ON g.id = s.grant_id
    WHERE s.id = ? AND g.firm = ? AND g.owner = ? AND g.matter = ?`);
  const submitted = q('INSERT INTO portal_submissions (id, grant_id, name, sha, data, bytes, status, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  const decide = q("UPDATE portal_submissions SET status = ?, document_id = ?, bytes = ?, data = '{}' WHERE id = ?");
  const failed = new Map();
  const allowedOrigins = (req, origin) => !req.headers.origin || req.headers.origin === origin;

  function credentials(req) {
    const token = typeof req.headers.authorization === 'string' && req.headers.authorization.match(/^Bearer ([\da-f]{64})$/);
    const code = req.headers['x-portal-code'];
    if (!token || typeof code !== 'string' || !/^\d{8}$/.test(code)) throw new HttpError(401, 'Open a current access link and enter its code.');
    const key = digest(token[1]).toString('hex');
    const grant = lookup.get(key);
    const time = Date.now();
    const attempts = failed.get(key);
    if (attempts && attempts.until > time && attempts.count >= 8) throw new HttpError(429, 'Too many attempts. Try again later.');
    const matches = timingSafeEqual(digest(code), grant?.code_hash ?? unknown);
    if (!grant || !matches || grant.revoked_at || grant.expires <= time) {
      if (grant && !matches) failed.set(key, {
        count: attempts?.until > time ? attempts.count + 1 : 1, until: time + 15 * 60000,
      });
      throw new HttpError(401, 'This link or code is unavailable.');
    }
    failed.delete(key);
    return grant;
  }

  function list(user, matter) {
    return {
      grants: grants.all(user.firm, user.username, matter.id).map(row => ({
        id: row.id, recipient: row.recipient, documents: JSON.parse(row.documents), canUpload: Boolean(row.can_upload),
        expires: new Date(row.expires).toISOString(), revokedAt: row.revoked_at,
      })),
      submissions: submissions.all(user.firm, user.username, matter.id),
    };
  }

  function sendPdf(res, bytes, name) {
    res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Length': bytes.length,
      'Content-Disposition': "attachment; filename*=UTF-8''" + encodeURIComponent(name) });
    res.end(bytes);
  }

  async function guest(req, res, url, origin) {
    if (!allowedOrigins(req, origin) || req.headers['sec-fetch-site'] === 'cross-site') throw new HttpError(403, 'Open the client portal directly.');
    const grant = credentials(req);
    const owner = { firm: grant.firm, username: grant.owner };
    const matter = getMatter(owner, grant.matter);
    const ids = JSON.parse(grant.documents);
    if (url.pathname === '/api/portal/info' && req.method === 'GET') {
      return json(res, 200, { matter: matter.name, recipient: grant.recipient, canUpload: Boolean(grant.can_upload),
        files: matter.documents.filter(doc => ids.includes(doc.id)).map(doc => ({ id: doc.id, name: doc.name, bytes: doc.bytes })) });
    }
    const matched = url.pathname.match(/^\/api\/portal\/files\/([\w-]+)$/);
    if (matched && req.method === 'GET') {
      if (!ids.includes(matched[1])) throw new HttpError(404, 'This file is unavailable.');
      const { stored, doc } = original(owner, matter, matched[1]);
      return sendPdf(res, stored, doc.name);
    }
    if (url.pathname === '/api/portal/upload' && req.method === 'POST') {
      if (!grant.can_upload || req.headers['content-type'] !== 'application/pdf') throw new HttpError(403, 'This link cannot accept that upload.');
      let name;
      try { name = clean(basename(decodeURIComponent(req.headers['x-pdf-name'] || '')), 180); }
      catch { throw new HttpError(400, 'The file name is invalid.'); }
      if (!/\.pdf$/i.test(name)) throw new HttpError(400, 'Choose a PDF.');
      const bytes = await payload(req, limits.bytes);
      const hash = sha256(bytes);
      const before = duplicate.get(grant.id, hash);
      if (before) return json(res, 200, { receipt: before.id, status: before.status });
      if (pendingCount.get(grant.id).count >= 12) throw new HttpError(429, 'This link has 12 submissions awaiting review.');
      const doc = await indexPdf(bytes, name, { textOnly: true });
      const current = credentials(req);
      const entry = transact(() => {
        const found = duplicate.get(current.id, hash);
        if (found) return found;
        if (pendingCount.get(current.id).count >= 12) throw new HttpError(429, 'This link has 12 submissions awaiting review.');
        const id = uid();
        submitted.run(id, current.id, name, hash, JSON.stringify(doc), bytes, 'pending', new Date().toISOString());
        return { id, status: 'pending' };
      });
      return json(res, 201, { receipt: entry.id, status: entry.status });
    }
    throw new HttpError(404, 'Route unavailable.');
  }

  async function lawyer(req, res, user, matter, target, format, origin) {
    if (!target && req.method === 'GET') return json(res, 200, list(user, matter));
    if (!target && req.method === 'POST') {
      const data = await jsonInput(req);
      const recipient = clean(data.recipient, 120);
      const documents = Array.isArray(data.documents) ? [...new Set(data.documents)] : [];
      const days = Number(data.days);
      if (!recipient || !Number.isInteger(days) || days < 1 || days > 30 || documents.length > 50 ||
          documents.some(id => !matter.documents.some(doc => doc.id === id)) || (!documents.length && data.canUpload !== true) || data.attested !== true) {
        throw new HttpError(422, 'Review the recipient, access period and selected files or upload permission.');
      }
      const token = randomBytes(32).toString('hex');
      const code = String(randomInt(10000000, 100000000));
      const id = uid();
      const expires = Date.now() + days * lifetime;
      add.run(id, digest(token).toString('hex'), digest(code), user.firm, user.username, matter.id, recipient,
        JSON.stringify(documents), data.canUpload === true ? 1 : 0, expires);
      return json(res, 201, { ...list(user, matter), created: { id, link: origin + '/portal.html#' + token, code, expires: new Date(expires).toISOString() } });
    }
    if (target && format === 'revoke' && req.method === 'POST') {
      const changed = revoke.run(new Date().toISOString(), target, user.firm, user.username, matter.id);
      if (!changed.changes && !list(user, matter).grants.some(row => row.id === target)) throw new HttpError(404, 'This link is unavailable.');
      return json(res, 200, list(user, matter));
    }
    const submission = scoped.get(target ?? '', user.firm, user.username, matter.id);
    if (!submission) throw new HttpError(404, 'This submission is unavailable.');
    if (format === 'pdf' && req.method === 'GET' && submission.status === 'pending') {
      if (sha256(submission.bytes) !== submission.sha) throw new HttpError(409, 'The PDF failed its integrity check.');
      return sendPdf(res, submission.bytes, submission.name);
    }
    if (format === 'review' && req.method === 'POST') {
      const { accept, attested } = await jsonInput(req);
      if (typeof accept !== 'boolean' || attested !== true) throw new HttpError(422, 'Confirm your review decision.');
      const current = transact(() => {
        const item = scoped.get(target, user.firm, user.username, matter.id);
        const entry = getMatter(user, matter.id);
        if (item.status !== 'pending') return entry;
        if (accept) {
          if (sha256(item.bytes) !== item.sha) throw new HttpError(409, 'The PDF failed its integrity check.');
          let document = entry.documents.find(doc => sameOriginal(doc, item.sha, 'supporting'));
          if (!document) {
            document = { ...JSON.parse(item.data), id: uid(), purpose: 'supporting' };
            addDocument(entry, document, user.name);
            originalAdd.run(user.firm, user.username, entry.id, document.id, item.bytes);
          }
          decide.run('accepted', document.id, Buffer.alloc(0), item.id);
        } else decide.run('declined', null, Buffer.alloc(0), item.id);
        entry.activity.unshift({ action: accept ? 'Portal submission accepted' : 'Portal submission declined', at: new Date().toISOString(), actor: user.name });
        save(user, entry);
        return entry;
      });
      return json(res, 200, { ...list(user, matter), matter: current });
    }
    throw new HttpError(404, 'Route unavailable.');
  }
  return { guest, lawyer };
}
