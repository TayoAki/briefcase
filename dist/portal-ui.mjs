export function portalUI(view) {
  const { state, escape: e, button, attribute, field, pill, showDialog, bindForm, errorSlot,
    cancelButton, submitButton, render, toast, download } = view;
  const data = new Map();
  const enabled = () => Boolean(state.store?.info.portal);
  const checkbox = (name, label, attrs = '') =>
    `<label class="check-label"><input type="checkbox" name="${name}" ${attrs}>${e(label)}</label>`;
  const verify = label => checkbox('attested', label, 'required');
  const action = (label, name, id) => button(label, name, '', 'small', id ? attribute('id', id) : '');

  function form(title, content, callback, submit) {
    showDialog(title, `<form class="dialog-body">${content}${errorSlot}<div class="dialog-actions">
      ${cancelButton()}${submitButton(submit)}</div></form>`);
    return bindForm(callback, { close: false });
  }
  async function refresh(path = '', body) {
    const selected = state.matter;
    const result = await state.store.portal(selected, path, body);
    data.set(selected.id, { grants: result.grants, submissions: result.submissions });
    if (result.matter && state.matter.id === selected.id) state.matter = result.matter;
    render();
    return result;
  }
  function create() {
    const docs = state.matter.documents;
    return form('Create client access', field('Recipient', 'recipient', '', 'maxlength="120" required') +
      field('Access expires in days', 'days', '7', 'type="number" min="1" max="30" required') +
      `<fieldset class="office-list-input"><legend>Exact PDFs to share</legend>${docs.map(doc =>
        checkbox('documents', doc.name, 'value="' + e(doc.id) + '"')).join('') || '<p>Attach a PDF or enable submissions below.</p>'}</fieldset>` +
      checkbox('canUpload', 'Allow PDF submissions for lawyer review') + verify('I reviewed the recipient, selected files and access period.'),
      async (values, element) => {
        const result = await refresh('', { ...values, documents: new FormData(element).getAll('documents'),
          canUpload: values.canUpload === 'on', attested: values.attested === 'on' });
        if (!result.created) return view.dialog.close();
        showDialog('Client access created', `<div class="dialog-body"><p>Share the link and code through your approved channels.
          You can revoke access from the client portal list.</p>
          ${field('Client link', 'url', result.created.link, 'readonly')}
          ${field('Access code', 'code', result.created.code, 'readonly')}
          <p>Expires ${e(new Date(result.created.expires).toLocaleString())}</p></div>`);
      }, 'Create access');
  }
  function review(id) {
    return form('Review client submission', `<label class="form-field"><span>Decision</span><select name="decision">
      <option value="accept">Attach as a supporting PDF</option><option value="decline">Decline submission</option></select></label>` +
      verify('I reviewed the uploaded PDF and confirmed this decision.'), async values => {
      await refresh('/' + id + '/review', { accept: values.decision === 'accept', attested: values.attested === 'on' });
      view.dialog.close();
      toast('Submission review saved.');
    }, 'Save review');
  }
  function revoke(id) {
    return form('Revoke client access', verify('Revoke future access through this link.'), async () => {
      await refresh('/' + id + '/revoke', {});
      view.dialog.close();
      toast('Client access revoked.');
    }, 'Revoke access');
  }
  return {
    panel() {
      const saved = data.get(state.matter.id);
      const grants = saved?.grants ?? [];
      const submissions = saved?.submissions ?? [];
      return `<section class="panel wf-panel"><div class="wf-panel-head"><div><h3>Client portal</h3>
        <p>${enabled() ? 'Create scoped access, revoke links and review incoming PDFs.' :
          'Scoped client links and uploads are available on the configured local server.'}</p></div>
        ${enabled() ? `<div class="button-row">${action('Refresh', 'portal-refresh')}${action('Create access', 'portal-create')}</div>` : ''}</div>
        <div class="wf-panel-body">
          ${grants.map(row => {
            const live = !row.revokedAt && Date.parse(row.expires) > Date.now();
            return `<div class="wf-row"><div class="wf-row-main"><strong>${e(row.recipient)}</strong>
              <small>${row.documents.length} shared PDFs · expires ${e(row.expires.slice(0, 10))}</small></div>
              <div class="button-row">${pill(live ? 'Active' : row.revokedAt ? 'Revoked' : 'Expired', live ? 'verified' : 'neutral')}
                ${live ? action('Revoke', 'portal-revoke', row.id) : ''}</div></div>`;
          }).join('')}
          ${submissions.map(row => `<div class="wf-row"><div class="wf-row-main"><strong>${e(row.name)}</strong>
            <small>${e(row.recipient)} · ${e(row.created.slice(0, 10))} · ${e(row.status)}</small></div>
            <div class="button-row">${row.status === 'pending' ? action('Download for review', 'portal-pdf', row.id) + action('Review', 'portal-review', row.id) : ''}</div></div>`).join('')}
        </div></section>`;
    },
    actions: {
      'portal-refresh': () => refresh(),
      'portal-create': create,
      'portal-revoke': item => revoke(item.dataset.id),
      'portal-review': item => review(item.dataset.id),
      'portal-pdf': async item => {
        const selected = state.matter;
        const row = data.get(selected.id)?.submissions.find(record => record.id === item.dataset.id);
        const response = await fetch('/api/matters/' + selected.id + '/portal/' + item.dataset.id + '/pdf');
        if (!response.ok) throw new Error('This submission is unavailable.');
        download(await response.blob(), row?.name ?? 'Client-submission.pdf');
      },
    },
  };
}
