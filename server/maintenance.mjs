import { link, mkdtemp, readFile, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { sha256 } from './pdf.mjs';
import { roleRecordHash } from './role-work.mjs';

function verifySpecialistWork(db) {
  if (!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='specialist_work'").get()) return;
  for (const row of db.prepare('SELECT * FROM specialist_work').iterate()) {
    const item = JSON.parse(row.state);
    if (item.firm !== row.firm || item.id !== row.id || item.creator !== row.creator ||
        item.assignee !== row.assignee || item.reviewer !== row.reviewer ||
        item.history.length !== item.revision + 1 || item.history.some((event, index) => event.revision !== index)) {
      throw new Error('A specialist workflow failed its audit integrity check.');
    }
    for (const version of item.versions) {
      const { sha256: hash, decision, ...body } = version;
      if (hash !== roleRecordHash(body) || (decision && decision.sha256 !== hash)) throw new Error('A specialist output failed its version integrity check.');
      const candidates = item.matter ? db.prepare('SELECT state FROM matters WHERE firm=? AND id=?').all(row.firm, item.matter)
        .map(record => JSON.parse(record.state)) : [];
      for (const source of version.sources ?? []) {
        if (!candidates.some(matter => matter.documents.some(doc => doc.id === source.documentId && doc.sha256 === source.sha256 &&
            (source.page === undefined || doc.pages.some(page => page.number === source.page))))) {
          throw new Error('A specialist output lost its original source binding.');
        }
      }
    }
    if (item.status === 'approved' && !item.versions.some(v => v.number === item.submission?.number && v.sha256 === item.submission?.sha256 && v.decision?.action === 'approve')) {
      throw new Error('A specialist approval lost its exact submission.');
    }
  }
}

const sample = new URL('../dist/sample/Ellis_Medical_Records.pdf', import.meta.url);

function verifyRoleWork(db) {
  if (!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='role_work'").get()) return;
  const history = db.prepare('SELECT count(*) AS count,max(revision) AS latest FROM role_work_audit WHERE firm=? AND item=?');
  const matter = db.prepare('SELECT state FROM matters WHERE firm=? AND owner=? AND id=?');
  const validDigest = item => {
    const { sha256, ...body } = item;
    return sha256 === roleRecordHash(body);
  };
  for (const row of db.prepare('SELECT firm,id,creator,assignee,reviewer,state FROM role_work').iterate()) {
    const item = JSON.parse(row.state);
    const audit = history.get(row.firm, row.id);
    const snapshots = [item.submission, ...item.attempts.map(attempt => attempt.submission)].filter(Boolean);
    const rejectedReceipts = item.attempts.flatMap(attempt =>
      [attempt.receipt, ...(attempt.receiptReturns ?? []).map(entry => entry.receipt)]);
    const receipts = [item.receipt, ...(item.receiptReturns ?? []).map(attempt => attempt.receipt), ...rejectedReceipts].filter(Boolean);
    if (item.id !== row.id || item.creator !== row.creator || item.assignee !== row.assignee || item.reviewer !== row.reviewer ||
        audit.latest !== item.revision || audit.count !== item.revision + 1 ||
        !snapshots.every(validDigest) || !receipts.every(validDigest) ||
        (item.status === 'verified' && (!item.verification || !item.submission ||
          item.verification.outputSha256 !== item.submission.sha256 ||
          (item.receipt && item.verification.receiptSha256 !== item.receipt.sha256)))) {
      throw new Error('A role-work verification record failed its integrity check.');
    }
    if (item.matter) {
      const linked = matter.get(row.firm, row.creator, item.matter);
      if (!linked) throw new Error('A linked role-work matter is unavailable.');
      const { documents } = JSON.parse(linked.state);
      for (const { source, files = [] } of snapshots) {
        if (source && !documents.some(doc => doc.id === source.documentId && doc.sha256 === source.originalSha256 &&
            doc.pages.some(page => page.number === source.page))) {
          throw new Error('A role-work source reference is missing or changed.');
        }
        if (files.some(file => !documents.some(doc => doc.id === file.id && doc.sha256 === file.sha256 && doc.purpose === 'supporting'))) {
          throw new Error('A role-work output PDF is missing or changed.');
        }
      }
    }
  }
}

export async function verifyDatabase(filename) {
  const db = new DatabaseSync(filename, { readOnly: true });
  try {
    const integrity = db.prepare('PRAGMA integrity_check').all();
    if (integrity.length !== 1 || integrity[0].integrity_check !== 'ok' || db.prepare('PRAGMA foreign_key_check').all().length) {
      throw new Error('Database integrity or reference check failed.');
    }
    const source = db.prepare('SELECT bytes FROM originals WHERE firm = ? AND owner = ? AND matter = ? AND id = ?');
    let matterCount = 0;
    let originalCount = 0;
    let approvals = 0;
    for (const row of db.prepare('SELECT firm, owner, id, state FROM matters').iterate()) {
      const matter = JSON.parse(row.state);
      if (matter.id !== row.id || !Array.isArray(matter.documents) || !Array.isArray(matter.approvals)) throw new Error('Matter data failed validation.');
      const documents = new Map();
      for (const doc of matter.documents) {
        const bytes = matter.demo && doc.id === 'ellis-medical-records' ? await readFile(sample) : source.get(row.firm, row.owner, row.id, doc.id)?.bytes;
        if (!bytes || bytes.length !== doc.bytes || sha256(bytes) !== doc.sha256) throw new Error('Original PDF integrity check failed.');
        documents.set(doc.id, doc);
        originalCount += 1;
      }
      for (const approval of matter.approvals) {
        for (const event of approval.events) {
          const doc = documents.get(event.documentId);
          if (!doc || doc.sha256 !== event.sourceSha256 || !doc.pages.some(page => page.number === event.page)) {
            throw new Error('An approved source reference is missing or changed.');
          }
        }
        approvals += 1;
      }
      matterCount += 1;
    }
    verifyRoleWork(db);
    verifySpecialistWork(db);
    return { matters: matterCount, originals: originalCount, chronologyApprovals: approvals };
  } finally { db.close(); }
}

export async function copyDatabase(source, destination) {
  const started = Date.now();
  if (resolve(source) === resolve(destination)) throw new Error('Use a separate destination database.');
  const folder = await mkdtemp(join(dirname(resolve(destination)), '.briefcase-snapshot-'));
  const staged = join(folder, 'verified.sqlite');
  try {
    const db = new DatabaseSync(source, { readOnly: true });
    try { await backup(db, staged); }
    finally { db.close(); }
    const evidence = await verifyDatabase(staged);
    await link(staged, resolve(destination));
    return { ...evidence, elapsedMs: Date.now() - started };
  } finally { await rm(folder, { recursive: true, force: true }); }
}

const tenantTableOrder = [
  'portal_submissions', 'portal_grants', 'role_work_audit', 'role_work', 'specialist_work', 'firm_desk',
  'matter_audit', 'matter_members', 'matter_screens', 'originals', 'import_jobs', 'matters',
];

export async function copyTenantDatabase(source, destination, firm) {
  if (!/^[\w.-]{1,70}$/.test(firm ?? '')) throw new Error('Choose one configured firm ID.');
  if (resolve(source) === resolve(destination)) throw new Error('Use a separate destination database.');
  const folder = await mkdtemp(join(dirname(resolve(destination)), '.briefcase-tenant-'));
  const staged = join(folder, 'full.sqlite');
  const compact = join(folder, 'tenant.sqlite');
  try {
    const live = new DatabaseSync(source, { readOnly: true });
    try { await backup(live, staged); }
    finally { live.close(); }
    const working = new DatabaseSync(staged);
    try {
      const tables = new Set(working.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
        .all().map(row => row.name));
      if ([...tables].some(table => !tenantTableOrder.includes(table))) {
        throw new Error('The database contains a table without a tenant export rule.');
      }
      const hasMatter = working.prepare('SELECT 1 FROM matters WHERE firm=? LIMIT 1').get(firm);
      const hasDesk = tables.has('firm_desk') && working.prepare('SELECT 1 FROM firm_desk WHERE firm=? LIMIT 1').get(firm);
      const hasWork = tables.has('role_work') && working.prepare('SELECT 1 FROM role_work WHERE firm=? LIMIT 1').get(firm);
      if (!hasMatter && !hasDesk && !hasWork) throw new Error('No durable records were found for this firm.');
      working.exec('PRAGMA foreign_keys=ON; PRAGMA secure_delete=ON; BEGIN IMMEDIATE');
      try {
        for (const table of tenantTableOrder) {
          if (!tables.has(table)) continue;
          if (table === 'portal_submissions') {
            working.prepare('DELETE FROM portal_submissions WHERE grant_id NOT IN (SELECT id FROM portal_grants WHERE firm=?)').run(firm);
          } else {
            working.prepare('DELETE FROM ' + table + ' WHERE firm IS NOT ?').run(firm);
          }
        }
        working.exec('COMMIT');
      } catch (error) {
        working.exec('ROLLBACK');
        throw error;
      }
      working.prepare('VACUUM INTO ?').run(compact);
    } finally { working.close(); }
    const evidence = await verifyDatabase(compact);
    await link(compact, resolve(destination));
    return { firm, ...evidence };
  } finally { await rm(folder, { recursive: true, force: true }); }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  process.umask(0o077);
  const [, , command, source, destination, firm] = process.argv;
  try {
    if (command === 'verify' && source && !destination) console.log(JSON.stringify(await verifyDatabase(source)));
    else if (['backup', 'restore'].includes(command) && source && destination) console.log(JSON.stringify(await copyDatabase(source, destination)));
    else if (command === 'export-tenant' && source && destination && firm) console.log(JSON.stringify(await copyTenantDatabase(source, destination, firm)));
    else throw new Error('Use export-tenant SOURCE NEW_DESTINATION FIRM, verify SOURCE, backup SOURCE NEW_DESTINATION, or restore SOURCE NEW_DESTINATION.');
  } catch (error) {
    console.error(error.code === 'EEXIST' ? 'Choose a new destination. The existing database is intact.' : error.message);
    process.exitCode = 1;
  }
}
