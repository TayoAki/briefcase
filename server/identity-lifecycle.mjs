export function createIdentityLifecycle({ db, accounts, HttpError, records, transact }) {
  const { byKind, find, store, current, person, requireRole, value } = records;
  const statement = db.prepare("SELECT state FROM firm_desk WHERE firm=? AND kind='identity' AND id=?");
  const hasPortal = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='portal_grants'");
  const grants = db.prepare(`SELECT g.owner,g.matter,m.state FROM matter_members g JOIN matters m
    ON m.firm=g.firm AND m.owner=g.owner AND m.id=g.matter WHERE g.firm=? AND g.username=? AND g.revoked_at IS NULL`);
  const revoke = db.prepare('UPDATE matter_members SET revoked_at=? WHERE firm=? AND username=? AND revoked_at IS NULL');
  const persist = db.prepare('UPDATE matters SET state=? WHERE firm=? AND owner=? AND id=?');
  const audit = db.prepare('INSERT INTO matter_audit(firm,owner,matter,actor,action,target,at) VALUES (?,?,?,?,?,?,?)');
  const recent = db.prepare(`SELECT id,actor,action,at,owner FROM matter_audit WHERE firm=? AND at>=?
    AND action IN ('original opened','approved chronology exported','identity access revoked') ORDER BY id DESC LIMIT 1000`);
  const state = user => {
    const row = statement.get(user.firm, user.username);
    return row ? JSON.parse(row.state).status : accounts.get(user.username)?.initiallyDisabled ? 'pending' : 'active';
  };
  const fail = (status, message) => { throw new HttpError(status, message); };
  const canAdmin = user => user.desk.some(role => ['R55', 'R61'].includes(role));

  function update(user, input) {
    if (input.action === 'activate') requireRole(user, 'R55');
    else if (input.action !== 'offboard') fail(422, 'Choose an identity action.');
    else if (!canAdmin(user)) fail(403, 'Identity offboarding requires an authorized role.');
    const account = person(user, input.username);
    if (account.username === user.username) fail(422, 'A different administrator must change your access.');
    const prior = find(user, 'identity', account.username);
    current(input, prior);
    const previous = state(account);
    const reference = value(input.reference, 'External HR or incident reference', 180);
    if (input.action === 'activate') {
      if (previous !== 'pending') fail(409, 'Only a newly provisioned pending account can be activated.');
      return store(user, 'identity', account.username, prior, { status: 'active', reference }, 'account activated');
    }
    if (previous !== 'active') fail(409, 'This account is not active.');
    const at = new Date().toISOString();
    for (const row of grants.all(user.firm, account.username)) {
      const matter = JSON.parse(row.state);
      if (matter.teamReview?.status === 'submitted' && matter.teamReview.reviewer === account.username) {
        Object.assign(matter.teamReview, { status: 'returned', reason: 'The reviewer account was offboarded.',
          reviewedAt: at, reviewedBy: user.username });
        persist.run(JSON.stringify(matter), user.firm, row.owner, row.matter);
      }
      audit.run(user.firm, row.owner, row.matter, user.username, 'identity access revoked', account.username, at);
    }
    const revokedMatterGrants = revoke.run(at, user.firm, account.username).changes;
    const revokedPortalGrants = hasPortal.get() ? db.prepare(
      'UPDATE portal_grants SET revoked_at=? WHERE firm=? AND owner=? AND revoked_at IS NULL').run(at, user.firm, account.username).changes : 0;
    return store(user, 'identity', account.username, prior, { status: 'offboarded', reference,
      revokedMatterGrants, revokedPortalGrants }, 'account access revoked');
  }
  function view(user) {
    if (!canAdmin(user)) fail(403, 'Identity administration requires an authorized role.');
    const records = new Map(byKind(user, 'identity').map(row => [row.id, row]));
    return [...accounts.values()].filter(account => account.firm === user.firm &&
      user.offices.includes(account.office) && user.practices.includes(account.practiceGroup))
      .map(account => ({ username: account.username, status: state(account), revision: records.get(account.username)?.revision ?? 0,
        history: records.get(account.username)?.history ?? [] }));
  }
  function security(user) {
    if (!user.desk.includes('R61')) return [];
    return recent.all(user.firm, new Date(Date.now() - 7 * 86_400_000).toISOString()).flatMap(event => {
      const owner = accounts.get(event.owner);
      if (!owner || !user.offices.includes(owner.office) || !user.practices.includes(owner.practiceGroup)) return [];
      const { id, actor, action, at } = event;
      return [{ id, actor, action, at }];
    });
  }
  return { view, security, update: (user, input) => transact(() => update(user, input)),
    active: user => accounts.has(user.username) && accounts.get(user.username).firm === user.firm && state(user) === 'active' };
}
