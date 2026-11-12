import { createHash, randomUUID } from 'node:crypto';
import { workflows as legal } from './workflows/legal.mjs';
import { workflows as documents } from './workflows/documents.mjs';
import { workflows as practice } from './workflows/practice-operations.mjs';
import { workflows as specialists } from './workflows/specialists.mjs';
import { workflows as finance } from './workflows/finance-people.mjs';
import { workflows as technology } from './workflows/technology.mjs';

export const workflows = [...legal, ...documents, ...practice, ...specialists, ...finance, ...technology]
  .sort((a, b) => a.roleId.localeCompare(b.roleId));
export const workbenchHash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const uuid = /^[a-f0-9-]{36}$/;
const MAX_RECORD = 16 * 1024 * 1024;

export function createWorkbench({ db, accounts, team, HttpError, transact, original, isActive, config = {}, technology = {} }) {
  const catalog = new Map(workflows.map(def => [def.roleId, def]));
  if (catalog.size !== workflows.length) throw new Error('Duplicate specialist workflow role.');
  db.exec(`CREATE TABLE IF NOT EXISTS specialist_work (
    firm TEXT NOT NULL, id TEXT NOT NULL, creator TEXT NOT NULL, request_id TEXT NOT NULL,
    assignee TEXT NOT NULL, reviewer TEXT NOT NULL, state TEXT NOT NULL,
    PRIMARY KEY(firm,id), UNIQUE(firm,creator,request_id)
  ); CREATE INDEX IF NOT EXISTS specialist_work_people ON specialist_work(firm,assignee,reviewer);`);
  const get = db.prepare('SELECT state FROM specialist_work WHERE firm=? AND id=?');
  const priorRequest = db.prepare('SELECT state FROM specialist_work WHERE firm=? AND creator=? AND request_id=?');
  const summaryColumns = `firm,id,creator,assignee,reviewer,json_extract(state,'$.roleId') AS roleId,
    json_extract(state,'$.title') AS title,json_extract(state,'$.matter') AS matter,
    json_extract(state,'$.status') AS status,json_extract(state,'$.revision') AS revision,
    json_extract(state,'$.updatedAt') AS updatedAt`;
  const rows = db.prepare(`SELECT ${summaryColumns} FROM specialist_work WHERE firm=? AND (creator=? OR assignee=? OR reviewer=?) ORDER BY rowid DESC`);
  const delegatedRows = db.prepare(`SELECT ${summaryColumns} FROM specialist_work WHERE firm=? AND creator=? AND id<>? ORDER BY rowid DESC`);
  const insert = db.prepare('INSERT INTO specialist_work VALUES (?,?,?,?,?,?,?)');
  const write = db.prepare('UPDATE specialist_work SET assignee=?,reviewer=?,state=? WHERE firm=? AND id=?');
  const fail = (status, message) => { throw new HttpError(status, message); };
  const text = (value, label, max = 500) => {
    if (typeof value !== 'string' || !value.trim() || value.length > max) fail(422, label + ' is required (maximum ' + max + ' characters).');
    return value.trim();
  };
  function person(user, username) {
    const account = accounts.get(username);
    if (!account || account.firm !== user.firm || !isActive(account)) fail(422, 'Choose an active account in this firm.');
    return account;
  }
  function authorize(user, item) {
    if (!isActive(user) || item.firm !== user.firm || ![item.creator, item.assignee, item.reviewer].includes(user.username)) fail(404, 'That specialist work is unavailable.');
    if (user.matterOnly && !item.matter) fail(404, 'That specialist work is unavailable.');
    if (item.matter) team.access(user, item.matter);
    return item;
  }
  function itemFor(user, id) {
    const row = typeof id === 'string' && uuid.test(id) && get.get(user.firm, id);
    if (!row) fail(404, 'That specialist work is unavailable.');
    return authorize(user, JSON.parse(row.state));
  }
  function sameVersion(item, input) {
    if (input.revision !== item.revision) fail(409, 'This work changed. Refresh before continuing.');
  }
  function persist(item) {
    const state = JSON.stringify(item);
    if (Buffer.byteLength(state) > MAX_RECORD) fail(413, 'This work record is full. Start a follow-up assignment.');
    write.run(item.assignee, item.reviewer, state, item.firm, item.id);
  }
  function event(item, user, action, note = '') {
    item.revision += 1;
    item.updatedAt = new Date().toISOString();
    item.history.push({ revision: item.revision, actor: user.username, action, at: item.updatedAt, note });
    if (item.history.length > 500) fail(409, 'Start a follow-up assignment after 500 changes.');
  }
  function participants(item, user) {
    for (const name of [item.assignee, item.reviewer]) {
      const account = person(user, name);
      if (item.matter) team.access(account, item.matter);
    }
    const reviewer = accounts.get(item.reviewer);
    if (reviewer.role !== 'lawyer') fail(403, 'An assigned lawyer must review this work.');
    if (item.assignee === item.reviewer && [...accounts.values()].filter(a => a.firm === user.firm && isActive(a)).length !== 1) {
      fail(409, 'This firm now has more than one active account. Assign an independent reviewer.');
    }
    if (item.matter) team.assert(team.access(reviewer, item.matter), 'review');
  }
  const brief = item => ({ id: item.id, roleId: item.roleId, title: item.title, status: item.status,
    assignee: item.assignee, reviewer: item.reviewer, revision: item.revision, updatedAt: item.updatedAt });

  function project(user, item) {
    const def = catalog.get(item.roleId);
    if (!def.project) return item;
    const result = structuredClone(item), ctx = context(user, item);
    result.data = def.project(result.data, ctx);
    for (const version of result.versions) {
      version.data = def.project(version.data, ctx);
      if (!ctx.isReviewer && version.decision) delete version.decision.notes;
    }
    if (!ctx.isReviewer) result.history = result.history.map(({ note, ...event }) => event);
    result.projected = true;
    return result;
  }

  function activeHolds(user, matterId, excludeItem) {
    if (!matterId) return [];
    const matter = team.access(user, matterId).matter;
    const holds = (matter.practice?.office?.records?.hold ?? []).filter(row => row.status === 'Active')
      .map(row => 'matter-hold:' + workbenchHash([user.firm, matterId, row.id]));
    for (const row of db.prepare("SELECT id,state FROM specialist_work WHERE firm=? AND json_extract(state,'$.matter')=? AND json_extract(state,'$.roleId')='R63'").all(user.firm, matterId)) {
      if (row.id === excludeItem) continue;
      for (const hold of JSON.parse(row.state).data.holds ?? []) {
        if (!hold.released) holds.push('records-hold:' + workbenchHash([row.id, hold.reference]));
      }
    }
    return holds.sort();
  }

  function context(user, item) {
    const bound = new Map();
    const ctx = {
      user, roleId: item.roleId, matterId: item.matter, itemId: item.id, creator: item.creator,
      now: new Date().toISOString(), isReviewer: user.username === item.reviewer,
      assignee: item.assignee, reviewer: item.reviewer,
      fail, hash: workbenchHash, diligenceKeys: config.diligenceKeys ?? {},
      finance: {
        assertUnique(kind, key) {
          const rules = {
            'ap-invoice': ['R50', 'invoices', 'key'], 'ap-receipt': ['R50', 'payments', 'receiptReference'],
            'ar-invoice': ['R53', 'invoices', 'invoiceId'], 'ar-receipt': ['R53', 'payments', 'receiptReference'],
            'billing-invoice': ['R52', null, 'invoiceReference'], 'billing-submission': ['R52', 'submissions', 'reference'],
            'billing-result': ['R52', 'results', 'receiptReference'],
          };
          const rule = rules[kind];
          if (!rule || item.roleId !== rule[0]) fail(403, 'That financial uniqueness check is unavailable.');
          const [roleId, collection, field] = rule;
          for (const row of db.prepare("SELECT state FROM specialist_work WHERE firm=? AND id<>? AND json_extract(state,'$.roleId')=?").all(user.firm, item.id, roleId)) {
            const data = JSON.parse(row.state).data;
            if (collection ? (data[collection] ?? []).some(entry => entry[field] === key) : data[field] === key) {
              fail(409, 'This financial record is already registered in another firm workflow.');
            }
          }
        },
      },
      technology: {
        recoveryManifest() { if (item.roleId !== 'R59') fail(403, 'Recovery assignment required.'); return technology.recoveryManifest(user); },
        supportJobs() { if (item.roleId !== 'R60') fail(403, 'Support assignment required.'); return technology.supportJobs(user); },
        securityEvents() { if (item.roleId !== 'R61') fail(403, 'Security assignment required.'); return technology.securityEvents(user); },
        accountActive(username) { if (item.roleId !== 'R61') fail(403, 'Security assignment required.'); const a = accounts.get(username); return Boolean(a && a.firm === user.firm && isActive(a)); },
        activeHolds(_documentId) { if (item.roleId !== 'R63') fail(403, 'Records assignment required.'); return activeHolds(user, item.matter, item.id); },
      },
      source(documentId, page) {
        if (!item.matter) fail(422, 'Link an authorized matter to use source documents.');
        const scope = team.access(user, item.matter);
        const result = original(user, scope.matter, documentId);
        if (page !== undefined && (!Number.isSafeInteger(page) || !result.doc.pages.some(row => row.number === page))) fail(422, 'Choose an existing physical source page.');
        const binding = { documentId, sha256: result.doc.sha256, name: result.doc.name, ...(page !== undefined ? { page } : {}) };
        bound.set(documentId + ':' + (page ?? ''), binding);
        return { ...result.doc, bytes: Buffer.from(result.stored) };
      },
      sourceBinding(documentId, page) {
        const doc = ctx.source(documentId, page);
        return { documentId: doc.id, sha256: doc.sha256, name: doc.name, ...(page !== undefined ? { page } : {}) };
      },
      operations: {
        roster: () => [...accounts.values()].filter(a => a.firm === user.firm && isActive(a) && !a.matterOnly)
          .map(({ username, role }) => ({ username, role })),
        queue: () => {
          if (item.roleId !== 'R34') fail(403, 'Practice operations assignment required.');
          return delegatedRows.all(user.firm, item.creator, item.id)
            .map(({ id, roleId, assignee, status, updatedAt, revision }) => ({ id, roleId, assignee, status, updatedAt, revision }));
        },
        reassign(id, username, revision) {
          if (item.roleId !== 'R34') fail(403, 'Practice operations assignment required.');
          const raw = get.get(user.firm, id);
          const target = raw && JSON.parse(raw.state);
          if (!target || target.creator !== item.creator || target.id === item.id) fail(404, 'That delegated work is unavailable.');
          sameVersion(target, { revision });
          const account = person(user, username);
          if (account.username === target.reviewer || account.matterOnly) fail(422, 'Choose an independent preparer.');
          const owner = person(user, target.creator);
          if (target.matter) { team.access(owner, target.matter); team.access(account, target.matter); }
          target.assignee = account.username;
          target.status = 'draft';
          target.submission = null;
          event(target, user, 'practice reassignment');
          persist(target);
          const { title, reviewer, ...metadata } = brief(target);
          return metadata;
        },
      },
    };
    ctx.boundSources = () => [...bound.values()];
    return ctx;
  }
  function validate(def, data, ctx) {
    const result = def.validate(data, ctx);
    if (!result || !Array.isArray(result.errors)) throw new Error('Invalid specialist validation result.');
    return { errors: result.errors, warnings: result.warnings ?? [] };
  }
  function sourceChecks(ctx, bindings) {
    for (const binding of bindings ?? []) {
      if (ctx.source(binding.documentId, binding.page).sha256 !== binding.sha256) fail(409, 'A bound source changed. Review a new version.');
    }
  }
  function checkFields(fields, data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) fail(422, 'Provide structured workflow fields.');
    for (const field of fields ?? []) {
      const value = data[field.name];
      if (field.required && (value === undefined || value === null || value === '')) fail(422, field.label + ' is required.');
      if (value === undefined || value === null || value === '') continue;
      if (['text', 'textarea', 'date', 'select', 'file'].includes(field.type) && typeof value !== 'string') fail(422, field.label + ' must be text.');
      if (field.type === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) fail(422, field.label + ' must be a finite number.');
      if (field.type === 'checkbox' && typeof value !== 'boolean') fail(422, field.label + ' must be true or false.');
      if (field.type === 'select' && field.options && !field.options.map(o => typeof o === 'string' ? o : o.value).includes(value)) fail(422, 'Choose a listed ' + field.label + '.');
    }
  }
  function create(user, input) {
    const def = catalog.get(input.roleId);
    if (!def) fail(422, 'Choose an available specialist workflow.');
    if (user.matterOnly || (user.role !== 'lawyer' && !user.desk.includes(input.roleId))) fail(403, 'A lawyer or authorized specialist must create this work.');
    if (!uuid.test(input.requestId ?? '')) fail(422, 'A request ID is required.');
    const assignee = person(user, input.assignee);
    const reviewer = person(user, input.reviewer);
    if (reviewer.role !== 'lawyer') fail(422, 'Choose a lawyer to review the work.');
    const solo = assignee.username === user.username && reviewer.username === user.username &&
      [...accounts.values()].filter(a => a.firm === user.firm && isActive(a)).length === 1;
    if (assignee.username === reviewer.username && !solo) fail(422, 'Choose independent preparer and reviewer accounts.');
    const matter = input.matter ? text(input.matter, 'Matter', 100) : null;
    if ((def.matterRequired || assignee.matterOnly || reviewer.matterOnly) && !matter) fail(422, 'This workflow needs an authorized source matter.');
    const title = text(input.title, 'Title', 180);
    const requestHash = workbenchHash({ roleId: input.roleId, title, assignee: assignee.username, reviewer: reviewer.username, matter, data: input.data });
    const previous = priorRequest.get(user.firm, user.username, input.requestId);
    if (previous) {
      const item = authorize(user, JSON.parse(previous.state));
      if (item.requestHash !== requestHash) fail(409, 'This request ID was already used with different inputs.');
      return { item, created: false };
    }
    const item = { id: randomUUID(), firm: user.firm, roleId: def.roleId, title, creator: user.username,
      assignee: assignee.username, reviewer: reviewer.username, matter, requestHash, reviewMode: solo ? 'self-review' : 'independent',
      revision: 0, status: 'draft', versions: [], history: [], submission: null, updatedAt: new Date().toISOString() };
    authorize(user, item);
    participants(item, user);
    const ctx = context(user, item);
    checkFields(def.fields, input.data ?? {});
    item.data = def.create(input.data ?? {}, ctx);
    item.history.push({ revision: 0, actor: user.username, action: 'created', at: item.updatedAt });
    const state = JSON.stringify(item);
    if (Buffer.byteLength(state) > MAX_RECORD) fail(413, 'The work record is too large.');
    insert.run(user.firm, item.id, user.username, input.requestId, assignee.username, reviewer.username, state);
    return { item, created: true };
  }
  function update(user, id, input) {
    const item = itemFor(user, id);
    sameVersion(item, input);
    const def = catalog.get(item.roleId);
    const ctx = context(user, item);
    const action = input.action;
    if (action === 'change-assignment') {
      if (user.username !== item.creator) fail(403, 'Only the assignment creator may change its participants.');
      const assignee = person(user, input.data?.assignee), reviewer = person(user, input.data?.reviewer);
      if (assignee.username === reviewer.username) fail(422, 'Choose an independent preparer and reviewer.');
      if ((assignee.matterOnly || reviewer.matterOnly) && !item.matter) fail(422, 'Outside counsel requires a linked matter.');
      item.assignee = assignee.username; item.reviewer = reviewer.username; item.reviewMode = 'independent';
      participants(item, user); item.status = 'draft'; item.submission = null;
    } else if (action === 'submit') {
      if (user.username !== item.assignee) fail(403, 'Only the assigned preparer submits this work.');
      if (item.status === 'submitted') fail(409, 'This version is already awaiting review.');
      participants(item, user);
      const checks = validate(def, item.data, ctx);
      if (checks.errors.length) fail(422, checks.errors.join(' '));
      const output = def.output(item.data, ctx);
      const body = { number: item.versions.length + 1, data: structuredClone(item.data), output,
        sources: ctx.boundSources(), submittedBy: user.username, submittedAt: ctx.now };
      const version = { ...body, sha256: workbenchHash(body), decision: null };
      item.versions.push(version);
      item.submission = { number: version.number, sha256: version.sha256 };
      item.status = 'submitted';
    } else if (action === 'approve' || action === 'return') {
      if (!ctx.isReviewer) fail(403, 'Only the assigned lawyer reviews this work.');
      if (item.status !== 'submitted') fail(409, 'Submit the current work before review.');
      participants(item, user);
      const version = item.versions.at(-1);
      if (input.sha256 !== version.sha256) fail(409, 'Review the exact current submission.');
      const notes = text(input.notes, 'Review notes', 2000);
      if (action === 'approve') {
        if (input.attested !== true) fail(422, 'Confirm review of the output and sources.');
        sourceChecks(ctx, version.sources);
        const checks = validate(def, version.data, ctx);
        if (checks.errors.length) fail(422, checks.errors.join(' '));
      }
      version.decision = { action, by: user.username, at: ctx.now, notes, sha256: version.sha256 };
      item.status = action === 'approve' ? 'approved' : 'returned';
    } else {
      const command = def.actions.find(row => row.id === action);
      if (!command) fail(422, 'Choose an available workflow action.');
      if (command.reviewerOnly ? !ctx.isReviewer : user.username !== item.assignee) fail(403, command.reviewerOnly ? 'The assigned reviewer must perform this action.' : 'The assigned preparer must perform this action.');
      if (command.reviewerOnly) {
        if (user.role !== 'lawyer') fail(403, 'The assigned reviewer must be a lawyer.');
        if (item.assignee === item.reviewer) participants(item, user);
        if (item.matter) team.assert(team.access(user, item.matter), 'review');
      }
      checkFields(command.fields, input.data ?? {});
      item.data = def.update(structuredClone(item.data), action, input.data ?? {}, ctx);
      item.submission = null;
      item.status = 'draft';
    }
    event(item, user, action, ['approve', 'return'].includes(action) ? input.notes : '');
    persist(item);
    return item;
  }
  function detail(user, id) {
    const item = itemFor(user, id);
    const def = catalog.get(item.roleId);
    const ctx = context(user, item);
    let validation;
    try { validation = validate(def, item.data, ctx); }
    catch (error) { if (!error.status) throw error; validation = { errors: [error.message], warnings: [] }; }
    return { item: project(user, item), validation, ...(item.roleId === 'R63' ? {
      externalHolds: item.data.records.map(row => ({ documentId: row.binding.documentId, holds: activeHolds(user, item.matter, item.id) })),
    } : {}) };
  }
  return {
    list(user) {
      const items = rows.all(user.firm, user.username, user.username, user.username).filter(item => {
        try { authorize(user, item); return true; } catch (error) { if (error.status !== 404) throw error; return false; }
      }).map(brief);
      return { items, workflows: workflows.map(({ roleId, title, description, fields, actions, formats, matterRequired }) =>
        ({ roleId, title, description, fields, actions, formats: ['json', ...(formats ?? [])], matterRequired: Boolean(matterRequired) })),
      roster: user.matterOnly ? [] : [...accounts.values()].filter(a => a.firm === user.firm && isActive(a)).map(({ username, name, role }) => ({ username, name, role })) };
    },
    create: (user, input) => transact(() => { const result = create(user, input); return { ...result, item: project(user, result.item) }; }),
    update: (user, id, input) => transact(() => project(user, update(user, id, input))),
    detail,
    activeHolds,
    diligenceEvidence(user, { workItemId, inquiryId, requestReference, assignee, counsel }) {
      const raw = get.get(user.firm, workItemId);
      const item = raw && JSON.parse(raw.state);
      if (!item || item.roleId !== 'R17' || item.data.caseReference !== inquiryId ||
          item.data.requestReference !== requestReference || item.assignee !== assignee || item.reviewer !== counsel) {
        fail(409, 'The signed verification does not match this inquiry and its assigned reviewers.');
      }
      const account = person(user, item.assignee);
      person(user, item.reviewer);
      const version = item.versions.find(row => row.number === item.submission?.number);
      if (item.status !== 'approved' || version?.decision?.action !== 'approve') return {
        status: ['review', 'failed'].includes(item.data.status) ? item.data.status : 'pending', workId: item.id,
      };
      const { sha256, decision, ...body } = version;
      if (workbenchHash(body) !== sha256 || decision.sha256 !== sha256) fail(409, 'The signed verification record failed integrity checking.');
      const ctx = context(account, item), def = catalog.get('R17');
      const checks = validate(def, item.data, ctx);
      if (checks.errors.length) return { status: 'review', workId: item.id };
      const latest = item.data.receipts.at(-1);
      return { status: latest.status, workId: item.id, sha256, expiresAt: latest.expiresAt };
    },
    async export(user, id, format = 'json', number) {
      const item = itemFor(user, id);
      const def = catalog.get(item.roleId);
      const requested = number === null || number === undefined ? item.submission?.number : Number(number);
      const version = item.versions.find(row => row.number === requested);
      if (!version || version.decision?.action !== 'approve') fail(409, 'Approve the exact version before export.');
      const { sha256, decision, ...body } = version;
      if (workbenchHash(body) !== sha256 || decision.sha256 !== sha256) fail(409, 'The approved version failed its integrity check.');
      const ctx = context(user, item);
      sourceChecks(ctx, version.sources);
      def.assertExport?.(item.data, version.data, ctx);
      if (format === 'json') return { bytes: Buffer.from(JSON.stringify({ roleId: item.roleId, title: item.title,
        version: { number: version.number, output: version.output, sha256: version.sha256,
          submittedBy: version.submittedBy, submittedAt: version.submittedAt,
          decision: { action: decision.action, by: decision.by, at: decision.at, sha256: decision.sha256 } },
        reviewMode: item.reviewMode }, null, 2)), mime: 'application/json', name: 'briefcase-' + item.roleId + '-v' + version.number + '.json' };
      if (!def.exportFile || !def.formats?.includes(format)) fail(422, 'Choose a supported output format.');
      const result = await def.exportFile(version.data, ctx, format);
      // Revocation during document rendering must take effect before bytes are delivered.
      const current = itemFor(user, id);
      const after = context(user, current);
      sourceChecks(after, version.sources);
      def.assertExport?.(current.data, version.data, after);
      return result;
    },
  };
}
