import { clean, now, uid, approveMatter } from '../dist/model.mjs';

const draftActions = new Set([
  'request-save', 'request-receipt', 'request-status', 'request-sent', 'demand-save', 'bill-save', 'bill-remove',
  'exhibit-save', 'exhibit-remove', 'task-save', 'update-save',
]);
const officeDraftStates = {
  screening: ['Triage', 'Review'], caseplan: ['Planned', 'Active'], incident: ['Unverified', 'Disputed'],
  witness: ['Identified', 'Scheduled', 'Interviewed'], evidence: ['Requested', 'Received'], preservation: ['Draft'],
  claim: ['Open', 'Disputed'], coverage: ['Asserted', 'Disputed'], provider: ['Open', 'Partial'],
  damage: ['Asserted'], casecost: ['Incurred'], lien: ['Asserted', 'Disputed', 'Negotiated'],
  receipt: ['Pending'], allocation: ['Draft'], disbursement: ['Pending'], reconciliation: ['Draft'],
  correspondence: ['Draft', 'Received'], clienttask: ['Draft', 'Received'], pleading: ['Draft'],
  notice: ['Received'], discovery: ['Draft'], production: ['Draft'], deposition: ['Planned'],
  authoritysource: ['Candidate'], motion: ['Draft'], hearing: ['Planned'],
};

export function createTeamAccess(db, accounts, HttpError, isActive = () => true) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS matter_members (
      firm TEXT NOT NULL, owner TEXT NOT NULL, matter TEXT NOT NULL, username TEXT NOT NULL,
      access TEXT NOT NULL CHECK(access IN ('prepare','review')), granted_at TEXT NOT NULL, revoked_at TEXT,
      PRIMARY KEY(firm, owner, matter, username),
      FOREIGN KEY(firm, owner, matter) REFERENCES matters(firm, owner, id)
    );
    CREATE TABLE IF NOT EXISTS matter_screens (
      firm TEXT NOT NULL, owner TEXT NOT NULL, matter TEXT NOT NULL, username TEXT NOT NULL,
      PRIMARY KEY(firm,owner,matter,username),
      FOREIGN KEY(firm,owner,matter) REFERENCES matters(firm,owner,id)
    );
    CREATE TABLE IF NOT EXISTS matter_audit (
      id INTEGER PRIMARY KEY, firm TEXT NOT NULL, owner TEXT NOT NULL, matter TEXT NOT NULL,
      actor TEXT NOT NULL, action TEXT NOT NULL, target TEXT, at TEXT NOT NULL,
      FOREIGN KEY(firm, owner, matter) REFERENCES matters(firm, owner, id)
    );
    CREATE INDEX IF NOT EXISTS matter_members_user ON matter_members(firm, username, revoked_at);
    CREATE INDEX IF NOT EXISTS matter_audit_scope ON matter_audit(firm, owner, matter, id);
  `);
  if (!db.prepare('PRAGMA table_info(matter_members)').all().some(column => column.name === 'expires_at')) {
    db.exec('ALTER TABLE matter_members ADD COLUMN expires_at TEXT');
  }
  const prepare = sql => db.prepare(sql);
  const owned = prepare('SELECT owner, state FROM matters WHERE firm = ? AND owner = ? AND id = ?');
  const shared = prepare(`SELECT m.owner,m.state,g.access FROM matter_members g JOIN matters m
    ON m.firm=g.firm AND m.owner=g.owner AND m.id=g.matter
    WHERE g.firm=? AND g.username=? AND g.matter=? AND g.revoked_at IS NULL AND (g.expires_at IS NULL OR g.expires_at>?)
      AND NOT EXISTS (SELECT 1 FROM matter_screens s WHERE s.firm=g.firm AND s.owner=g.owner
        AND s.matter=g.matter AND s.username=g.username) LIMIT 2`);
  const available = prepare(`SELECT m.owner,m.state,g.access FROM matter_members g JOIN matters m
    ON m.firm=g.firm AND m.owner=g.owner AND m.id=g.matter
    WHERE g.firm=? AND g.username=? AND g.revoked_at IS NULL AND (g.expires_at IS NULL OR g.expires_at>?)
      AND NOT EXISTS (SELECT 1 FROM matter_screens s WHERE s.firm=g.firm AND s.owner=g.owner
        AND s.matter=g.matter AND s.username=g.username)`);
  const members = prepare('SELECT username,access,granted_at AS grantedAt,revoked_at AS revokedAt,expires_at AS expiresAt FROM matter_members WHERE firm=? AND owner=? AND matter=? ORDER BY username');
  const upsert = prepare(`INSERT INTO matter_members(firm,owner,matter,username,access,granted_at,revoked_at,expires_at)
    VALUES (?,?,?,?,?,?,NULL,?) ON CONFLICT(firm,owner,matter,username) DO UPDATE SET
    access=excluded.access,granted_at=excluded.granted_at,revoked_at=NULL,expires_at=excluded.expires_at`);
  const revoke = prepare('UPDATE matter_members SET revoked_at=? WHERE firm=? AND owner=? AND matter=? AND username=? AND revoked_at IS NULL');
  const persistMatter = prepare('UPDATE matters SET state=? WHERE firm=? AND owner=? AND id=?');
  const screenCheck = prepare('SELECT 1 FROM matter_screens WHERE firm=? AND owner=? AND matter=? AND username=?');
  const screenAdd = prepare('INSERT OR IGNORE INTO matter_screens VALUES (?,?,?,?)');
  const screenRemove = prepare('DELETE FROM matter_screens WHERE firm=? AND owner=? AND matter=? AND username=?');
  const screens = prepare('SELECT username FROM matter_screens WHERE firm=? AND owner=? AND matter=? ORDER BY username');
  const grant = prepare('SELECT access,granted_at AS grantedAt,revoked_at AS revokedAt,expires_at AS expiresAt FROM matter_members WHERE firm=? AND owner=? AND matter=? AND username=?');
  const scopeArgs = scope => [scope.firm, scope.owner, scope.matter.id];
  const auditInsert = prepare('INSERT INTO matter_audit(firm,owner,matter,actor,action,target,at) VALUES (?,?,?,?,?,?,?)');
  const auditRead = prepare('SELECT actor,action,target,at FROM matter_audit WHERE firm=? AND owner=? AND matter=? ORDER BY id DESC LIMIT 100');
  const fail = (status, message) => { throw new HttpError(status, message); };
  const isLawyer = user => user.role !== 'preparer';
  const activeGrant = row => Boolean(row && !row.revokedAt && (!row.expiresAt || row.expiresAt > now()));
  const decode = (user, row, level) => ({ level, matter: JSON.parse(row.state), owner: row.owner, firm: user.firm });

  function access(user, id) {
    if (!isActive(user)) fail(404, 'That matter is unavailable.');
    const own = !user.matterOnly && owned.get(user.firm, user.username, id);
    if (own) return decode(user, own, isLawyer(user) ? 'owner' : 'prepare');
    const matches = shared.all(user.firm, user.username, id, now());
    if (matches.length !== 1) fail(404, 'That matter is unavailable.');
    const row = matches[0];
    return decode(user, row, row.access === 'review' && isLawyer(user) ? 'review' : 'prepare');
  }

  function assert(scope, level) {
    if (level === 'owner' && scope.level !== 'owner') fail(403, 'The matter owner must perform this action.');
    if (level === 'review' && scope.level === 'prepare') fail(403, 'An assigned lawyer must approve this action.');
  }

  function audit(user, scope, action, target = null) {
    auditInsert.run(scope.firm, scope.owner, scope.matter.id, user.username, action, target, now());
  }

  function list(user, scope) {
    const roster = members.all(scope.firm, scope.owner, scope.matter.id);
    return {
      access: scope.level, owner: scope.owner, review: scope.matter.teamReview ?? null,
      reviewHistory: (scope.matter.teamReviewHistory ?? []).slice(0, 20),
      reviewers: [scope.owner, ...roster.filter(row => row.access === 'review' && !screenCheck.get(...scopeArgs(scope), row.username) && activeGrant(row) && accounts.get(row.username)?.role === 'lawyer' && isActive(accounts.get(row.username))).map(row => row.username)],
      members: scope.level === 'owner' ? roster : [],
      screens: scope.level === 'owner' ? screens.all(...scopeArgs(scope)).map(row => row.username) : [],
      candidates: scope.level === 'owner' ? [...accounts.values()].filter(person =>
        person.firm === user.firm && person.username !== scope.owner).map(({ username, name, role }) => ({ username, name, role })) : [],
      audit: scope.level === 'owner' ? auditRead.all(scope.firm, scope.owner, scope.matter.id) : [],
    };
  }

  function returnPending(user, scope, username, reason) {
    const pending = scope.matter.teamReview;
    if (pending?.status !== 'submitted' || pending.reviewer !== username) return false;
    Object.assign(pending, { status: 'returned', reason, reviewedAt: now(), reviewedBy: user.username });
    return true;
  }
  function withdrawReviewer(user, scope, username) {
    if (returnPending(user, scope, username, 'The reviewer no longer has access. Submit to a different lawyer.')) {
      persistMatter.run(JSON.stringify(scope.matter), ...scopeArgs(scope));
    }
  }

  function member(user, scope, input) {
    assert(scope, 'owner');
    if (scope.matter.demo) fail(422, 'Create a new synthetic matter to test sharing.');
    const account = accounts.get(input.username);
    if (!account || account.firm !== user.firm || account.username === scope.owner) fail(404, 'That firm account is unavailable.');
    const args = [scope.firm, scope.owner, scope.matter.id, account.username];
    if (input.action === 'screen' || input.action === 'unscreen') {
      const reason = clean(input.reason, 350);
      if (!reason) fail(422, 'Record a reason for this screen decision.');
      const changed = (input.action === 'screen' ? screenAdd : screenRemove).run(...args).changes;
      if (changed) {
        if (input.action === 'screen') {
          revoke.run(now(), ...args);
          withdrawReviewer(user, scope, account.username);
        }
        audit(user, scope, 'screen ' + input.action + ' · ' + reason, account.username);
      }
    } else if (input.action === 'revoke') {
      if (revoke.run(now(), ...args).changes) {
        withdrawReviewer(user, scope, account.username);
        audit(user, scope, 'access revoked', account.username);
      }
    } else if (input.action === 'grant' && isActive(account) && ['prepare', 'review'].includes(input.access) &&
        (input.access !== 'review' || isLawyer(account))) {
      if (screenCheck.get(...args)) fail(409, 'That account is screened from this matter.');
      const expiry = input.expiresAt || null;
      if ((account.matterOnly && !expiry) || (expiry && (typeof expiry !== 'string' ||
          !Number.isFinite(Date.parse(expiry)) || new Date(expiry).toISOString() !== expiry ||
          Date.parse(expiry) <= Date.now() || Date.parse(expiry) > Date.now() + 30 * 86_400_000))) {
        fail(422, 'Set an expiry within 30 days for a temporary matter grant.');
      }
      const prior = grant.get(...args);
      if (!prior || prior.revokedAt || prior.access !== input.access || prior.expiresAt !== expiry) {
        upsert.run(...args, input.access, now(), expiry);
        audit(user, scope, 'access granted · ' + input.access + (expiry ? ' · expires ' + expiry : ''), account.username);
      }
    } else fail(422, 'Choose a role permitted for this firm account.');
    return list(user, scope);
  }

  function practiceAction(scope, input) {
    if (scope.level === 'owner' || draftActions.has(input.action)) return;
    if (input.action === 'office-save' && Object.hasOwn(officeDraftStates, input.type)) {
      const statuses = officeDraftStates[input.type];
      const prior = input.id && scope.matter.practice?.office?.records?.[input.type]?.find(row => row.id === input.id);
      if (statuses.includes(input.status) && (!input.id || (prior && statuses.includes(prior.status)))) return;
    }
    fail(403, 'The matter owner must complete this workflow action.');
  }

  function review(user, scope, input) {
    const { matter } = scope;
    const previous = matter.teamReview;
    if (input.revision !== matter.revision) fail(409, 'The chronology changed. Refresh and review the current version.');
    if (input.action === 'submit') {
      if (!matter.events.some(event => event.status === 'verified') || matter.events.some(event => event.status === 'needs_review')) {
        fail(422, 'Prepare and check the evidence rows before submitting the chronology.');
      }
      if (previous?.status === 'submitted' && previous.revision === matter.revision &&
          list(user, scope).reviewers.includes(previous.reviewer)) return;
      const reviewer = input.reviewer ?? scope.owner;
      const account = accounts.get(reviewer);
      if (reviewer === user.username || !account || account.firm !== scope.firm || !isLawyer(account) ||
          (reviewer !== scope.owner && access(account, matter.id).level !== 'review')) {
        fail(422, 'Choose a different assigned lawyer to review this chronology.');
      }
      if (previous) matter.teamReviewHistory = [structuredClone(previous), ...(matter.teamReviewHistory ?? [])];
      matter.teamReview = { id: uid(), revision: matter.revision, submittedBy: user.username, reviewer, status: 'submitted', submittedAt: now() };
      audit(user, scope, 'chronology submitted', matter.teamReview.id);
      return;
    }
    assert(scope, 'review');
    if (input.action === 'approve' && previous?.status === 'approved' && previous.id === input.id &&
        previous.revision === matter.revision && previous.reviewer === user.username) return;
    if (!previous || previous.id !== input.id || previous.status !== 'submitted' || previous.revision !== matter.revision) {
      fail(409, 'This submission changed or is no longer ready for review.');
    }
    if (user.username !== previous.reviewer || user.username === previous.submittedBy) {
      fail(403, 'The assigned lawyer who received this submission must review it.');
    }
    if (input.action === 'return') {
      const reason = clean(input.reason, 700);
      if (!reason) fail(422, 'Explain what the preparer should revise.');
      Object.assign(previous, { status: 'returned', reason, reviewedAt: now(), reviewedBy: user.username });
    } else if (input.action === 'approve') {
      const result = approveMatter(matter, user.name, input.attested);
      Object.assign(previous, { status: 'approved', approvalId: result.id, reviewedAt: now(), reviewedBy: user.username });
    } else fail(422, 'Choose a review action.');
    audit(user, scope, 'chronology ' + previous.status, previous.id);
  }

  function staffing(user, scope, target, previous) {
    const args = [...scopeArgs(scope), target.username];
    if (!isActive(target) || target.matterOnly) fail(409, 'The proposed reviewer account is inactive.');
    if (screenCheck.get(...args)) fail(409, 'The proposed reviewer cannot receive this matter.');
    const existing = grant.get(...args);
    if (target.username === previous?.username) {
      if (existing?.revokedAt || existing?.grantedAt !== previous.grant || existing?.access !== 'review') {
        fail(409, 'The reviewer access changed outside this staffing plan.');
      }
      return false;
    }
    if (activeGrant(existing)) fail(409, 'The proposed reviewer already has an independently managed grant.');
    if (previous) {
      const oldArgs = [...scopeArgs(scope), previous.username];
      const old = grant.get(...oldArgs);
      if (old && !old.revokedAt) {
        if (old.grantedAt !== previous.grant || old.access !== 'review') fail(409, 'The prior grant changed outside this staffing plan.');
        revoke.run(now(), ...oldArgs);
      }
    }
    upsert.run(...args, 'review', now(), null);
    audit(user, scope, 'staffing reviewer assigned', target.username);
    if (previous) audit(user, scope, 'staffing reviewer replaced', previous.username);
    return previous ? returnPending(user, scope, previous.username, 'The staffing reviewer changed. Submit to the new reviewer.') : false;
  }

  return { access, assert, audit, list, member, practiceAction, review, staffing,
    screened: (firm, owner, matter, username) => Boolean(screenCheck.get(firm, owner, matter, username)),
    staffingGrant: (scope, username) => grant.get(...scopeArgs(scope), username)?.grantedAt,
    shared: user => available.all(user.firm, user.username, now())
    .map(row => decode(user, row, row.access === 'review' && isLawyer(user) ? 'review' : 'prepare')) };
}
