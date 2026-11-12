import { calendarText, encryptedArchive, verifyArchive } from './recovery.mjs';

export function redactionBox(fields) {
  const names = ['left', 'top', 'width', 'height'];
  if (names.some(name => typeof fields[name] !== 'string' || !/^\d+(?:\.\d+)?$/.test(fields[name]))) throw new Error('Enter percentages for all four sides.');
  const [left, top, width, height] = names.map(name => Number(fields[name]));
  if (left < 0 || top < 0 || width <= 0 || height <= 0 || left + width > 100 || top + height > 100) throw new Error('The rectangle must fit inside the page.');
  return { left, top, width, height };
}

export function matterTools(view) {
  const { state, button, escape: e, attribute, field, showDialog, bindForm, cancelButton, submitButton,
    errorSlot, download, toast, dialog } = view;
  const panel = (title, description, tools) => `<section class="panel wf-panel"><div class="wf-panel-head">
    <div><h3>${title}</h3><p>${description}</p></div><div class="button-row">${tools}</div></div></section>`;
  function form(title, body, handler, label, close = true) {
    showDialog(title, `<form class="dialog-body">${body}${errorSlot}<div class="dialog-actions">
      ${cancelButton()}${submitButton(label)}</div></form>`);
    return bindForm(handler, { close });
  }
  const passphrase = field('Archive passphrase', 'password', '', 'type="password" minlength="12" maxlength="512" required autocomplete="new-password"');
  function exportArchive() {
    const matter = state.matter;
    return form('Export encrypted matter archive', '<p>The archive contains matter records, review history and original PDFs. Keep the passphrase with your recovery materials.</p>' +
      passphrase + field('Repeat passphrase', 'confirmation', '', 'type="password" minlength="12" maxlength="512" required autocomplete="new-password"'),
      async values => {
        if (values.password !== values.confirmation) throw new Error('The passphrases differ.');
        const bytes = await encryptedArchive(matter, (matter, doc) => state.store.original(matter, doc), values.password);
        const label = (matter.reference || 'matter').replace(/[^a-zA-Z0-9._-]+/g, '-');
        download(new Blob([bytes], { type: 'application/octet-stream' }), label + '.briefcase');
        toast('Encrypted matter archive downloaded.');
      }, 'Create archive');
  }
  function checkArchive() {
    return form('Verify matter archive', '<label class="form-field"><span>Archive file</span><input type="file" name="file" accept=".briefcase" required></label>' +
      passphrase, async (values, element) => {
      const file = element.elements.file.files[0];
      if (!file || file.size > 75 * 1024 * 1024 + 64) throw new Error('Choose a Briefcase archive up to 75 MB.');
      const result = await verifyArchive(await file.arrayBuffer(), values.password);
      showDialog('Archive verified', `<div class="dialog-body"><div class="choice-box">${e(result.matter)}</div>
        <p>${result.originals} verified original PDFs · ${result.approvals} chronology approvals</p></div>`);
    }, 'Verify archive', false);
  }
  async function redact(item) {
    const matter = state.matter;
    const doc = matter.documents.find(row => row.id === item.dataset.id);
    if (!doc) throw new Error('This original is unavailable.');
    const { openPdf } = await import('./pdf.mjs');
    const pdf = await openPdf(await state.store.original(matter, doc));
    const boxes = [];
    let pageNumber = Math.max(1, Math.min(pdf.numPages, Number(item.dataset.page) || 1));
    let previewNumber = null;
    let generation = 0;
    let active = false;
    const percentage = (label, name) => field(label + ' (%)', name, '', 'type="number" min="0" max="100" step=".1"');
    const controls = form('Create a redacted page copy', '<p>Draw rectangles over sensitive areas or enter their positions. Inspect the preview before downloading the flattened page.</p>' +
      field('Original PDF page', 'page', pageNumber, 'type="number" min="1" max="' + pdf.numPages + '" required') +
      '<canvas id="redact-preview" class="redact-canvas" aria-label="Preview of redacted page"></canvas>' +
      `<div class="field-row">${percentage('From left', 'left')}${percentage('From top', 'top')}</div>
      <div class="field-row">${percentage('Width', 'width')}${percentage('Height', 'height')}</div>
      <div class="button-row"><button class="btn small" id="redact-add" type="button">Add rectangle</button>
      <button class="btn small" id="redact-undo" type="button">Undo rectangle</button><span id="redact-count" aria-live="polite"></span></div>
      <label class="check-label"><input type="checkbox" name="confirmed" required> I inspected the redacted page preview.</label>`,
      async values => {
        if (!boxes.length || previewNumber !== pageNumber || Number(values.page) !== pageNumber || values.confirmed !== 'on') {
          throw new Error('Preview a page with at least one redaction rectangle.');
        }
        const selectedPage = pageNumber;
        const selectedBoxes = boxes.map(box => ({ ...box }));
        const { PDFDocument } = await import('./vendor/packets/pdf-lib.mjs');
        const rendered = await makeCanvas(2.3, selectedPage, selectedBoxes);
        const output = await PDFDocument.create();
        const image = await output.embedPng(rendered.toDataURL('image/png'));
        const page = output.addPage([rendered.width / 2.3, rendered.height / 2.3]);
        page.drawImage(image, { x: 0, y: 0, width: page.getWidth(), height: page.getHeight() });
        download(new Blob([await output.save()], { type: 'application/pdf' }), 'Redacted-page-' + selectedPage + '.pdf');
        toast('Flattened redacted page downloaded.');
      }, 'Download redacted page');
    const canvas = controls.querySelector('#redact-preview');
    const status = controls.querySelector('.form-error');
    function error(message) { status.hidden = !message; status.textContent = message || ''; }
    async function makeCanvas(scale, selectedPage, selectedBoxes) {
      const page = await pdf.getPage(selectedPage);
      const viewport = page.getViewport({ scale });
      const rendered = document.createElement('canvas');
      rendered.width = Math.ceil(viewport.width);
      rendered.height = Math.ceil(viewport.height);
      await page.render({ canvas: rendered, viewport, background: '#fff' }).promise;
      const ctx = rendered.getContext('2d');
      ctx.fillStyle = '#000';
      for (const box of selectedBoxes) {
        const left = Math.floor(rendered.width * box.left / 100);
        const top = Math.floor(rendered.height * box.top / 100);
        const right = Math.ceil(rendered.width * (box.left + box.width) / 100);
        const bottom = Math.ceil(rendered.height * (box.top + box.height) / 100);
        ctx.fillRect(left, top, right - left, bottom - top);
      }
      return rendered;
    }
    async function paint() {
      const token = ++generation;
      const desired = pageNumber;
      previewNumber = null;
      controls.elements.confirmed.checked = false;
      controls.querySelector('#redact-count').textContent = boxes.length + (boxes.length === 1 ? ' rectangle' : ' rectangles');
      try {
        const image = await makeCanvas(1, desired, boxes.map(box => ({ ...box })));
        if (token !== generation || !dialog.open) return;
        canvas.width = image.width;
        canvas.height = image.height;
        canvas.getContext('2d').drawImage(image, 0, 0);
        previewNumber = desired;
      } catch (failure) { if (token === generation) error(failure.message); }
    }
    const add = values => {
      if (state.saving) return;
      try {
        if (boxes.length >= 50) throw new Error('The page has reached the 50-rectangle limit.');
        boxes.push(redactionBox(values));
        error('');
        void paint();
      } catch (failure) { error(failure.message); }
    };
    controls.querySelector('#redact-add').addEventListener('click', () => add(Object.fromEntries(new FormData(controls))));
    controls.querySelector('#redact-undo').addEventListener('click', () => { if (!state.saving) { boxes.pop(); void paint(); } });
    controls.elements.page.addEventListener('change', () => {
      const next = Number(controls.elements.page.value);
      if (!Number.isInteger(next) || next < 1 || next > pdf.numPages) return;
      if (next !== pageNumber) { pageNumber = next; boxes.length = 0; error(''); void paint(); }
    });
    const pos = event => {
      const bounds = canvas.getBoundingClientRect();
      return { x: Math.max(0, Math.min(100, 100 * (event.clientX - bounds.left) / bounds.width)),
        y: Math.max(0, Math.min(100, 100 * (event.clientY - bounds.top) / bounds.height)) };
    };
    let start;
    canvas.addEventListener('pointerdown', event => {
      if (previewNumber !== pageNumber || state.saving) return;
      start = pos(event);
      active = true;
      canvas.setPointerCapture(event.pointerId);
    });
    canvas.addEventListener('pointercancel', () => { active = false; });
    canvas.addEventListener('pointerup', event => {
      if (!active) return;
      active = false;
      const end = pos(event);
      const round = n => String(Math.floor(n * 1000) / 1000);
      if (Math.abs(end.x - start.x) < .2 || Math.abs(end.y - start.y) < .2) return;
      add({ left: round(Math.min(end.x, start.x)), top: round(Math.min(end.y, start.y)),
        width: round(Math.abs(end.x - start.x)), height: round(Math.abs(end.y - start.y)) });
    });
    dialog.addEventListener('close', () => { generation += 1; void pdf.destroy(); }, { once: true });
    await paint();
  }
  return {
    panel() { return panel('Matter archive', 'Export and verify an encrypted copy of the matter and its originals.',
      button('Export archive', 'archive-export', 'Download', 'small') + button('Verify archive', 'archive-verify', 'ShieldCheck', 'small')) +
      (state.store.info.mode === 'server' ? panel('Local service diagnostics', 'Download service and import counts for troubleshooting.',
        button('Download diagnostics', 'diagnostics-export', 'Download', 'small')) : ''); },
    redactButton(doc, page = 1) { return button('Redact page', 'document-redact', 'FileText', 'small', attribute('id', doc.id) + ' ' + attribute('page', page)); },
    actions: {
      'archive-export': exportArchive, 'archive-verify': checkArchive, 'document-redact': redact,
      'diagnostics-export': async () => download(new Blob([JSON.stringify(await state.store.diagnostics(), null, 2)], { type: 'application/json' }), 'Briefcase-diagnostics.json'),
      'calendar-export': () => download(new Blob([calendarText(state.matter)], { type: 'text/calendar;charset=utf-8' }), 'Confirmed-matter-dates.ics'),
    },
  };
}
