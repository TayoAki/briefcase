import { createHash, timingSafeEqual } from 'node:crypto';
import { createReadStream, mkdirSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { basename, dirname, extname, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import {
  addDocument, approveMatter, clean, createEvent, createMatter, exportName, exportSnapshot, limits,
  reviewPage, sameOriginal, suggestionsFor, uid, updateEvent, ValidationError,
} from '../dist/model.mjs';
import { changePractice, conflictResult, practice, queueItems } from '../dist/practice.mjs';
import { modelSuggestions } from './llm.mjs';
import { createPaperless } from './paperless.mjs';
import { indexPdf, sha256 } from './pdf.mjs';
import { portalService } from './portal.mjs';
import { createTeamAccess } from './team.mjs';
import { createRoleWork } from './role-work.mjs';
import { createFirmDesk, deskAccount } from './firm-desk.mjs';
import { createClientDevelopment } from './client-development.mjs';
import { createRiskIntake } from './risk-intake.mjs';
import { createIdentityLifecycle } from './identity-lifecycle.mjs';
import { createWorkbench } from './workbench.mjs';
import { createAgents } from './agents.mjs';
import { caseworkCandidates, searchMatter } from './casework.mjs';

const site = fileURLToPath(new URL('../dist/', import.meta.url));
const sample = 'Ellis_Medical_Records.pdf';
const types = {
  '.html': 'text/html; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.pdf': 'application/pdf',
  '.svg': 'image/svg+xml', '.wasm': 'application/wasm', '.gz': 'application/gzip',
};
const digest = value => createHash('sha256').update(value).digest();
const jsonType = 'application/json; charset=utf-8';

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function json(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': jsonType, ...headers });
  res.end(JSON.stringify(body));
}

async function payload(req, max) {
  const parts = [];
  let length = 0;
  if (Number(req.headers['content-length']) > max) throw new HttpError(413, 'The upload is too large.');
  for await (const chunk of req) {
    length += chunk.length;
    if (length > max) throw new HttpError(413, 'The upload is too large.');
    parts.push(chunk);
  }
  return Buffer.concat(parts);
}

async function jsonInput(req, max = 12000) {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new HttpError(415, 'Send a JSON request.');
  const bytes = await payload(req, max);
  req.checkBriefcaseAccount?.();
  let data;
  try { data = JSON.parse(bytes); } catch { throw new HttpError(400, 'The request is not valid JSON.'); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new HttpError(400, 'The request must be an object.');
  return data;
}

function serveAsset(url, res) {
  let path;
  try { path = resolve(site, '.' + decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname)); }
  catch { throw new HttpError(400, 'Invalid URL.'); }
  if (!path.startsWith(site.endsWith(sep) ? site : site + sep)) throw new HttpError(404, 'File unavailable.');
  let stat;
  try { stat = statSync(path); } catch { throw new HttpError(404, 'File unavailable.'); }
  if (!stat.isFile()) throw new HttpError(404, 'File unavailable.');
  res.writeHead(200, { 'Content-Type': types[extname(path)] ?? 'application/octet-stream', 'Content-Length': stat.size });
  createReadStream(path).pipe(res);
}

function sampleMatter() {
  const matter = createMatter({
    id: 'ellis-sample', name: 'Ellis v. Northline Logistics', reference: 'PI-2026-014',
    jurisdiction: 'Personal injury', demo: true,
  });
  const doc = JSON.parse(readFileSync(resolve(site, 'sample/index.json'), 'utf8'));
  addDocument(matter, doc, 'Sample import');
  for (const event of matter.events.filter(item => [3, 5].includes(item.page))) {
    updateEvent(matter, event.id, { action: 'verify' }, 'Sample reviewer');
  }
  return matter;
}

export function buildApp({ database, users, origin, paperless, model, portal = false, railwayHealth = false, workbench: workbenchConfig = {}, agents: agentLimits = {} }) {
  const accounts = new Map(users.map(account => {
    const { username, password, firm, name, role = 'lawyer' } = account;
    if (!/^[\w.-]{1,60}$/.test(username ?? '') || typeof password !== 'string' || password.length < 12 ||
        !/^[\w.-]{1,70}$/.test(firm ?? '') || !['lawyer', 'preparer'].includes(role)) {
      throw new Error('Configure valid account names, supported roles and passwords of at least 12 characters.');
    }
    return [username, { username, passwordHash: digest(password), firm, role, name: clean(name, 80) || username, ...deskAccount(account), initiallyDisabled: account.initiallyDisabled === true, matterOnly: account.matterOnly === true }];
  }));
  if (!accounts.size || accounts.size !== users.length) throw new Error('Configure at least one unique lawyer account.');
  if (paperless && new Set(users.map(user => user.firm)).size > 1) {
    throw new Error('Configure a separate Briefcase server and Paperless instance for each firm.');
  }
  if (database !== ':memory:') mkdirSync(dirname(database), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(database);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS matters (
      firm TEXT, owner TEXT, id TEXT, state TEXT NOT NULL, PRIMARY KEY(firm, owner, id)
    );
    CREATE TABLE IF NOT EXISTS originals (
      firm TEXT, owner TEXT, matter TEXT, id TEXT, bytes BLOB NOT NULL,
      PRIMARY KEY(firm, owner, matter, id), FOREIGN KEY(firm, owner, matter) REFERENCES matters(firm, owner, id)
    );
    CREATE TABLE IF NOT EXISTS import_jobs (
      firm TEXT, sha TEXT, state TEXT NOT NULL, PRIMARY KEY(firm, sha)
    );
  `);
  const q = sql => db.prepare(sql);
  const team = createTeamAccess(db, accounts, HttpError, user => identity.active(user));
  const matterGet = q('SELECT state FROM matters WHERE firm = ? AND owner = ? AND id = ?');
  const matterList = q('SELECT state FROM matters WHERE firm = ? AND owner = ?');
  const matterAdd = q('INSERT OR IGNORE INTO matters(firm, owner, id, state) VALUES (?, ?, ?, ?)');
  const matterPut = q('UPDATE matters SET state = ? WHERE firm = ? AND owner = ? AND id = ?');
  const originalAdd = q('INSERT INTO originals(firm, owner, matter, id, bytes) VALUES (?, ?, ?, ?, ?)');
  const originalGet = q('SELECT bytes FROM originals WHERE firm = ? AND owner = ? AND matter = ? AND id = ?');
  const jobGet = q('SELECT state FROM import_jobs WHERE firm = ? AND sha = ?');
  const firmJobs = q('SELECT state FROM import_jobs WHERE firm = ?');
  const jobPut = q('INSERT INTO import_jobs(firm, sha, state) VALUES (?, ?, ?) ON CONFLICT(firm, sha) DO UPDATE SET state = excluded.state');
  const inflight = new Map();
  const importArchive = paperless ? createPaperless(paperless) : null;
  const unknown = digest('invalid account placeholder');

  function authenticate(req) {
    const header = req.headers.authorization;
    if (typeof header !== 'string' || !header.startsWith('Basic ') || header.length > 1024) return null;
    const value = Buffer.from(header.slice(6), 'base64').toString('utf8');
    const delimiter = value.indexOf(':');
    if (delimiter < 0) return null;
    const account = accounts.get(value.slice(0, delimiter));
    const match = timingSafeEqual(digest(value.slice(delimiter + 1)), account?.passwordHash ?? unknown);
    return match && identity.active(account) ? account : null;
  }

  function getMatter(user, id) { return team.access(user, id).matter; }

  function save(user, matter) { matterPut.run(JSON.stringify(matter), user.firm, team.access(user, matter.id).owner, matter.id); }
  function transact(work) {
    db.exec('BEGIN IMMEDIATE');
    try { const result = work(); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  }

  function original(user, matter, id) {
    const doc = matter.documents.find(item => item.id === id);
    if (!doc) throw new HttpError(404, 'That original PDF is unavailable.');
    const stored = id === 'ellis-medical-records' && matter.demo
      ? readFileSync(resolve(site, 'sample', sample)) : originalGet.get(user.firm, team.access(user, matter.id).owner, matter.id, doc.id)?.bytes;
    if (!stored) throw new HttpError(404, 'That original PDF is unavailable.');
    if (sha256(stored) !== doc.sha256) throw new HttpError(409, 'The original PDF failed its integrity check.');
    return { stored, doc };
  }

  function indexed(user, matterId, bytes, hash) {
    const key = [user.firm, user.username, matterId, hash].join(':');
    if (inflight.has(key)) return inflight.get(key);
    const existing = jobGet.get(user.firm, hash);
    const job = existing ? JSON.parse(existing.state) : { filename: 'briefcase-' + hash + '.pdf', state: 'new' };
    const options = importArchive ? {
      importArchive: () => {
        team.access(user, matterId);
        return importArchive({ bytes, job, save: value => jobPut.run(user.firm, hash, JSON.stringify(value)) });
      },
    } : {};
    const running = indexPdf(bytes, 'Record.pdf', options).then(async doc => {
      let events;
      if (model?.url) {
        team.access(user, matterId);
        try { events = await modelSuggestions(doc, model); }
        catch {
          doc.importNote = [doc.importNote, 'The configured model was unavailable. On-device draft rules were used.'].filter(Boolean).join(' ');
        }
      }
      return { doc, events: events ?? suggestionsFor(doc) };
    }).finally(() => inflight.delete(key));
    inflight.set(key, running);
    return running;
  }

  const firmDesk = createFirmDesk({ db, accounts, team, HttpError, transact });
  const clientDevelopment = createClientDevelopment({ db, accounts, team, HttpError, transact, records: firmDesk.clientRecords });
  const identity = createIdentityLifecycle({ db, accounts, HttpError, records: firmDesk.clientRecords, transact });
  const riskIntake = createRiskIntake({ db, accounts, team, HttpError, transact, records: firmDesk.clientRecords,
    diligenceEvidence: (user, input) => workbench.diligenceEvidence(user, input) });
  const roleWork = createRoleWork({ db, accounts, team, HttpError, transact, original, isActive: identity.active });
  const workbench = createWorkbench({ db, accounts, team, HttpError, transact, original, isActive: identity.active, config: workbenchConfig,
    technology: {
      recoveryManifest(user) {
        const originals = [];
        let matters = 0;
        for (const row of db.prepare('SELECT owner,id,state FROM matters WHERE firm=? ORDER BY owner,id').all(user.firm)) {
          matters += 1;
          const state = JSON.parse(row.state);
          for (const doc of state.documents) {
            const bytes = state.demo && doc.id === 'ellis-medical-records' ? readFileSync(resolve(site, 'sample', sample))
              : originalGet.get(user.firm, row.owner, row.id, doc.id)?.bytes;
            if (!bytes || sha256(bytes) !== doc.sha256) throw new HttpError(409, 'An original failed recovery validation.');
            originals.push({ id: [row.owner, row.id, doc.id].join('/'), sha256: doc.sha256 });
          }
        }
        return { firm: user.firm, capturedAt: new Date().toISOString(), originals,
          counts: { matters, originals: originals.length } };
      },
      supportJobs(user) {
        const scoped = { ...user, desk: [...user.desk, 'R60'] };
        const imports = new Map(firmDesk.clientRecords.byKind(user, 'import').map(row => [row.id, row]));
        return firmDesk.view(scoped).support.map(job => {
          const raw = imports.get(job.id);
          return { ...job, scopeKey: raw ? sha256(Buffer.from(JSON.stringify([user.firm, raw.custodian ?? raw.owner, raw.matterId]))) : null };
        });
      },
      securityEvents: user => identity.security({ ...user, desk: [...user.desk, 'R61'] }),
    } });
  const agents = createAgents({ db, accounts, team, HttpError, workbench, roleWork, isActive: identity.active, model,
    skillsDir: fileURLToPath(new URL('./agents/skills', import.meta.url)), limits: agentLimits });
  const clientPortal = portal ? portalService({ db, HttpError, json, jsonInput, payload, transact, getMatter, save, original, originalAdd }) : null;

  async function route(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; object-src 'none'; frame-ancestors 'none'; base-uri 'none'");
    const appOrigin = origin || 'http://127.0.0.1:' + res.socket.localPort;
    const url = new URL(req.url, appOrigin);
    if (railwayHealth && req.headers.host === 'healthcheck.railway.app' && req.method === 'GET' &&
        req.url === '/health') return json(res, 200, { ok: true });
    if (req.headers.host !== new URL(appOrigin).host || url.origin !== appOrigin) {
      throw new HttpError(421, 'Use the configured Briefcase address.');
    }
    if (url.pathname === '/health' && req.method === 'GET') return json(res, 200, { ok: true });
    if (clientPortal && url.pathname.startsWith('/api/portal/')) return clientPortal.guest(req, res, url, appOrigin);
    if (clientPortal && req.method === 'GET' && ['/portal.html', '/portal.mjs', '/portal.css'].includes(url.pathname)) return serveAsset(url, res);
    const user = authenticate(req);
    if (!user) return json(res, 401, { error: 'Sign in to Briefcase.' }, { 'WWW-Authenticate': 'Basic realm="Briefcase Solo", charset="UTF-8"' });
    req.checkBriefcaseAccount = () => { if (!identity.active(user)) throw new HttpError(401, 'Sign in to Briefcase.'); };
    if (req.method === 'POST' && (req.headers['x-briefcase-request'] !== '1' ||
        (req.headers.origin && req.headers.origin !== appOrigin) || req.headers['sec-fetch-site'] === 'cross-site')) {
      throw new HttpError(403, 'Open Briefcase directly before making changes.');
    }
    if (!url.pathname.startsWith('/api/')) {
      if (req.method !== 'GET') throw new HttpError(405, 'Method unavailable.');
      return serveAsset(url, res);
    }

    const [, root, resource, matterId, group, target, format, ...rest] = url.pathname.split('/');
    if (root !== 'api' || rest.length) throw new HttpError(404, 'Route unavailable.');
    if (resource === 'bootstrap' && !matterId && req.method === 'GET') {
      return json(res, 200, {
        mode: 'server', actor: user.name, engine: importArchive ? 'Private Paperless and local OCR' : 'Local PDF and OCR',
        model: Boolean(model?.url), portal: Boolean(clientPortal), role: user.role, username: user.username, team: true, roleWork: true, workbench: true, agents: !user.matterOnly, firmDesk: !user.matterOnly, clientDevelopment: !user.matterOnly, riskIntake: !user.matterOnly, matterOnly: user.matterOnly, identityAdmin: !user.matterOnly && user.desk.some(role => ['R55', 'R61'].includes(role)),
      });
    }
    if (user.matterOnly && !['matters', 'role-work', 'workbench'].includes(resource)) {
      throw new HttpError(403, 'This account is limited to assigned matter work.');
    }
    if (resource === 'workbench' && !target && !format) {
      if (!matterId && !group && req.method === 'GET') return json(res, 200, workbench.list(user));
      if (!matterId && !group && req.method === 'POST') {
        const result = workbench.create(user, await jsonInput(req, 12 * 1024 * 1024));
        return json(res, result.created ? 201 : 200, { item: result.item });
      }
      if (matterId && !group && req.method === 'GET') return json(res, 200, workbench.detail(user, matterId));
      if (matterId && !group && req.method === 'POST') return json(res, 200, {
        item: workbench.update(user, matterId, await jsonInput(req, 12 * 1024 * 1024)),
      });
      if (matterId && group === 'export' && req.method === 'GET') {
        const result = await workbench.export(user, matterId, url.searchParams.get('format') || 'json', url.searchParams.get('version'));
        res.writeHead(200, { 'Content-Type': result.mime, 'Content-Length': result.bytes.length,
          'Content-Disposition': "attachment; filename*=UTF-8''" + encodeURIComponent(result.name) });
        return res.end(result.bytes);
      }
    }
    if (resource === 'agents' && !target && !format) {
      if (!matterId && req.method === 'GET') return json(res, 200, agents.overview(user));
      if (matterId === 'runs' && !group && req.method === 'POST') return json(res, 201, { run: agents.start(user, await jsonInput(req, 24000)) });
      if (matterId === 'runs' && group && req.method === 'GET') return json(res, 200, { run: agents.detail(user, group) });
      if (matterId === 'runs' && group && req.method === 'POST') return json(res, 200, { run: agents.act(user, group, await jsonInput(req, 24000)) });
    }
    if (resource === 'identity' && !matterId && !group && !target && !format) {
      if (req.method === 'GET') return json(res, 200, { accounts: identity.view(user), accessEvents: identity.security(user), canActivate: user.desk.includes('R55'), username: user.username });
      if (req.method === 'POST') return json(res, 200, { item: identity.update(user, await jsonInput(req, 4000)) });
    }
    if (resource === 'risk-intake' && !matterId && !group && !target && !format) {
      if (req.method === 'GET') return json(res, 200, riskIntake.view(user));
      if (req.method === 'POST') return json(res, 200, { item: riskIntake.update(user, await jsonInput(req, 24000)) });
    }
    if (resource === 'client-development' && !format) {
      if (!matterId && req.method === 'GET') return json(res, 200, clientDevelopment.view(user));
      if (!matterId && req.method === 'POST') {
        return json(res, 200, { item: clientDevelopment.update(user, await jsonInput(req, 24000)) });
      }
      if (matterId && group && target === 'export' && req.method === 'GET') {
        return json(res, 200, clientDevelopment.artifact(user, matterId, group),
          { 'Content-Disposition': 'attachment; filename="briefcase-client-artifact.json"' });
      }
    }
    if (resource === 'firm-desk' && !target && !format) {
      if (!matterId && !group && req.method === 'GET') {
        return json(res, 200, firmDesk.view(user, url.searchParams.get('month')));
      }
      if (!matterId && !group && req.method === 'POST') {
        return json(res, 200, { item: firmDesk.update(user, await jsonInput(req, 24000)) });
      }
      if (matterId && group === 'export' && req.method === 'GET') {
        return json(res, 200, firmDesk.export(user, matterId, url.searchParams.get('month')),
          { 'Content-Disposition': 'attachment; filename="briefcase-firm-desk.json"' });
      }
      if (matterId && group === 'pricing' && req.method === 'GET') {
        return json(res, 200, firmDesk.priceProof(user, matterId),
          { 'Content-Disposition': 'attachment; filename="briefcase-pricing-comparison.json"' });
      }
      if (matterId && group === 'decision' && req.method === 'GET') {
        return json(res, 200, firmDesk.proof(user, matterId),
          { 'Content-Disposition': 'attachment; filename="briefcase-partner-decision.json"' });
      }
    }
    if (resource === 'role-work' && matterId && group === 'file' && target && format && req.method === 'GET') {
      const result = roleWork.file(user, matterId, target, format);
      res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Length': result.stored.length,
        'Content-Disposition': "attachment; filename*=UTF-8''" + encodeURIComponent(result.name) });
      return res.end(result.stored);
    }
    if (resource === 'role-work' && !target && !format) {
      if (!matterId && !group && req.method === 'GET') {
        const offset = Number(url.searchParams.get('offset') ?? 0);
        if (!Number.isSafeInteger(offset) || offset < 0) throw new HttpError(422, 'Invalid queue offset.');
        return json(res, 200, { ...roleWork.list(user, offset), roles: roleWork.catalog(), roster: roleWork.roster(user) });
      }
      if (!matterId && !group && req.method === 'POST') {
        const result = roleWork.open(user, await jsonInput(req, 24000));
        return json(res, result.created ? 201 : 200, { item: result.item });
      }
      if (matterId && !group && req.method === 'GET') return json(res, 200, roleWork.detail(user, matterId));
      if (matterId && !group && req.method === 'POST') {
        return json(res, 200, { item: roleWork.update(user, matterId, await jsonInput(req, 96000)) });
      }
      if (matterId && group === 'proof' && req.method === 'GET') {
        return json(res, 200, roleWork.proof(user, matterId),
          { 'Content-Disposition': 'attachment; filename="briefcase-role-work-proof.json"' });
      }
    }
    if (resource === 'diagnostics' && !matterId && req.method === 'GET') {
      const states = { new: 0, uploading: 0, queued: 0, download: 0, 'source verified': 0, failed: 0 };
      for (const row of firmJobs.all(user.firm)) {
        const job = JSON.parse(row.state);
        if (Object.hasOwn(states, job.state)) states[job.state] += 1;
      }
      if (user.role === 'preparer') throw new HttpError(403, 'A lawyer account must request diagnostics.');
      return json(res, 200, { version: '0.8.0', capturedAt: new Date().toISOString(),
        integrations: { paperless: Boolean(importArchive), model: Boolean(model?.url), portal: Boolean(clientPortal) },
        activeImports: [...inflight.keys()].filter(key => key.startsWith(user.firm + ':')).length, importStates: states });
    }
    if (resource !== 'matters') throw new HttpError(404, 'Route unavailable.');
    if (!matterId) {
      if (req.method === 'GET') {
        if (user.role === 'lawyer' && !user.matterOnly && !matterGet.get(user.firm, user.username, 'ellis-sample')) {
          const demo = sampleMatter();
          matterAdd.run(user.firm, user.username, demo.id, JSON.stringify(demo));
        }
        const matters = [...(user.matterOnly ? [] : matterList.all(user.firm, user.username).map(row => JSON.parse(row.state))),
          ...team.shared(user).map(scope => scope.matter)];
        return json(res, 200, matters.map(item => ({
          id: item.id, name: item.name, reference: item.reference, demo: item.demo, count: item.documents.length, updatedAt: item.updatedAt,
          queue: queueItems(item),
        })).sort((a, b) => Number(b.demo) - Number(a.demo) || b.updatedAt.localeCompare(a.updatedAt)));
      }
      if (req.method === 'POST') {
        if (user.role === 'preparer' || user.matterOnly) throw new HttpError(403, 'A firm lawyer account must open this matter.');
        const { name, reference, jurisdiction } = await jsonInput(req);
        const matter = createMatter({ name, reference, jurisdiction });
        matterAdd.run(user.firm, user.username, matter.id, JSON.stringify(matter));
        return json(res, 201, matter);
      }
    }

    const scope = team.access(user, matterId);
    const matter = scope.matter;
    if (!group && req.method === 'GET') return json(res, 200, matter);
    if (group === 'portal' && clientPortal) {
      team.assert(scope, 'owner');
      return clientPortal.lawyer(req, res, user, matter, target, format, appOrigin);
    }
    if (group === 'team' && !target) {
      if (req.method === 'GET') return json(res, 200, team.list(user, scope));
      if (req.method === 'POST') {
        const data = await jsonInput(req);
        return json(res, 200, transact(() => team.member(user, team.access(user, matterId), data)));
      }
    }
    if (group === 'review' && !target && req.method === 'POST') {
      const data = await jsonInput(req);
      const result = transact(() => {
        const current = team.access(user, matterId);
        team.review(user, current, data);
        save(user, current.matter);
        return { matter: current.matter, team: team.list(user, current) };
      });
      return json(res, 200, result);
    }
    if (group === 'search' && !target && req.method === 'GET') {
      const matches = searchMatter(matter, url.searchParams.get('q'), url.searchParams.get('document'));
      team.audit(user, scope, 'matter search');
      return json(res, 200, { matches });
    }
    if (group === 'casework' && !target && req.method === 'GET') {
      const document = matter.documents.find(doc => doc.id === url.searchParams.get('document'));
      const previousId = url.searchParams.get('previous');
      const previous = matter.documents.find(doc => doc.id === previousId);
      if (!document || (previousId && !previous)) throw new HttpError(404, 'That document is unavailable.');
      team.audit(user, scope, 'casework candidates viewed', document.id);
      return json(res, 200, caseworkCandidates(matter, document, previous));
    }
    if (!target && group === 'conflicts' && req.method === 'GET') {
      team.assert(scope, 'review');
      const others = matterList.all(user.firm, user.username).map(row => JSON.parse(row.state));
      return json(res, 200, conflictResult(matter, others));
    }
    if (!target && group === 'practice' && req.method === 'POST') {
      const data = await jsonInput(req, 180000);
      const updated = transact(() => {
        const live = team.access(user, matterId);
        team.practiceAction(live, data);
        const current = live.matter;
        if (req.headers['if-match'] !== String(practice(current).revision)) throw new HttpError(409, 'This workflow changed. Review the latest version.');
        const others = ['conflict-review', 'intake-decision', 'engagement-save'].includes(data.action)
          ? matterList.all(user.firm, user.username).map(row => JSON.parse(row.state)) : [];
        if (data.action === 'office-save' && data.type === 'retention' &&
            ['Cleared for disposition', 'Completed externally'].includes(data.status) && workbench.activeHolds(user, matterId).length) {
          throw new HttpError(422, 'Resolve all active matter and specialist records holds before disposition.');
        }
        changePractice(current, data, user.name, others);
        save(user, current);
        if (['intake-decision', 'engagement-save'].includes(data.action)) firmDesk.finishIntake(user, current);
        team.audit(user, live, 'practice · ' + clean(data.action, 80));
        return current;
      });
      return json(res, 200, { matter: updated });
    }
    if (group === 'documents' && target && format === 'original' && req.method === 'GET') {
      const { stored, doc } = original(user, matter, target);
      team.audit(user, scope, 'original opened', doc.id);
      res.writeHead(200, {
        'Content-Type': 'application/pdf', 'Content-Length': stored.length,
        'Content-Disposition': "inline; filename*=UTF-8''" + encodeURIComponent(doc.name),
      });
      return res.end(stored);
    }
    if (group === 'approvals' && target && ['json', 'csv'].includes(format) && req.method === 'GET') {
      const snapshot = matter.approvals.find(item => item.id === target);
      if (!snapshot) throw new HttpError(404, 'That approved version is unavailable.');
      team.audit(user, scope, 'approved chronology exported', snapshot.id);
      res.writeHead(200, {
        'Content-Type': format === 'csv' ? 'text/csv; charset=utf-8' : jsonType,
        'Content-Disposition': 'attachment; filename="' + exportName(snapshot, format) + '"',
      });
      return res.end(exportSnapshot(snapshot, format, appOrigin));
    }
    if (group === 'documents' && !target && req.method === 'POST') {
      if (req.headers['content-type'] !== 'application/pdf') throw new HttpError(415, 'Choose a PDF file.');
      const purpose = req.headers['x-pdf-purpose'] ?? 'medical';
      if (!['medical', 'supporting'].includes(purpose)) throw new HttpError(400, 'Choose a document purpose.');
      let name;
      try { name = clean(basename(decodeURIComponent(req.headers['x-pdf-name'] || '')), 180); }
      catch { throw new HttpError(400, 'The PDF name could not be read.'); }
      if (!/\.pdf$/i.test(name)) throw new HttpError(400, 'Choose a PDF file.');
      const bytes = await payload(req, limits.bytes);
      const liveUpload = team.access(user, matterId);
      const current = liveUpload.matter;
      const hash = sha256(bytes);
      const existing = current.documents.find(doc => sameOriginal(doc, hash, purpose));
      if (existing) return json(res, 200, { matter: current, document: existing, duplicate: true });
      const importId = firmDesk.importStart(user, matterId, liveUpload.owner);
      try {
        const result = purpose === 'supporting'
          ? { doc: await indexPdf(bytes, 'Record.pdf', { textOnly: true }), events: [] } : await indexed(user, matterId, bytes, hash);
        const reply = transact(() => {
          const live = team.access(user, matterId);
          const current = live.matter;
          firmDesk.importEnd(user, importId, 'complete');
          const existing = current.documents.find(doc => sameOriginal(doc, hash, purpose));
          if (existing) return { matter: current, document: existing, duplicate: true };
          const doc = { ...result.doc, id: uid(), name, purpose };
          addDocument(current, doc, user.name, result.events.map(event => ({ ...event, id: uid(), documentId: doc.id })));
          originalAdd.run(user.firm, live.owner, current.id, doc.id, bytes);
          save(user, current);
          team.audit(user, live, 'original imported', doc.id);
          return { matter: current, document: doc };
        });
        return json(res, reply.duplicate ? 200 : 201, reply);
      } catch (error) {
        firmDesk.importEnd(user, importId, 'failed', error instanceof ValidationError ?
          'The PDF could not be processed. Check the file and retry.' : 'The import did not complete. Review access or server diagnostics.');
        throw error;
      }
    }
    if (req.method === 'POST' && !format && ['events', 'approve', 'page-review'].includes(group)) {
      if (target && group !== 'events') throw new HttpError(404, 'Route unavailable.');
      const data = await jsonInput(req);
      const reply = transact(() => {
        const live = team.access(user, matterId);
        const current = live.matter;
        if (req.headers['if-match'] !== String(current.revision)) {
          throw new HttpError(409, 'The draft changed. Refresh and review the latest version.');
        }
        let result = {};
        if (group === 'events') result = { event: target ? updateEvent(current, target, data, user.name) : createEvent(current, data, user.name) };
        if (group === 'page-review') reviewPage(current, data, user.name);
        if (group === 'approve') {
          team.assert(live, 'owner');
          if (current.teamReview?.status === 'submitted') throw new HttpError(409, 'Review the submitted revision in Matter team.');
          result = { approval: approveMatter(current, user.name, data.attested) };
          team.audit(user, live, 'chronology approved', result.approval.id);
        }
        save(user, current);
        return { matter: current, ...result };
      });
      return json(res, 200, reply);
    }
    throw new HttpError(404, 'Route unavailable.');
  }

  const server = createServer((req, res) => {
    route(req, res).catch(error => {
      if (res.headersSent || res.destroyed) return;
      const status = error.status ?? (error instanceof ValidationError ? 422 : 500);
      json(res, status, { error: status === 500 ? 'The server could not finish this request. Check the local setup.' : error.message });
    });
  });
  server.on('close', () => db.close());
  return server;
}
