import { icon } from './icons.mjs';
import { coverage, exportName, exportSnapshot, getPage, referenceUrl, reviewState, supportingPdf } from './model.mjs';
import { openPdf } from './pdf.mjs';
import { openStore } from './storage.mjs';
import { practice, workflowNames } from './practice.mjs';
import { workflowUI } from './practice-ui.mjs';
import { office, officeSectionNames } from './office.mjs';
import { officeSections } from './office-schema.mjs';
import { officeUI } from './office-ui.mjs';
import { portalUI } from './portal-ui.mjs';
import { matterTools } from './tools-ui.mjs';
import { matterTeam } from './team-ui.mjs';

const app = document.querySelector('#app');
const dialog = document.querySelector('#workspace-dialog');
const toastElement = document.querySelector('#toast');
const state = {
  store: null, matters: [], matter: null, screen: 'chronology', selection: null, docId: null,
  page: 1, zoom: 100, filter: 'all', searchOpen: false, query: '', menu: false, saving: false,
};
const statuses = { needs_review: 'Needs review', verified: 'Verified', excluded: 'Excluded' };
const screens = { matters: 'Matters', chronology: 'Chronology', documents: 'Source PDFs', approvals: 'Approvals', team: 'Matter team', ...workflowNames, ...officeSectionNames };
const escape = value => String(value ?? '').replace(/[&<>"']/g, character =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const dateFormat = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
const formatDate = value => value ? dateFormat.format(new Date(value)) : 'Undated';
const initials = name => String(name || 'Workspace').split(/[\s.]+/).filter(Boolean).slice(0, 2).map(item => item[0]).join('').toUpperCase();
const ordered = matter => [...(matter?.events ?? [])].sort((a, b) => a.date.localeCompare(b.date) || a.page - b.page);
const selected = () => state.matter?.events.find(event => event.id === state.selection);
const source = () => state.matter?.documents.find(doc => doc.id === state.docId);
const option = (value, label, active) => `<option value="${escape(value)}"${value === active ? ' selected' : ''}>${escape(label)}</option>`;
const button = (label, action, graphic, variant = '', extra = '') =>
  `<button class="btn ${variant}" type="button" data-action="${action}" ${extra}>${graphic ? icon(graphic, 15) : ''}<span>${escape(label)}</span></button>`;
const smallButton = (label, action, graphic, extra = '', variant = '') =>
  `<button class="icon-btn subtle ${variant}" type="button" title="${escape(label)}" aria-label="${escape(label)}" data-action="${action}" ${extra}>${icon(graphic, 16)}</button>`;
const pill = (text, type, graphic) =>
  `<span class="pill ${type}">${graphic ? icon(graphic, 12) : ''}${escape(text)}</span>`;
const attribute = (name, value) => `data-${name}="${escape(value)}"`;

let toastTimer;
function toast(message, error = false) {
  clearTimeout(toastTimer);
  toastElement.innerHTML = `<div class="toast ${error ? 'error' : ''}">${icon(error ? 'CircleAlert' : 'CircleCheck', 16)}${escape(message)}</div>`;
  toastTimer = setTimeout(() => { toastElement.textContent = ''; }, error ? 6500 : 3500);
}

function sideNav(name, graphic, count) {
  return `<button class="side-nav" type="button" data-action="nav" data-screen="${name}" title="${screens[name]}"
    aria-label="${screens[name]}"${state.screen === name ? ' aria-current="page"' : ''}>
    ${icon(graphic, 17)}<span>${screens[name]}</span>${count !== undefined ? `<span class="side-count">${count}</span>` : ''}</button>`;
}

function sidebar() {
  const matter = state.matter;
  const actor = state.store?.info.actor || 'Workspace lawyer';
  return `<aside class="sidebar" id="workspace-navigation" aria-label="Workspace navigation">
    <div class="brand"><span class="brand-mark">${icon('BriefcaseBusiness', 22)}</span><div>
      <div class="brand-name">Briefcase</div><div class="brand-caption">SOLO PRACTICE</div>
    </div></div>
    ${matter ? `<button class="matter-switch" type="button" data-action="nav" data-screen="matters" title="Switch matter">
      <span class="matter-avatar">${escape(initials(matter.name))}</span>
      <span class="matter-switch-copy"><strong>${escape(matter.reference || matter.name)}</strong><small>${matter.demo ? 'Sample matter' : 'Switch matter'}</small></span>
      ${icon('ChevronsUpDown', 13)}</button>` : ''}
    <nav aria-label="Workspace">
      <div class="side-group"><h2>Workspace</h2>${sideNav('matters', 'FolderOpen')}${state.store?.info.roleWork ? '<a class="side-nav" href="/role-work.html">' + icon('ListChecks', 17) + '<span>Role work</span></a>' : ''}
      ${state.store?.info.firmDesk ? '<a class="side-nav" href="/firm-desk.html">' + icon('Building2', 17) + '<span>Firm desk</span></a>' : ''}
      ${state.store?.info.workbench ? '<a class="side-nav" href="/workbench.html">' + icon('ListChecks', 17) + '<span>Specialist workflows</span></a>' : ''}
      ${state.store?.info.clientDevelopment ? '<a class="side-nav" href="/client-development.html">' + icon('Building2', 17) + '<span>Client development</span></a>' : ''}
      ${state.store?.info.riskIntake ? '<a class="side-nav" href="/risk-intake.html">' + icon('ShieldCheck', 17) + '<span>Risk and intake</span></a>' : ''}
      ${state.store?.info.identityAdmin ? '<a class="side-nav" href="/identity.html">' + icon('ShieldCheck', 17) + '<span>Identity and access</span></a>' : ''}</div>
      ${matter ? `<div class="side-group"><h2>Matter</h2>
        ${sideNav('chronology', 'ListChecks')}${sideNav('documents', 'FileStack', matter.documents.length)}
        ${sideNav('approvals', 'History', matter.approvals.length)}${sideNav('team', 'ShieldCheck')}</div>
        <div class="side-group workflow-nav"><h2>Practice workflows</h2>
        ${sideNav('intake', 'Building2')}${sideNav('records', 'FileUp')}${sideNav('demand', 'FileCheck2')}
        ${sideNav('queue', 'CalendarClock')}${sideNav('closing', 'ShieldCheck')}</div>
        <div class="side-group workflow-nav"><h2>Case and firm desk</h2>
        ${officeSections.map(section => sideNav(section.id, section.icon)).join('')}</div>` : ''}
    </nav>
    <div class="side-bottom">
      <div class="side-mode" title="${escape(state.store?.info.engine)}">${icon('ShieldCheck', 16)}<span>${state.store?.info.mode === 'server' ? 'Local server' : 'On-device pilot'}</span></div>
      <div class="account"><div class="account-avatar">${escape(initials(actor))}</div>
        <div><strong>${escape(actor)}</strong><small>Solo practice</small></div></div>
    </div>
  </aside>`;
}

function topbar() {
  const hasMatter = state.matter && state.screen !== 'matters';
  return `<header class="topbar">
    <div class="breadcrumbs">
      ${smallButton('Open navigation', 'toggle-menu', 'Menu', 'aria-controls="workspace-navigation" aria-expanded="' + state.menu + '"', 'mobile-menu')}
      ${hasMatter ? `<button class="breadcrumb-button" type="button" data-action="nav" data-screen="matters">Matters</button>
        ${icon('ChevronRight', 13)}<span class="crumb-current">${escape(state.matter.name)}</span>` : '<span class="crumb-current">Matters</span>'}
    </div>
    <div class="bar-actions">${hasMatter
      ? button('Import PDF', 'import', 'UploadCloud') + (workflowNames[state.screen] || officeSectionNames[state.screen] || state.screen === 'team' ||
          state.store?.info.role === 'preparer' ? '' : button('Export', 'export', 'ArrowDownToLine', 'primary'))
      : (state.store?.info.role === 'preparer' || state.store?.info.matterOnly) ? '' : button('New matter', 'new-matter', 'Plus', 'primary')}</div>
  </header>`;
}

function matterHeading() {
  const matter = state.matter;
  const review = reviewState(matter);
  const previous = matter.approvals.length > 0;
  const ready = review.verified && !review.pending && !review.gaps && !review.limited;
  const action = review.current ? pill('Approved v' + review.current.version, 'verified', 'CircleCheck')
    : ready ? button('Approve chronology', 'export', 'ShieldCheck', 'small')
    : pill(previous ? 'Draft changed' : 'In review', 'neutral', 'Clock3');
  return `<div class="page-head">
    <div>
      <div class="page-kickers">${matter.reference ? `<span class="matter-ref">${escape(matter.reference)}</span>` : ''}
        ${matter.demo ? pill('Sample matter', 'demo') : ''}</div>
      <h1>${escape(matter.name)}</h1>
      <div class="page-meta"><span>${icon('BriefcaseBusiness', 14)}${escape(matter.jurisdiction || 'Medical records')}</span>
        ${matter.demo ? '<i class="meta-dot" aria-hidden="true"></i><span>Morgan Ellis</span>' : ''}</div>
    </div>${workflowNames[state.screen] || officeSectionNames[state.screen] || state.screen === 'team' || state.store?.info.role === 'preparer' ?
      '' : `<div class="head-action">${action}</div>`}
  </div>`;
}

function stat(label, value, graphic, tone, action, filter) {
  const contents = `<span class="stat-icon ${tone || ''}">${icon(graphic, 17)}</span><span><span class="stat-label">${label}</span>
    <span class="stat-value" style="display:block">${value}</span></span>`;
  return action ? `<button type="button" class="stat" data-action="${action}" ${filter ? attribute('filter', filter) : 'data-screen="documents"'}>${contents}</button>`
    : `<div class="stat">${contents}</div>`;
}

function stats() {
  const matter = state.matter;
  const review = reviewState(matter);
  return `<div class="stats" aria-label="Chronology progress">
    ${stat('Source PDFs', matter.documents.length, 'FileStack', '', 'nav')}
    ${stat('Events', matter.events.length, 'CalendarDays', '', 'filter', 'all')}
    ${stat('Verified', review.verified, 'CircleCheck', 'good', 'filter', 'verified')}
    ${stat('Needs review', review.pending, 'Clock3', 'open', 'filter', 'needs_review')}
  </div>`;
}

function empty(graphic, title, message, action = '', tall = false) {
  return `<div class="empty${tall ? ' tall' : ''}">${icon(graphic, 25)}<strong>${escape(title)}</strong>
    ${message ? `<span>${escape(message)}</span>` : ''}${action}</div>`;
}

function visibleEvents() {
  const query = state.query.toLowerCase().trim();
  return ordered(state.matter).filter(event => (state.filter === 'all' || state.filter === event.status)
    && (!query || [event.title, event.provider, event.summary, event.date].some(text => text.toLowerCase().includes(query))));
}

function eventRow(event) {
  const page = getPage(state.matter, event.documentId, event.page);
  return `<li><button type="button" class="event-row" data-action="select-event" ${attribute('id', event.id)}
      aria-pressed="${state.selection === event.id}">
    <span class="event-date">${escape(formatDate(event.date))}</span>
    <span><span class="event-title" style="display:block" title="${escape(event.title)}">${escape(event.title)}</span>
      <span class="event-meta"><span class="event-source">p. ${event.page}${page?.label ? ' · ' + escape(page.label) : ''}</span>
      ${event.provider ? `<span aria-hidden="true">·</span><span class="event-provider">${escape(event.provider)}</span>` : ''}</span></span>
    <span class="event-status pill ${event.status}">${icon(event.status === 'verified' ? 'Check' : event.status === 'excluded' ? 'Ban' : 'Clock3', 11)}
      ${statuses[event.status]}</span>
    </button></li>`;
}

function eventDetail() {
  const event = selected();
  if (!event) return '';
  const primary = event.status === 'needs_review'
    ? button('Verify event', 'verify', 'Check', 'primary small') : button('Reopen review', 'reopen', 'RotateCcw', 'small');
  const exclude = event.status !== 'excluded' ? button('Exclude', 'exclude', 'Ban', 'ghost small danger') : '';
  const quote = event.quote !== event.summary ? `<div class="excerpt">${icon('Quote', 13)}<span>${escape(event.quote)}</span></div>` : '';
  return `<div class="detail">
    <div class="detail-head"><h3>${event.status === 'excluded' ? 'Excluded event' : 'Event summary'}</h3>
      <button class="text-link detail-source" type="button" data-action="cite">${icon('FileText', 13)} Original p. ${event.page} ${icon('ArrowUpRight', 12)}</button></div>
    <p>${escape(event.summary)}</p>${quote}
    ${event.reason ? `<p class="inline-note">${escape(event.reason)}</p>` : ''}
    <div class="detail-actions">${primary}${button('Edit event', 'edit', 'Pencil', 'small')}${exclude}</div>
  </div>`;
}

function timeline() {
  const matter = state.matter;
  const items = visibleEvents();
  const review = reviewState(matter);
  const filters = [['all', 'All events'], ['needs_review', 'Needs review'], ['verified', 'Verified'], ['excluded', 'Excluded']];
  let list = `<ul class="event-list" aria-label="Chronology events">${items.map(eventRow).join('')}</ul>`;
  if (!items.length) {
    list = matter.events.length ? empty('Search', 'No matching events', 'Try a different filter or search.')
      : matter.documents.length ? empty('CalendarClock', 'No dated events found', 'Review the original pages and add an event.')
      : empty('FileUp', 'Import your first medical PDF', 'Draft events will appear here when a service date can be identified.', button('Import PDF', 'import', 'UploadCloud', 'primary small'));
  }
  return `<section class="panel timeline" aria-labelledby="chronology-heading">
    <div class="panel-head">
      <div><h2 class="panel-title" id="chronology-heading">Medical chronology</h2><p class="panel-subtitle">Review each event against its source.</p></div>
      <div class="button-row">${button('Add event', 'add-event', 'Plus', 'small', matter.documents.length ? '' : 'disabled')}</div>
    </div>
    <div class="filterbar"><div class="filters" aria-label="Filter events">
      ${filters.map(([key, label]) => `<button type="button" class="filter" data-action="filter" data-filter="${key}"
        aria-pressed="${state.filter === key}">${label}</button>`).join('')}
    </div>${smallButton(state.searchOpen ? 'Hide event search' : 'Search events', 'toggle-search', state.searchOpen ? 'X' : 'Search')}</div>
    ${state.searchOpen ? `<div class="search-wrap"><label class="visually-hidden" for="event-search">Search events</label>
      <input id="event-search" type="search" placeholder="Search events" value="${escape(state.query)}"></div>` : ''}
    <div id="event-list-slot">${list}</div>
    ${eventDetail()}
    ${review.gaps || review.limited ? `<div class="gap-note">${icon('TriangleAlert', 16)}<span>${review.gaps ? review.gaps + ' flagged PDF page' + (review.gaps === 1 ? ' needs' : 's need') + ' review. ' : ''}
      ${review.limited ? 'The draft hit the event limit. ' : ''}<button class="text-link" data-action="nav" data-screen="documents" type="button">Open source PDFs</button></span></div>` : ''}
  </section>`;
}

function sourcePanel() {
  const doc = source();
  const page = doc?.pages[state.page - 1];
  if (!doc || !page) return `<section class="panel" aria-labelledby="source-heading">
    <div class="panel-head source-head"><h2 class="panel-title" id="source-heading">Original source</h2></div>
    ${empty('FileQuestion', 'No original page selected', 'Select an event or open a PDF from Source PDFs.', '', true)}</section>`;
  const picker = state.matter.documents.length > 1
    ? `<label class="source-picker"><span class="visually-hidden">Source PDF</span><select id="source-picker">
        ${state.matter.documents.map(item => option(item.id, item.name, doc.id)).join('')}</select></label>`
    : `<span title="${escape(doc.name)}">${escape(doc.name)}</span>`;
  const key = [state.matter.id, doc.id, state.page, state.zoom].join('/');
  return `<section class="panel source-panel" id="original-source" aria-labelledby="source-heading">
    <div class="panel-head source-head">
      <div style="min-width:0"><h2 class="panel-title" id="source-heading">Original source</h2>
        <div class="source-name">${icon('FileText', 14)}${picker}</div></div>
      ${smallButton('Download original PDF', 'original', 'Download')}
    </div>
    <div class="pdf-toolbar" aria-label="PDF page controls">
      <div class="pdf-tools">
        ${smallButton('Previous page', 'prev-page', 'ChevronLeft', state.page <= 1 ? 'disabled' : '')}
        <span class="page-counter" aria-label="PDF page ${state.page} of ${doc.pages.length}">${state.page} / ${doc.pages.length}</span>
        ${smallButton('Next page', 'next-page', 'ChevronRight', state.page >= doc.pages.length ? 'disabled' : '')}
      </div>
      <div class="pdf-tools">
        ${smallButton('Zoom out', 'zoom-out', 'Minus', state.zoom <= 70 ? 'disabled' : '')}
        <span class="zoom-counter">${state.zoom}%</span>
        ${smallButton('Zoom in', 'zoom-in', 'Plus', state.zoom >= 175 ? 'disabled' : '')}
        ${smallButton('Fit page width', 'zoom-fit', 'Maximize2')}
      </div>
    </div>
    <div class="pdf-viewport" id="pdf-viewport" data-key="${escape(key)}" tabindex="0" aria-label="Original PDF page ${state.page}">
      <div class="pdf-loading" role="status">Opening original page…</div></div>
    <div class="source-foot">
      <span>${icon('Hash', 13)} PDF p. ${page.number} ${page.label ? `<span aria-hidden="true">·</span><span class="label-value">${escape(page.label)}</span>` : ''}</span>
      ${supportingPdf(doc) ? pill('Supporting PDF', 'neutral') : page.method === 'unreadable'
        ? pill('Text needs review', 'issue', 'TriangleAlert')
        : `<span>${page.method === 'ocr' ? icon('ScanText', 14) : `<i class="good-icon">${icon('ShieldCheck', 14)}</i>`}${page.method === 'ocr' ? 'OCR text indexed' : 'Original page'}</span>`}
    </div>
  </section>`;
}

function chronology() {
  return matterHeading() + stats() + `<div class="review-grid">${timeline()}${sourcePanel()}</div>`;
}

function documents() {
  const matter = state.matter;
  const gaps = coverage(matter);
  const rows = matter.documents.map(doc => `<div class="data-row">
    <span class="stat-icon">${icon('FileText', 17)}</span><div class="row-body">
      <strong>${escape(doc.name)}</strong>
      <small>${doc.pages.length} pages · ${supportingPdf(doc) ? 'Supporting PDF' : doc.pages.filter(page => page.method === 'ocr').length + ' OCR · ' + escape(doc.engine)}</small>
      <small>SHA-256 ${escape(doc.sha256)}</small>${doc.importNote ? `<small>${escape(doc.importNote)}</small>` : ''}
    </div><div class="button-row">${button('View PDF', 'view-doc', 'Eye', 'small', attribute('id', doc.id))}${tools.redactButton(doc)}
      ${button('Download', 'original', 'Download', 'small', attribute('id', doc.id))}</div></div>`);
  const flags = gaps.map(page => `<div class="data-row">
    <span class="stat-icon open">${icon('TriangleAlert', 17)}</span><div class="row-body">
      <strong>${escape(page.name)} · PDF page ${page.number}</strong>
      <small>${page.review ? 'Reviewed · ' + escape(page.review.reason) : 'This page has no usable extracted text.'}</small>
    </div><div class="button-row">
      ${button('View page', 'view-doc', 'Eye', 'small', attribute('id', page.documentId) + ' ' + attribute('page', page.number))}
      ${button(page.review ? 'Edit note' : 'Record review', 'review-gap', 'Pencil', 'small', attribute('id', page.documentId) + ' ' + attribute('page', page.number))}
    </div></div>`);
  return matterHeading() + `<section class="panel simple-panel"><h2>Source PDFs</h2>
    <p>Original files and their page indexes.</p>
    ${rows.join('') || empty('FileUp', 'No PDFs imported', 'Import a medical PDF to start reviewing pages.', button('Import PDF', 'import', 'UploadCloud', 'primary small'))}
    </section>${flags.length ? `<section class="panel simple-panel"><h2>Flagged pages</h2>
    <p>Inspect each original and record how you handled the missing text.</p>${flags.join('')}</section>` : ''}`;
}

function approvals() {
  const matter = state.matter;
  const workflowLabels = {
    'conflict-review': 'Conflict review recorded', 'intake-decision': 'Intake decision recorded',
    'engagement-save': 'Signed engagement recorded', 'request-sent': 'Provider request send logged',
    'request-receipt': 'Received PDF linked', 'demand-approve': 'Demand package approved',
    'task-status': 'Deadline status updated', 'update-approve': 'Client update approved',
    'update-sent': 'Client update delivery logged', 'settlement-approve': 'Settlement statement approved',
    'close-matter': 'Matter closed', 'close-reopen': 'Matter reopened',
  };
  const history = [...matter.activity, ...office(matter).events.map(event => ({ ...event, action: event.type + ' · ' + event.action })),
    ...practice(matter).activity.filter(item => Object.hasOwn(workflowLabels, item.action))
    .map(item => ({ ...item, action: workflowLabels[item.action] }))].sort((a, b) => b.at.localeCompare(a.at));
  const versions = matter.approvals.map(snapshot => `<div class="data-row">
    <span class="stat-icon good">${icon('FileCheck2', 17)}</span><div class="row-body"><strong>Chronology v${snapshot.version}</strong>
      <small>${snapshot.events.length} events · ${escape(snapshot.approvedBy)} · ${escape(formatDate(snapshot.approvedAt))}</small>
    </div><div class="button-row">
      ${button('CSV', 'download-version', 'Download', 'small', attribute('id', snapshot.id) + ' data-format="csv"')}
      ${button('Source manifest', 'download-version', 'FileJson', 'small', attribute('id', snapshot.id) + ' data-format="json"')}
    </div></div>`);
  return matterHeading() + `<section class="panel simple-panel"><h2>Approved versions</h2>
    <p>Each export is tied to the events and original files you approved.</p>
    ${versions.join('') || empty('FileCheck2', 'No approved versions', 'Verify the draft events before approving a chronology.')}</section>
    <section class="panel simple-panel"><h2>Review history</h2>
    ${history.length ? `<ul class="activity">${history.slice(0, 30).map(item =>
      `<li><span><strong>${escape(item.action)}${item.version ? ' · v' + item.version : ''}</strong> · ${escape(item.actor)}
        ${item.reason ? `<small class="activity-note">${escape(item.reason)}</small>` : ''}</span>
        <time datetime="${escape(item.at)}">${escape(formatDate(item.at))}</time></li>`).join('')}</ul>` : '<p>No activity yet.</p>'}</section>`;
}

function matterList() {
  const rows = state.matters.map(item => `<div class="data-row"><span class="stat-icon">${icon('FolderOpen', 17)}</span>
    <div class="row-body"><strong>${escape(item.name)}</strong>
      <small>${item.reference ? escape(item.reference) + ' · ' : ''}${item.count} PDF${item.count === 1 ? '' : 's'}${item.demo ? ' · Sample matter' : ''}</small>
    </div>${button('Open matter', 'open-matter', 'ArrowRight', 'small', attribute('id', item.id))}</div>`);
  return `<div class="page-head"><div><h1>Matters</h1><p class="page-meta">Open a matter or check upcoming work across your practice.</p></div></div>
    <section class="panel simple-panel" aria-label="Matter list">${rows.join('') || empty('FolderOpen', 'No matters yet', 'Create a matter to organize your PDFs.')}</section>
    <div class="wf-matter-queue">${workflows.upcoming(state.matters)}</div>`;
}

let loadedPdf;
let renderTask;
let renderRun = 0;
async function paintPdf(viewport) {
  const doc = source();
  const matter = state.matter;
  const pageNumber = state.page;
  const zoom = state.zoom;
  if (!viewport || !doc) return;
  const run = ++renderRun;
  if (renderTask) { renderTask.cancel(); renderTask = null; }
  let pdf;
  try {
    const key = matter.id + '/' + doc.id;
    if (loadedPdf?.key !== key) {
      const old = loadedPdf;
      const pending = state.store.original(matter, doc).then(openPdf);
      loadedPdf = { key, pending };
      if (old) old.pending.then(value => value.destroy()).catch(() => {});
    }
    pdf = await loadedPdf.pending;
    if (run !== renderRun || !viewport.isConnected) return;
    const page = await pdf.getPage(pageNumber);
    if (run !== renderRun || !viewport.isConnected) return;
    const basic = page.getViewport({ scale: 1 });
    const style = getComputedStyle(viewport);
    const width = Math.max(140, viewport.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) - 2);
    const scale = width / basic.width * zoom / 100;
    const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    const renderViewport = page.getViewport({ scale: scale * pixelRatio });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(renderViewport.width);
    canvas.height = Math.ceil(renderViewport.height);
    canvas.style.width = Math.floor(renderViewport.width / pixelRatio) + 'px';
    canvas.style.height = Math.floor(renderViewport.height / pixelRatio) + 'px';
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', 'PDF page ' + pageNumber + ' of ' + doc.name);
    const task = page.render({ canvas, viewport: renderViewport });
    renderTask = task;
    await task.promise;
    if (run === renderRun && viewport.isConnected) viewport.replaceChildren(canvas);
  } catch {
    if (run === renderRun && viewport.isConnected) {
      if (!pdf) loadedPdf = null;
      viewport.innerHTML = '<div class="pdf-loading" role="alert">The original page could not be displayed. Download the PDF to review it.</div>';
    }
  } finally {
    if (run === renderRun) renderTask = null;
  }
}

function render() {
  const before = app.querySelector('#pdf-viewport');
  const scroll = app.querySelector('.event-list')?.scrollTop || 0;
  const contents = state.screen === 'matters' ? matterList()
    : state.screen === 'documents' ? documents() : state.screen === 'approvals' ? approvals()
    : state.screen === 'team' ? matterHeading() + matterTeamView.render()
    : workflowNames[state.screen] ? matterHeading() + workflows.render(state.screen)
    : officeSectionNames[state.screen] ? matterHeading() + officeWorkflows.render(state.screen) : chronology();
  app.innerHTML = `<div class="shell ${state.menu ? 'nav-open' : ''}">${sidebar()}
    <button class="nav-shade" type="button" aria-label="Close navigation" data-action="toggle-menu"></button>
    <main class="main">${topbar()}<div class="workspace">${contents}</div></main></div>`;
  const after = app.querySelector('#pdf-viewport');
  if (before && after && before.dataset.key === after.dataset.key) after.replaceWith(before);
  else if (after) void paintPdf(after);
  const list = app.querySelector('.event-list');
  if (list) list.scrollTop = scroll;
}

function updateUrl() {
  const url = new URL(location.href);
  url.search = '';
  if (state.matter && state.screen !== 'matters') {
    url.searchParams.set('matter', state.matter.id);
    if (state.screen !== 'chronology') url.searchParams.set('view', state.screen);
    if (state.docId && state.screen === 'chronology') {
      url.searchParams.set('document', state.docId);
      url.searchParams.set('page', state.page);
    }
  }
  history.replaceState(null, '', url);
}

function navigate(screen) {
  if (!Object.hasOwn(screens, screen) || (!state.matter && screen !== 'matters')) return;
  state.screen = screen;
  state.menu = false;
  updateUrl();
  render();
}

function chooseSource(docId, page = 1) {
  const doc = state.matter?.documents.find(item => item.id === docId);
  if (!doc) return;
  if (state.docId !== docId) state.zoom = 100;
  state.docId = docId;
  state.page = Math.min(doc.pages.length, Math.max(1, Number(page) || 1));
}

function chooseEvent(event, open = false) {
  state.selection = event?.id ?? null;
  if (event && open) chooseSource(event.documentId, event.page);
}

function pickVisibleEvent(prefer) {
  const items = visibleEvents();
  const next = items.find(item => item.id === prefer) ?? items[0];
  chooseEvent(next, true);
}

async function openMatter(id, reference = {}) {
  const matter = await state.store.matter(id);
  Object.assign(state, { matter, screen: Object.hasOwn(screens, reference.screen) && reference.screen !== 'matters' && !reference.docId ? reference.screen : 'chronology',
    selection: null, docId: null, page: 1, zoom: 100,
    filter: 'all', searchOpen: false, query: '', menu: false });
  const event = ordered(matter).find(item => item.documentId === reference.docId && item.page === reference.page) ?? ordered(matter)[0];
  chooseEvent(event, true);
  if (reference.docId && matter.documents.some(doc => doc.id === reference.docId)) chooseSource(reference.docId, reference.page);
  else if (!event && matter.documents.length) chooseSource(matter.documents[0].id);
  updateUrl();
  render();
}

function errorField(form, message) {
  const field = form.querySelector('.form-error');
  field.hidden = !message;
  field.textContent = message || '';
}

function showDialog(title, body) {
  dialog.innerHTML = `<div class="dialog-head"><h2 id="dialog-title">${escape(title)}</h2>${smallButton('Close dialog', 'close-modal', 'X')}</div>${body}`;
  if (!dialog.open) dialog.showModal();
}

const cancelButton = () => button('Cancel', 'close-modal', '', '');
const submitButton = (label, disabled = false) => `<button type="submit" class="btn primary"${disabled ? ' disabled' : ''}>${escape(label)}</button>`;
const errorSlot = '<div class="form-error" role="alert" hidden></div>';
const field = (label, name, value = '', attrs = '') =>
  `<label class="form-field"><span>${escape(label)}</span><input name="${name}" value="${escape(value)}" ${attrs}></label>`;

function bindForm(work, { close = true } = {}) {
  const form = dialog.querySelector('form');
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (state.saving) return;
    state.saving = true;
    const submit = form.querySelector('[type=submit]');
    if (submit) submit.disabled = true;
    errorField(form, '');
    try {
      await work(Object.fromEntries(new FormData(form)), form);
      if (close) dialog.close();
    } catch (error) {
      errorField(form, error.message);
    } finally {
      state.saving = false;
      if (submit) submit.disabled = false;
    }
  });
  return form;
}

function newMatter() {
  showDialog('New matter', `<form class="dialog-body">
    ${field('Matter name', 'name', '', 'maxlength="110" required autofocus placeholder="Example: Ellis v. Northline"')}
    <div class="field-row">${field('Reference', 'reference', '', 'maxlength="30"')}
      ${field('Practice area or jurisdiction', 'jurisdiction', '', 'maxlength="70"')}</div>
    ${errorSlot}<div class="dialog-actions">${cancelButton()}${submitButton('Create matter')}</div>
  </form>`);
  bindForm(async data => {
    const matter = await state.store.create(data);
    state.matters = await state.store.list();
    await openMatter(matter.id, { screen: 'intake' });
    toast('Matter created.');
  });
}

function importDialog(trigger) {
  const mode = state.store.info.mode;
  const detail = mode === 'browser'
    ? 'Use synthetic records in this pilot. The PDF and draft stay in this browser.'
    : 'Medical PDFs use ' + state.store.info.engine + (state.store.info.model ? ' and the configured model.' : '.');
  const screen = state.screen;
  const purpose = trigger?.dataset.purpose || (['intake', 'demand', 'closing'].includes(screen) ? 'supporting' : 'medical');
  showDialog('Import a PDF', `<form class="dialog-body">
    <p>${escape(detail)}</p>
    <label class="form-field"><span>Document purpose</span><select name="purpose">
      ${option('medical', 'Medical records · index and draft chronology events', purpose)}
      ${option('supporting', 'Supporting PDF · agreement, bills or exhibits', purpose)}
    </select></label>
    <label class="dropzone" id="dropzone">${icon('UploadCloud', 24)}
      <strong id="upload-name">Choose a PDF or drop it here</strong><small>Up to 25 MB and 60 pages</small>
      <input id="pdf-file" class="visually-hidden" type="file" accept=".pdf,application/pdf" aria-label="Choose a PDF">
    </label><div><button class="text-link" id="choose-sample" type="button">Use sample PDF</button></div>
    <div class="progress-label" id="upload-progress" role="status" hidden><span class="spinner"></span><span></span></div>
    ${errorSlot}<div class="dialog-actions">${cancelButton()}${submitButton('Import PDF', true)}</div>
  </form>`);
  const matter = state.matter;
  let file = null;
  const form = bindForm(async (data, form) => {
    if (!file) throw new Error('Choose a PDF to import.');
    const progress = form.querySelector('#upload-progress');
    progress.hidden = false;
    try {
      const reply = await state.store.upload(matter, file, label => { progress.lastElementChild.textContent = label; }, data.purpose);
      state.matter = reply.matter;
      state.matters = await state.store.list();
      if (!workflowNames[screen] && !officeSectionNames[screen]) {
        state.screen = supportingPdf(reply.document) ? 'documents' : 'chronology';
        state.filter = 'all';
        state.query = '';
        state.searchOpen = false;
        const event = ordered(reply.matter).find(item => item.documentId === reply.document.id);
        chooseEvent(event, true);
        if (!event) chooseSource(reply.document.id);
      }
      updateUrl();
      render();
      toast(reply.duplicate ? 'This original is already in the matter.' :
        supportingPdf(reply.document) ? 'Supporting PDF attached.' : 'Medical PDF imported. Review the draft events in Chronology.');
    } finally {
      progress.hidden = true;
    }
  });
  const input = form.querySelector('#pdf-file');
  const drop = form.querySelector('#dropzone');
  function useFile(next) {
    if (state.saving) return;
    file = next;
    form.querySelector('#upload-name').textContent = next?.name || 'Choose a PDF or drop it here';
    form.querySelector('[type=submit]').disabled = !file;
    errorField(form, '');
  }
  input.addEventListener('change', () => useFile(input.files[0]));
  form.querySelector('#choose-sample').addEventListener('click', async () => {
    try {
      const response = await fetch(new URL('./sample/Ellis_Medical_Records.pdf', import.meta.url));
      if (!response.ok) throw new Error('The sample PDF is unavailable.');
      useFile(new File([await response.blob()], 'Ellis Medical Records.pdf', { type: 'application/pdf' }));
    } catch (error) {
      errorField(form, error.message);
    }
  });
  for (const type of ['dragenter', 'dragover']) drop.addEventListener(type, event => {
    event.preventDefault();
    if (!state.saving) drop.classList.add('dragging');
  });
  drop.addEventListener('dragleave', () => drop.classList.remove('dragging'));
  drop.addEventListener('drop', event => {
    event.preventDefault();
    drop.classList.remove('dragging');
    useFile(event.dataTransfer.files[0]);
  });
}

async function mutate(command, data) {
  const id = state.matter.id;
  try {
    const result = await state.store.mutate(state.matter, command, data);
    if (state.matter.id === id) state.matter = result.matter;
    return result;
  } catch (error) {
    if (error.status === 409) {
      state.matter = await state.store.matter(id);
      pickVisibleEvent(state.selection);
      render();
    }
    throw error;
  }
}

function eventDialog(event) {
  const matter = state.matter;
  const docId = event?.documentId ?? state.docId ?? matter.documents[0]?.id;
  const page = event?.page ?? state.page ?? 1;
  showDialog(event ? 'Edit event' : 'Add event', `<form class="dialog-body">
    ${field('Event title', 'title', event?.title, 'required maxlength="120" autofocus')}
    <div class="field-row">${field('Date of service', 'date', event?.date, 'type="date" required min="1900-01-01" max="2200-12-31"')}
      ${field('Provider', 'provider', event?.provider, 'maxlength="140"')}</div>
    <label class="form-field"><span>Summary</span><textarea name="summary" rows="2" required maxlength="1400">${escape(event?.summary)}</textarea></label>
    <div class="field-row">
      <label class="form-field"><span>Source PDF</span><select name="documentId" required>
        ${matter.documents.map(doc => option(doc.id, doc.name, docId)).join('')}</select></label>
      ${field('Original PDF page', 'page', page, 'type="number" required min="1"')}
    </div>
    <label class="form-field"><span>Evidence excerpt</span><textarea name="quote" rows="2" required maxlength="700">${escape(event?.quote)}</textarea></label>
    <label class="check-label"><input type="checkbox" name="manualSource" ${event?.manualSource ? 'checked' : ''}>
      <span>I transcribed this excerpt directly from the original PDF.</span></label>
    ${errorSlot}<div class="dialog-actions">${cancelButton()}${submitButton('Save for review')}</div>
  </form>`);
  const form = bindForm(async data => {
    data.manualSource = data.manualSource === 'on';
    data.action = 'edit';
    const result = await mutate(event ? 'events/' + event.id : 'events', data);
    state.filter = 'all';
    state.query = '';
    chooseEvent(result.event, true);
    updateUrl();
    render();
    toast('Event saved for review.');
  });
  const updateMax = () => {
    const input = form.elements.page;
    input.max = matter.documents.find(doc => doc.id === form.elements.documentId.value)?.pages.length ?? 1;
    if (Number(input.value) > Number(input.max)) input.value = input.max;
  };
  form.elements.documentId.addEventListener('change', updateMax);
  updateMax();
}

function reasonDialog(title, label, work, value = '') {
  showDialog(title, `<form class="dialog-body">
    <label class="form-field"><span>${escape(label)}</span><textarea name="reason" required rows="3" maxlength="500" autofocus>${escape(value)}</textarea></label>
    ${errorSlot}<div class="dialog-actions">${cancelButton()}${submitButton('Save review')}</div></form>`);
  bindForm(data => work(data.reason));
}

function exportDialog() {
  const matter = state.matter;
  const review = reviewState(matter);
  if (review.current) {
    const snapshot = review.current;
    showDialog('Export approved chronology', `<div class="dialog-body">
      <div class="choice-box">Version ${snapshot.version} · ${snapshot.events.length} verified event${snapshot.events.length === 1 ? '' : 's'} · Approved by ${escape(snapshot.approvedBy)}</div>
      <p>Source links reopen the original page in this workspace.</p>
      <div class="version-downloads">
        ${button('Download CSV', 'download-version', 'Download', 'primary', attribute('id', snapshot.id) + ' data-format="csv"')}
        ${button('Source manifest', 'download-version', 'FileJson', '', attribute('id', snapshot.id) + ' data-format="json"')}
      </div></div>`);
    return;
  }
  const blocked = review.pending || review.gaps || review.limited || !review.verified;
  if (blocked) {
    const needs = [
      review.pending ? review.pending + ' open event' + (review.pending === 1 ? '' : 's') : '',
      review.gaps ? review.gaps + ' flagged page' + (review.gaps === 1 ? '' : 's') : '',
      review.limited ? 'draft event limit reached' : '',
      !review.verified ? 'at least one verified event required' : '',
    ].filter(Boolean);
    showDialog('Finish review before export', `<div class="dialog-body">
      <p>Resolve the open items before approving this draft.</p><div class="choice-box">${escape(needs.join(' · '))}</div>
      <div class="dialog-actions">${matter.approvals.length ? button('Approved versions', 'nav', 'History', '', 'data-screen="approvals"') : ''}
        ${button(review.gaps ? 'Review flagged pages' : 'Back to chronology', 'finish-review', 'ArrowRight', 'primary')}</div></div>`);
    return;
  }
  showDialog('Approve chronology', `<form class="dialog-body">
    <p>Save a reviewed version of the chronology. This version can be exported from Approvals.</p>
    <div class="choice-box">${review.verified} verified event${review.verified === 1 ? '' : 's'} · ${matter.documents.length} source PDF${matter.documents.length === 1 ? '' : 's'}</div>
    <label class="check-label"><input type="checkbox" name="confirm" required><span>I reviewed the events and their cited pages.</span></label>
    ${errorSlot}<div class="dialog-actions">${cancelButton()}${submitButton('Approve chronology')}</div></form>`);
  bindForm(async data => {
    await mutate('approve', { attested: data.confirm === 'on' });
    render();
    exportDialog();
    toast('Chronology approved.');
  }, { close: false });
}

function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

async function downloadVersion(id, format) {
  const matter = state.matter;
  const snapshot = matter.approvals.find(item => item.id === id);
  if (!snapshot) throw new Error('That approved version is unavailable.');
  const blob = state.store.info.mode === 'server' ? await state.store.approvedExport(matter, snapshot, format)
    : new Blob([exportSnapshot(snapshot, format, location.origin)], { type: format === 'json' ? 'application/json' : 'text/csv;charset=utf-8' });
  download(blob, exportName(snapshot, format));
  toast(format === 'json' ? 'Source manifest downloaded.' : 'Approved chronology downloaded.');
}

function showOriginal(docId, page, scroll = false) {
  chooseSource(docId, page);
  navigate('chronology');
  if (scroll && window.matchMedia('(max-width: 760px)').matches) app.querySelector('#original-source')?.scrollIntoView({ block: 'start' });
}

const view = { state, button, pill, attribute, escape, field, option, showDialog, bindForm,
  errorSlot, cancelButton, submitButton, icon, render, toast, download, dialog };
const tools = matterTools(view);
const portal = portalUI(view);
view.openSource = item => {
  if (dialog.open) dialog.close();
  showOriginal(item.dataset.id, item.dataset.page, true);
};
const matterTeamView = matterTeam(view);
view.recovery = tools;
view.portal = portal;
const workflows = workflowUI(view);
const officeWorkflows = officeUI(view);
const actions = {
  ...workflows.actions,
  ...officeWorkflows.actions,
  ...tools.actions,
  ...portal.actions,
  ...matterTeamView.actions,
  'toggle-menu': () => { state.menu = !state.menu; render(); },
  nav: async item => {
    if (dialog.open) dialog.close();
    if (item.dataset.screen === 'matters') state.matters = await state.store.list();
    navigate(item.dataset.screen);
    if (item.dataset.screen === 'team' && state.store.info.team) await matterTeamView.actions['team-load']();
  },
  'new-matter': newMatter,
  'open-matter': item => {
    if (dialog.open) dialog.close();
    return openMatter(item.dataset.id, { screen: item.dataset.screen });
  },
  import: importDialog,
  export: exportDialog,
  'close-modal': () => dialog.close(),
  'finish-review': () => {
    dialog.close();
    if (reviewState(state.matter).gaps) navigate('documents');
    else { state.filter = 'needs_review'; pickVisibleEvent(state.selection); navigate('chronology'); }
  },
  'toggle-search': () => {
    state.searchOpen = !state.searchOpen;
    if (!state.searchOpen) state.query = '';
    render();
    if (state.searchOpen) app.querySelector('#event-search')?.focus();
  },
  filter: item => {
    state.filter = item.dataset.filter;
    pickVisibleEvent(state.selection);
    navigate('chronology');
  },
  'select-event': item => {
    chooseEvent(state.matter.events.find(event => event.id === item.dataset.id), true);
    updateUrl();
    render();
    app.querySelector('[data-action="select-event"][aria-pressed="true"]')?.focus({ preventScroll: true });
  },
  'add-event': () => eventDialog(),
  edit: () => eventDialog(selected()),
  cite: () => { const event = selected(); if (event) showOriginal(event.documentId, event.page, true); },
  verify: async () => {
    const event = selected();
    if (!event) return;
    if (state.docId !== event.documentId || state.page !== event.page) {
      showOriginal(event.documentId, event.page, true);
      toast('Source opened. Review the page before verifying.');
      return;
    }
    state.saving = true;
    try {
      await mutate('events/' + event.id, { action: 'verify' });
      pickVisibleEvent(event.id);
      updateUrl();
      render();
      toast('Event verified.');
    } finally { state.saving = false; }
  },
  reopen: async () => {
    const event = selected();
    if (!event) return;
    state.saving = true;
    try {
      await mutate('events/' + event.id, { action: 'reopen' });
      pickVisibleEvent(event.id);
      updateUrl();
      render();
      toast('Event reopened for review.');
    } finally { state.saving = false; }
  },
  exclude: () => {
    const event = selected();
    if (!event) return;
    reasonDialog('Exclude event', 'Reason for exclusion', async reason => {
      await mutate('events/' + event.id, { action: 'exclude', reason });
      pickVisibleEvent(event.id);
      updateUrl();
      render();
      toast('Event excluded.');
    });
  },
  'view-doc': item => showOriginal(item.dataset.id, item.dataset.page || 1, true),
  'review-gap': item => {
    const docId = item.dataset.id;
    const page = Number(item.dataset.page);
    reasonDialog('Review PDF page ' + page, 'How did you handle this page?', async reason => {
      await mutate('page-review', { documentId: docId, page, reason });
      render();
      toast('Page review recorded.');
    }, state.matter.pageReviews[docId + ':' + page]?.reason);
  },
  'prev-page': () => { chooseSource(state.docId, state.page - 1); updateUrl(); render(); },
  'next-page': () => { chooseSource(state.docId, state.page + 1); updateUrl(); render(); },
  'zoom-out': () => { state.zoom = Math.max(70, state.zoom - 15); render(); },
  'zoom-in': () => { state.zoom = Math.min(175, state.zoom + 15); render(); },
  'zoom-fit': () => { state.zoom = 100; render(); },
  original: async item => {
    const doc = item.dataset.id ? state.matter.documents.find(doc => doc.id === item.dataset.id) : source();
    if (!doc) return;
    const bytes = await state.store.original(state.matter, doc);
    download(new Blob([bytes], { type: 'application/pdf' }), doc.name);
    toast('Original PDF downloaded.');
  },
  'download-version': item => downloadVersion(item.dataset.id, item.dataset.format),
};

document.addEventListener('click', event => {
  const item = event.target.closest('[data-action]');
  if (!item || item.disabled || state.saving || !state.store) return;
  const run = actions[item.dataset.action];
  if (run) Promise.resolve().then(() => run(item)).catch(error => toast(error.message, true));
});
dialog.addEventListener('cancel', event => { if (state.saving) event.preventDefault(); });
app.addEventListener('change', event => {
  if (event.target.id === 'source-picker') showOriginal(event.target.value, 1);
});
app.addEventListener('input', event => {
  if (event.target.id !== 'event-search') return;
  state.query = event.target.value;
  const items = visibleEvents();
  const before = state.selection;
  pickVisibleEvent(before);
  const slot = app.querySelector('#event-list-slot');
  slot.innerHTML = items.length ? `<ul class="event-list" aria-label="Chronology events">${items.map(eventRow).join('')}</ul>`
    : empty('Search', 'No matching events', 'Try a different filter or search.');
  if (before !== state.selection) {
    const detail = app.querySelector('.detail');
    if (detail) detail.remove();
    slot.insertAdjacentHTML('afterend', eventDetail());
    const panel = app.querySelector('.source-panel');
    if (panel) panel.outerHTML = sourcePanel();
    void paintPdf(app.querySelector('#pdf-viewport'));
    updateUrl();
  }
});
let resize;
window.addEventListener('resize', () => {
  clearTimeout(resize);
  resize = setTimeout(() => { const viewport = app.querySelector('#pdf-viewport'); if (viewport) void paintPdf(viewport); }, 160);
});

async function boot() {
  try {
    state.store = await openStore();
    state.matters = await state.store.list();
    const query = new URLSearchParams(location.search);
    const id = query.get('matter');
    const initial = state.matters.find(item => item.id === id) ?? state.matters[0];
    if (initial) {
      await openMatter(initial.id, { screen: query.get('view'), docId: query.get('document'), page: Number(query.get('page')) });
      if (id && id !== initial.id) toast('That source is unavailable in this workspace.', true);
    } else {
      state.screen = 'matters';
      render();
    }
  } catch (error) {
    app.innerHTML = `<div class="boot"><div class="empty">${icon('CircleAlert', 24)}<strong>Briefcase could not open</strong>
      <span>${escape(error.message)}</span><a href="/">Reload workspace</a></div></div>`;
  }
}

void boot();
