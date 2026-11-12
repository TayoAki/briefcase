import { createHash, randomUUID } from 'node:crypto';
import { roleCatalog } from './role-catalog.mjs';

const catalog = new Map(roleCatalog.map(role => [role.id, role]));
const tokenPattern = /^[a-f0-9-]{36}$/;
export const roleRecordHash = record => createHash('sha256').update(JSON.stringify(record)).digest('hex');

export function createRoleWork({ db, accounts, team, HttpError, transact, original, isActive = () => true }) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS role_work (
      firm TEXT NOT NULL, id TEXT NOT NULL, creator TEXT NOT NULL, request_id TEXT NOT NULL,
      assignee TEXT NOT NULL, reviewer TEXT NOT NULL, state TEXT NOT NULL,
      PRIMARY KEY (firm,id), UNIQUE (firm,creator,request_id)
    );
    CREATE INDEX IF NOT EXISTS role_work_assignee ON role_work(firm,assignee);
    CREATE INDEX IF NOT EXISTS role_work_reviewer ON role_work(firm,reviewer);
    CREATE INDEX IF NOT EXISTS role_work_creator ON role_work(firm,creator);
    CREATE TABLE IF NOT EXISTS role_work_audit (
      firm TEXT NOT NULL, item TEXT NOT NULL, revision INTEGER NOT NULL,
      actor TEXT NOT NULL, action TEXT NOT NULL, at TEXT NOT NULL,
      PRIMARY KEY (firm,item,revision),
      FOREIGN KEY (firm,item) REFERENCES role_work(firm,id)
    );
  `);
  const get = db.prepare('SELECT state FROM role_work WHERE firm=? AND id=?');
  const list = db.prepare(`SELECT state FROM role_work WHERE firm=? AND (creator=? OR assignee=? OR reviewer=?)
    ORDER BY rowid DESC LIMIT ? OFFSET ?`);
  const replay = db.prepare('SELECT state FROM role_work WHERE firm=? AND creator=? AND request_id=?');
  const add = db.prepare('INSERT INTO role_work(firm,id,creator,request_id,assignee,reviewer,state) VALUES (?,?,?,?,?,?,?)');
  const save = db.prepare('UPDATE role_work SET state=? WHERE firm=? AND id=?');
  const log = db.prepare('INSERT INTO role_work_audit VALUES (?,?,?,?,?,?)');
  const history = db.prepare('SELECT revision,actor,action,at FROM role_work_audit WHERE firm=? AND item=? ORDER BY revision');
  const fail = (status, message) => { throw new HttpError(status, message); };
  function text(input, name, max) {
    const value = typeof input === 'string' ? input.trim() : '';
    if (!value || value.length > max) fail(422, name + ' is required and must be at most ' + max + ' characters.');
    return value;
  }
  function participant(user, item) {
    if ((user.matterOnly && !item.matter) || ![item.creator, item.assignee, item.reviewer].includes(user.username)) fail(404, 'That work item is unavailable.');
    if (item.matter) team.access(user, item.matter);
    return item;
  }
  function itemFor(user, id) {
    const row = tokenPattern.test(id) && get.get(user.firm, id);
    if (!row) fail(404, 'That work item is unavailable.');
    return participant(user, JSON.parse(row.state));
  }
  function record(user, item, action) {
    item.updatedAt = new Date().toISOString();
    log.run(user.firm, item.id, item.revision, user.username, action, item.updatedAt);
  }
  function open(user, input) {
    if (user.role !== 'lawyer' || user.matterOnly) fail(403, 'A firm lawyer account must assign role work.');
    const role = catalog.get(input.roleId);
    if (!role) fail(422, 'Choose a role workflow.');
    if (typeof input.requestId !== 'string' || !tokenPattern.test(input.requestId)) fail(422, 'A request ID is required.');
    const title = text(input.title, 'Title', 180);
    const context = text(input.context, 'Work inputs', 4000);
    const assignee = accounts.get(input.assignee);
    const reviewer = accounts.get(input.reviewer);
    const soloReview = assignee === user && reviewer === user &&
      [...accounts.values()].filter(account => account.firm === user.firm && isActive(account)).length === 1;
    if (!assignee || !reviewer || !isActive(assignee) || !isActive(reviewer) || assignee.firm !== user.firm || reviewer.firm !== user.firm ||
        (assignee.username === reviewer.username && !soloReview) || reviewer.role !== 'lawyer') {
      fail(422, 'Choose two distinct people in your firm, including a lawyer as reviewer.');
    }
    const matter = input.matter == null || input.matter === '' ? null : text(input.matter, 'Matter ID', 100);
    if (!matter && (assignee.matterOnly || reviewer.matterOnly)) fail(422, 'Outside counsel assignments must link an authorized matter.');
    if (matter) {
      const scope = team.access(user, matter);
      team.assert(scope, 'owner');
      for (const account of [assignee, reviewer]) {
        if (team.access(account, matter).owner !== scope.owner) fail(404, 'That matter is unavailable.');
      }
      team.assert(team.access(reviewer, matter), 'review');
    }
    const fields = { roleId: role.id, title, context, assignee: assignee.username, reviewer: reviewer.username, matter, reviewMode: soloReview ? 'self-review' : 'independent' };
    const requestHash = roleRecordHash(fields);
    const prior = replay.get(user.firm, user.username, input.requestId);
    if (prior) {
      const existing = participant(user, JSON.parse(prior.state));
      if (requestHash !== existing.requestHash) fail(409, 'This request ID was used for a different assignment.');
      return { item: existing, created: false };
    }
    const item = { ...fields, id: randomUUID(), creator: user.username, requestHash, revision: 0, status: 'draft',
      submission: null, decision: null, receipt: null, verification: null, attempts: [], updatedAt: new Date().toISOString() };
    add.run(user.firm, item.id, item.creator, input.requestId, item.assignee, item.reviewer, JSON.stringify(item));
    record(user, item, 'assigned');
    return { item, created: true };
  }
  function sourceFor(user, item, input) {
    if (!input.sourceId && !input.sourcePage) return null;
    if (!item.matter) fail(422, 'Link a matter before attaching an original page.');
    const scope = team.access(user, item.matter);
    const doc = scope.matter.documents.find(document => document.id === input.sourceId);
    if (!doc || !Number.isSafeInteger(input.sourcePage) || input.sourcePage < 1 || input.sourcePage > doc.pages.length) {
      fail(422, 'Choose an original document and a physical page in the linked matter.');
    }
    return { documentId: doc.id, page: input.sourcePage, originalSha256: doc.sha256 };
  }
  function outputFiles(user, item, input) {
    const ids = input.outputDocuments ?? [];
    if (!Array.isArray(ids) || ids.length > 10 || ids.some(id => typeof id !== 'string') || new Set(ids).size !== ids.length) {
      fail(422, 'Choose up to ten distinct supporting PDFs.');
    }
    if (!ids.length) return [];
    if (!item.matter) fail(422, 'Link the matter that contains the supporting PDFs.');
    const { matter } = team.access(user, item.matter);
    return ids.map(id => {
      const document = matter.documents.find(row => row.id === id && row.purpose === 'supporting');
      if (!document) fail(422, 'Choose an output PDF uploaded as supporting in this matter.');
      original(user, matter, id);
      return { id, name: document.name, sha256: document.sha256 };
    });
  }
  function boundFile(user, item, binding) {
    const { matter } = team.access(user, item.matter);
    const result = original(user, matter, binding.id);
    if (result.doc.sha256 !== binding.sha256) fail(409, 'The submitted PDF no longer matches the original.');
    return result;
  }
  function update(user, id, input) {
    const item = itemFor(user, id);
    if (input.revision !== item.revision) fail(409, 'The item changed. Refresh and review the latest version.');
    const role = catalog.get(item.roleId);
    const act = input.action;
    if (!['submit', 'return', 'approve', 'receipt', 'verify', 'revise', 'cancel'].includes(act)) fail(422, 'Choose a workflow action.');
    if (act === 'cancel') {
      if (user.username !== item.creator) fail(403, 'Only the person who assigned the work can cancel it.');
      if (['verified', 'canceled'].includes(item.status)) fail(409, 'This item is already closed.');
      item.cancellation = { reason: text(input.notes, 'Cancellation reason', 1600), by: user.username };
      item.status = 'canceled';
      item.revision += 1;
      record(user, item, act);
      save.run(JSON.stringify(item), user.firm, item.id);
      return item;
    }
    const preparing = act === 'submit' || act === 'receipt';
    if (user.username !== item[preparing ? 'assignee' : 'reviewer'] || (!preparing && user.role !== 'lawyer')) {
      fail(403, 'This action belongs to the assigned ' + (preparing ? 'preparer.' : 'reviewer.'));
    }
    if (!preparing && item.matter) team.assert(team.access(user, item.matter), 'review');
    if (act === 'submit') {
      if (!['draft', 'returned'].includes(item.status)) fail(409, 'The item is already in review or finished.');
      if (item.attempts.length >= 25) fail(409, 'Start a follow-up assignment after 25 submissions.');
      if (item.submission) item.attempts.push({ submission: item.submission, decision: item.decision,
        ...(item.revisionRequest ? { revisionRequest: item.revisionRequest, receipt: item.receipt,
          receiptReturns: item.receiptReturns ?? [] } : {}) });
      const snapshot = { revision: item.revision + 1, author: user.username, output: text(input.output, role.output, 12000),
        evidence: text(input.evidence, 'Supporting references', 4000), source: sourceFor(user, item, input) };
      const files = outputFiles(user, item, input);
      if (files.length) snapshot.files = files;
      item.submission = { ...snapshot, sha256: roleRecordHash(snapshot) };
      item.decision = null;
      item.revisionRequest = null;
      item.receipt = null;
      item.receiptReturns = [];
      item.status = 'submitted';
    } else if (act === 'receipt') {
      if (!role.external || !['awaiting_receipt', 'receipt_returned'].includes(item.status)) fail(409, 'An approved handoff must be awaiting a receipt.');
      const receipt = { provider: text(input.provider, 'Provider or destination', 160),
        reference: text(input.reference, 'Receipt or status reference', 400), outcome: text(input.outcome, 'Observed outcome', 1200),
        recordedBy: user.username, revision: item.revision + 1 };
      item.receipt = { ...receipt, sha256: roleRecordHash(receipt) };
      item.status = 'receipt_recorded';
    } else {
      const at = new Date().toISOString();
      const notes = text(input.notes, 'Review notes', 1600);
      if (act === 'return' && item.status === 'receipt_recorded') {
        item.receiptReturns ??= [];
        if (item.receiptReturns.length >= 25) fail(409, 'Start a follow-up assignment after 25 receipt returns.');
        item.receiptReturns.push({ receipt: item.receipt, notes, reviewer: user.username, at });
        item.status = 'receipt_returned';
      } else if (act === 'revise') {
        if (item.status !== 'receipt_recorded') fail(409, 'Record the provider result before requesting a revised submission.');
        item.revisionRequest = { notes, reviewer: user.username, at };
        item.status = 'returned';
      } else if (act === 'verify') {
        if (item.status !== 'receipt_recorded') fail(409, 'Record the provider result before verifying it.');
        if (input.attested !== true) fail(422, 'Confirm you checked the external result against the approved work.');
        item.verification = { notes, reviewer: user.username, at, outputSha256: item.submission.sha256, receiptSha256: item.receipt.sha256 };
        item.status = 'verified';
      } else {
        if (item.status !== 'submitted') fail(409, 'Only a current submission can be reviewed.');
        if (act === 'approve' && input.attested !== true) fail(422, 'Confirm you checked the work against the acceptance criteria.');
        item.decision = { action: act, notes, reviewer: user.username, at, outputSha256: item.submission.sha256 };
        item.status = act === 'return' ? 'returned' : role.external ? 'awaiting_receipt' : 'verified';
        if (item.status === 'verified') item.verification = item.decision;
      }
    }
    item.revision += 1;
    record(user, item, act);
    save.run(JSON.stringify(item), user.firm, item.id);
    return item;
  }
  return {
    catalog: () => roleCatalog,
    roster: user => user.role === 'lawyer' && !user.matterOnly ? [...accounts.values()].filter(account => account.firm === user.firm && isActive(account))
      .map(({ username, name, role }) => ({ username, name, role })) : [],
    list(user, offset) {
      const rows = list.all(user.firm, user.username, user.username, user.username, 51, offset);
      const items = rows.slice(0, 50).map(row => JSON.parse(row.state)).filter(item => {
        try { participant(user, item); return true; }
        catch (error) { if (error.status !== 404) throw error; return false; }
      }).map(({ id, roleId, title, status, assignee, reviewer, updatedAt }) =>
        ({ id, roleId, title, status, assignee, reviewer, updatedAt }));
      return { items, hasMore: rows.length > 50 };
    },
    open: (user, input) => transact(() => open(user, input)),
    update: (user, id, input) => transact(() => update(user, id, input)),
    detail(user, id) {
      const item = itemFor(user, id);
      const outputDocuments = item.matter && item.assignee === user.username && ['draft', 'returned'].includes(item.status) ?
        team.access(user, item.matter).matter.documents.filter(row => row.purpose === 'supporting')
          .map(({ id, name }) => ({ id, name })) : [];
      return { item, history: history.all(user.firm, id), outputDocuments };
    },
    file(user, id, revision, fileId) {
      const item = itemFor(user, id);
      const attempts = [item.submission, ...item.attempts.map(row => row.submission)];
      const entry = attempts.find(row => row?.revision === Number(revision))?.files?.find(row => row.id === fileId);
      if (!entry) fail(404, 'That submitted output is unavailable.');
      const result = boundFile(user, item, entry);
      return { ...result, name: entry.name };
    },
    proof(user, id) {
      const item = itemFor(user, id);
      if (item.status !== 'verified') fail(409, 'Verification is required before exporting proof.');
      for (const submission of [item.submission, ...item.attempts.map(row => row.submission)]) {
        for (const binding of submission?.files ?? []) boundFile(user, item, binding);
      }
      const { requestHash, ...record } = item;
      return { record, acceptance: catalog.get(item.roleId).check, history: history.all(user.firm, id) };
    },
  };
}
