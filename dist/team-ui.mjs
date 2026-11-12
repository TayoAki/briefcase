export function matterTeam(view) {
  const { state, button, escape: e, field, option, attribute, pill, showDialog, bindForm, errorSlot,
    cancelButton, submitButton, render, toast } = view;
  const cache = new Map();
  const matter = () => state.matter;
  const saved = () => cache.get(matter().id);
  const select = (label, name, entries) => `<label class="form-field"><span>${e(label)}</span><select name="${name}" required>
    ${option('', 'Choose…')}${entries.map(([value, label]) => option(value, label)).join('')}</select></label>`;
  const confirm = label => `<label class="check-label"><input type="checkbox" name="attested" required>${e(label)}</label>`;
  const panel = (title, summary, action, body = '') => `<section class="panel wf-panel"><div class="wf-panel-head">
    <div><h3>${e(title)}</h3><p>${e(summary)}</p></div><div class="button-row">${action}</div></div><div class="wf-panel-body">${body}</div></section>`;
  const line = (name, note, actions = '') => `<div class="wf-row"><div class="wf-row-main"><strong>${e(name)}</strong>
    <small>${e(note)}</small></div><div class="button-row">${actions}</div></div>`;
  const open = source => button('Open page', 'team-source', 'FileText', 'small', attribute('id', source.documentId) + ' ' + attribute('page', source.page));
  function form(title, body, run, label) {
    showDialog(title, `<form class="dialog-body">${body}${errorSlot}<div class="dialog-actions">${cancelButton()}${submitButton(label)}</div></form>`);
    bindForm(run);
  }
  async function reload(data) {
    const current = matter();
    const next = await state.store.team(current, data);
    cache.set(current.id, next);
    render();
  }
  async function review(action, values) {
    const current = matter();
    const result = await state.store.teamReview(current, { revision: current.revision, id: saved()?.review?.id, action, ...values });
    state.matter = result.matter;
    cache.set(current.id, result.team);
    render();
    toast('Review ' + result.team.review.status + '.');
  }
  function roster(data) {
    return panel('Matter access', 'Share this matter with a configured account in your firm.',
      button('Grant matter access', 'team-grant', 'Plus', 'small') +
      button('Screen account', 'team-screen', 'ShieldCheck', 'small'), data.members.map(row => line(row.username,
        row.revokedAt ? 'Revoked' : (row.access === 'review' ? 'Lawyer review' : 'Preparation') +
          (row.expiresAt ? ' · expires ' + new Date(row.expiresAt).toLocaleString() : ''),
        row.revokedAt ? '' : button('Revoke', 'team-revoke', '', 'small', attribute('user', row.username)))).join('') +
      (data.screens ?? []).map(username => line(username, 'Screened',
        button('Remove screen', 'team-unscreen', '', 'small', attribute('user', username)))).join(''));
  }
  function queue(data) {
    const record = data.review;
    const stale = record && record.revision !== matter().revision;
    const mayReview = record?.status === 'submitted' && !stale && record.reviewer === state.store.info.username;
    const submit = data.reviewers.some(username => username !== state.store.info.username) &&
      (!record || stale || record.status === 'returned' || (record.status === 'submitted' && !data.reviewers.includes(record.reviewer)));
    return panel('Chronology review', 'Submit the checked draft to an assigned lawyer. A changed draft needs a new submission.',
      submit ? button('Submit for review', 'team-submit', 'ArrowRight', 'small primary') : '',
      record ? line('Revision ' + record.revision, (stale ? 'Draft changed · ' : '') + record.status + ' · ' + record.submittedBy + ' → ' + record.reviewer,
        mayReview ? button('Return for changes', 'team-return', '', 'small') + button('Approve revision', 'team-approve', 'Check', 'small primary') :
          pill(record.status, record.status === 'approved' ? 'verified' : 'neutral')) +
        (record.reason ? line('Requested changes', record.reason) : '') +
        data.reviewHistory.map(row => line('Revision ' + row.revision + ' · ' + row.status, row.reason || row.submittedBy + ' → ' + row.reviewer)).join('') : '');
  }
  function renderTeam() {
    if (!state.store.info.team) return panel('Matter team', 'Run the authenticated server to use shared matter access and the lawyer review queue.', '');
    const data = saved();
    return panel('Team workspace', 'Search this matter’s original pages or inspect an incoming packet.', 
      button('Refresh team', 'team-load', '', 'small') + button('Search pages', 'team-search', 'Search', 'small') +
      button('Check records packet', 'team-casework', 'FileText', 'small')) +
      (data ? queue(data) + (data.access === 'owner' ? roster(data) + panel('Access and review history',
        'Recent matter access and approval events.', '', data.audit.map(row => line(row.action, row.actor + ' · ' + row.at)).join('')) : '') : '');
  }
  return { render: renderTeam, actions: {
    'team-load': () => reload(),
    'team-grant': () => form('Grant matter access', select('Firm account', 'username', saved().candidates.map(row => [row.username, row.name])) +
      select('Matter role', 'access', [['prepare', 'Prepare'], ['review', 'Lawyer review']]) +
      field('Expiry for temporary access (local time)', 'expiresAt', '', 'type="datetime-local"'), async values => {
      const expiresAt = values.expiresAt ? new Date(values.expiresAt).toISOString() : null;
      await reload({ action: 'grant', ...values, expiresAt });
      toast('Matter access saved.');
    }, 'Grant access'),
    'team-screen': () => form('Screen account', select('Firm account', 'username', saved().candidates
      .filter(row => !(saved().screens ?? []).includes(row.username)).map(row => [row.username, row.name])) +
      field('Screen reason', 'reason', '', 'maxlength="350" required'),
    values => reload({ action: 'screen', ...values }), 'Apply screen'),
    'team-unscreen': item => form('Remove screen', field('Reason', 'reason', '', 'maxlength="350" required'),
      values => reload({ action: 'unscreen', username: item.dataset.user, ...values }), 'Remove screen'),
    'team-revoke': item => form('Revoke matter access', confirm('Remove this account from the matter.'), async () => {
      await reload({ action: 'revoke', username: item.dataset.user });
      toast('Matter access revoked.');
    }, 'Revoke access'),
    'team-submit': () => form('Submit chronology', select('Assigned lawyer', 'reviewer', saved().reviewers
      .filter(id => id !== state.store.info.username).map(id => [id, id])),
    values => review('submit', values), 'Submit'),
    'team-return': () => form('Return chronology for changes', field('Requested changes', 'reason', '', 'maxlength="700" required'),
      values => review('return', values), 'Return for changes'),
    'team-approve': () => form('Approve the submitted chronology', confirm('I reviewed the exact submitted revision and its source pages.'),
      values => review('approve', { attested: values.attested === 'on' }), 'Approve revision'),
    'team-search': () => {
      showDialog('Search original pages', `<form class="dialog-body">${field('Search words', 'query', '', 'maxlength="180" required')}
        <div id="team-results"></div>${errorSlot}<div class="dialog-actions">${cancelButton()}${submitButton('Search')}</div></form>`);
      bindForm(async (values, element) => {
        const { matches } = await state.store.search(matter(), values.query);
        element.querySelector('#team-results').innerHTML = matches.map(hit => line(hit.name + ' · page ' + hit.page, hit.excerpt, open(hit))).join('') ||
          '<p>No matching original pages.</p>';
      }, { close: false });
    },
    'team-casework': () => {
      const options = matter().documents.map(doc => [doc.id, doc.name]);
      showDialog('Check a records packet', `<form class="dialog-body">${select('Current PDF', 'document', options)}
        <label class="form-field"><span>Earlier PDF to compare</span><select name="previous">${option('', 'None')}
        ${options.map(([value, label]) => option(value, label)).join('')}</select></label>
        <div id="team-results"></div>${errorSlot}<div class="dialog-actions">${cancelButton()}${submitButton('Check packet')}</div></form>`);
      bindForm(async (values, element) => {
        const data = await state.store.casework(matter(), values.document, values.previous);
        const compare = data.comparison;
        element.querySelector('#team-results').innerHTML =
          (data.matches.map(row => line(row.provider, 'Candidate request · ' + row.evidence.reason, open(row.evidence))).join('') ||
            '<p>No open request matched this packet.</p>') +
          (data.ambiguous ? '<p>Multiple candidates. Choose the correct request in Records collection.</p>' : '') +
          (data.unreadable.length ? '<p>Unreadable pages · ' + data.unreadable.join(', ') + '</p>' : '') +
          (compare ? line('Text comparison', 'Current-only pages ' + (compare.currentOnly.join(', ') || 'none') +
            ' · earlier-only pages ' + (compare.priorOnly.join(', ') || 'none') +
            (compare.priorUnreadable.length ? ' · earlier unreadable pages ' + compare.priorUnreadable.join(', ') : '')) : '');
      }, { close: false });
    },
    'team-source': item => view.openSource(item),
  }};
}
