import { createHash, randomUUID } from 'node:crypto';
import { practice } from '../dist/practice.mjs';

const areas = ['Personal injury', 'Commercial disputes', 'Employment', 'Corporate', 'Real estate', 'Other'];
const services = ['Case assessment', 'Document review', 'Negotiation', 'Trial preparation', 'Transaction support'];
const outcomes = ['Resolution reached', 'Work completed', 'Proceedings concluded'];
const channels = ['Website', 'Newsletter', 'Social'];
const pitchStyles = {
  introduction: 'We would welcome a conversation about how we can help.',
  followup: 'Thank you for speaking with us. Here is relevant experience for your consideration.',
};
const storyStyles = {
  client: 'A client shares their experience',
  service: 'Client perspective on our service',
};
const hash = data => createHash('sha256').update(JSON.stringify(data)).digest('hex');
const dateNow = () => new Date().toISOString();

export function createClientDevelopment({ db, accounts, team, HttpError, transact, records }) {
  const { byKind, find, store, current, recordFor, value, requireRole, inScope, person, matterFor } = records;
  const matterGet = db.prepare('SELECT state FROM matters WHERE firm=? AND owner=? AND id=?');
  const fail = (status, message) => { throw new HttpError(status, message); };
  const insert = (user, kind, fields, action) => store(user, kind, randomUUID(), null, fields, action);
  const choose = (input, allowed, label) => {
    if (!allowed.includes(input)) fail(422, 'Choose ' + label + '.');
    return input;
  };
  const own = (user, row) => {
    if (row.owner !== user.username) fail(404, 'That record is unavailable.');
  };
  function matchScope(user, owner) {
    const account = accounts.get(owner);
    return account?.firm === user.firm && inScope(user, account.office, account.practiceGroup);
  }
  function safeMatter(user, owner, id) {
    if (!matchScope(user, owner) || team.screened(user.firm, owner, id, user.username)) return null;
    const row = matterGet.get(user.firm, owner, id);
    return row ? JSON.parse(row.state) : null;
  }
  function checkDistinct(user, username, role) {
    const account = person(user, username);
    if (!account.desk.includes(role)) fail(422, 'Choose an account assigned to ' + role + '.');
    return account;
  }
  function versions(user, kind, row, data, action) {
    const number = (row?.versions.at(-1)?.number ?? 0) + 1;
    if (number > 50) fail(409, 'Create a follow-up record for further versions.');
    const draft = { number, data, sha256: hash(data), by: user.username, at: dateNow() };
    const fields = { author: user.username, status: 'draft', versions: [...(row?.versions ?? []), draft],
      submitted: null, approved: null };
    return row ? store(user, kind, row.id, row, fields, action) : insert(user, kind, fields, action);
  }
  function review(user, kind, row, input, draft, reviewer) {
    current(input, row);
    const action = input.action.split('-').at(-1);
    const version = row.versions.at(-1);
    if (input.version !== version.number) fail(409, 'Review the current version.');
    if (action === 'submit') {
      if (user.username !== row.author) fail(403, 'The author must submit this version.');
      if (row.status !== 'draft') fail(409, 'Only a current draft can be submitted.');
      return store(user, kind, row.id, row, { status: 'submitted', submitted: { number: version.number,
        sha256: version.sha256, at: dateNow() } }, 'version submitted');
    }
    if (user.username !== reviewer || reviewer === row.author) fail(403, 'The assigned independent reviewer must review this version.');
    if (row.status !== 'submitted' || row.submitted?.sha256 !== version.sha256) fail(409, 'This version is not pending review.');
    const notes = value(input.notes, 'Review notes', 800);
    if (action === 'return') return store(user, kind, row.id, row, { status: 'returned' }, 'version returned', notes);
    if (input.attested !== true) fail(422, 'Confirm review of the current version and permitted material.');
    const approved = { number: version.number, by: user.username, at: dateNow(), sha256: version.sha256,
      artifactSha256: hash(draft) };
    return store(user, kind, row.id, row, { status: 'approved', approved }, 'version approved', notes);
  }

  function experiencePublic(user, row) {
    if (!row || !row.active) return null;
    const matter = safeMatter(user, row.owner, row.matterId);
    const closeout = matter && practice(matter).settlement.closeout;
    if (!closeout || closeout.id !== row.closeoutId) return null;
    return { reference: row.id, area: row.area, service: row.service, outcome: row.outcome };
  }
  function experience(user, input) {
    if (input.action === 'experience-retire') {
      const row = recordFor(user, 'experience', input.id);
      own(user, row);
      current(input, row);
      if (!row.active) fail(409, 'This experience card was already retired.');
      return store(user, 'experience', row.id, row, { active: false }, 'experience approval withdrawn');
    }
    const scope = matterFor(user, input.matterId, 'owner');
    const closed = practice(scope.matter).settlement.closeout;
    if (!closed?.id) fail(422, 'Close the source matter before approving a reusable experience card.');
    if (input.attested !== true) fail(422, 'Confirm that the selected categories may be shared.');
    return insert(user, 'experience', { owner: user.username, matterId: scope.matter.id, closeoutId: closed.id,
      active: true, area: choose(input.area, areas, 'a practice area'), service: choose(input.service, services, 'a service'),
      outcome: choose(input.outcome, outcomes, 'an outcome') }, 'anonymized experience approved');
  }
  function briefAvailable(user, brief) {
    if (!brief || brief.revokedAt || (user.username !== brief.owner && user.username !== brief.manager) || !matchScope(user, brief.owner)) return false;
    const referral = find(user, 'referral', brief.referralId);
    return Boolean(referral && referral.partner === brief.owner &&
      (!referral.matterId || safeMatter(user, referral.partner, referral.matterId)));
  }
  function shareReferral(user, input) {
    const referral = recordFor(user, 'referral', input.referralId);
    if (referral.partner !== user.username || user.role !== 'lawyer') fail(404, 'That referral is unavailable.');
    if (referral.matterId) matterFor(user, referral.matterId, 'owner');
    const manager = checkDistinct(user, input.manager, 'R07');
    if (manager.username === user.username || (referral.matterId && !safeMatter(manager, user.username, referral.matterId))) {
      fail(422, 'Choose a different authorized business development manager.');
    }
    const id = hash([referral.id, manager.username]);
    if (find(user, 'brief', id)) fail(409, 'This referral brief is already shared with the manager.');
    return store(user, 'brief', id, null, { owner: user.username, manager: manager.username,
      referralId: referral.id, area: choose(input.area, areas, 'a practice area') }, 'sanitized referral brief shared');
  }
  function revokeBrief(user, input) {
    const row = recordFor(user, 'brief', input.id);
    own(user, row);
    current(input, row);
    if (row.revokedAt) fail(409, 'This referral brief was already withdrawn.');
    return store(user, 'brief', row.id, row, { revokedAt: dateNow() }, 'referral brief withdrawn');
  }
  const publicBrief = row => ({ id: row.id, owner: row.owner, manager: row.manager, area: row.area });
  function pitchArtifact(user, data) {
    const brief = find(user, 'brief', data.brief);
    const author = brief && accounts.get(brief.manager);
    const reviewer = brief && accounts.get(brief.owner);
    if (!briefAvailable(user, brief) || !author || !reviewer || !author.desk.includes('R07') ||
        !briefAvailable(author, brief) || !briefAvailable(reviewer, brief)) fail(409, 'The referral brief is no longer available.');
    const experience = data.cards.map(id => {
      const row = find(user, 'experience', id);
      const card = experiencePublic(user, row);
      if (!card || !experiencePublic(author, row) || !experiencePublic(reviewer, row)) {
        fail(409, 'An experience reference is no longer approved for this pitch.');
      }
      return card;
    });
    return { title: 'Experience overview · ' + brief.area, introduction: pitchStyles[data.style], experience };
  }
  function pitch(user, input) {
    const row = input.id ? recordFor(user, 'pitch', input.id) : null;
    if (row && !pitchParticipant(user, row)) fail(404, 'That pitch is unavailable.');
    if (input.action === 'pitch-save') {
      requireRole(user, 'R07');
      current(input, row);
      if (row && (row.author !== user.username || !['draft', 'returned'].includes(row.status))) fail(409, 'Return the pitch before editing it.');
      const brief = find(user, 'brief', value(input.brief, 'Referral brief', 180));
      if (!briefAvailable(user, brief) || brief.manager !== user.username) fail(404, 'That referral brief is unavailable.');
      if (row && row.versions[0].data.brief !== brief.id) fail(422, 'Create a new pitch for another referral.');
      if (!Array.isArray(input.cards) || input.cards.length < 1 || input.cards.length > 8 ||
          input.cards.some(id => typeof id !== 'string') || new Set(input.cards).size !== input.cards.length) {
        fail(422, 'Choose one to eight distinct approved experience cards.');
      }
      const data = { brief: brief.id, style: choose(input.style, Object.keys(pitchStyles), 'a pitch format'), cards: input.cards };
      pitchArtifact(user, data);
      return versions(user, 'pitch', row, data, 'pitch version saved');
    }
    if (!row) fail(404, 'That pitch is unavailable.');
    if (input.action === 'pitch-submit') requireRole(user, 'R07');
    const data = row.versions.at(-1).data;
    const artifact = pitchArtifact(user, data);
    return review(user, 'pitch', row, input, artifact, find(user, 'brief', data.brief).owner);
  }
  function pitchParticipant(user, row) {
    const brief = find(user, 'brief', row.versions.at(-1).data.brief);
    return briefAvailable(user, brief) && ((row.author === user.username && user.desk.includes('R07')) ||
      (brief.owner === user.username && row.status !== 'draft'));
  }

  function consentActive(user, consent) {
    if (!consent || consent.revokedAt || Date.parse(consent.expiresAt) <= Date.now()) return false;
    const matter = safeMatter(user, consent.owner, consent.matterId);
    return Boolean(matter?.documents.some(doc => doc.id === consent.documentId && doc.sha256 === consent.documentSha256));
  }
  function consent(user, input) {
    if (input.action === 'consent-revoke') {
      const row = recordFor(user, 'consent', input.id);
      own(user, row);
      current(input, row);
      if (row.revokedAt) fail(409, 'Consent was already withdrawn.');
      return store(user, 'consent', row.id, row, { revokedAt: dateNow() }, 'consent withdrawn',
        value(input.notes, 'Withdrawal reason', 800));
    }
    const scope = matterFor(user, input.matterId, 'owner');
    const marketer = checkDistinct(user, input.marketer, 'R08');
    const reviewer = checkDistinct(user, input.reviewer, 'R08');
    if (marketer.username === reviewer.username || !safeMatter(marketer, user.username, scope.matter.id) ||
        !safeMatter(reviewer, user.username, scope.matter.id)) fail(422, 'Choose distinct, authorized marketing author and reviewer.');
    const doc = scope.matter.documents.find(row => row.id === input.documentId && row.purpose === 'supporting');
    if (!doc || input.attested !== true) fail(422, 'Confirm signed consent and select its supporting PDF.');
    const date = value(input.expires, 'Expiry date', 10);
    const expiry = new Date(date + 'T00:00:00.000Z');
    if (!Number.isFinite(expiry.valueOf()) || expiry.toISOString().slice(0, 10) !== date ||
        expiry.valueOf() <= Date.now()) fail(422, 'Enter a future expiry date.');
    return insert(user, 'consent', { owner: user.username, matterId: scope.matter.id,
      documentId: doc.id, documentSha256: doc.sha256, marketer: marketer.username, reviewer: reviewer.username,
      excerpt: value(input.excerpt, 'Exact authorized client copy', 3000),
      channel: choose(input.channel, channels, 'an authorized channel'), expiresAt: expiry.toISOString(), revokedAt: null },
    'limited consent recorded');
  }
  function storyParticipants(user, grant) {
    return grant && [grant.marketer, grant.reviewer].includes(user.username) && user.desk.includes('R08') &&
      matchScope(user, grant.owner) && !team.screened(user.firm, grant.owner, grant.matterId, user.username);
  }
  function storyArtifact(user, data) {
    const grant = find(user, 'consent', data.consent);
    const author = grant && accounts.get(grant.marketer);
    const reviewer = grant && accounts.get(grant.reviewer);
    if (!storyParticipants(user, grant) || !author || !reviewer || !storyParticipants(author, grant) ||
        !storyParticipants(reviewer, grant) || !consentActive(user, grant) ||
        !consentActive(author, grant) || !consentActive(reviewer, grant)) {
      fail(409, 'Active consent is required to use this client story.');
    }
    if (data.channel !== grant.channel) fail(422, 'The selected channel is outside the consent scope.');
    return { headline: storyStyles[data.style], copy: grant.excerpt, channel: grant.channel };
  }
  function story(user, input) {
    requireRole(user, 'R08');
    const row = input.id ? recordFor(user, 'story', input.id) : null;
    if (row && !storyParticipants(user, find(user, 'consent', row.versions.at(-1).data.consent))) {
      fail(404, 'That story is unavailable.');
    }
    if (input.action === 'story-save') {
      current(input, row);
      if (row && (row.author !== user.username || !['draft', 'returned'].includes(row.status))) fail(409, 'Return the story before editing it.');
      const grant = find(user, 'consent', value(input.consent, 'Consent record', 180));
      if (!grant || grant.marketer !== user.username) fail(404, 'That consent record is unavailable.');
      if (row && row.versions[0].data.consent !== grant.id) fail(422, 'Create a new story for different consent.');
      const data = { consent: grant.id, channel: choose(input.channel, channels, 'a channel'),
        style: choose(input.style, Object.keys(storyStyles), 'a story format') };
      storyArtifact(user, data);
      return versions(user, 'story', row, data, 'story version saved');
    }
    if (!row) fail(404, 'That story is unavailable.');
    const data = row.versions.at(-1).data;
    return review(user, 'story', row, input, storyArtifact(user, data), find(user, 'consent', data.consent).reviewer);
  }

  function accountCreate(user, input) {
    if (user.role !== 'lawyer') fail(403, 'A lawyer account must own a client account.');
    const manager = checkDistinct(user, input.manager, 'R09');
    return insert(user, 'client-account', { owner: user.username, manager: manager.username,
      label: value(input.label, 'Approved account display label') }, 'client account created');
  }
  function accountLink(user, input) {
    const account = recordFor(user, 'client-account', input.accountId);
    const manager = accounts.get(account.manager);
    const scope = matterFor(user, input.matterId, 'owner');
    const id = hash([account.id, scope.matter.id]);
    const prior = find(user, 'client-link', id);
    current(input, prior);
    if (input.action === 'account-unlink') {
      if (!prior?.active || prior.owner !== user.username) fail(404, 'That client history record is unavailable.');
      return store(user, 'client-link', id, prior, { active: false }, 'client history permission withdrawn');
    }
    if (!manager || manager.firm !== user.firm || !manager.desk.includes('R09') ||
        !safeMatter(manager, user.username, scope.matter.id)) fail(404, 'The designated relationship manager cannot receive this matter.');
    if (account.owner !== user.username && !account.approvedOwners?.includes(user.username)) {
      fail(404, 'That client account is unavailable.');
    }
    return store(user, 'client-link', id, prior, { accountId: account.id, matterId: scope.matter.id,
      owner: user.username, active: true, label: value(input.label, 'Approved matter history label'),
      milestone: choose(input.milestone, ['Opened', 'In progress', 'Resolved', 'Closed'], 'a milestone') }, 'client history shared');
  }
  function accountInvite(user, input) {
    const account = recordFor(user, 'client-account', input.id);
    own(user, account);
    current(input, account);
    const owner = person(user, input.username);
    if (owner.role !== 'lawyer') fail(422, 'Choose a lawyer to contribute their matters.');
    if (account.approvedOwners?.includes(owner.username)) fail(409, 'This lawyer already has permission to contribute.');
    return store(user, 'client-account', account.id, account, {
      approvedOwners: [...(account.approvedOwners ?? []), owner.username],
    }, 'matter owner invited to contribute client history');
  }
  function linkVisible(user, link) {
    const account = find(user, 'client-account', link.accountId);
    return link.active && account && (link.owner === user.username ||
      (account.manager === user.username && user.desk.includes('R09'))) &&
      Boolean(safeMatter(user, link.owner, link.matterId));
  }
  function feedback(user, input) {
    if (input.action === 'feedback-new') {
      requireRole(user, 'R09');
      const link = recordFor(user, 'client-link', input.linkId);
      const account = find(user, 'client-account', link.accountId);
      if (!linkVisible(user, link) || account.manager !== user.username) fail(404, 'That client history record is unavailable.');
      return insert(user, 'feedback', { linkId: link.id, author: user.username, lead: link.owner,
        topic: choose(input.topic, ['Communication', 'Timing', 'Billing', 'Other'], 'a topic'),
        feedback: value(input.feedback, 'Client feedback', 1800),
        nextStep: value(input.nextStep, 'Requested follow-up', 900), status: 'routed' }, 'feedback routed to matter lead');
    }
    const row = recordFor(user, 'feedback', input.id);
    const link = find(user, 'client-link', row.linkId);
    if (!link || row.lead !== user.username || !safeMatter(user, link.owner, link.matterId)) fail(404, 'That service follow-up is unavailable.');
    current(input, row);
    if (input.action === 'feedback-ack' && row.status === 'routed') {
      return store(user, 'feedback', row.id, row, { status: 'acknowledged' }, 'matter lead acknowledged');
    }
    if (input.action === 'feedback-resolve' && row.status === 'acknowledged') {
      return store(user, 'feedback', row.id, row, { status: 'resolved',
        resolution: value(input.resolution, 'Resolution and evidence', 1400) }, 'matter lead resolved follow-up');
    }
    fail(409, 'Acknowledge this follow-up before resolving it.');
  }

  function preview(user, row, kind) {
    const current = row.versions.at(-1);
    let artifact = null;
    try { artifact = (kind === 'pitch' ? pitchArtifact : storyArtifact)(user, current.data); }
    catch (error) { if (error.status !== 409) throw error; }
    const { id, status, revision, author, submitted, approved, history } = row;
    return { id, status, revision, author, submitted, approved, history, version: current.number,
      versions: row.versions.map(({ number, sha256, by, at }) => ({ number, sha256, by, at })),
      selection: artifact ? current.data : null, artifact,
      ...(kind === 'pitch' ? { reviewer: find(user, 'brief', current.data.brief).owner } :
        { reviewer: find(user, 'consent', current.data.consent).reviewer }) };
  }
  function view(user) {
    const roles = user.desk;
    const experience = byKind(user, 'experience');
    const consents = byKind(user, 'consent');
    const links = byKind(user, 'client-link');
    const approvedLinks = links.filter(row => linkVisible(user, row));
    return {
      username: user.username, roles, options: { areas, services, outcomes, channels, pitchStyles, storyStyles },
      experience: roles.includes('R07') ? experience.map(row => experiencePublic(user, row)).filter(Boolean) : [],
      ownedExperience: experience.filter(row => row.owner === user.username),
      briefs: byKind(user, 'brief').filter(row => briefAvailable(user, row)).map(publicBrief),
      ownedBriefs: byKind(user, 'brief').filter(row => row.owner === user.username && !row.revokedAt).map(row => ({ ...publicBrief(row), revision: row.revision })),
      pitches: byKind(user, 'pitch').filter(row => pitchParticipant(user, row)).map(row => preview(user, row, 'pitch')),
      ownedConsents: consents.filter(row => row.owner === user.username).map(({ excerpt, ...row }) => row),
      consentOptions: consents.filter(row => storyParticipants(user, row) && consentActive(user, row))
        .map(({ id, channel, expiresAt, marketer, reviewer, excerpt }) => ({ id, channel, expiresAt, marketer, reviewer, excerpt })),
      stories: byKind(user, 'story').filter(row => {
        const grant = find(user, 'consent', row.versions.at(-1).data.consent);
        return storyParticipants(user, grant) && (row.author === user.username || row.status !== 'draft');
      }).map(row => preview(user, row, 'story')),
      clientAccounts: byKind(user, 'client-account').filter(row => row.owner === user.username ||
        row.approvedOwners?.includes(user.username) || approvedLinks.some(link => link.accountId === row.id))
        .map(({ id, label, owner, manager, revision }) => ({ id, label, owner, manager, revision })),
      ownedLinks: links.filter(row => row.owner === user.username).map(({ accountId, matterId, revision }) => ({ accountId, matterId, revision })),
      clientHistory: approvedLinks.map(({ id, accountId, label, milestone, owner, updatedAt, revision, matterId }) =>
        ({ id, accountId, label, milestone, owner, updatedAt, revision, ...(owner === user.username ? { matterId } : {}) })),
      feedback: byKind(user, 'feedback').filter(row => {
        const link = find(user, 'client-link', row.linkId);
        return link && ((row.author === user.username && linkVisible(user, link)) ||
          (row.lead === user.username && safeMatter(user, link.owner, link.matterId)));
      }),
      people: user.role === 'lawyer' ? [...accounts.values()].filter(account => account.firm === user.firm &&
        inScope(user, account.office, account.practiceGroup)).map(({ username, role, desk }) => ({ username, role, desk })) : [],
      lawyer: user.role === 'lawyer',
    };
  }
  const actions = {
    'experience-add': experience, 'experience-retire': experience, 'referral-share': shareReferral, 'referral-withdraw': revokeBrief,
    'pitch-save': pitch, 'pitch-submit': pitch, 'pitch-return': pitch, 'pitch-approve': pitch,
    'consent-add': consent, 'consent-revoke': consent,
    'story-save': story, 'story-submit': story, 'story-return': story, 'story-approve': story,
    'account-add': accountCreate, 'account-invite': accountInvite, 'account-link': accountLink, 'account-unlink': accountLink,
    'feedback-new': feedback, 'feedback-ack': feedback, 'feedback-resolve': feedback,
  };
  return {
    view,
    update(user, input) {
      if (!Object.hasOwn(actions, input.action)) fail(422, 'Choose a client development action.');
      return transact(() => actions[input.action](user, input));
    },
    artifact(user, kind, id) {
      if (!['pitch', 'story'].includes(kind)) fail(404, 'That artifact is unavailable.');
      const row = recordFor(user, kind, id);
      const data = row.versions.at(-1).data;
      if (kind === 'pitch' ? !pitchParticipant(user, row) : !storyParticipants(user, find(user, 'consent', data.consent))) {
        fail(404, 'That artifact is unavailable.');
      }
      if (row.status !== 'approved') fail(409, 'Approve the exact version before exporting.');
      const artifact = (kind === 'pitch' ? pitchArtifact : storyArtifact)(user, data);
      if (hash(artifact) !== row.approved.artifactSha256) fail(409, 'The approved artifact has changed.');
      return { artifact, version: row.approved.number, sha256: row.approved.artifactSha256 };
    },
  };
}
