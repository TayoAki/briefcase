import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { workflows } from '../server/workflows/finance-people.mjs';
const pdf = readFileSync(new URL('./fixtures/digital.pdf', import.meta.url));
const hash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const sourceSha = createHash('sha256').update(pdf).digest('hex');
const defs = Object.fromEntries(workflows.map(row => [row.roleId, row]));
function context(reviews = false, extras = {}) {
  return { roleId: 'R48', user: { username: reviews ? 'reviewer' : 'preparer', firm: 'test', role: reviews ? 'lawyer' : 'preparer', desk: [] },
    matterId: 'test-matter', now: '2026-11-12T12:00:00.000Z', isReviewer: reviews, hash, finance: { assertUnique() {} },
    fail(status, message) { throw Object.assign(new Error(message), { status }); },
    source(id) { if (id !== 'statement-pdf') this.fail(404, 'Missing source'); return { id, sha256: sourceSha, bytes: pdf, name: 'Statement.pdf', pages: [{ number: 1, text: 'Fictional records' }] }; },
    sourceBinding(id) { const doc = this.source(id); return { documentId: id, sha256: doc.sha256, name: doc.name }; }, ...extras };
}
const ctx = context(), review = context(true);
const opening = { period: '2026-11-12', currency: 'USD', opening: { operating: 0, trust: 0 } };
const entry = (id, bankId, account, amountCents) => ({ id, bankId, account, amountCents, date: '2026-11-01', reference: 'external-ledger:' + id });
function imported(role = 'R48', entries = [entry('entry-op', 'bank-op', 'operating', 12000), entry('entry-trust', 'bank-trust', 'trust', 20000)]) {
  let state = defs[role].create(opening, ctx);
  state = defs[role].update(state, 'import-entries', { batchReference: 'ledger-batch-a', entries }, ctx);
  return state;
}
function statement(role, state, account, closingCents, lines, reference = 'statement:' + account) {
  state = defs[role].update(state, 'import-statement', { account, reference, documentId: 'statement-pdf', closingCents, lines }, ctx);
  const current = state.statements.filter(row => row.account === account).at(-1);
  return defs[role].update(state, 'approve-statement', { account, sha256: current.sha256, notes: 'Compared imported rows with the source PDF.' }, review);
}
function balanced(role = 'R48') {
  let state = imported(role);
  state = statement(role, state, 'operating', 12000, [{ id: 'bank-op', amountCents: 12000 }]);
  return statement(role, state, 'trust', 20000, [{ id: 'bank-trust', amountCents: 20000 }]);
}
const rejects = (call, status = 422) => assert.throws(call, error => error.status === status);

test('R48 reconciles operating and trust independently against exact reviewed source statements', () => {
  const def = defs.R48;
  let state = imported();
  assert.equal(def.validate(state, ctx).errors.length, 2);
  state = def.update(state, 'import-statement', { account: 'operating', reference: 'statement:operating', documentId: 'statement-pdf', closingCents: 12000, lines: [{ id: 'bank-op', amountCents: 12000 }] }, ctx);
  const approval = { account: 'operating', sha256: state.statements[0].sha256, notes: 'Reviewed.' };
  rejects(() => def.update(state, 'approve-statement', approval, ctx), 403);
  rejects(() => def.update(state, 'approve-statement', { ...approval, sha256: 'stale' }, review), 409);
  state = def.update(state, 'approve-statement', approval, review);
  state = statement('R48', state, 'trust', 20000, [{ id: 'bank-trust', amountCents: 20000 }]);
  assert.deepEqual(def.validate(state, ctx).errors, []);
  const report = def.output(state, ctx);
  assert.deepEqual(report.accounts.map(row => [row.account, row.ledgerClosingCents, row.statementClosingCents]), [['operating', 12000, 12000], ['trust', 20000, 20000]]);
  assert.equal(report.accounts[0].source.sha256, sourceSha);
  const tampered = context(false, { source: () => ({ sha256: 'changed' }) });
  assert.match(def.validate(state, tampered).errors.join(' '), /source has changed/);
  // Equal combined totals cannot hide misallocation between operating and trust.
  state = statement('R48', state, 'operating', 20000, [{ id: 'bank-op', amountCents: 20000 }], 'amended:operating');
  state = statement('R48', state, 'trust', 12000, [{ id: 'bank-trust', amountCents: 12000 }], 'amended:trust');
  assert.equal(def.validate(state, ctx).errors.filter(row => row.includes('do not reconcile')).length, 2);
});

test('R49 blocks unmatched signoff and preserves original entry while appending its correction', () => {
  const def = defs.R49;
  let state = imported('R49', [entry('wrong', 'bank-op', 'operating', 13000), entry('trust', 'bank-trust', 'trust', 20000)]);
  state = statement('R49', state, 'operating', 12000, [{ id: 'bank-op', amountCents: 12000 }]);
  state = statement('R49', state, 'trust', 20000, [{ id: 'bank-trust', amountCents: 20000 }]);
  assert.match(def.validate(state, ctx).errors.join(' '), /unmatched/);
  const prior = structuredClone(state.entries[0]);
  state = def.update(state, 'correct-entry', { entryId: 'wrong', reversalId: 'reverse-wrong', reason: 'Corrected source amount', replacement: entry('correct', 'bank-op', 'operating', 12000) }, ctx);
  assert.deepEqual(state.entries[0], prior);
  assert.equal(state.entries.find(row => row.id === 'reverse-wrong').amountCents, -13000);
  assert.equal(state.entries.find(row => row.id === 'correct').replaces, 'wrong');
  assert.deepEqual(def.validate(state, ctx).errors, []);
  rejects(() => def.update(state, 'reverse-entry', { entryId: 'wrong', reversalId: 'second', reason: 'Again' }, ctx), 409);
  state = def.update(state, 'record-exception', { id: 'ex-1', reason: 'Outstanding source review' }, ctx);
  assert.match(def.validate(state, ctx).errors.join(' '), /Unresolved/);
  rejects(() => def.update(state, 'resolve-exception', { id: 'ex-1', evidence: 'ticket-cleared' }, ctx), 403);
  state = def.update(state, 'resolve-exception', { id: 'ex-1', evidence: 'review-ticket-cleared' }, review);
  assert.deepEqual(def.validate(state, ctx).errors, []);
});

test('R50 deduplicates vendor invoices and separates approval from recorded payment', () => {
  const def = defs.R50;
  let state = def.create({ currency: 'USD' }, ctx);
  const input = { vendorReference: 'vendor-alpha', invoiceNumber: 'INV-A', amountCents: 5000, due: '2026-12-01', documentId: 'statement-pdf' };
  state = def.update(state, 'import-invoice', input, ctx);
  state = def.update(state, 'import-invoice', input, ctx);
  assert.equal(state.invoices.length, 1);
  rejects(() => def.update(state, 'import-invoice', { ...input, amountCents: 6000 }, ctx), 409);
  const invoice = state.invoices[0], payment = { invoiceKey: invoice.key, receiptReference: 'pay-receipt-a', amountCents: 2000 };
  rejects(() => def.update(state, 'record-payment', payment, ctx), 409);
  rejects(() => def.update(state, 'approve-invoice', { invoiceKey: invoice.key, sha256: invoice.sha256, notes: 'Verified' }, ctx), 403);
  state = def.update(state, 'approve-invoice', { invoiceKey: invoice.key, sha256: invoice.sha256, notes: 'Verified source invoice' }, review);
  assert.equal(state.payments.length, 0);
  assert.equal(def.output(state, ctx).invoices[0].status, 'approved-awaiting-payment');
  state = def.update(state, 'record-payment', payment, ctx);
  state = def.update(state, 'record-payment', payment, ctx);
  assert.equal(state.payments.length, 1);
  assert.equal(def.output(state, ctx).invoices[0].remainingCents, 3000);
  rejects(() => def.update(state, 'record-payment', { ...payment, receiptReference: 'pay-b', amountCents: 4000 }, ctx), 409);
  assert.deepEqual(def.validate(state, ctx).errors, []);
});

test('R51 repeated external transaction imports do not alter balances and reversals retain history', () => {
  const def = defs.R51, entries = [entry('entry-op', 'bank-op', 'operating', 12000), entry('entry-trust', 'bank-trust', 'trust', 20000)];
  let state = imported('R51', entries);
  state = def.update(state, 'import-entries', { batchReference: 'ledger-batch-a', entries }, ctx);
  state = def.update(state, 'import-entries', { batchReference: 'another-report', entries }, ctx);
  assert.equal(state.entries.length, 2);
  assert.equal(def.output(state, ctx).accounts[0].ledgerClosingCents, 12000);
  rejects(() => def.update(state, 'import-entries', { batchReference: 'third', entries: [entry('entry-op', 'bank-op', 'operating', 999)] }, ctx), 409);
  state = def.update(state, 'reverse-entry', { entryId: 'entry-op', reversalId: 'rev-a', reason: 'External transaction reversed' }, ctx);
  assert.equal(state.entries[0].amountCents, 12000);
  assert.equal(state.entries.at(-1).reversalOf, 'entry-op');
  assert.equal(def.output(state, ctx).accounts[0].ledgerClosingCents, 0);
  state = statement('R51', state, 'operating', 0, []);
  state = statement('R51', state, 'trust', 20000, [{ id: 'bank-trust', amountCents: 20000 }]);
  assert.deepEqual(def.validate(state, ctx).errors, []);
});

test('R52 rejection returns the same invoice for a new exact revision while preserving both submissions', () => {
  const def = defs.R52, lines = [{ code: 'L100', description: 'Work reviewed', quantity: 2, unitCents: 12000 }];
  let state = def.create({ invoiceReference: 'INV-52', clientReference: 'client-a', currency: 'USD', lines }, ctx);
  const first = structuredClone(state.versions[0]);
  rejects(() => def.update(state, 'record-submission', { reference: 'provider-a', sha256: first.sha256 }, ctx), 409);
  state = def.update(state, 'authorize-submission', { sha256: first.sha256, notes: 'Reviewed exact version' }, review);
  state = def.update(state, 'record-submission', { reference: 'provider-a', sha256: first.sha256 }, ctx);
  state = def.update(state, 'record-result', { submissionReference: 'provider-a', result: 'rejected', receiptReference: 'result-a', reason: 'Billing code rejected' }, ctx);
  assert.equal(def.validate(state, ctx).errors.length, 1);
  state = def.update(state, 'correct-invoice', { lines: [{ ...lines[0], code: 'L110' }], reason: 'Correct billing code' }, ctx);
  assert.equal(state.invoiceReference, 'INV-52');
  assert.deepEqual(state.versions[0], first);
  const second = state.versions[1];
  rejects(() => def.update(state, 'record-submission', { reference: 'provider-b', sha256: second.sha256 }, ctx), 409);
  state = def.update(state, 'authorize-submission', { sha256: second.sha256, notes: 'Reviewed correction' }, review);
  state = def.update(state, 'record-submission', { reference: 'provider-b', sha256: second.sha256 }, ctx);
  state = def.update(state, 'record-result', { submissionReference: 'provider-b', result: 'accepted', receiptReference: 'result-b', reason: 'Provider accepted' }, ctx);
  assert.equal(state.submissions.length, 2);
  assert.deepEqual(state.submissions.map(row => row.sha256), [first.sha256, second.sha256]);
  assert.deepEqual(def.validate(state, ctx).errors, []);
  rejects(() => def.update(state, 'correct-invoice', { lines, reason: 'Overwrite accepted' }, ctx), 409);
});

test('R53 partial payment reduces only the selected balance and write-off requires current reviewer authorization', () => {
  const def = defs.R53;
  let state = def.create({ currency: 'USD' }, ctx);
  for (const invoiceId of ['a', 'b']) state = def.update(state, 'add-invoice', { invoiceId, clientReference: 'client-' + invoiceId, amountCents: 10000, reference: 'ledger-' + invoiceId }, ctx);
  const payment = { receiptReference: 'payment-a', invoiceId: 'a', amountCents: 4000 };
  state = def.update(state, 'allocate-payment', payment, ctx);
  state = def.update(state, 'allocate-payment', payment, ctx);
  assert.deepEqual(def.output(state, ctx).invoices.map(row => row.balanceCents), [6000, 10000]);
  rejects(() => def.update(state, 'allocate-payment', { ...payment, invoiceId: 'b' }, ctx), 409);
  state = def.update(state, 'request-writeoff', { requestId: 'wo-a', invoiceId: 'a', amountCents: 6000, reason: 'Proposed adjustment' }, ctx);
  assert.equal(def.output(state, ctx).invoices[0].balanceCents, 6000);
  assert.match(def.validate(state).errors.join(' '), /Pending/);
  const approval = { requestId: 'wo-a', sha256: state.writeoffs[0].sha256, notes: 'Adjustment reviewed' };
  rejects(() => def.update(state, 'approve-writeoff', approval, ctx), 403);
  rejects(() => def.update(state, 'approve-writeoff', { ...approval, sha256: 'wrong' }, review), 409);
  state = def.update(state, 'approve-writeoff', approval, review);
  assert.deepEqual(def.output(state, ctx).invoices.map(row => row.balanceCents), [0, 10000]);
  assert.deepEqual(def.validate(state).errors, []);
  state = def.update(state, 'request-writeoff', { requestId: 'wo-b', invoiceId: 'b', amountCents: 10000, reason: 'Proposed adjustment' }, ctx);
  const staleHash = state.writeoffs.at(-1).sha256;
  state = def.update(state, 'allocate-payment', { receiptReference: 'payment-b', invoiceId: 'b', amountCents: 2000 }, ctx);
  rejects(() => def.update(state, 'approve-writeoff', { requestId: 'wo-b', sha256: staleHash, notes: 'Old amount' }, review), 409);
  state = def.update(state, 'cancel-writeoff', { requestId: 'wo-b', reason: 'Balance changed after payment' }, ctx);
  assert.equal(state.writeoffs.at(-1).canceled.by, 'preparer');
  assert.equal(def.output(state, ctx).invoices[1].balanceCents, 8000);
  assert.deepEqual(def.validate(state).errors, []);
});

test('R54 returned trust payment reopens discrepancy and blocks signoff until an amended statement reconciles', () => {
  const def = defs.R54;
  let state = balanced('R54');
  assert.deepEqual(def.validate(state, ctx).errors, []);
  const approvedBeforeReturn = structuredClone(state);
  def.assertExport(state, approvedBeforeReturn, ctx);
  state = def.update(state, 'return-payment', { entryId: 'entry-trust', reversalId: 'return-a', bankId: 'bank-return-a', reason: 'Bank return receipt-a' }, ctx);
  const report = def.output(state, ctx);
  rejects(() => def.assertExport(state, approvedBeforeReturn, ctx), 409);
  assert.equal(report.accounts[1].ledgerClosingCents, 0);
  assert.equal(report.accounts[1].differenceCents, -20000);
  assert.match(def.validate(state, ctx).errors.join(' '), /do not reconcile/);
  assert.equal(state.entries.find(row => row.id === 'entry-trust').amountCents, 20000);
  state = statement('R54', state, 'trust', 0, [{ id: 'bank-trust', amountCents: 20000 }, { id: 'bank-return-a', amountCents: -20000 }], 'trust-amended-a');
  assert.deepEqual(def.validate(state, ctx).errors, []);
  rejects(() => def.update(state, 'return-payment', { entryId: 'entry-op', reversalId: 'return-op', reason: 'Wrong account' }, ctx));
  state = def.update(state, 'record-exception', { id: 'unresolved', reason: 'Unexplained variance' }, ctx);
  assert.match(def.validate(state, ctx).errors.join(' '), /Unresolved/);
});

test('R56 limits names sent to conflicts and gives recruiting a status-only projection', () => {
  const def = defs.R56, names = [{ name: 'Private Former Client', relationship: 'former client' }];
  let state = def.create({ candidateReference: 'candidate-abc', names }, ctx);
  rejects(() => def.create({ candidateReference: 'candidate-abc', names, salary: 200000 }, ctx));
  rejects(() => def.create({ candidateReference: 'candidate-abc', names: [{ ...names[0], interviewNotes: 'Private notes' }] }, ctx));
  rejects(() => def.update(state, 'record-clearance', { namesHash: state.namesHash, status: 'clear', reference: 'conflicts-abc' }, ctx), 403);
  assert.deepEqual(def.project(state, review).names, names);
  state = def.update(state, 'record-clearance', { namesHash: state.namesHash, status: 'conditions', reference: 'conflicts-abc' }, review);
  assert.equal(def.output(state).clearance, 'conditions');
  assert.doesNotMatch(JSON.stringify(def.project(state, ctx)), /Private Former Client|former client/);
  assert.deepEqual(def.validate(state).errors, []);
  const priorHash = state.namesHash;
  state = def.update(state, 'replace-names', { names: [{ name: 'Another Party', relationship: 'adverse party' }] }, ctx);
  assert.equal(def.output(state).clearance, 'pending');
  assert.equal(def.validate(state).errors.length, 1);
  rejects(() => def.update(state, 'record-clearance', { namesHash: priorHash, status: 'clear', reference: 'conflicts-b' }, review), 409);
});

test('R58 rejects payroll/banking payloads and matter linkage, then acknowledges only current provider status', () => {
  const def = defs.R58, payrollCtx = context(false, { matterId: null }), financeCtx = context(true, { matterId: null });
  const input = { runReference: 'payrun-Nov-a', periodEnd: '2026-11-30', status: 'pending' };
  rejects(() => def.create(input, ctx));
  rejects(() => def.create({ ...input, bankAccount: '123456789' }, payrollCtx));
  rejects(() => def.create({ ...input, runReference: 'bank-123456789' }, payrollCtx));
  let state = def.create(input, payrollCtx);
  rejects(() => def.update(state, 'record-status', { status: 'processed', receiptReference: 'receipt-a', payees: [] }, payrollCtx));
  state = def.update(state, 'record-status', { status: 'processed', receiptReference: 'receipt-payroll-a' }, payrollCtx);
  const current = state.statuses.at(-1);
  rejects(() => def.update(state, 'acknowledge-finance', { statusHash: current.sha256 }, payrollCtx), 403);
  rejects(() => def.update(state, 'acknowledge-finance', { statusHash: 'old' }, financeCtx), 409);
  state = def.update(state, 'acknowledge-finance', { statusHash: current.sha256 }, financeCtx);
  assert.deepEqual(def.validate(state).errors, []);
  assert.equal(def.output(state).currentStatus.status, 'processed');
  assert.equal(def.output(state).financeAcknowledgment.by, 'reviewer');
  assert.doesNotMatch(JSON.stringify(state), /bankAccount|payees|amountCents/);
  state = def.update(state, 'record-status', { status: 'failed', receiptReference: 'receipt-payroll-b' }, payrollCtx);
  assert.equal(def.validate(state).errors.length, 1);
});

// Exercise the same domain actions through persisted, authenticated routes so a
// pure function result cannot be mistaken for a working end-to-end role path.
test('R48–R54, R56 and R58 complete authenticated review/export with per-role gates and tenant denial', async t => {
  const { buildApp } = await import('../server/app.mjs');
  const { randomUUID } = await import('node:crypto');
  const users = [
    { username: 'owner', role: 'lawyer', firm: 'alpha' },
    { username: 'staff', role: 'preparer', firm: 'alpha', desk: workflows.map(row => row.roleId) },
    { username: 'unrelated', role: 'lawyer', firm: 'alpha' },
    { username: 'foreign', role: 'lawyer', firm: 'beta' },
  ].map(row => ({ ...row, password: 'synthetic-' + row.username + '-secret' }));
  const server = buildApp({ database: ':memory:', users });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = 'http://127.0.0.1:' + server.address().port;
  async function call(user, path, body, expected = 200) {
    const binary = Buffer.isBuffer(body);
    const headers = { Authorization: 'Basic ' + Buffer.from(user + ':synthetic-' + user + '-secret').toString('base64') };
    if (body) Object.assign(headers, { 'X-Briefcase-Request': '1', 'Content-Type': binary ? 'application/pdf' : 'application/json', ...(binary ? { 'X-PDF-Name': 'Financial evidence.pdf', 'X-PDF-Purpose': 'supporting' } : {}) });
    const response = await fetch(origin + path, { method: body ? 'POST' : 'GET', headers, body: body && (binary ? body : JSON.stringify(body)) });
    const result = response.headers.get('content-type')?.includes('application/json') ? await response.json() : await response.arrayBuffer();
    assert.equal(response.status, expected, result?.error);
    return result;
  }
  const matter = await call('owner', '/api/matters', { name: 'Finance role synthetic evidence' }, 201);
  await call('owner', `/api/matters/${matter.id}/team`, { action: 'grant', username: 'staff', access: 'prepare' });
  const uploaded = await call('owner', `/api/matters/${matter.id}/documents`, pdf, 201);
  const documentId = uploaded.document.id;
  for (const roleId of workflows.map(row => row.roleId)) {
    await t.test(roleId + ' persisted acceptance', async () => {
      const data = ['R48', 'R49', 'R51', 'R54'].includes(roleId) ? { ...opening, period: new Date().toISOString().slice(0, 10) } : roleId === 'R52' ?
        { invoiceReference: 'INV-52', clientReference: 'client-a', currency: 'USD', lines: [{ code: 'L100', description: 'Work', quantity: 1, unitCents: 12000 }] } : roleId === 'R56' ?
        { candidateReference: 'candidate-abc', names: [{ name: 'Confidential Former Client', relationship: 'former client' }] } : roleId === 'R58' ?
        { runReference: 'payroll-run-a', periodEnd: '2026-11-30', status: 'pending' } : { currency: 'USD' };
      const createInput = { requestId: randomUUID(), roleId, title: roleId + ' acceptance', assignee: 'staff', reviewer: 'owner', matter: ['R56', 'R58'].includes(roleId) ? null : matter.id, data };
      let item = (await call('owner', '/api/workbench', createInput, 201)).item;
      const id = item.id, path = '/api/workbench/' + id;
      assert.equal((await call('owner', '/api/workbench', createInput)).item.id, id);
      await call('foreign', path, undefined, 404);
      await call('unrelated', path, undefined, 404);
      async function command(action, data, as = 'staff', expected = 200) {
        const result = await call(as, path, { action, data, revision: item.revision }, expected);
        if (expected === 200) item = result.item;
        return result;
      }
      const zeroOp = { account: 'operating', reference: 'op-statement', documentId, closingCents: 0, lines: [] };
      if (['R48', 'R49', 'R51', 'R54'].includes(roleId)) {
        const entries = [entry('book-op', 'bank-op', 'operating', roleId === 'R49' ? 13000 : 12000), entry('book-trust', 'bank-trust', 'trust', 20000)];
        await command('import-entries', { batchReference: 'batch-one', entries });
        if (roleId === 'R51') {
          await command('import-entries', { batchReference: 'batch-two', entries });
          assert.equal(item.data.entries.length, 2);
          await command('reverse-entry', { entryId: 'book-op', reversalId: 'reverse-op', reason: 'Correcting the entry' });
        }
        for (const account of ['operating', 'trust']) {
          const amount = account === 'operating' ? 12000 : 20000;
          await command('import-statement', roleId === 'R51' && account === 'operating' ? zeroOp : { account, reference: account + '-statement', documentId, closingCents: amount, lines: [{ id: 'bank-' + (account === 'operating' ? 'op' : 'trust'), amountCents: amount }] });
          const current = item.data.statements.filter(row => row.account === account).at(-1);
          await command('approve-statement', { account, sha256: current.sha256, notes: 'Checked actual uploaded PDF.' }, 'staff', 403);
          await command('approve-statement', { account, sha256: current.sha256, notes: 'Checked actual uploaded PDF.' }, 'owner');
        }
        if (roleId === 'R49') {
          await call('staff', path, { action: 'submit', revision: item.revision }, 422);
          await command('correct-entry', { entryId: 'book-op', reversalId: 'reverse-op', reason: 'Correct source amount', replacement: entry('correct-op', 'bank-op', 'operating', 12000) });
          assert.equal(item.data.entries.find(row => row.id === 'book-op').amountCents, 13000);
        }
        if (roleId === 'R54') {
          await command('return-payment', { entryId: 'book-trust', reversalId: 'return-trust', bankId: 'bank-return', reason: 'Return receipt' });
          await call('staff', path, { action: 'submit', revision: item.revision }, 422);
          await command('import-statement', { account: 'trust', reference: 'trust-amended', documentId, closingCents: 0, lines: [{ id: 'bank-trust', amountCents: 20000 }, { id: 'bank-return', amountCents: -20000 }] });
          const current = item.data.statements.at(-1);
          await command('approve-statement', { account: 'trust', sha256: current.sha256, notes: 'Reviewed return.' }, 'owner');
        }
      } else if (roleId === 'R50') {
        const invoice = { vendorReference: 'vendor-a', invoiceNumber: 'INV-A', amountCents: 5000, due: '2026-12-01', documentId };
        await command('import-invoice', invoice);
        await command('import-invoice', invoice);
        assert.equal(item.data.invoices.length, 1);
        const current = item.data.invoices[0];
        await command('record-payment', { invoiceKey: current.key, receiptReference: 'payment-a', amountCents: 5000 }, 'staff', 409);
        await command('approve-invoice', { invoiceKey: current.key, sha256: current.sha256, notes: 'Reviewed vendor invoice' }, 'owner');
        assert.equal(item.data.payments.length, 0);
        await command('record-payment', { invoiceKey: current.key, receiptReference: 'payment-a', amountCents: 5000 });
      } else if (roleId === 'R52') {
        let current = item.data.versions.at(-1);
        await command('authorize-submission', { sha256: current.sha256, notes: 'Reviewed invoice' }, 'owner');
        await command('record-submission', { reference: 'submission-a', sha256: current.sha256 });
        await command('record-result', { submissionReference: 'submission-a', result: 'rejected', receiptReference: 'result-a', reason: 'Bad code' });
        await command('correct-invoice', { lines: [{ code: 'L110', description: 'Work', quantity: 1, unitCents: 12000 }], reason: 'Corrected code' });
        current = item.data.versions.at(-1);
        await command('authorize-submission', { sha256: current.sha256, notes: 'Reviewed correction' }, 'owner');
        await command('record-submission', { reference: 'submission-b', sha256: current.sha256 });
        await command('record-result', { submissionReference: 'submission-b', result: 'accepted', receiptReference: 'result-b', reason: 'Accepted' });
        assert.equal(item.data.submissions.length, 2);
      } else if (roleId === 'R53') {
        await command('add-invoice', { invoiceId: 'invoice-a', clientReference: 'client-a', amountCents: 10000, reference: 'ledger-a' });
        await command('allocate-payment', { invoiceId: 'invoice-a', receiptReference: 'pay-a', amountCents: 4000 });
        await command('request-writeoff', { requestId: 'wo-a', invoiceId: 'invoice-a', amountCents: 6000, reason: 'Adjustment proposed' });
        await call('staff', path, { action: 'submit', revision: item.revision }, 422);
        await command('approve-writeoff', { requestId: 'wo-a', sha256: item.data.writeoffs[0].sha256, notes: 'Approved adjustment' }, 'owner');
      } else if (roleId === 'R56') {
        assert.doesNotMatch(JSON.stringify(await call('staff', path)), /Confidential Former Client/);
        await command('record-clearance', { namesHash: item.data.namesHash, status: 'conditions', reference: 'conflicts-a' }, 'owner');
        assert.equal(item.data.names[0].name, 'Confidential Former Client');
        assert.doesNotMatch(JSON.stringify(await call('staff', path)), /Confidential Former Client/);
      } else if (roleId === 'R58') {
        await command('record-status', { status: 'processed', receiptReference: 'payroll-result-a' });
        await command('acknowledge-finance', { statusHash: item.data.statuses.at(-1).sha256 }, 'owner');
      }
      assert.deepEqual((await call('owner', path)).validation.errors, []);
      item = (await call('staff', path, { action: 'submit', revision: item.revision })).item;
      const submission = item.submission;
      await call('staff', path, { action: 'approve', revision: item.revision, sha256: submission.sha256, attested: true, notes: 'Wrong reviewer' }, 403);
      item = (await call('owner', path, { action: 'approve', revision: item.revision, sha256: submission.sha256, attested: true, notes: 'Reviewed exact work and source evidence.' })).item;
      const artifact = await call('staff', path + '/export?format=json');
      assert.equal(artifact.roleId, roleId);
      assert.equal(item.status, 'approved');
      if (roleId === 'R56') assert.doesNotMatch(JSON.stringify(artifact), /Confidential Former Client|former client/);
      await call('foreign', path + '/export?format=json', undefined, 404);
      // Explicitly asking for the earlier approved version cannot bypass a
      // changed balance, permission-sensitive clearance, or provider status.
      if (['R48', 'R49', 'R51', 'R54'].includes(roleId)) {
        await command('record-exception', { id: 'new-exception', reason: 'New unresolved source discrepancy' });
      } else if (roleId === 'R50') {
        await command('import-invoice', { vendorReference: 'vendor-new', invoiceNumber: 'INV-NEW', amountCents: 9000, due: '2026-12-01', documentId });
      } else if (roleId === 'R52') {
        await command('authorize-submission', { sha256: item.data.versions.at(-1).sha256, notes: 'Additional review event' }, 'owner');
      } else if (roleId === 'R53') {
        await command('add-invoice', { invoiceId: 'invoice-b', clientReference: 'client-b', amountCents: 3000, reference: 'ledger-b' });
      } else if (roleId === 'R56') {
        await command('replace-names', { names: [{ name: 'New Relevant Party', relationship: 'adverse party' }] });
      } else if (roleId === 'R58') {
        await command('record-status', { status: 'failed', receiptReference: 'payroll-result-b' });
      }
      await call('staff', path + '/export?format=json&version=' + submission.number, undefined, 409);
      assert.equal((await call('owner', path)).item.versions[0].decision.action, 'approve');
    });
  }
});

test('financial reference registry fails closed when unavailable', () => {
  const unavailable = context(false, { finance: null });
  const def = defs.R50, state = def.create({ currency: 'USD' }, unavailable);
  rejects(() => def.update(state, 'import-invoice', { vendorReference: 'vendor-a', invoiceNumber: 'INV-A', amountCents: 1000, due: '2026-12-01', documentId: 'statement-pdf' }, unavailable), 503);
});

test('financial invoice and receipt references are unique across workspaces within a firm, independently reusable by another firm', async t => {
  const { buildApp } = await import('../server/app.mjs');
  const { randomUUID } = await import('node:crypto');
  const users = [{ username: 'owner', role: 'lawyer', firm: 'alpha' }, { username: 'staff', role: 'preparer', firm: 'alpha', desk: ['R50', 'R52', 'R53'] }, { username: 'foreign', role: 'lawyer', firm: 'beta' }]
    .map(row => ({ ...row, password: 'synthetic-' + row.username + '-secret' }));
  const server = buildApp({ database: ':memory:', users });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = 'http://127.0.0.1:' + server.address().port;
  async function call(user, path, body, expected = 200) {
    const binary = Buffer.isBuffer(body), headers = { Authorization: 'Basic ' + Buffer.from(user + ':synthetic-' + user + '-secret').toString('base64') };
    if (body) Object.assign(headers, { 'X-Briefcase-Request': '1', 'Content-Type': binary ? 'application/pdf' : 'application/json', ...(binary ? { 'X-PDF-Name': 'Invoice evidence.pdf', 'X-PDF-Purpose': 'supporting' } : {}) });
    const response = await fetch(origin + path, { method: body ? 'POST' : 'GET', headers, body: body && (binary ? body : JSON.stringify(body)) });
    const result = await response.json(); assert.equal(response.status, expected, result?.error); return result;
  }
  const sources = {};
  for (const user of ['owner', 'foreign']) {
    const matter = await call(user, '/api/matters', { name: 'Scoped finance source' }, 201);
    if (user === 'owner') await call(user, `/api/matters/${matter.id}/team`, { action: 'grant', username: 'staff', access: 'prepare' });
    const { document } = await call(user, `/api/matters/${matter.id}/documents`, pdf, 201);
    sources[user] = { matterId: matter.id, documentId: document.id };
  }
  async function workspace(roleId, owner = 'owner', data = { currency: 'USD' }, expected = 201) {
    const assignee = owner === 'owner' ? 'staff' : owner;
    const result = await call(owner, '/api/workbench', { requestId: randomUUID(), roleId, title: roleId + ' registry fixture', assignee, reviewer: owner, matter: sources[owner].matterId, data }, expected);
    if (expected !== 201) return result;
    return { item: result.item, owner, assignee, async command(action, data, review = false, status = 200) {
      const result = await call(review ? this.owner : this.assignee, '/api/workbench/' + this.item.id, { revision: this.item.revision, action, data }, status);
      if (status === 200) this.item = result.item;
      return result;
    } };
  }
  const vendor = { vendorReference: 'vendor-a', invoiceNumber: 'INV-A', amountCents: 5000, due: '2026-12-01' };
  const firstAP = await workspace('R50'), secondAP = await workspace('R50'), foreignAP = await workspace('R50', 'foreign');
  await firstAP.command('import-invoice', { ...vendor, documentId: sources.owner.documentId });
  await secondAP.command('import-invoice', { ...vendor, documentId: sources.owner.documentId }, false, 409);
  await foreignAP.command('import-invoice', { ...vendor, documentId: sources.foreign.documentId });
  await secondAP.command('import-invoice', { ...vendor, invoiceNumber: 'INV-B', documentId: sources.owner.documentId });
  for (const work of [firstAP, secondAP, foreignAP]) {
    const invoice = work.item.data.invoices[0];
    await work.command('approve-invoice', { invoiceKey: invoice.key, sha256: invoice.sha256, notes: 'Exact invoice reviewed.' }, true);
  }
  const payment = { receiptReference: 'payment:unique-a', amountCents: 2000 };
  await firstAP.command('record-payment', { ...payment, invoiceKey: firstAP.item.data.invoices[0].key });
  await secondAP.command('record-payment', { ...payment, invoiceKey: secondAP.item.data.invoices[0].key }, false, 409);
  await foreignAP.command('record-payment', { ...payment, invoiceKey: foreignAP.item.data.invoices[0].key });

  const firstAR = await workspace('R53'), secondAR = await workspace('R53'), foreignAR = await workspace('R53', 'foreign');
  const receivable = { invoiceId: 'receivable-a', clientReference: 'client-a', amountCents: 10000, reference: 'ledger:receivable-a' };
  await firstAR.command('add-invoice', receivable);
  await secondAR.command('add-invoice', receivable, false, 409);
  await foreignAR.command('add-invoice', receivable);
  await secondAR.command('add-invoice', { ...receivable, invoiceId: 'receivable-b' });
  const allocation = { receiptReference: 'receipt:unique-a', invoiceId: 'receivable-a', amountCents: 4000 };
  await firstAR.command('allocate-payment', allocation);
  await secondAR.command('allocate-payment', { ...allocation, invoiceId: 'receivable-b' }, false, 409);
  await foreignAR.command('allocate-payment', allocation);

  const invoiceData = { invoiceReference: 'billing-invoice-a', clientReference: 'client-a', currency: 'USD', lines: [{ code: 'L100', description: 'Work', quantity: 1, unitCents: 1000 }] };
  const firstBill = await workspace('R52', 'owner', invoiceData);
  await workspace('R52', 'owner', invoiceData, 409);
  const secondBill = await workspace('R52', 'owner', { ...invoiceData, invoiceReference: 'billing-invoice-b' });
  const foreignBill = await workspace('R52', 'foreign', invoiceData);
  for (const work of [firstBill, secondBill, foreignBill]) await work.command('authorize-submission', { sha256: work.item.data.versions[0].sha256, notes: 'Reviewed invoice.' }, true);
  await firstBill.command('record-submission', { reference: 'provider-submission-a', sha256: firstBill.item.data.versions[0].sha256 });
  await secondBill.command('record-submission', { reference: 'provider-submission-a', sha256: secondBill.item.data.versions[0].sha256 }, false, 409);
  await foreignBill.command('record-submission', { reference: 'provider-submission-a', sha256: foreignBill.item.data.versions[0].sha256 });
  await secondBill.command('record-submission', { reference: 'provider-submission-b', sha256: secondBill.item.data.versions[0].sha256 });
  const result = { submissionReference: 'provider-submission-a', result: 'accepted', receiptReference: 'provider-result-a', reason: 'Accepted' };
  await firstBill.command('record-result', result);
  await secondBill.command('record-result', { ...result, submissionReference: 'provider-submission-b' }, false, 409);
  await foreignBill.command('record-result', result);
});
