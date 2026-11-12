import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { workflows } from '../server/workbench.mjs';

// A small DOM protocol harness exercises rendering and form submission without
// claiming layout/browser coverage. Duplicate named text controls intentionally
// follow RadioNodeList.value behavior (empty string), exposing real form collisions.
const source = await readFile(new URL('../dist/workbench-ui.mjs', import.meta.url), 'utf8');
const metadata = workflow => ({ ...workflow, formats: ['json', ...(workflow.formats ?? [])] });
async function boot({ workflow, selected = false, actor = 'staff', data = {}, output = {}, status = 'draft' }) {
  const events = new Map(), posts = [], elements = new Map();
  let ready;
  const completed = new Promise(resolve => { ready = resolve; });
  const element = id => {
    if (!elements.has(id)) elements.set(id, {
      id, value: id === 'workflow-choice' ? workflow.roleId : '', innerHTML: '', textContent: '', dataset: {},
      addEventListener(type, callback) { events.set(id + ':' + type, callback); },
      querySelector(selector) { return selector === '#source-matter' ? element('source-matter') : element(selector.slice(1)); },
      querySelectorAll() { return []; },
      setAttribute(name, value) { this[name] = value; if (id === 'workbench' && name === 'aria-busy' && value === 'false') ready(); },
    });
    return elements.get(id);
  };
  const root = element('workbench');
  const item = {
    id: 'fixture-item', roleId: workflow.roleId, title: 'Assigned specialist work', assignee: 'staff', reviewer: 'lawyer', matter: 'matter-1',
    revision: 7, status, data, submission: { number: 1, sha256: 'a'.repeat(64) },
    versions: [{ number: 1, sha256: 'a'.repeat(64), output, sources: [{ name: 'Source fixture', documentId: 'doc-1', page: 1 }], decision: status === 'approved' ? { action: 'approve', by: 'lawyer' } : null }],
    history: [{ actor: 'staff', action: 'submit', at: '2026-11-12T12:00:00.000Z' }],
  };
  const catalog = { workflows: [metadata(workflow)], items: [], roster: [{ username: 'staff', name: 'Specialist', role: 'preparer' }, { username: 'lawyer', name: 'Lawyer', role: 'lawyer' }] };
  const location = { search: selected ? '?item=fixture-item' : '', href: '' };
  const sandbox = {
    document: { querySelector: selector => element(selector.slice(1)) }, location, URLSearchParams,
    crypto: { randomUUID: () => '11111111-1111-4111-8111-111111111111' },
    fetch: async (path, options = {}) => {
      if (options.method === 'POST') { posts.push({ path, body: JSON.parse(options.body) }); return { ok: true, json: async () => ({ item }) }; }
      const response = path === '/api/bootstrap' ? { username: actor, role: actor === 'lawyer' ? 'lawyer' : 'preparer' } :
        path === '/api/workbench' ? catalog : path === '/api/workbench/fixture-item' ? { item, validation: { errors: [], warnings: [] } } :
          path === '/api/matters' ? [{ id: 'matter-1', name: 'Matter fixture' }] : { documents: [{ id: 'doc-1', name: 'Source fixture' }] };
      return { ok: true, json: async () => structuredClone(response) };
    },
    btoa: value => Buffer.from(value, 'binary').toString('base64'), Uint8Array, setTimeout, clearTimeout,
  };
  // Function-valued metadata isn't JSON in the real API; strip it before cloning.
  catalog.workflows = JSON.parse(JSON.stringify(catalog.workflows));
  vm.runInNewContext(source + '\nglobalThis.__uiTest = { arraySchema, rowsMarkup, editorRows, syncRows, applyJson };', sandbox, { filename: 'workbench-ui.mjs' });
  await completed;
  assert.equal(element('workbench-status').dataset.error, undefined, element('workbench-status').textContent);
  return { root, element, events, posts, location, item, ui: sandbox.__uiTest };
}
const unescape = value => value.replaceAll('&quot;', '"').replaceAll('&#39;', "'").replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');
function collection(controls) {
  const groups = new Map();
  for (const [name, value] of controls) { const group = groups.get(name) ?? []; group.push({ name, value, checked: false, files: [] }); groups.set(name, group); }
  const result = { namedItem(name) { const group = groups.get(name); return group?.length === 1 ? group[0] : group ? { value: '', length: group.length } : null; } };
  for (const name of groups.keys()) Object.defineProperty(result, name, { get: () => result.namedItem(name) });
  return result;
}

test('workbench UI renders every role without crashing and restricts action forms to the assigned actor', async () => {
  for (const workflow of workflows) {
    const preparer = await boot({ workflow, selected: true });
    const reviewer = await boot({ workflow, selected: true, actor: 'lawyer', status: 'submitted' });
    assert.ok(preparer.root.innerHTML.includes(workflow.roleId), workflow.roleId);
    for (const action of workflow.actions) {
      const token = 'data-command="' + action.id + '"';
      assert.equal(preparer.root.innerHTML.includes(token), !action.reviewerOnly, workflow.roleId + ' preparer ' + action.id);
      assert.equal(reviewer.root.innerHTML.includes(token), Boolean(action.reviewerOnly), workflow.roleId + ' reviewer ' + action.id);
    }
    assert.ok(reviewer.root.innerHTML.includes('id="review-specialist"'), workflow.roleId);
    assert.ok(!reviewer.root.innerHTML.includes('data-command="submit"'), workflow.roleId);
  }
});

test('document workflow creation keeps assignment and domain titles separate in the submitted payload', async () => {
  const workflow = workflows.find(row => row.roleId === 'R26');
  const { element, events, posts, location } = await boot({ workflow });
  const controls = [
    ['roleId', 'R26'], ['title', 'Assignment title'], ['assignee', 'staff'], ['reviewer', 'lawyer'], ['matter', 'matter-1'],
  ];
  const html = element('create-domain-fields').innerHTML;
  for (const match of html.matchAll(/<(input|textarea|select)\b[^>]*\bname="([^"]+)"/g)) {
    const name = unescape(match[2]);
    const definition = workflow.fields.find(field => name === field.name || name.endsWith('.' + field.name) || name.endsWith('_' + field.name));
    assert.ok(definition, 'Unknown domain control ' + name);
    controls.push([name, definition.name === 'title' ? 'Exhibit packet title' : '[{"documentId":"doc-1","label":"Exhibit A","pages":[1]}]']);
  }
  const form = { id: 'create-specialist', elements: collection(controls), querySelectorAll: () => [] };
  await events.get('workbench:submit')({ preventDefault() {}, target: form });
  assert.equal(posts.length, 1, element('workbench-status').textContent);
  assert.equal(posts[0].body.title, 'Assignment title');
  assert.equal(posts[0].body.data.title, 'Exhibit packet title');
  assert.ok(location.href.includes('fixture-item'));
});

test('reviewers can inspect the entire long draft before approval and rendered evidence escapes markup', async () => {
  const tail = 'CRITICAL_CLAUSE_AT_THE_END';
  const longDraft = 'Ordinary draft text. '.repeat(130) + tail;
  const { root } = await boot({ workflow: workflows.find(row => row.roleId === 'R39'), selected: true, actor: 'lawyer', status: 'submitted', output: { draft: longDraft, hostile: '<script>bad()</script>' } });
  assert.ok(root.innerHTML.includes(tail), 'The reviewer cannot inspect the end of the unapproved draft.');
  assert.ok(!root.innerHTML.includes('<script>bad()</script>'));
  assert.ok(root.innerHTML.includes('&lt;script&gt;bad()&lt;/script&gt;'));
});

test('invalid JSON in a domain action stays local and never sends a partial mutation', async () => {
  const workflow = workflows.find(row => row.roleId === 'R42');
  const { events, element, posts } = await boot({ workflow, selected: true });
  const action = workflow.actions.find(row => row.id === 'set-distributions');
  // Obtain the renderer's control name so this checks the same namespace used by the UI.
  const html = element('workbench').innerHTML;
  const formBody = html.split('data-command="set-distributions"')[1].split('</form>')[0];
  const controlName = unescape(formBody.match(/name="([^"]+)"/)[1]);
  const form = { id: '', dataset: { command: action.id }, elements: collection([[controlName, '[not valid json]']]), querySelectorAll: () => [] };
  await events.get('workbench:submit')({ preventDefault() {}, target: form });
  assert.equal(posts.length, 0);
  assert.match(element('workbench-status').textContent, /valid JSON/);
});

test('changing source matter preserves typed workflow fields and exposes copyable source references', async () => {
  const workflow = workflows.find(row => row.roleId === 'R39');
  const { element, events } = await boot({ workflow });
  const fields = element('create-domain-fields');
  fields.innerHTML = '<textarea name="data.claims">typed claim not yet submitted</textarea>';
  const entered = fields.innerHTML;
  await events.get('workbench:change')({ target: { id: 'source-matter', value: 'matter-1', dataset: {} } });
  assert.equal(fields.innerHTML, entered, 'Changing matter discarded in-progress inputs.');
  assert.match(element('source-reference-list').innerHTML, /data-copy-reference="doc-1"/);
  assert.match(element('source-reference-list').innerHTML, /Source fixture/);
  assert.match(element('source-reference-list').innerHTML, /\/api\/matters\/matter-1\/documents\/doc-1\/original/);
});

test('common record arrays provide add/remove rows, source dropdowns and retain advanced JSON import', async () => {
  for (const roleId of ['R26', 'R39', 'R48', 'R52', 'R65']) {
    const workflow = workflows.find(row => row.roleId === roleId);
    const { root, ui } = await boot({ workflow, selected: true });
    const arrayFields = [...workflow.fields, ...workflow.actions.flatMap(action => action.fields)].filter(field => ui.arraySchema(field, workflow));
    assert.ok(arrayFields.length, roleId + ' has no structured row editor');
    const creation = await boot({ workflow });
    const rendered = root.innerHTML + creation.element('create-domain-fields').innerHTML;
    assert.match(rendered, /data-json-editor/, roleId);
    assert.match(rendered, /data-add-row/, roleId);
    assert.match(rendered, /Advanced JSON and file import/, roleId);
    const field = arrayFields.find(field => ui.arraySchema(field, workflow).columns.some(column => /documentId$/i.test(column.name)));
    if (field) {
      const schema = ui.arraySchema(field, workflow);
      const row = Object.fromEntries(schema.columns.map(column => [column.name, column.name === 'documentId' ? 'doc-1' : column.type === 'number' ? 1 : 'Fixture']));
      const html = ui.rowsMarkup(schema, [row]);
      assert.match(html, /data-source-select/);
      assert.match(html, /value="doc-1" selected/);
      assert.match(html, /data-remove-row/);
    }
  }
});

test('structured rows serialize typed amounts and string lists without dropping additional imported fields', async () => {
  const workflow = workflows.find(row => row.roleId === 'R44');
  const { ui } = await boot({ workflow, selected: true });
  const schema = { primitive: false, columns: [{ name: 'id', type: 'text' }, { name: 'amountCents', type: 'number' }, { name: 'aliases', type: 'string-list' }] };
  const row = {
    dataset: { rowBase: JSON.stringify({ id: 'old', amountCents: 100, aliases: [], importedReference: { receipt: 'KEEP-THIS' } }) },
    querySelectorAll: () => [
      { dataset: { cellKey: 'id', cellType: 'text' }, value: 'payee-1' },
      { dataset: { cellKey: 'amountCents', cellType: 'number' }, value: '10001' },
      { dataset: { cellKey: 'aliases', cellType: 'string-list' }, value: 'Alias A\nAlias B' },
    ],
  };
  const textarea = { value: '' }, status = { textContent: '' };
  const editor = {
    dataset: { schema: JSON.stringify(schema) }, querySelectorAll: () => [row],
    querySelector: selector => selector === '[data-json]' ? textarea : status,
  };
  ui.syncRows(editor);
  const data = JSON.parse(textarea.value);
  assert.equal(data[0].amountCents, 10001);
  assert.deepEqual(data[0].aliases, ['Alias A', 'Alias B']);
  assert.deepEqual(data[0].importedReference, { receipt: 'KEEP-THIS' });
});

test('JSON edits rebuild structured rows, pause on malformed data and keep nested schemas in explicit import mode', async () => {
  const workflow = workflows.find(row => row.roleId === 'R23');
  const { ui } = await boot({ workflow, selected: true });
  assert.equal(ui.arraySchema(workflow.fields.find(field => field.name === 'memos'), workflow), null);
  const controls = new Map([
    ['[data-json]', { value: '[{"amountCents":1200,"reference":"Fixture"}]' }],
    ['[data-json-rows]', { innerHTML: '' }], ['[data-json-status]', { textContent: '' }],
  ]);
  const editor = { dataset: { schema: JSON.stringify({ primitive: false, columns: [{ name: 'amountCents', type: 'number' }, { name: 'reference', type: 'text' }] }) }, querySelector: selector => controls.get(selector) };
  ui.applyJson(editor);
  assert.equal(editor.dataset.invalidJson, 'false');
  assert.match(controls.get('[data-json-rows]').innerHTML, /value="1200"/);
  controls.get('[data-json]').value = '{broken';
  ui.applyJson(editor);
  assert.equal(editor.dataset.invalidJson, 'true');
  assert.equal(controls.get('[data-json-rows]').innerHTML, '');
  assert.match(controls.get('[data-json-status]').textContent, /paused/);
});

test('Add row, cell edits and Remove update the canonical submitted JSON through delegated UI events', async () => {
  const workflow = workflows.find(row => row.roleId === 'R42');
  const { events } = await boot({ workflow, selected: true });
  const schema = { primitive: false, columns: [{ name: 'id', type: 'text' }, { name: 'amountCents', type: 'number' }] };
  let rows = [];
  const textarea = { value: '[]' }, status = { textContent: '' };
  const rowsContainer = {
    set innerHTML(value) {
      rows = [...value.matchAll(/data-row-base="([^"]+)"/g)].map(match => {
        const original = JSON.parse(unescape(match[1]));
        const controls = schema.columns.map(column => ({ dataset: { cellKey: column.name, cellType: column.type }, value: String(original[column.name] ?? ''), closest: () => editor }));
        const row = { dataset: { rowBase: JSON.stringify(original) }, controls, querySelectorAll: () => controls, remove() { rows = rows.filter(value => value !== row); } };
        return row;
      });
    },
  };
  const editor = {
    dataset: { schema: JSON.stringify(schema) }, querySelectorAll: () => rows,
    querySelector: selector => selector === '[data-json]' ? textarea : selector === '[data-json-status]' ? status : rowsContainer,
  };
  const button = name => ({ dataset: {}, hasAttribute: attr => attr === name, closest: selector => selector === '[data-entry-row]' ? rows[0] : editor });
  await events.get('workbench:click')({ target: { closest: () => button('data-add-row') } });
  assert.equal(rows.length, 1);
  rows[0].controls[0].value = 'beneficiary-1';
  rows[0].controls[1].value = '12345';
  await events.get('workbench:input')({ target: rows[0].controls[1] });
  assert.deepEqual(JSON.parse(textarea.value), [{ id: 'beneficiary-1', amountCents: 12345 }]);
  await events.get('workbench:click')({ target: { closest: () => button('data-remove-row') } });
  assert.deepEqual(JSON.parse(textarea.value), []);
});
