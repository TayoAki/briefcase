import { createHash, randomUUID } from 'node:crypto';
import { createMatter } from '../dist/model.mjs';
import { practice, queueItems } from '../dist/practice.mjs';

export const deskRoles = Array.from({ length: 65 }, (_, index) => 'R' + String(index + 1).padStart(2, '0'));
const sha = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const scopeId = value => typeof value === 'string' && /^[a-z0-9][a-z0-9-]{0,49}$/.test(value);

export function deskAccount({ desk = [], office = 'main', offices = [office], practiceGroup = 'general',
  practices = [practiceGroup] }) {
  if (!Array.isArray(desk) || desk.some(role => !deskRoles.includes(role)) ||
      !scopeId(office) || !scopeId(practiceGroup) || !Array.isArray(offices) || !Array.isArray(practices) ||
      !offices.includes(office) || !practices.includes(practiceGroup) || [...offices, ...practices].some(value => !scopeId(value))) {
    throw new Error('Configure valid firm desk roles, offices, and practice groups.');
  }
  return { desk, office, offices, practiceGroup, practices };
}

export function createFirmDesk({ db, accounts, team, HttpError, transact }) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS firm_desk (
      firm TEXT NOT NULL, kind TEXT NOT NULL, id TEXT NOT NULL, state TEXT NOT NULL,
      PRIMARY KEY(firm,kind,id)
    );
  `);
  const all = db.prepare('SELECT state FROM firm_desk WHERE firm=? AND kind=? ORDER BY id');
  const get = db.prepare('SELECT state FROM firm_desk WHERE firm=? AND kind=? AND id=?');
  const write = db.prepare(`INSERT INTO firm_desk(firm,kind,id,state) VALUES (?,?,?,?)
    ON CONFLICT(firm,kind,id) DO UPDATE SET state=excluded.state`);
  const matterRows = db.prepare('SELECT owner,id,state FROM matters WHERE firm=? ORDER BY id,owner');
  const newMatter = db.prepare('INSERT INTO matters(firm,owner,id,state) VALUES (?,?,?,?)');
  const saveMatter = db.prepare('UPDATE matters SET state=? WHERE firm=? AND owner=? AND id=?');
  const fail = (status, message) => { throw new HttpError(status, message); };
  const stamp = () => new Date().toISOString();
  const byKind = (user, kind) => all.all(user.firm, kind).map(row => JSON.parse(row.state));
  const find = (user, kind, id) => {
    const row = get.get(user.firm, kind, id);
    return row && JSON.parse(row.state);
  };
  function value(input, label, limit = 180) {
    const text = typeof input === 'string' ? input.trim() : '';
    if (!text || text.length > limit) fail(422, label + ' is required and must be at most ' + limit + ' characters.');
    return text;
  }
  function integer(input, label, max = 1_000_000_000_000) {
    if (!Number.isSafeInteger(input) || input < 0 || input > max) fail(422, label + ' must be a whole number from 0 to ' + max + '.');
    return input;
  }
  function iso(input, label, length) {
    const text = value(input, label, length);
    const expanded = length === 7 ? text + '-01T00:00:00.000Z' : length === 10 ? text + 'T00:00:00.000Z' : text;
    const date = new Date(expanded);
    if (text.length !== length || !Number.isFinite(date.valueOf()) || date.toISOString() !== expanded) fail(422, 'Enter a valid ' + label + '.');
    return text;
  }
  const month = input => iso(input, 'month (YYYY-MM)', 7);
  const day = input => iso(input, 'date (YYYY-MM-DD)', 10);
  const time = input => iso(input, 'UTC time', 24);
  function requireRole(user, role) {
    if (!user.desk.includes(role)) fail(403, 'This action requires firm desk role ' + role + '.');
  }
  const inScope = (user, office, group) => user.offices.includes(office) && (!group || user.practices.includes(group));
  function requireScope(user, office, group) {
    if (!inScope(user, office, group)) fail(404, 'That office or practice is unavailable.');
  }
  function person(user, username) {
    const account = accounts.get(username);
    if (!account || account.firm !== user.firm || !inScope(user, account.office, account.practiceGroup)) {
      fail(404, 'That firm account is unavailable.');
    }
    return account;
  }
  function matterFor(user, id, level) {
    const scope = team.access(user, value(id, 'Matter ID', 100));
    if (scope.matter.demo) fail(422, 'Use a firm matter for this workflow.');
    const owner = accounts.get(scope.owner);
    if (!owner) fail(404, 'That matter is unavailable.');
    requireScope(user, owner.office, owner.practiceGroup);
    if (level) team.assert(scope, level);
    return { ...scope, office: owner.office, practiceGroup: owner.practiceGroup };
  }
  function visibleMatters(user) {
    return matterRows.all(user.firm).flatMap(row => {
      try {
        const scope = matterFor(user, row.id);
        return scope.owner === row.owner ? [scope] : [];
      } catch (error) {
        if ([404, 422].includes(error.status)) return [];
        throw error;
      }
    });
  }
  function store(user, kind, id, prior, data, action, note) {
    const entry = { ...prior, ...data, id, revision: (prior?.revision ?? 0) + 1, updatedAt: stamp() };
    entry.history = [...(prior?.history ?? []), { revision: entry.revision, by: user.username, action, at: entry.updatedAt,
      ...(note ? { note } : {}) }];
    write.run(user.firm, kind, id, JSON.stringify(entry));
    return entry;
  }
  function current(input, record) {
    if (input.revision !== (record?.revision ?? 0)) fail(409, 'This record changed. Refresh and review it before continuing.');
  }
  function recordFor(user, kind, id) {
    const record = find(user, kind, value(id, 'Record ID', 180));
    if (!record) fail(404, 'That record is unavailable.');
    return record;
  }

  function capacity(user, period) {
    const roster = [...accounts.values()].filter(account => account.firm === user.firm &&
      inScope(user, account.office, account.practiceGroup) && account.role === 'lawyer');
    const plans = new Map(byKind(user, 'capacity').filter(row => row.period === period).map(row => [row.username, row]));
    const visible = new Set(visibleMatters(user).map(scope => scope.matter.id));
    const loads = byKind(user, 'staffing').filter(row => row.period === period && visible.has(row.matterId));
    return roster.map(({ username, office, practiceGroup }) => {
      const plan = plans.get(username);
      const assigned = loads.filter(row => row.username === username).reduce((sum, row) => sum + row.hours, 0);
      return { username, office, practiceGroup, available: plan?.hours ?? null, assigned,
        gap: plan ? Math.max(0, assigned - plan.hours) : null, revision: plan?.revision ?? 0 };
    });
  }
  function partnerPack(user, period) {
    const ledgers = byKind(user, 'ledger').filter(row => row.period === period);
    const asOf = stamp().slice(0, 10);
    const nextMonth = new Date(period + '-01T00:00:00.000Z');
    nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1);
    const cutoff = period < asOf.slice(0, 7) ? nextMonth.toISOString().slice(0, 10) :
      period === asOf.slice(0, 7) ? asOf : null;
    const rows = visibleMatters(user).filter(scope => scope.level !== 'prepare').map(scope => {
      const ledger = ledgers.find(row => row.matterId === scope.matter.id);
      const overdue = cutoff ? queueItems(scope.matter).filter(task => task.due && task.due < cutoff).length : 0;
      return { matterId: scope.matter.id, name: scope.matter.name, office: scope.office,
        ledger: ledger ? { budget: ledger.budget, revenue: ledger.revenue, reference: ledger.reference, revision: ledger.revision } : null,
        overdue };
    });
    const staffing = capacity(user, period);
    const offices = user.offices.map(office => {
      const source = rows.filter(row => row.office === office);
      const budget = source.reduce((sum, row) => sum + (row.ledger?.budget ?? 0), 0);
      const revenue = source.reduce((sum, row) => sum + (row.ledger?.revenue ?? 0), 0);
      return { office, budget, revenue, variance: revenue - budget, sourceCount: source.length,
        missingLedger: source.filter(row => !row.ledger).length,
        overdue: source.reduce((sum, row) => sum + row.overdue, 0),
        capacityGapHours: staffing.filter(row => row.office === office).reduce((sum, row) => sum + (row.gap ?? 0), 0) };
    });
    return { period, asOf, currency: 'USD', offices, rows };
  }

  function serviceVisible(user, row) {
    return ((user.desk.includes('R06') || (user.desk.includes('R64') && ['room', 'mail', 'facilities'].includes(row.type))) && inScope(user, row.office)) ||
      (row.delegate === user.username && row.status !== 'canceled' && Date.parse(row.accessUntil) > Date.now());
  }

  function view(user, period) {
    const roles = user.desk;
    const matters = visibleMatters(user);
    const ids = new Set(matters.map(scope => scope.matter.id));
    const reviewIds = new Set(matters.filter(scope => scope.level !== 'prepare').map(scope => scope.matter.id));
    const data = { roles, period, username: user.username, office: user.office, offices: user.offices,
      matters: matters.map(scope => ({ id: scope.matter.id, name: scope.matter.name, office: scope.office,
        access: scope.level, intake: practice(scope.matter).intake.status })),
      people: [...accounts.values()].filter(account => account.firm === user.firm &&
        inScope(user, account.office, account.practiceGroup) && (roles.length || account.desk.includes('R04')))
        .map(({ username, office, role, desk }) => ({ username, office, role, managesStaffing: desk.includes('R04') })),
      services: byKind(user, 'service').filter(row => serviceVisible(user, row)),
    };
    if (roles.includes('R01')) {
      data.pack = partnerPack(user, period);
      data.decisions = byKind(user, 'decision').filter(row => row.by === user.username && row.period === period &&
        row.offices.every(office => inScope(user, office.office)));
    }
    if (roles.includes('R02') || roles.includes('R01')) {
      data.referrals = byKind(user, 'referral').filter(row => row.partner === user.username ||
        (roles.includes('R01') && row.matterId && reviewIds.has(row.matterId)))
        .filter(row => !row.matterId || ids.has(row.matterId));
    }
    if (roles.includes('R02')) {
      const credits = data.referrals.filter(row => row.creditedTo === user.username &&
        row.updatedAt.slice(0, 7) === period);
      data.portfolio = { approvedReferrals: credits.length, fees: credits.reduce((sum, row) => sum + row.approvedFee, 0),
        commitments: credits.reduce((sum, row) => sum + row.approvedCommitment, 0) };
    }
    data.myStaffing = byKind(user, 'staffing').filter(row => row.username === user.username && ids.has(row.matterId))
      .map(({ matterId, hours, period }) => ({ matterId, hours, period }));
    const ownedIds = new Set(matters.filter(scope => scope.level === 'owner').map(scope => scope.matter.id));
    data.delegations = byKind(user, 'delegation').filter(row => ownedIds.has(row.matterId) ||
      (roles.includes('R04') && reviewIds.has(row.matterId)));
    if (roles.includes('R04')) {
      data.capacity = capacity(user, period);
      data.staffing = byKind(user, 'staffing').filter(row => reviewIds.has(row.matterId));
    }
    if (roles.includes('R05')) {
      const imports = byKind(user, 'import').filter(row => ids.has(row.matterId) &&
        (row.status !== 'complete' || row.startedAt.slice(0, 7) === period));
      const late = record => record.status === 'open' && record.due < stamp().slice(0, 10);
      data.intake = byKind(user, 'intake').filter(row => ids.has(row.matterId) &&
        (row.status === 'open' || row.startedAt.slice(0, 7) === period)).map(row => ({ ...row,
        late: late(row), durationMs: Date.parse(row.finishedAt ?? stamp()) - Date.parse(row.startedAt) }));
      data.imports = imports.map(row => ({ ...row, durationMs: Date.parse(row.finishedAt ?? stamp()) - Date.parse(row.startedAt),
        stalled: row.status === 'running' && Date.now() - Date.parse(row.startedAt) >= 15 * 60_000 }));
      data.training = byKind(user, 'training').filter(row => inScope(user, row.office));
    }
    if (roles.includes('R57')) data.training = byKind(user, 'training').filter(row => inScope(user, row.office));
    if (roles.some(role => ['R01', 'R04', 'R05'].includes(role))) {
      const rows = byKind(user, 'training').filter(row => row.due.slice(0, 7) === period);
      data.trainingTotals = user.offices.map(office => {
        const officeRows = rows.filter(row => row.office === office);
        return { office, assigned: officeRows.length, completed: officeRows.filter(row => row.status === 'complete').length };
      });
    }
    if (roles.includes('R60')) {
      data.support = byKind(user, 'import').filter(row => {
        const actor = accounts.get(row.owner);
        return actor?.firm === user.firm && inScope(user, actor.office, actor.practiceGroup) &&
          !team.screened(user.firm, row.custodian ?? row.owner, row.matterId, user.username);
      }).map(({ id, status, startedAt, finishedAt, history }) => ({ id, status, startedAt, finishedAt,
        durationMs: Date.parse(finishedAt ?? stamp()) - Date.parse(startedAt),
        triage: find(user, 'support-triage', id) ?? null,
        stalled: status === 'running' && Date.now() - Date.parse(startedAt) >= 15 * 60_000,
        history: history.map(({ action, at }) => ({ action, at })),
      }));
    }
    data.intakeTargets = byKind(user, 'intake').filter(row => ownedIds.has(row.matterId)).map(row => row.matterId);
    data.pricing = byKind(user, 'pricing').filter(row => ids.has(row.matterId) &&
      (row.author === user.username || row.reviewer === user.username) && (row.author === user.username || row.status !== 'draft'));
    data.ledger = byKind(user, 'ledger').filter(row => row.period === period && matters.some(scope =>
      scope.matter.id === row.matterId && (scope.level === 'owner' || (scope.level === 'review' && roles.includes('R01')))));
    return data;
  }

  function ledger(user, input) {
    const scope = matterFor(user, input.matterId, 'owner');
    const period = month(input.period);
    const id = scope.matter.id + ':' + period;
    const prior = find(user, 'ledger', id);
    current(input, prior);
    return store(user, 'ledger', id, prior, { matterId: scope.matter.id, period,
      budget: integer(input.budget, 'Budget cents'), revenue: integer(input.revenue, 'Revenue cents'),
      reference: value(input.reference, 'Ledger source reference') }, 'ledger reconciled');
  }

  function decision(user, input) {
    requireRole(user, 'R01');
    const pack = partnerPack(user, month(input.period));
    if (input.packHash !== sha(pack)) fail(409, 'The pack changed. Reload it before recording the decision.');
    const id = randomUUID();
    return store(user, 'decision', id, null, { by: user.username, period: pack.period, asOf: pack.asOf,
      offices: pack.offices, packHash: input.packHash, decision: value(input.decision, 'Decision', 1200) }, 'partner decision recorded');
  }

  function referral(user, input) {
    const act = input.action;
    if (act === 'referral-new') {
      requireRole(user, 'R02');
      if (user.role !== 'lawyer') fail(403, 'A lawyer account must own a referral.');
      const reference = value(input.reference, 'Referral reference', 90);
      const id = sha(reference.toLowerCase());
      const prior = find(user, 'referral', id);
      if (prior) fail(409, 'That referral reference is already in use.');
      return store(user, 'referral', id, null, { partner: user.username, reference,
        source: value(input.source, 'Referring source'), name: value(input.name, 'Prospective matter name'),
        fee: integer(input.fee, 'Proposed fee cents'), commitment: integer(input.commitment, 'Cost commitment cents'),
        matterId: null, status: 'received' }, 'referral received');
    }
    const row = recordFor(user, 'referral', input.id);
    if (act === 'referral-open') {
      requireRole(user, 'R02');
      if (row.partner !== user.username || user.role !== 'lawyer') fail(404, 'That referral is unavailable.');
      current(input, row);
      if (row.status !== 'received') fail(409, 'This referral already has a matter.');
      const matter = createMatter({ name: row.name, reference: row.reference, jurisdiction: value(input.practice, 'Matter jurisdiction') });
      newMatter.run(user.firm, user.username, matter.id, JSON.stringify(matter));
      startIntake(user, matter.id, day(input.due));
      return store(user, 'referral', row.id, row, { matterId: matter.id, status: 'intake' }, 'prospective matter opened');
    }
    requireRole(user, 'R01');
    if (!row.matterId) fail(404, 'That referral is unavailable.');
    const scope = matterFor(user, row.matterId, 'review');
    current(input, row);
    if (row.status !== 'intake' || practice(scope.matter).intake.status !== 'engaged') {
      fail(409, 'Complete conflicts clearance and engagement before approving referral credit.');
    }
    if (row.partner === user.username) fail(403, 'A different reviewing partner must approve the credit.');
    return store(user, 'referral', row.id, row, { status: 'approved', creditedTo: row.partner,
      approvedBy: user.username, approvedFee: row.fee, approvedCommitment: row.commitment,
      engagement: { practiceRevision: practice(scope.matter).revision, ...practice(scope.matter).intake.agreement } },
    'origination credit and commitment approved', value(input.notes, 'Approval rationale', 900));
  }

  function planCapacity(user, input) {
    requireRole(user, 'R04');
    const account = person(user, input.username);
    if (account.role !== 'lawyer') fail(422, 'Choose a lawyer for the staffing plan.');
    const period = month(input.period);
    const id = period + ':' + account.username;
    const prior = find(user, 'capacity', id);
    current(input, prior);
    return store(user, 'capacity', id, prior, { period, username: account.username,
      hours: integer(input.hours, 'Available hours', 744) }, 'capacity recorded');
  }
  function delegateStaffing(user, input) {
    const scope = matterFor(user, input.matterId, 'owner');
    const prior = find(user, 'delegation', scope.matter.id);
    current(input, prior);
    if (input.enabled === false) {
      if (!prior?.manager) fail(409, 'There is no active staffing delegation.');
      return store(user, 'delegation', scope.matter.id, prior, { manager: null }, 'staffing delegation revoked');
    }
    const manager = person(user, input.manager);
    if (!manager.desk.includes('R04') || !inScope(manager, scope.office, scope.practiceGroup)) {
      fail(422, 'Choose a practice leader authorized for this matter.');
    }
    matterFor(manager, scope.matter.id, 'review');
    return store(user, 'delegation', scope.matter.id, prior, { matterId: scope.matter.id,
      manager: manager.username }, 'staffing delegated');
  }
  function staffing(user, input) {
    requireRole(user, 'R04');
    const scope = matterFor(user, input.matterId, 'review');
    if (scope.level !== 'owner' && find(user, 'delegation', scope.matter.id)?.manager !== user.username) {
      fail(403, 'The matter owner must delegate staffing for this matter.');
    }
    const target = person(user, input.username);
    if (target.role !== 'lawyer' || target.username === scope.owner || target.username === user.username ||
        target.practiceGroup !== scope.practiceGroup) fail(422, 'Choose another lawyer in the matter practice group.');
    const period = month(input.period);
    const hours = integer(input.hours, 'Assigned hours', 744);
    if (!hours) fail(422, 'Assign at least one hour.');
    const note = value(input.notes, 'Assignment reason', 900);
    const prior = find(user, 'staffing', scope.matter.id);
    current(input, prior);
    const changed = team.staffing(user, scope, target, prior);
    if (changed) saveMatter.run(JSON.stringify(scope.matter), scope.firm, scope.owner, scope.matter.id);
    return store(user, 'staffing', scope.matter.id, prior, { matterId: scope.matter.id, period, hours,
      username: target.username, grant: team.staffingGrant(scope, target.username) }, 'responsible reviewer assigned', note);
  }

  function startIntake(user, matterId, due) {
    const id = matterId;
    const prior = find(user, 'intake', id);
    if (prior) fail(409, 'An intake target already exists for this matter.');
    const startedAt = stamp();
    return store(user, 'intake', id, null, { matterId, owner: user.username, due, startedAt, status: 'open' }, 'intake target opened');
  }
  function intake(user, input) {
    const scope = matterFor(user, input.matterId, 'owner');
    if (['declined', 'engaged'].includes(practice(scope.matter).intake.status)) fail(409, 'This matter already has an intake disposition.');
    return startIntake(user, scope.matter.id, day(input.due));
  }
  function finishIntake(user, matter) {
    const prior = find(user, 'intake', matter.id);
    const state = practice(matter).intake.status;
    if (prior?.status === 'open' && ['engaged', 'declined'].includes(state)) {
      store(user, 'intake', prior.id, prior, { status: state, finishedAt: stamp() }, 'intake disposition recorded');
    }
  }
  function importStart(user, matterId, custodian) {
    const id = randomUUID();
    store(user, 'import', id, null, { matterId, custodian, owner: user.username, startedAt: stamp(), status: 'running' }, 'PDF import started');
    return id;
  }
  function importEnd(user, id, status, reason) {
    const prior = find(user, 'import', id);
    store(user, 'import', id, prior, { status, finishedAt: stamp() }, status === 'failed' ? 'PDF import failed' : 'PDF import finished', reason);
  }
  function exception(user, input) {
    requireRole(user, 'R05');
    const kind = input.kind;
    if (!['intake', 'import'].includes(kind)) fail(422, 'Choose an intake or import exception.');
    const prior = recordFor(user, kind, input.id);
    matterFor(user, prior.matterId);
    current(input, prior);
    const note = value(input.notes, 'Follow-up or resolution', 900);
    if (kind === 'import' && !['running', 'failed'].includes(prior.status)) fail(409, 'This import has no open exception.');
    if (kind === 'intake' && prior.status !== 'open') fail(409, 'This intake is closed.');
    return store(user, kind, prior.id, prior, { followUp: note, followUpBy: user.username }, 'exception follow-up recorded', note);
  }
  function training(user, input) {
    if (input.action === 'training-assign') {
      if (!user.desk.includes('R57')) requireRole(user, 'R05');
      const account = person(user, input.username);
      return store(user, 'training', randomUUID(), null, { office: account.office, username: account.username,
        title: value(input.title, 'Training title'), due: day(input.due), status: 'assigned' }, 'training assigned');
    }
    const prior = recordFor(user, 'training', input.id);
    if (prior.username !== user.username) fail(404, 'That training assignment is unavailable.');
    current(input, prior);
    if (prior.status !== 'assigned') fail(409, 'That training assignment is complete.');
    return store(user, 'training', prior.id, prior, { status: 'complete', finishedAt: stamp(),
      evidence: value(input.evidence, 'Completion evidence', 900) }, 'training completed');
  }

  function service(user, input) {
    const act = input.action;
    if (act === 'service-new') {
      if (!user.desk.includes('R06')) {
        requireRole(user, 'R64');
        if (!['room', 'mail', 'facilities'].includes(input.type)) fail(403, 'This office service requires R06.');
      }
      const office = value(input.office, 'Office', 50);
      requireScope(user, office);
      const delegate = person(user, input.delegate);
      if (delegate.office !== office || delegate.username === user.username) fail(422, 'Choose a different delegate at this office.');
      const type = input.type;
      if (!['renewal', 'room', 'coverage', 'mail', 'facilities'].includes(type)) fail(422, 'Choose an office service type.');
      const start = time(input.start);
      const end = time(input.end);
      const accessUntil = time(input.accessUntil);
      if (start >= end || accessUntil < end || Date.parse(accessUntil) <= Date.now()) fail(422, 'Check the reservation and delegate access times.');
      const resource = value(input.resource, 'Resource or agreement reference');
      if (['room', 'coverage'].includes(type) && byKind(user, 'service').some(row => row.office === office && row.type === type &&
          (row.resource.toLowerCase() === resource.toLowerCase() || (type === 'coverage' && row.delegate === delegate.username)) &&
          row.status !== 'canceled' && start < row.end && end > row.start)) {
        fail(409, 'That resource or coverage delegate is already reserved for part of this time.');
      }
      return store(user, 'service', randomUUID(), null, { office, delegate: delegate.username, type, start, end,
        accessUntil, resource, title: value(input.title, 'Service title'), status: 'assigned' }, 'office work routed');
    }
    const prior = recordFor(user, 'service', input.id);
    if (!serviceVisible(user, prior)) fail(404, 'That office service item is unavailable.');
    current(input, prior);
    if (['service-verify', 'service-cancel'].includes(act)) {
      if (!user.desk.includes('R06')) {
        requireRole(user, 'R64');
        if (!['room', 'mail', 'facilities'].includes(prior.type)) fail(404, 'That office service item is unavailable.');
      }
      requireScope(user, prior.office);
      if (prior.delegate === user.username) fail(403, 'A different office administrator must check the delegate’s work.');
      if (act === 'service-verify' ? prior.status !== 'submitted' : ['verified', 'canceled'].includes(prior.status)) {
        fail(409, 'This service item cannot take that action.');
      }
      return store(user, 'service', prior.id, prior, { status: act === 'service-verify' ? 'verified' : 'canceled' },
        act === 'service-verify' ? 'office work verified' : 'office work canceled', value(input.notes, 'Reason or verification notes', 900));
    }
    if (prior.delegate !== user.username || Date.parse(prior.accessUntil) <= Date.now()) fail(404, 'That delegated item is unavailable.');
    if (act === 'service-ack' && prior.status === 'assigned') {
      return store(user, 'service', prior.id, prior, { status: 'accepted' }, 'delegate acknowledged');
    }
    if (act === 'service-complete' && prior.status === 'accepted') {
      return store(user, 'service', prior.id, prior, { status: 'submitted', evidence: value(input.evidence, 'Completion evidence', 900) }, 'delegate completed');
    }
    fail(409, 'Acknowledge the current assignment before completing it.');
  }

  function supportTriage(user, input) {
    requireRole(user, 'R60');
    const job = recordFor(user, 'import', input.id);
    const actor = accounts.get(job.owner);
    if (actor?.firm !== user.firm || !inScope(user, actor.office, actor.practiceGroup) ||
        team.screened(user.firm, job.custodian ?? job.owner, job.matterId, user.username)) fail(404, 'That support job is unavailable.');
    if (!['failed', 'running'].includes(job.status)) fail(409, 'This import does not need triage.');
    const prior = find(user, 'support-triage', job.id);
    current(input, prior);
    const outcome = input.outcome;
    if (!['Retry requested', 'Escalated to operations', 'Awaiting user response'].includes(outcome)) {
      fail(422, 'Choose a support disposition.');
    }
    return store(user, 'support-triage', job.id, prior, { outcome }, 'metadata-only triage recorded');
  }

  function priceOption(input) {
    if (!input || !Array.isArray(input.staff) || !input.staff.length || input.staff.length > 25) {
      fail(422, 'Enter one to 25 staffing rows for each option.');
    }
    const staff = input.staff.map(row => {
      if (!row || typeof row !== 'object') fail(422, 'Enter a valid staffing row.');
      const minutes = integer(row.minutes, 'Staff minutes', 600_000);
      const costRate = integer(row.costRate, 'Cost rate per hour (cents)', 10_000_000);
      const billRate = integer(row.billRate, 'Bill rate per hour (cents)', 10_000_000);
      return { label: value(row.label, 'Staffing label'), minutes, costRate, billRate,
        cost: Math.round(minutes * costRate / 60), estimatedBill: Math.round(minutes * billRate / 60) };
    });
    if (!['fixed', 'hourly'].includes(input.type)) fail(422, 'Choose fixed or hourly for each fee.');
    const fee = input.type === 'fixed' ? integer(input.fixedFee, 'Fixed fee cents') :
      staff.reduce((sum, row) => sum + row.estimatedBill, 0);
    const staffing = staff.reduce((sum, row) => sum + row.cost, 0);
    const expenses = integer(input.expenses ?? 0, 'Estimated expense cents');
    return { label: value(input.label, 'Option label'), type: input.type, staff, expenses, fee, staffing, margin: fee - staffing - expenses };
  }
  function pricing(user, input) {
    const action = input.action;
    if (action === 'pricing-save') {
      requireRole(user, 'R47');
      const scope = matterFor(user, input.matterId);
      const reviewer = person(user, input.reviewer);
      if (reviewer.username === user.username || reviewer.role !== 'lawyer') fail(422, 'Choose a different assigned lawyer.');
      matterFor(reviewer, scope.matter.id, 'review');
      if (!Array.isArray(input.options) || input.options.length !== 2) fail(422, 'Enter exactly two fee options.');
      const options = input.options.map(priceOption);
      if (options[0].label === options[1].label) fail(422, 'Give the options distinct labels.');
      const assumptions = value(input.assumptions, 'Rates and staffing assumptions', 1600);
      const prior = input.id ? recordFor(user, 'pricing', input.id) : null;
      if (prior && (prior.author !== user.username || prior.matterId !== scope.matter.id ||
          !['draft', 'returned'].includes(prior.status))) fail(404, 'That pricing draft is unavailable.');
      current(input, prior);
      const snapshot = { options, assumptions };
      const versions = [...(prior?.versions ?? []), { ...snapshot, sha256: sha(snapshot) }];
      if (versions.length > 25) fail(409, 'Start a follow-up pricing draft.');
      return store(user, 'pricing', prior?.id ?? randomUUID(), prior, { matterId: scope.matter.id, author: user.username,
        reviewer: reviewer.username, versions, status: 'draft', selected: null }, 'pricing comparison version saved');
    }
    const row = recordFor(user, 'pricing', input.id);
    if (![row.author, row.reviewer].includes(user.username)) fail(404, 'That pricing comparison is unavailable.');
    current(input, row);
    const version = row.versions.at(-1);
    if (input.sha256 !== version.sha256) fail(409, 'Review the exact current comparison.');
    if (action === 'pricing-submit') {
      requireRole(user, 'R47');
      matterFor(user, row.matterId);
      if (row.author !== user.username || row.status !== 'draft') fail(409, 'Only the author can submit the current draft.');
      return store(user, 'pricing', row.id, row, { status: 'submitted' }, 'pricing comparison submitted');
    }
    matterFor(user, row.matterId, 'review');
    if (row.reviewer !== user.username || row.status !== 'submitted') fail(403, 'The assigned lawyer must review the submitted comparison.');
    const note = value(input.notes, 'Review rationale', 900);
    if (action === 'pricing-return') return store(user, 'pricing', row.id, row, { status: 'returned' }, 'comparison returned', note);
    if (input.attested !== true || ![0, 1].includes(input.option)) fail(422, 'Confirm review and select one of the two options.');
    return store(user, 'pricing', row.id, row, { status: 'approved',
      selected: { index: input.option, sha256: version.sha256, by: user.username, at: stamp() } }, 'pricing option approved', note);
  }

  const actions = {
    'ledger-save': ledger, 'decision-save': decision,
    'referral-new': referral, 'referral-open': referral, 'referral-approve': referral,
    'capacity-save': planCapacity, 'staffing-delegate': delegateStaffing, 'staffing-save': staffing,
    'pricing-save': pricing, 'pricing-submit': pricing, 'pricing-return': pricing, 'pricing-approve': pricing,
    'intake-start': intake, 'exception-note': exception, 'support-triage': supportTriage, 'training-assign': training, 'training-complete': training,
    'service-new': service, 'service-ack': service, 'service-complete': service, 'service-verify': service, 'service-cancel': service,
  };
  return {
    view(user, period) {
      const result = view(user, month(period ?? stamp().slice(0, 7)));
      result.myTraining = byKind(user, 'training').filter(row => row.username === user.username);
      if (result.pack) result.packHash = sha(result.pack);
      return result;
    },
    export(user, role, period) {
      requireRole(user, role);
      const data = view(user, month(period ?? stamp().slice(0, 7)));
      if (role === 'R01') return { ...data.pack, sha256: sha(data.pack) };
      if (role === 'R02') return { period: data.period, totals: data.portfolio, referrals: data.referrals,
        ledger: data.ledger };
      if (role === 'R04') return { period: data.period, capacity: data.capacity, staffing: data.staffing.map(({ grant, ...row }) => row) };
      if (role === 'R05') return { period: data.period, intake: data.intake, imports: data.imports, training: data.training };
      if (role === 'R06') return { period: data.period, services: data.services };
      fail(404, 'That report is unavailable.');
    },
    priceProof(user, id) {
      const row = recordFor(user, 'pricing', id);
      if (![row.author, row.reviewer].includes(user.username)) fail(404, 'That pricing comparison is unavailable.');
      matterFor(user, row.matterId);
      if (row.status !== 'approved') fail(409, 'Approve the comparison before export.');
      return row;
    },
    proof(user, id) {
      requireRole(user, 'R01');
      const row = recordFor(user, 'decision', id);
      if (row.by !== user.username || !row.offices.every(office => inScope(user, office.office))) {
        fail(404, 'That decision is unavailable.');
      }
      return row;
    },
    update(user, input) {
      if (!Object.hasOwn(actions, input.action)) fail(422, 'Choose a firm desk action.');
      return transact(() => actions[input.action](user, input));
    },
    clientRecords: { byKind, find, store, current, recordFor, value, requireRole, inScope, person, matterFor },
    finishIntake, importStart, importEnd,
  };
}
