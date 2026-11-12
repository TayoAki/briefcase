import { createHash, randomUUID } from 'node:crypto';
import { createMatter } from '../dist/model.mjs';
import { practice } from '../dist/practice.mjs';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const normalized = name => name.normalize('NFKC').toLowerCase().replace(/[\p{P}\p{Z}]+/gu, ' ').trim();
const stamp = () => new Date().toISOString();

export function createRiskIntake({ db, accounts, team, HttpError, transact, records, diligenceEvidence }) {
  const { byKind, find, store, current, recordFor, value, requireRole, inScope, person, matterFor } = records;
  const matterRead = db.prepare('SELECT state FROM matters WHERE firm=? AND owner=? AND id=?');
  const matterInsert = db.prepare('INSERT INTO matters(firm,owner,id,state) VALUES (?,?,?,?)');
  const auditRead = db.prepare('SELECT id,actor,action,target,at FROM matter_audit WHERE firm=? AND owner=? AND matter=? AND at>=? AND at<=? ORDER BY id LIMIT 251');
  const fail = (status, message) => { throw new HttpError(status, message); };
  const insert = (user, kind, data, event) => store(user, kind, randomUUID(), null, data, event);
  const role = (user, name) => user.desk.includes(name);
  function pick(user, username, name) {
    const account = person(user, username);
    requireRole(account, name);
    return account;
  }
  function time(input, title) {
    const raw = value(input, title, 24);
    const date = new Date(raw);
    if (!Number.isFinite(date.valueOf()) || raw !== date.toISOString()) fail(422, 'Choose a valid ' + title + '.');
    return raw;
  }
  function within(user, row) {
    return inScope(user, row.office, row.practiceGroup);
  }
  function source(user, owner, id) {
    const account = accounts.get(owner);
    if (!account || account.firm !== user.firm || !inScope(user, account.office, account.practiceGroup) ||
        team.screened(user.firm, owner, id, user.username)) return null;
    const row = matterRead.get(user.firm, owner, id);
    return row && JSON.parse(row.state);
  }

  function incident(user, input) {
    if (input.action === 'incident-open') {
      const scope = matterFor(user, input.matterId, 'owner');
      const counsel = pick(user, input.counsel, 'R10');
      const investigator = person(user, input.investigator);
      if (counsel.role !== 'lawyer' || counsel.username === investigator.username ||
          !source(counsel, user.username, scope.matter.id) || !source(investigator, user.username, scope.matter.id)) {
        fail(422, 'Choose an eligible counsel and a different investigator.');
      }
      const from = time(input.from, 'window start');
      const to = time(input.to, 'window end');
      if (Date.parse(to) < Date.parse(from) || Date.parse(to) - Date.parse(from) > 31 * 86_400_000) {
        fail(422, 'Choose an incident window of up to 31 days.');
      }
      const entries = auditRead.all(user.firm, user.username, scope.matter.id, from, to);
      if (entries.length > 250) fail(422, 'Narrow the window to 250 or fewer audit events.');
      const evidence = entries.map(event => ({ ...event }));
      return insert(user, 'risk-incident', { owner: user.username, matterId: scope.matter.id, counsel: counsel.username,
        investigator: investigator.username, summary: value(input.summary, 'Incident summary', 1200),
        assignment: value(input.assignment, 'Minimum investigator instructions', 1200),
        evidence, evidenceSha256: digest(evidence), from, to, status: 'open' }, 'incident opened and audit preserved');
    }
    const row = recordFor(user, 'risk-incident', input.id);
    if (!incidentVisible(user, row)) fail(404, 'That incident is unavailable.');
    current(input, row);
    if (input.action === 'incident-findings' && row.status === 'open' && row.investigator === user.username) {
      return store(user, 'risk-incident', row.id, row, { status: 'reported',
        findings: value(input.findings, 'Assigned investigation findings', 3000) }, 'investigator submitted findings');
    }
    requireRole(user, 'R10');
    if (input.action !== 'incident-resolve' || row.status !== 'reported' || row.counsel !== user.username) fail(403, 'Only the assigned counsel may resolve reported findings.');
    return store(user, 'risk-incident', row.id, row, { status: 'resolved',
      decision: value(input.decision, 'Counsel disposition and evidence references', 3000) }, 'incident disposition recorded');
  }
  function incidentVisible(user, row) {
    return (row.owner === user.username || (row.counsel === user.username && role(user, 'R10')) ||
      row.investigator === user.username) && Boolean(source(user, row.owner, row.matterId));
  }
  function incidentProjection(user, row) {
    if (row.owner === user.username || row.counsel === user.username) return row;
    const { id, assignment, revision, status, findings, investigator } = row;
    return { id, assignment, revision, status, findings, investigator };
  }

  function callback(user, input) {
    if (input.action === 'callback-route') {
      const scope = matterFor(user, input.matterId, 'owner');
      const code = value(input.code, 'Callback code', 80);
      const id = digest(code.toLowerCase());
      const prior = find(user, 'callback-route', id);
      if (prior) fail(409, 'That callback code is unavailable.');
      return store(user, 'callback-route', id, null, { owner: user.username, matterId: scope.matter.id,
        office: scope.office, practiceGroup: scope.practiceGroup }, 'private callback route created');
    }
    if (input.action === 'callback-new') {
      requireRole(user, 'R12');
      const code = value(input.code, 'Callback code', 80);
      const route = find(user, 'callback-route', digest(code.toLowerCase()));
      if (!route || !source(user, route.owner, route.matterId)) fail(404, 'That callback route is unavailable.');
      return insert(user, 'callback', { sender: user.username, owner: route.owner, matterId: route.matterId,
        caller: value(input.caller, 'Callback name'), number: value(input.number, 'Callback contact', 120),
        note: value(input.note, 'Callback message', 1200), status: 'routed' }, 'private callback routed');
    }
    const row = recordFor(user, 'callback', input.id);
    if (row.owner !== user.username || !source(user, row.owner, row.matterId)) fail(404, 'That callback is unavailable.');
    current(input, row);
    if (row.status !== 'routed') fail(409, 'This callback was already acknowledged.');
    return store(user, 'callback', row.id, row, { status: 'acknowledged' }, 'attorney acknowledged callback');
  }
  function intakeVisible(user, row) {
    return within(user, row) && (row.createdBy === user.username || row.assignee === user.username ||
      row.counsel === user.username || row.advisor === user.username || row.opener === user.username || row.analyst === user.username ||
      (role(user, 'R13') && row.status === 'new'));
  }
  function peopleNames(input) {
    if (!Array.isArray(input) || input.length < 1 || input.length > 30) fail(422, 'Enter one to 30 party names.');
    return [...new Set(input.map(name => value(name, 'Party name', 150)))];
  }
  function inquiry(user, input) {
    if (input.action === 'inquiry-new') {
      if (!role(user, 'R12')) requireRole(user, 'R13');
      const reference = value(input.reference, 'Inquiry duplicate reference', 120);
      const id = digest([user.office, user.practiceGroup, normalized(reference)]);
      const event = { via: value(input.channel, 'Intake channel', 100), contact: value(input.contact, 'Contact name'),
        notes: value(input.notes, 'Initial inquiry', 1400), by: user.username, at: stamp() };
      const prior = find(user, 'inquiry', id);
      if ((prior && !['new', 'assigned'].includes(prior.status)) || (prior?.submissions.length ?? 0) >= 25) fail(409, 'An intake worker must review this inquiry.');
      const row = store(user, 'inquiry', id, prior, prior ? { submissions: [...prior.submissions, event] } :
        { office: user.office, practiceGroup: user.practiceGroup, createdBy: user.username, status: 'new', submissions: [event] },
      prior ? 'duplicate inquiry merged with provenance' : 'inquiry received');
      return { id: row.id, status: row.status, submissions: row.submissions.length };
    }
    const row = recordFor(user, 'inquiry', input.id);
    if (!intakeVisible(user, row)) fail(404, 'That inquiry is unavailable.');
    current(input, row);
    if (input.action === 'inquiry-assign') {
      requireRole(user, 'R13');
      if (row.status !== 'new') fail(409, 'The inquiry was already assigned.');
      const assignee = pick(user, input.assignee, 'R13');
      const counsel = pick(user, input.counsel, 'R15');
      const analyst = pick(user, input.analyst, 'R14');
      const opener = pick(user, input.opener, 'R16');
      if (counsel.role !== 'lawyer' || ![assignee, counsel, analyst, opener].every(account => within(account, row))) {
        fail(422, 'Assign the inquiry within the authorized office and practice.');
      }
      return store(user, 'inquiry', row.id, row, { assignee: assignee.username, counsel: counsel.username,
        analyst: analyst.username, opener: opener.username, parties: peopleNames(input.parties),
        urgency: input.urgency === 'urgent' ? 'urgent' : 'routine', reviewAt: time(input.reviewAt, 'lawyer review time'),
        status: 'assigned' }, 'inquiry assigned for lawyer review');
    }
    if (input.action === 'inquiry-submit') {
      requireRole(user, 'R13');
      if (row.assignee !== user.username || row.status !== 'assigned') fail(403, 'The assigned intake worker must submit triage.');
      return store(user, 'inquiry', row.id, row, { status: 'triaged', eligibility: value(input.eligibility, 'Eligibility review notes', 1200) },
        'triage submitted to analyst and counsel');
    }
    fail(422, 'Choose an inquiry action.');
  }

  function entity(user, input) {
    const scope = matterFor(user, input.matterId, 'owner');
    if (input.attested !== true) fail(422, 'Approve minimal party names for conflict screening.');
    const optional = names => Array.isArray(names) && names.length === 0 ? [] : peopleNames(names);
    return insert(user, 'conflict-entity', { owner: user.username, matterId: scope.matter.id,
      name: value(input.name, 'Entity name'), aliases: optional(input.aliases), related: optional(input.related) },
    'minimal conflict names approved');
  }
  function scan(user, row) {
    const terms = new Set(row.parties.map(normalized));
    return byKind(user, 'conflict-entity').flatMap(entry => {
      if (!source(user, entry.owner, entry.matterId)) return [];
      const reasons = [
        [entry.name, 'Exact name'], ...entry.aliases.map(name => [name, 'Former name or alias']),
        ...entry.related.map(name => [name, 'Parent, subsidiary or related party']),
      ].filter(([name]) => terms.has(normalized(name))).map(([name, reason]) => ({ name, reason }));
      return reasons.length ? [{ id: entry.id, label: entry.name, reasons }] : [];
    });
  }
  function scanForCounsel(user, row) {
    const counsel = accounts.get(row.counsel);
    const analyst = accounts.get(row.analyst);
    if (!counsel || !analyst || !within(counsel, row) || !within(analyst, row)) fail(409, 'Reassign unavailable conflict reviewers.');
    return { analyst: scan(analyst, row), counsel: scan(counsel, row) };
  }
  function conflict(user, input) {
    const row = recordFor(user, 'inquiry', input.id);
    if (!intakeVisible(user, row)) fail(404, 'That inquiry is unavailable.');
    current(input, row);
    if (input.action === 'conflict-submit') {
      requireRole(user, 'R14');
      if (row.analyst !== user.username || !['triaged', 'conflicts', 'held', 'opening'].includes(row.status)) fail(403, 'The assigned analyst must review this inquiry.');
      const results = scanForCounsel(user, row);
      if (input.scanHash !== digest(results.analyst)) fail(409, 'The conflict candidates changed. Review again.');
      return store(user, 'inquiry', row.id, row, { status: 'conflicts', scanHash: digest(results.counsel) }, 'conflict candidates submitted');
    }
    if (input.action === 'waiver-assign') {
      requireRole(user, 'R15');
      if (row.counsel !== user.username || !['conflicts', 'held'].includes(row.status)) fail(404, 'That inquiry is unavailable.');
      const advisor = pick(user, input.advisor, 'R11');
      if (!within(advisor, row)) fail(404, 'That advisor is unavailable.');
      return store(user, 'inquiry', row.id, row, { advisor: advisor.username, waiver: null, waiverBrief: value(input.notes, 'Minimum waiver context', 1200) }, 'waiver review assigned');
    }
    if (input.action === 'waiver-record') {
      requireRole(user, 'R11');
      const reviewer = accounts.get(row.counsel);
      if (!reviewer || row.advisor !== user.username || !within(user, row) || !['conflicts', 'held'].includes(row.status)) {
        fail(409, 'The inquiry is unavailable for waiver review.');
      }
      return store(user, 'inquiry', row.id, row, { waiver: { reference: value(input.reference, 'Waiver evidence reference'),
        conditions: value(input.notes, 'Waiver or screen advice', 1500), by: user.username } }, 'waiver advice recorded');
    }
    requireRole(user, 'R15');
    if (row.counsel !== user.username || !['conflicts', 'held'].includes(row.status) || input.attested !== true) {
      fail(403, 'The assigned lawyer must attest to this conflict review.');
    }
    if (digest(scanForCounsel(user, row).counsel) !== row.scanHash) fail(409, 'The conflict candidates changed. Return to the analyst.');
    if (!['clear', 'hold'].includes(input.disposition)) fail(422, 'Choose clear or hold.');
    const screened = input.screened ?? [];
    if (!Array.isArray(screened) || screened.length > 30 || new Set(screened).size !== screened.length ||
        screened.some(name => !accounts.has(name) || accounts.get(name).firm !== user.firm || name === user.username)) {
      fail(422, 'Choose valid firm accounts to screen.');
    }
    if (input.requiresWaiver === true && input.disposition === 'clear' && !row.waiver) fail(409, 'Record waiver advice and evidence before clearance.');
    const diligence = find(user, 'diligence', row.id);
    if (input.disposition === 'clear' && ((input.requiresDiligence === true && !diligence) || (diligence && effectiveDiligence(user, row, diligence) !== 'verified'))) {
      fail(409, 'Resolve due diligence before clearance.');
    }
    return store(user, 'inquiry', row.id, row, { status: input.disposition === 'clear' ? 'cleared' : 'held',
      decision: { by: user.username, notes: value(input.notes, 'Conflict disposition and conditions', 1500),
        screened, requiresDiligence: input.requiresDiligence === true, requiresWaiver: input.requiresWaiver === true } },
    'conflict ' + input.disposition + ' recorded');
  }

  function linkedEvidence(user, inquiry, row, workItemId = row.workItemId) {
    if (typeof diligenceEvidence !== 'function') fail(409, 'Signed verification evidence is not configured.');
    return diligenceEvidence(user, { workItemId, inquiryId: inquiry.id, requestReference: row.reference,
      assignee: row.reviewer, counsel: inquiry.counsel });
  }
  function effectiveDiligence(user, inquiry, row = find(user, 'diligence', inquiry.id)) {
    if (!row) return null;
    if (!row.workItemId) return row.status;
    try {
      const evidence = linkedEvidence(user, inquiry, row);
      return evidence.status === 'clear' ? 'verified' : evidence.status === 'pending' ? 'pending' : 'escalated';
    } catch (error) {
      if (![401, 403, 404, 409, 422].includes(error.status)) throw error;
      return 'escalated';
    }
  }
  function assertOpeningDiligence(user, inquiry) {
    const row = find(user, 'diligence', inquiry.id);
    if ((inquiry.decision?.requiresDiligence || row) && effectiveDiligence(user, inquiry, row) !== 'verified') {
      fail(409, 'Current due diligence clearance is required to open or finalize this matter.');
    }
  }

  function diligence(user, input) {
    const inquiry = recordFor(user, 'inquiry', input.id);
    if (input.action === 'diligence-assign') {
      if (inquiry.counsel !== user.username || !role(user, 'R15') || !intakeVisible(user, inquiry)) fail(404, 'That inquiry is unavailable.');
      if (!['assigned', 'triaged', 'conflicts', 'held'].includes(inquiry.status)) fail(409, 'Assign diligence before clearance.');
      const reviewer = pick(user, input.reviewer, 'R17');
      if (!within(reviewer, inquiry)) fail(404, 'That reviewer is unavailable.');
      if (find(user, 'diligence', inquiry.id)) fail(409, 'A diligence assignment already exists.');
      return store(user, 'diligence', inquiry.id, null, { reviewer: reviewer.username, counsel: user.username, status: 'pending', mode: 'unverified',
        reference: value(input.reference, 'Restricted verification package reference') }, 'verification assigned');
    }
    const row = recordFor(user, 'diligence', inquiry.id);
    if (row.reviewer !== user.username || !role(user, 'R17') || !within(user, inquiry)) fail(404, 'That verification is unavailable.');
    current(input, row);
    if (input.action === 'diligence-link') {
      const workItemId = value(input.workItemId, 'Signed verification work item ID', 100);
      const evidence = linkedEvidence(user, inquiry, row, workItemId);
      const status = evidence.status === 'clear' ? 'verified' : evidence.status === 'pending' ? 'pending' : 'escalated';
      return store(user, 'diligence', row.id, row, { workItemId, mode: 'signed-provider', status,
        receipt: evidence.sha256 ?? null }, 'signed provider verification linked');
    }
    if (row.workItemId) fail(409, 'Update the linked signed provider workflow; manual status cannot replace it.');
    if (row.status === 'verified') fail(409, 'This verification is complete.');
    const result = input.result;
    if (!['verified', 'escalated'].includes(result)) fail(422, 'Choose verified or escalated.');
    return store(user, 'diligence', row.id, row, { status: result, mode: 'manual-reference',
      receipt: value(input.receipt, 'External verifier receipt'), notes: value(input.notes, 'Restricted verification notes', 1500) },
    result === 'verified' ? 'external verification recorded' : 'identity exception escalated');
  }

  function opening(user, input) {
    requireRole(user, 'R16');
    const row = recordFor(user, 'inquiry', input.id);
    if (row.opener !== user.username || !intakeVisible(user, row)) fail(404, 'That inquiry is unavailable.');
    assertOpeningDiligence(user, row);
    if (row.status === 'opened' && input.action === 'opening-finalize') return { id: row.id, status: row.status, billing: row.billing };
    if (row.status === 'opening' && input.action === 'opening-start') return { id: row.id, status: row.status };
    current(input, row);
    const counsel = accounts.get(row.counsel);
    if (!counsel || counsel.role !== 'lawyer' || !role(counsel, 'R15') || counsel.firm !== user.firm ||
        !within(counsel, row)) fail(409, 'The assigned lawyer is unavailable.');
    if (input.action === 'opening-start') {
      if (row.status !== 'cleared' || digest(scanForCounsel(user, row).counsel) !== row.scanHash) {
        fail(409, 'Current conflict clearance is required to start opening.');
      }
      let matter;
      const billingContact = row.billingContact ?? value(input.billingContact, 'Billing contact', 180);
      if (row.matterId) {
        matter = source(counsel, counsel.username, row.matterId);
        if (!matter) fail(409, 'The original prospective workspace is unavailable.');
      } else {
        matter = createMatter({ name: value(input.name, 'Matter name'), reference: value(input.code, 'Matter code'),
          jurisdiction: value(input.jurisdiction, 'Jurisdiction') });
        matterInsert.run(user.firm, counsel.username, matter.id, JSON.stringify(matter));
      }
      const scope = team.access(counsel, matter.id);
      for (const username of row.decision.screened) team.member(counsel, scope, { action: 'screen', username,
        reason: 'Screen required by the intake disposition.' });
      return store(user, 'inquiry', row.id, row, { status: 'opening', matterId: matter.id, billingContact }, 'prospective workspace opened');
    }
    if (row.status !== 'opening' || digest(scanForCounsel(user, row).counsel) !== row.scanHash) {
      fail(409, 'Current conflict clearance is required to complete opening.');
    }
    const matter = source(counsel, counsel.username, row.matterId);
    const intake = matter && practice(matter).intake;
    if (intake?.status !== 'engaged' || !intake.agreement?.sha256) fail(409, 'The matter lawyer must record the signed engagement.');
    const billing = { id: digest([row.id, 'billing-setup']), matterCode: matter.reference, contact: row.billingContact,
      agreementSha256: intake.agreement.sha256, openedAt: stamp() };
    return store(user, 'inquiry', row.id, row, { status: 'opened', billing }, 'signed engagement and billing setup recorded');
  }
  function view(user) {
    const inquiries = byKind(user, 'inquiry');
    const incidentRows = byKind(user, 'risk-incident').filter(row => incidentVisible(user, row)).map(row => incidentProjection(user, row));
    const diligenceRows = byKind(user, 'diligence').filter(row => {
      const inquiry = inquiries.find(candidate => candidate.id === row.id);
      return inquiry && within(user, inquiry) && ((role(user, 'R17') && row.reviewer === user.username) ||
        (role(user, 'R15') && row.counsel === user.username));
    }).map(row => ({ ...row, status: effectiveDiligence(user, inquiries.find(inquiry => inquiry.id === row.id), row),
      mode: row.mode ?? (row.receipt ? 'manual-reference' : 'unverified') }));
    return {
      username: user.username, roles: user.desk, lawyer: user.role === 'lawyer',
      people: [...accounts.values()].filter(account => account.firm === user.firm &&
        inScope(user, account.office, account.practiceGroup) &&
        (user.role === 'lawyer' || ['R13', 'R15'].some(code => role(user, code)))).map(({ username, desk, role }) => ({ username, desk, role })),
      incidents: incidentRows,
      callbacks: byKind(user, 'callback').flatMap(row => {
        if (!source(user, row.owner, row.matterId)) return [];
        if (row.owner === user.username) return [row];
        if (row.sender !== user.username || !role(user, 'R12')) return [];
        const { id, caller, number, note, status } = row;
        return [{ id, caller, number, note, status }];
      }),
      inquiries: inquiries.filter(row => intakeVisible(user, row)).map(row => {
        if (![row.assignee, row.counsel, row.analyst, row.opener].includes(user.username) && !role(user, 'R13')) {
          return { id: row.id, status: row.status, submissionCount: row.submissions.length };
        }
        const { matterId, decision, waiver, waiverBrief, ...safe } = row;
        const counsel = row.counsel === user.username;
        const analyst = row.analyst === user.username && role(user, 'R14');
        const candidates = (analyst || counsel) && row.parties ? scan(user, row) : null;
        return { ...safe, ...(counsel ? { matterId, decision, waiver } : {
          ...(decision ? { decision: { notes: decision.notes } } : {}),
          ...(waiver ? { waiver: { conditions: waiver.conditions } } : {}),
        }),
          ...(candidates ? { candidates, candidateHash: digest(candidates) } : {}),
          diligenceStatus: effectiveDiligence(user, row), diligenceMode: find(user, 'diligence', row.id)?.mode ?? null };
      }),
      waiverQueue: role(user, 'R11') ? inquiries.filter(row => row.advisor === user.username && within(user, row) && ['conflicts', 'held'].includes(row.status))
        .map(({ id, revision, status, waiver, waiverBrief }) => ({ id, revision, status, waiver, waiverBrief })) : [],
      diligence: diligenceRows,
    };
  }
  const actions = {
    'incident-open': incident, 'incident-findings': incident, 'incident-resolve': incident,
    'callback-route': callback, 'callback-new': callback, 'callback-ack': callback,
    'inquiry-new': inquiry, 'inquiry-assign': inquiry, 'inquiry-submit': inquiry,
    'conflict-entity': entity, 'conflict-submit': conflict, 'waiver-assign': conflict, 'waiver-record': conflict, 'conflict-decision': conflict,
    'diligence-assign': diligence, 'diligence-result': diligence, 'diligence-link': diligence,
    'opening-start': opening, 'opening-finalize': opening,
  };
  return {
    view,
    update(user, input) {
      if (!Object.hasOwn(actions, input.action)) fail(422, 'Choose a risk and intake action.');
      const item = transact(() => actions[input.action](user, input));
      return { id: item.id, status: item.status, revision: item.revision, ...(item.submissions && Number.isInteger(item.submissions) ? { submissionCount: item.submissions } : {}) };
    },
  };
}
