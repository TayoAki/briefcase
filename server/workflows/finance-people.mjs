// Amounts are integer minor units. These workspaces import and reconcile evidence;
// they do not move funds or claim a live banking/accounting/payroll connection.
const clone = value => structuredClone(value);
const field = (name, label, type = 'text', extra = {}) => ({ name, label, type, ...extra });
const text = (value, label, ctx, max = 180) => {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) ctx.fail(422, `${label} is required (up to ${max} characters).`);
  return value.trim();
};
const money = (value, label, ctx, positive = false) => {
  if (!Number.isSafeInteger(value) || Math.abs(value) > 1_000_000_000_000 || (positive && value <= 0)) ctx.fail(422, `${label} must be ${positive ? 'positive ' : ''}integer cents within the supported range.`);
  return value;
};
const sum = (values, ctx) => money(values.reduce((total, value) => total + value, 0), 'Total', ctx);
const rows = (value, label, ctx, max = 500) => {
  if (!Array.isArray(value) || !value.length || value.length > max) ctx.fail(422, `${label} must contain 1–${max} rows.`);
  return value;
};
const choice = (value, choices, label, ctx) => {
  if (!choices.includes(value)) ctx.fail(422, `Choose a supported ${label}.`);
  return value;
};
const only = (input, keys, ctx) => {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !keys.includes(key))) ctx.fail(422, 'Unexpected fields are not accepted in this workflow.');
};
const date = (value, ctx) => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) ctx.fail(422, 'Use a valid date in YYYY-MM-DD format.');
  return value;
};
const reviewer = ctx => { if (!ctx.isReviewer) ctx.fail(403, 'The assigned reviewer must perform this action.'); };
const unique = (kind, key, ctx) => {
  if (!ctx.finance || typeof ctx.finance.assertUnique !== 'function') ctx.fail(503, 'The firm financial reference registry is unavailable.');
  ctx.finance.assertUnique(kind, key);
};
const action = (id, label, fields, reviewerOnly = false) => ({ id, label, fields, reviewerOnly });
const event = (state, ctx, type, details = {}) => {
  state.history.push({ type, actor: ctx.user.username, at: ctx.now, ...details });
  return state;
};
const source = (id, ctx) => ctx.sourceBinding(text(id, 'Source PDF', ctx));
const sourceCheck = (binding, ctx, errors) => {
  try {
    const doc = ctx.source(binding.documentId);
    if (doc.sha256 !== binding.sha256) errors.push('A bound source has changed.');
  } catch { errors.push('A bound source is no longer available.'); }
};
const idempotent = (list, key, value, ctx) => {
  const existing = list.find(row => row[key] === value[key]);
  if (existing && ctx.hash(existing) !== ctx.hash(value)) ctx.fail(409, 'This reference already identifies different data.');
  return existing;
};
const accountChoices = ['operating', 'trust'];
const ledgerFields = [field('period', 'Period ending', 'date', { required: true }),
  field('currency', 'Currency', 'select', { options: ['USD', 'GBP', 'EUR', 'CAD', 'AUD'], required: true }),
  field('opening', 'Opening balances in cents', 'json', { hint: '{"operating":0,"trust":0}', required: true })];
const entriesFields = [field('batchReference', 'External ledger batch reference', 'text', { required: true }),
  field('entries', 'Ledger entries', 'json', { hint: '[{"id":"entry-1","bankId":"bank-1","account":"operating","amountCents":12500,"date":"2026-11-01","reference":"Ledger transaction 1"}]', required: true })];
const statementFields = [field('account', 'Account', 'select', { options: accountChoices }), field('reference', 'External statement reference'),
  field('documentId', 'Statement PDF document ID'), field('closingCents', 'Statement closing balance (cents)', 'number'),
  field('lines', 'Statement transactions', 'json', { hint: '[{"id":"bank-1","amountCents":12500}]' })];
function createLedger(input, ctx) {
  only(input, ['period', 'currency', 'opening'], ctx);
  only(input.opening, accountChoices, ctx);
  return { period: date(input.period, ctx), currency: choice(input.currency, ['USD', 'GBP', 'EUR', 'CAD', 'AUD'], 'currency', ctx),
    opening: Object.fromEntries(accountChoices.map(account => [account, money(input.opening[account], `${account} opening`, ctx)])),
    entries: [], batches: [], statements: [], approvals: [], history: [], exceptions: [] };
}
function ledgerEntry(input, batchReference, ctx) {
  only(input, ['id', 'bankId', 'account', 'amountCents', 'date', 'reference'], ctx);
  return { id: text(input.id, 'Ledger entry ID', ctx, 100), bankId: text(input.bankId, 'Statement transaction ID', ctx, 100),
    account: choice(input.account, accountChoices, 'account', ctx), amountCents: money(input.amountCents, 'Amount', ctx),
    date: date(input.date, ctx), reference: text(input.reference, 'External ledger reference', ctx), batchReference };
}
function currentStatement(state, account) { return state.statements.filter(row => row.account === account).at(-1); }
function ledgerReport(state, ctx) {
  const reports = accountChoices.map(account => {
    const entries = state.entries.filter(row => row.account === account);
    const statement = currentStatement(state, account);
    const byBankId = new Map();
    for (const entry of entries) byBankId.set(entry.bankId, sum([byBankId.get(entry.bankId) || 0, entry.amountCents], ctx));
    const lines = new Map((statement?.lines ?? []).map(line => [line.id, line.amountCents]));
    const unmatched = [...new Set([...byBankId.keys(), ...lines.keys()])].flatMap(id => {
      const ledgerCents = byBankId.get(id) || 0, statementCents = lines.get(id) || 0;
      return ledgerCents === statementCents ? [] : [{ id, ledgerCents, statementCents, differenceCents: ledgerCents - statementCents }];
    });
    const ledgerClosingCents = sum([state.opening[account], ...entries.map(row => row.amountCents)], ctx);
    const computedStatementClosingCents = statement ? sum([state.opening[account], ...statement.lines.map(row => row.amountCents)], ctx) : null;
    const approval = statement && state.approvals.find(row => row.statementHash === statement.sha256);
    return { account, openingCents: state.opening[account], ledgerClosingCents, statementClosingCents: statement?.closingCents ?? null,
      computedStatementClosingCents, differenceCents: statement ? ledgerClosingCents - statement.closingCents : null,
      statementReference: statement?.reference ?? null, statementHash: statement?.sha256 ?? null, source: statement?.source ?? null,
      statementReviewedBy: approval?.by ?? null, unmatched, entries: clone(entries) };
  });
  return { currency: state.currency, period: state.period, mode: 'manually imported external ledger and statement', accounts: reports,
    exceptions: clone(state.exceptions), history: clone(state.history) };
}
function updateLedger(previous, name, input, ctx) {
  const state = clone(previous);
  if (name === 'import-entries') {
    only(input, ['batchReference', 'entries'], ctx);
    const batchReference = text(input.batchReference, 'External batch reference', ctx);
    const entries = rows(input.entries, 'Ledger entries', ctx).map(row => ledgerEntry(row, batchReference, ctx));
    if (new Set(entries.map(row => row.id)).size !== entries.length) ctx.fail(422, 'Duplicate IDs in this batch.');
    const hash = ctx.hash(entries);
    const existingBatch = state.batches.find(row => row.reference === batchReference);
    if (existingBatch) {
      if (existingBatch.sha256 !== hash) ctx.fail(409, 'This external batch reference already identifies different rows.');
      return state;
    }
    for (const entry of entries) {
      const old = state.entries.find(row => row.id === entry.id);
      if (old) {
        // Re-importing the same external transaction from another report is harmless.
        const { batchReference: oldBatch, ...oldFields } = old;
        const { batchReference: newBatch, ...newFields } = entry;
        if (ctx.hash(oldFields) !== ctx.hash(newFields)) ctx.fail(409, 'An external transaction ID already exists with different values.');
      } else state.entries.push(entry);
    }
    state.batches.push({ reference: batchReference, sha256: hash, at: ctx.now });
    return event(state, ctx, name, { reference: batchReference, count: entries.length });
  }
  if (name === 'import-statement') {
    only(input, ['account', 'reference', 'documentId', 'closingCents', 'lines'], ctx);
    const statement = { account: choice(input.account, accountChoices, 'account', ctx), reference: text(input.reference, 'Statement reference', ctx),
      source: source(input.documentId, ctx), closingCents: money(input.closingCents, 'Closing balance', ctx),
      lines: (input.lines?.length === 0 ? [] : rows(input.lines, 'Statement lines', ctx)).map(line => {
        only(line, ['id', 'amountCents'], ctx);
        return { id: text(line.id, 'Statement transaction ID', ctx, 100), amountCents: money(line.amountCents, 'Statement amount', ctx) };
      }) };
    if (new Set(statement.lines.map(row => row.id)).size !== statement.lines.length) ctx.fail(422, 'Statement transaction IDs must be unique.');
    statement.sha256 = ctx.hash(statement);
    const old = state.statements.find(row => row.reference === statement.reference && row.account === statement.account);
    if (old) { if (old.sha256 !== statement.sha256) ctx.fail(409, 'Use a new reference for an amended statement.'); return state; }
    state.statements.push(statement);
    return event(state, ctx, name, { account: statement.account, reference: statement.reference, sha256: statement.sha256 });
  }
  if (name === 'approve-statement') {
    reviewer(ctx);
    only(input, ['account', 'sha256', 'notes'], ctx);
    const statement = currentStatement(state, choice(input.account, accountChoices, 'account', ctx));
    if (!statement || statement.sha256 !== input.sha256) ctx.fail(409, 'Review the current imported statement hash.');
    const errors = []; sourceCheck(statement.source, ctx, errors);
    if (errors.length) ctx.fail(409, errors[0]);
    const approval = { statementHash: statement.sha256, by: ctx.user.username, at: ctx.now, notes: text(input.notes, 'Review notes', ctx, 600) };
    if (!state.approvals.some(row => row.statementHash === statement.sha256)) state.approvals.push(approval);
    return event(state, ctx, name, { account: statement.account, statementHash: statement.sha256 });
  }
  if (['reverse-entry', 'correct-entry', 'return-payment'].includes(name)) {
    only(input, name === 'correct-entry' ? ['entryId', 'reversalId', 'reason', 'replacement'] : name === 'return-payment' ? ['entryId', 'reversalId', 'bankId', 'reason'] : ['entryId', 'reversalId', 'reason'], ctx);
    const original = state.entries.find(row => row.id === input.entryId);
    if (!original || original.reversalOf) ctx.fail(422, 'Choose an original ledger entry.');
    if (name === 'return-payment' && (original.account !== 'trust' || original.amountCents <= 0)) ctx.fail(422, 'Choose a positive trust receipt to return.');
    if (name === 'return-payment' && input.bankId === original.bankId) ctx.fail(422, 'Use the distinct bank transaction ID for the return.');
    const reversalId = text(input.reversalId, 'New reversal ID', ctx, 100), reason = text(input.reason, 'Correction reason', ctx, 500);
    const priorReversal = state.entries.find(row => row.reversalOf === original.id);
    if (priorReversal) {
      if (priorReversal.id === reversalId && priorReversal.reason === reason && name !== 'correct-entry' && (name !== 'return-payment' || priorReversal.bankId === input.bankId)) return state;
      ctx.fail(409, 'This transaction has already been reversed; the original remains in history.');
    }
    if (state.entries.some(row => row.id === reversalId)) ctx.fail(409, 'Choose an unused reversal ID.');
    const reverse = { ...original, id: reversalId, amountCents: -original.amountCents, reversalOf: original.id,
      date: ctx.now.slice(0, 10), reason, batchReference: 'internal-correction',
      ...(name === 'return-payment' ? { bankId: text(input.bankId, 'Bank return transaction ID', ctx, 100) } : {}) };
    state.entries.push(reverse);
    if (name === 'correct-entry') {
      const replacement = ledgerEntry(input.replacement, 'correction:' + reversalId, ctx);
      if (state.entries.some(row => row.id === replacement.id)) ctx.fail(409, 'Choose an unused replacement entry ID.');
      state.entries.push({ ...replacement, replaces: original.id });
    }
    // Existing statement approvals remain history, but validation sees the new discrepancy.
    return event(state, ctx, name, { originalId: original.id, reversalId, reason });
  }
  if (name === 'record-exception') {
    only(input, ['id', 'reason'], ctx);
    const row = { id: text(input.id, 'Exception ID', ctx, 100), reason: text(input.reason, 'Exception', ctx, 600), status: 'open' };
    if (!idempotent(state.exceptions, 'id', row, ctx)) state.exceptions.push(row);
    return event(state, ctx, name, { id: row.id });
  }
  if (name === 'resolve-exception') {
    reviewer(ctx); only(input, ['id', 'evidence'], ctx);
    const row = state.exceptions.find(row => row.id === input.id);
    if (!row || row.status !== 'open') ctx.fail(409, 'Choose an open exception.');
    Object.assign(row, { status: 'resolved', evidence: text(input.evidence, 'Resolution evidence reference', ctx, 300), resolvedBy: ctx.user.username });
    return event(state, ctx, name, { id: row.id });
  }
  ctx.fail(422, 'Unknown ledger action.');
}
function validateLedger(state, ctx) {
  const errors = [];
  if (state.entries.some(row => row.date > state.period)) errors.push('Ledger entries after the period ending must be reconciled in a later period.');
  for (const account of ledgerReport(state, ctx).accounts) {
    const statement = currentStatement(state, account.account);
    if (!statement) { errors.push(`Import the ${account.account} statement, including a zero-activity statement if applicable.`); continue; }
    sourceCheck(statement.source, ctx, errors);
    if (!account.statementReviewedBy) errors.push(`The current ${account.account} statement needs reviewer approval.`);
    if (account.differenceCents !== 0 || account.computedStatementClosingCents !== account.statementClosingCents) errors.push(`${account.account} closing balances do not reconcile.`);
    if (account.unmatched.length) errors.push(`${account.account} contains unmatched transactions.`);
    if (account.account === 'trust' && account.ledgerClosingCents < 0) errors.push('Trust balance cannot be negative.');
  }
  if (state.exceptions.some(row => row.status === 'open')) errors.push('Unresolved reconciliation exceptions block signoff.');
  return { errors, warnings: ['Statements and transactions are manually imported evidence. No bank or accounting-provider connection is claimed.'] };
}
const ledgerActions = [action('import-entries', 'Import external ledger entries', entriesFields), action('import-statement', 'Import statement evidence', statementFields),
  action('approve-statement', 'Review current statement', [field('account', 'Account', 'select', { options: accountChoices }), field('sha256', 'Current statement hash'), field('notes', 'Review notes', 'textarea')], true),
  action('reverse-entry', 'Reverse a transaction', [field('entryId', 'Original entry ID'), field('reversalId', 'New reversal ID'), field('reason', 'Reason')]),
  action('correct-entry', 'Correct without overwriting history', [field('entryId', 'Original entry ID'), field('reversalId', 'New reversal ID'), field('reason', 'Reason'), field('replacement', 'Replacement transaction', 'json', { hint: '{"id":"correction-1","bankId":"bank-1","account":"operating","amountCents":12500,"date":"2026-11-01","reference":"Corrected ledger entry"}' })]),
  action('record-exception', 'Record reconciliation exception', [field('id', 'Exception ID'), field('reason', 'Issue')]),
  action('resolve-exception', 'Review exception resolution', [field('id', 'Exception ID'), field('evidence', 'Evidence reference')], true)];
function ledgerWorkflow(roleId, title, description) {
  return { roleId, title, description, matterRequired: true, fields: ledgerFields,
    actions: roleId === 'R54' ? [...ledgerActions, action('return-payment', 'Record returned trust payment', [field('entryId', 'Original receipt entry ID'), field('reversalId', 'Return ledger entry ID'), field('bankId', 'Bank return transaction ID'), field('reason', 'Return receipt reference')])] : ledgerActions,
    create: createLedger, update: updateLedger, validate: validateLedger, output: ledgerReport };
}

function createAP(input, ctx) {
  only(input, ['currency'], ctx);
  return { currency: choice(input.currency, ['USD', 'GBP', 'EUR', 'CAD', 'AUD'], 'currency', ctx), invoices: [], approvals: [], payments: [], history: [] };
}
function apOutput(state, ctx) {
  return { currency: state.currency, mode: 'invoice register and manually recorded payment receipts', invoices: state.invoices.map(invoice => {
    const payments = state.payments.filter(row => row.invoiceKey === invoice.key), paidCents = sum(payments.map(row => row.amountCents), ctx);
    const approval = state.approvals.find(row => row.invoiceHash === invoice.sha256);
    return { ...invoice, approvedBy: approval?.by ?? null, paidCents, remainingCents: invoice.amountCents - paidCents,
      status: !approval ? 'awaiting-approval' : paidCents === invoice.amountCents ? 'payment-recorded' : 'approved-awaiting-payment', payments };
  }), history: state.history };
}
function updateAP(previous, name, input, ctx) {
  const state = clone(previous);
  if (name === 'import-invoice') {
    only(input, ['vendorReference', 'invoiceNumber', 'amountCents', 'due', 'documentId'], ctx);
    const invoice = { vendorReference: text(input.vendorReference, 'Vendor reference', ctx), invoiceNumber: text(input.invoiceNumber, 'Invoice number', ctx),
      amountCents: money(input.amountCents, 'Invoice amount', ctx, true), due: date(input.due, ctx), source: source(input.documentId, ctx) };
    invoice.key = invoice.vendorReference.toLowerCase() + ':' + invoice.invoiceNumber.toLowerCase();
    invoice.sha256 = ctx.hash(invoice);
    if (idempotent(state.invoices, 'key', invoice, ctx)) return state;
    unique('ap-invoice', invoice.key, ctx);
    state.invoices.push(invoice); return event(state, ctx, name, { invoiceKey: invoice.key });
  }
  const invoice = state.invoices.find(row => row.key === input.invoiceKey);
  if (!invoice) ctx.fail(422, 'Choose an imported invoice.');
  if (name === 'approve-invoice') {
    reviewer(ctx); only(input, ['invoiceKey', 'sha256', 'notes'], ctx);
    if (invoice.sha256 !== input.sha256) ctx.fail(409, 'Review the current invoice hash.');
    const errors = []; sourceCheck(invoice.source, ctx, errors); if (errors.length) ctx.fail(409, errors[0]);
    if (!state.approvals.some(row => row.invoiceHash === invoice.sha256)) state.approvals.push({ invoiceHash: invoice.sha256, by: ctx.user.username, at: ctx.now, notes: text(input.notes, 'Review notes', ctx, 600) });
    return event(state, ctx, name, { invoiceKey: invoice.key });
  }
  if (name === 'record-payment') {
    only(input, ['invoiceKey', 'receiptReference', 'amountCents'], ctx);
    if (!state.approvals.some(row => row.invoiceHash === invoice.sha256)) ctx.fail(409, 'Invoice approval is required before a payment receipt can be recorded.');
    const payment = { invoiceKey: invoice.key, receiptReference: text(input.receiptReference, 'External payment receipt reference', ctx), amountCents: money(input.amountCents, 'Payment', ctx, true) };
    if (idempotent(state.payments, 'receiptReference', payment, ctx)) return state;
    unique('ap-receipt', payment.receiptReference, ctx);
    const paid = sum(state.payments.filter(row => row.invoiceKey === invoice.key).map(row => row.amountCents), ctx);
    if (paid + payment.amountCents > invoice.amountCents) ctx.fail(409, 'The payment exceeds this invoice balance.');
    state.payments.push(payment); return event(state, ctx, name, { invoiceKey: invoice.key, receiptReference: payment.receiptReference });
  }
  ctx.fail(422, 'Unknown accounts-payable action.');
}
const ap = { roleId: 'R50', title: 'Vendor invoices and payment evidence', matterRequired: true,
  description: 'Import invoices once, obtain a separate approval, and reconcile recorded external payments.', fields: [field('currency', 'Currency', 'select', { options: ['USD', 'GBP', 'EUR', 'CAD', 'AUD'] })],
  actions: [action('import-invoice', 'Import vendor invoice', [field('vendorReference', 'Vendor reference'), field('invoiceNumber', 'Invoice number'), field('amountCents', 'Amount (cents)', 'number'), field('due', 'Due date', 'date'), field('documentId', 'Invoice PDF document ID')]),
    action('approve-invoice', 'Approve exact invoice', [field('invoiceKey', 'Invoice key'), field('sha256', 'Invoice hash'), field('notes', 'Review notes')], true),
    action('record-payment', 'Record external payment receipt', [field('invoiceKey', 'Invoice key'), field('receiptReference', 'Payment receipt reference'), field('amountCents', 'Paid amount (cents)', 'number')])],
  create: createAP, update: updateAP, output: apOutput,
  validate(state, ctx) { const errors = []; if (!state.invoices.length) errors.push('Import at least one invoice.'); for (const invoice of state.invoices) {
    sourceCheck(invoice.source, ctx, errors); if (!state.approvals.some(row => row.invoiceHash === invoice.sha256)) errors.push(`Invoice ${invoice.invoiceNumber} needs approval.`);
  } return { errors, warnings: ['Approval does not execute payment. Payment receipts must come from the external payment system.'] }; } };

function invoiceLines(input, ctx) {
  return rows(input, 'Invoice lines', ctx, 100).map(row => {
    only(row, ['code', 'description', 'quantity', 'unitCents'], ctx);
    const quantity = row.quantity;
    if (!Number.isSafeInteger(quantity) || quantity <= 0 || quantity > 1_000_000) ctx.fail(422, 'Invoice quantities must be positive whole units.');
    const unitCents = money(row.unitCents, 'Unit rate', ctx, true);
    return { code: text(row.code, 'Billing code', ctx, 40), description: text(row.description, 'Line description', ctx, 300), quantity, unitCents, totalCents: money(quantity * unitCents, 'Line total', ctx, true) };
  });
}
function invoiceVersion(lines, number, ctx) { const version = { number, lines: invoiceLines(lines, ctx) }; version.totalCents = sum(version.lines.map(row => row.totalCents), ctx); version.sha256 = ctx.hash(version); return version; }
const billing = { roleId: 'R52', title: 'E-billing corrections and submission history',
  description: 'Review exact invoices, record provider responses, and revise rejected invoices without losing their history.',
  fields: [field('invoiceReference', 'Invoice reference'), field('clientReference', 'Client billing reference'), field('currency', 'Currency', 'select', { options: ['USD', 'GBP', 'EUR', 'CAD', 'AUD'] }), field('lines', 'Billing lines', 'json', { hint: '[{"code":"L100","description":"Reviewed work","quantity":2,"unitCents":12500}]' })],
  actions: [action('authorize-submission', 'Authorize current invoice revision', [field('sha256', 'Current invoice hash'), field('notes', 'Review notes')], true),
    action('record-submission', 'Record provider submission receipt', [field('reference', 'Provider submission reference'), field('sha256', 'Submitted invoice hash')]),
    action('record-result', 'Record provider result', [field('submissionReference', 'Submission reference'), field('result', 'Result', 'select', { options: ['accepted', 'rejected'] }), field('receiptReference', 'Provider result reference'), field('reason', 'Result details')]),
    action('correct-invoice', 'Correct rejected invoice', [field('lines', 'Corrected billing lines', 'json', { hint: '[{"code":"L100","description":"Corrected work","quantity":2,"unitCents":12500}]' }), field('reason', 'Correction reason')])],
  create(input, ctx) { only(input, ['invoiceReference', 'clientReference', 'currency', 'lines'], ctx); const invoiceReference = text(input.invoiceReference, 'Invoice reference', ctx); unique('billing-invoice', invoiceReference, ctx); return { invoiceReference, clientReference: text(input.clientReference, 'Client reference', ctx), currency: choice(input.currency, ['USD', 'GBP', 'EUR', 'CAD', 'AUD'], 'currency', ctx), versions: [invoiceVersion(input.lines, 1, ctx)], authorizations: [], submissions: [], results: [], history: [] }; },
  update(previous, name, input, ctx) {
    const state = clone(previous), version = state.versions.at(-1);
    if (name === 'authorize-submission') {
      reviewer(ctx); only(input, ['sha256', 'notes'], ctx); if (input.sha256 !== version.sha256) ctx.fail(409, 'Review the current invoice revision.');
      if (!state.authorizations.some(row => row.sha256 === version.sha256)) state.authorizations.push({ sha256: version.sha256, by: ctx.user.username, at: ctx.now, notes: text(input.notes, 'Review notes', ctx, 600) });
      return event(state, ctx, name, { sha256: version.sha256 });
    }
    if (name === 'record-submission') {
      only(input, ['reference', 'sha256'], ctx);
      if (version.sha256 !== input.sha256 || !state.authorizations.some(row => row.sha256 === version.sha256)) ctx.fail(409, 'Authorize the exact current invoice before submitting.');
      const record = { reference: text(input.reference, 'Provider submission reference', ctx), sha256: version.sha256, version: version.number };
      if (idempotent(state.submissions, 'reference', record, ctx)) return state;
      unique('billing-submission', record.reference, ctx);
      if (state.submissions.some(row => row.sha256 === version.sha256)) ctx.fail(409, 'A provider submission already exists for this revision. Record its result first.');
      state.submissions.push(record); return event(state, ctx, name, record);
    }
    if (name === 'record-result') {
      only(input, ['submissionReference', 'result', 'receiptReference', 'reason'], ctx);
      const submission = state.submissions.find(row => row.reference === input.submissionReference);
      if (!submission) ctx.fail(422, 'Choose an existing submission.');
      const record = { submissionReference: submission.reference, result: choice(input.result, ['accepted', 'rejected'], 'result', ctx), receiptReference: text(input.receiptReference, 'Provider result reference', ctx), reason: text(input.reason, 'Provider result details', ctx, 500) };
      if (idempotent(state.results, 'submissionReference', record, ctx)) return state;
      if (state.results.some(row => row.receiptReference === record.receiptReference)) ctx.fail(409, 'The provider result reference already belongs to another submission.');
      unique('billing-result', record.receiptReference, ctx);
      state.results.push(record); return event(state, ctx, name, record);
    }
    if (name === 'correct-invoice') {
      only(input, ['lines', 'reason'], ctx);
      const submission = state.submissions.find(row => row.sha256 === version.sha256);
      if (!submission || !state.results.some(row => row.submissionReference === submission.reference && row.result === 'rejected')) ctx.fail(409, 'Only a rejected invoice revision can be corrected.');
      state.versions.push(invoiceVersion(input.lines, version.number + 1, ctx));
      return event(state, ctx, name, { priorSha256: version.sha256, sha256: state.versions.at(-1).sha256, reason: text(input.reason, 'Correction reason', ctx, 500) });
    }
    ctx.fail(422, 'Unknown billing action.');
  },
  validate(state) { const current = state.versions.at(-1), submission = state.submissions.find(row => row.sha256 === current.sha256), result = submission && state.results.find(row => row.submissionReference === submission.reference); return { errors: result?.result === 'accepted' ? [] : ['The current invoice requires authorization, submission, and an accepted provider result.'], warnings: ['Provider submission and result references are manually recorded; no electronic billing network is connected.'] }; },
  output(state) { return clone(state); } };

const ar = { roleId: 'R53', title: 'Receivables, partial payments and write-offs', description: 'Allocate receipts to specific invoices and require separate approval for each write-off.',
  fields: [field('currency', 'Currency', 'select', { options: ['USD', 'GBP', 'EUR', 'CAD', 'AUD'] })],
  actions: [action('add-invoice', 'Import receivable', [field('invoiceId', 'Invoice ID'), field('clientReference', 'Client reference'), field('amountCents', 'Invoice amount (cents)', 'number'), field('reference', 'External ledger reference')]),
    action('allocate-payment', 'Allocate external receipt', [field('receiptReference', 'Unique receipt reference'), field('invoiceId', 'Invoice ID'), field('amountCents', 'Allocated amount (cents)', 'number')]),
    action('request-writeoff', 'Request write-off', [field('requestId', 'Request ID'), field('invoiceId', 'Invoice ID'), field('amountCents', 'Requested amount (cents)', 'number'), field('reason', 'Reason')]),
    action('approve-writeoff', 'Authorize write-off', [field('requestId', 'Request ID'), field('sha256', 'Write-off request hash'), field('notes', 'Review notes')], true),
    action('cancel-writeoff', 'Withdraw pending write-off', [field('requestId', 'Request ID'), field('reason', 'Withdrawal reason')])],
  create(input, ctx) { only(input, ['currency'], ctx); return { currency: choice(input.currency, ['USD', 'GBP', 'EUR', 'CAD', 'AUD'], 'currency', ctx), invoices: [], payments: [], writeoffs: [], history: [] }; },
  update(previous, name, input, ctx) {
    const state = clone(previous);
    if (name === 'add-invoice') {
      only(input, ['invoiceId', 'clientReference', 'amountCents', 'reference'], ctx);
      const invoice = { invoiceId: text(input.invoiceId, 'Invoice ID', ctx, 100), clientReference: text(input.clientReference, 'Client reference', ctx), amountCents: money(input.amountCents, 'Amount', ctx, true), reference: text(input.reference, 'External ledger reference', ctx) };
      if (idempotent(state.invoices, 'invoiceId', invoice, ctx)) return state;
      unique('ar-invoice', invoice.invoiceId, ctx);
      state.invoices.push(invoice); return event(state, ctx, name, { invoiceId: invoice.invoiceId });
    }
    if (name === 'cancel-writeoff') {
      only(input, ['requestId', 'reason'], ctx);
      const request = state.writeoffs.find(row => row.requestId === input.requestId);
      if (!request || request.approved || request.canceled) ctx.fail(409, 'Choose a pending write-off.');
      request.canceled = { by: ctx.user.username, at: ctx.now, reason: text(input.reason, 'Withdrawal reason', ctx, 500) };
      return event(state, ctx, name, { requestId: request.requestId });
    }
    if (name === 'approve-writeoff') {
      reviewer(ctx); only(input, ['requestId', 'sha256', 'notes'], ctx);
      const request = state.writeoffs.find(row => row.requestId === input.requestId);
      if (!request || request.sha256 !== input.sha256 || request.approved || request.canceled) ctx.fail(409, 'Review the current pending write-off request.');
      if (request.amountCents > arBalance(state, request.invoiceId, ctx)) ctx.fail(409, 'The balance changed; the write-off exceeds the current amount due.');
      request.approved = { by: ctx.user.username, at: ctx.now, notes: text(input.notes, 'Review notes', ctx, 500) };
      return event(state, ctx, name, { requestId: request.requestId });
    }
    const invoice = state.invoices.find(row => row.invoiceId === input.invoiceId);
    if (!invoice) ctx.fail(422, 'Choose an imported receivable.');
    if (name === 'allocate-payment') {
      only(input, ['receiptReference', 'invoiceId', 'amountCents'], ctx);
      const payment = { receiptReference: text(input.receiptReference, 'Unique receipt reference', ctx), invoiceId: invoice.invoiceId, amountCents: money(input.amountCents, 'Payment allocation', ctx, true) };
      if (idempotent(state.payments, 'receiptReference', payment, ctx)) return state;
      unique('ar-receipt', payment.receiptReference, ctx);
      if (payment.amountCents > arBalance(state, invoice.invoiceId, ctx)) ctx.fail(409, 'Payment exceeds this invoice balance.');
      state.payments.push(payment); return event(state, ctx, name, payment);
    }
    if (name === 'request-writeoff') {
      only(input, ['requestId', 'invoiceId', 'amountCents', 'reason'], ctx);
      const request = { requestId: text(input.requestId, 'Write-off request ID', ctx, 100), invoiceId: invoice.invoiceId, amountCents: money(input.amountCents, 'Write-off amount', ctx, true), reason: text(input.reason, 'Reason', ctx, 500) };
      request.sha256 = ctx.hash(request);
      const prior = state.writeoffs.find(row => row.requestId === request.requestId);
      if (prior) { if (prior.sha256 !== request.sha256) ctx.fail(409, 'Write-off reference already exists.'); return state; }
      if (request.amountCents > arBalance(state, invoice.invoiceId, ctx)) ctx.fail(409, 'Write-off exceeds this invoice balance.');
      state.writeoffs.push(request); return event(state, ctx, name, { requestId: request.requestId });
    }
    ctx.fail(422, 'Unknown receivables action.');
  },
  validate(state) { return { errors: [...(!state.invoices.length ? ['Import at least one receivable.'] : []), ...(state.writeoffs.some(row => !row.approved && !row.canceled) ? ['Pending write-offs require reviewer authorization.'] : [])], warnings: ['Receipts and ledger references are manually imported; this register does not collect payments.'] }; },
  output(state, ctx) { return { currency: state.currency, invoices: state.invoices.map(row => ({ ...row, balanceCents: arBalance(state, row.invoiceId, ctx) })), payments: clone(state.payments), writeoffs: clone(state.writeoffs), history: clone(state.history) }; } };
function arBalance(state, invoiceId, ctx) {
  const invoice = state.invoices.find(row => row.invoiceId === invoiceId);
  return sum([invoice.amountCents, ...state.payments.filter(row => row.invoiceId === invoiceId).map(row => -row.amountCents), ...state.writeoffs.filter(row => row.invoiceId === invoiceId && row.approved).map(row => -row.amountCents)], ctx);
}

const recruiting = { roleId: 'R56', title: 'Restricted lateral conflicts clearance', description: 'Route only names needed for a conflicts check and return a minimal clearance result to recruiting.',
  fields: [field('candidateReference', 'Opaque candidate reference'), field('names', 'Relevant party names only', 'json', { hint: '[{"name":"Example Company","relationship":"former client"}]' })],
  actions: [action('replace-names', 'Update relevant names', [field('names', 'Relevant names', 'json', { hint: '[{"name":"Example Company","relationship":"former client"}]' })]),
    action('record-clearance', 'Record conflicts disposition', [field('namesHash', 'Current name-set hash'), field('status', 'Clearance status', 'select', { options: ['clear', 'conditions', 'blocked'] }), field('reference', 'Restricted conflicts case reference')], true)],
  create(input, ctx) { only(input, ['candidateReference', 'names'], ctx); const names = recruitNames(input.names, ctx); return { candidateReference: opaque(input.candidateReference, 'Candidate reference', ctx), names, namesHash: ctx.hash(names), decisions: [], history: [] }; },
  update(previous, name, input, ctx) {
    const state = clone(previous);
    if (name === 'replace-names') { only(input, ['names'], ctx); state.names = recruitNames(input.names, ctx); state.namesHash = ctx.hash(state.names); return event(state, ctx, name, { namesHash: state.namesHash }); }
    if (name === 'record-clearance') {
      reviewer(ctx); only(input, ['namesHash', 'status', 'reference'], ctx);
      if (input.namesHash !== state.namesHash) ctx.fail(409, 'Review the current relevant-name list.');
      const decision = { namesHash: state.namesHash, status: choice(input.status, ['clear', 'conditions', 'blocked'], 'clearance status', ctx), reference: opaque(input.reference, 'Conflicts reference', ctx), by: ctx.user.username, at: ctx.now };
      state.decisions.push(decision); return event(state, ctx, name, { status: decision.status, namesHash: state.namesHash });
    }
    ctx.fail(422, 'Unknown recruiting action.');
  },
  validate(state) { const result = state.decisions.filter(row => row.namesHash === state.namesHash).at(-1); return { errors: result ? [] : ['The current name set has no conflicts disposition.'], warnings: ['The conflicts reviewer records the decision; this workflow does not replace the firm’s conflict investigation.'] }; },
  output(state) { const result = state.decisions.filter(row => row.namesHash === state.namesHash).at(-1); return { candidateReference: state.candidateReference, clearance: result?.status ?? 'pending', clearanceReference: result?.reference ?? null, reviewedAt: result?.at ?? null }; },
  project(state, ctx) { return ctx.isReviewer ? clone(state) : { ...recruiting.output(state), namesHash: state.namesHash, history: state.history.map(({ type, at }) => ({ type, at })) }; }
};
function recruitNames(input, ctx) {
  const result = rows(input, 'Relevant names', ctx, 100).map(row => { only(row, ['name', 'relationship'], ctx); return { name: text(row.name, 'Name', ctx), relationship: choice(row.relationship, ['candidate', 'former client', 'adverse party', 'related entity'], 'relationship', ctx) }; });
  if (new Set(result.map(row => row.name.toLowerCase() + ':' + row.relationship)).size !== result.length) ctx.fail(422, 'List each relevant name and relationship once.');
  return result;
}
function opaque(value, label, ctx) {
  const result = text(value, label, ctx, 100);
  if (!/^[A-Za-z][A-Za-z0-9._:-]{1,99}$/.test(result) || /\d{8}/.test(result)) ctx.fail(422, `${label} must be an opaque reference without personal or banking data.`);
  return result;
}
const payroll = { roleId: 'R58', title: 'Payroll close status handoff', description: 'Send finance a bounded payroll-run status without storing payees, amounts, bank details, or payroll documents.',
  fields: [field('runReference', 'Opaque payroll run reference'), field('periodEnd', 'Period ending', 'date'), field('status', 'Payroll run status', 'select', { options: ['pending', 'processed', 'failed'] })],
  actions: [action('record-status', 'Update external payroll status', [field('status', 'Payroll run status', 'select', { options: ['pending', 'processed', 'failed'] }), field('receiptReference', 'Opaque provider receipt reference')]),
    action('acknowledge-finance', 'Acknowledge finance handoff', [field('statusHash', 'Current payroll status hash')], true)],
  create(input, ctx) { only(input, ['runReference', 'periodEnd', 'status'], ctx); if (ctx.matterId) ctx.fail(422, 'Payroll status must remain outside matter workspaces.'); const state = { runReference: opaque(input.runReference, 'Payroll run reference', ctx), periodEnd: date(input.periodEnd, ctx), statuses: [], acknowledgments: [], history: [] }; const entry = { status: choice(input.status, ['pending', 'processed', 'failed'], 'payroll status', ctx), receiptReference: null, at: ctx.now }; entry.sha256 = ctx.hash(entry); state.statuses.push(entry); return state; },
  update(previous, name, input, ctx) {
    const state = clone(previous); if (ctx.matterId) ctx.fail(422, 'Payroll status must remain outside matter workspaces.');
    if (name === 'record-status') { only(input, ['status', 'receiptReference'], ctx); const entry = { status: choice(input.status, ['pending', 'processed', 'failed'], 'payroll status', ctx), receiptReference: opaque(input.receiptReference, 'Provider receipt reference', ctx), at: ctx.now }; entry.sha256 = ctx.hash(entry); state.statuses.push(entry); return event(state, ctx, name, { status: entry.status }); }
    if (name === 'acknowledge-finance') { reviewer(ctx); only(input, ['statusHash'], ctx); const current = state.statuses.at(-1); if (input.statusHash !== current.sha256 || current.status === 'pending' || !current.receiptReference) ctx.fail(409, 'Acknowledge the current completed or failed provider result.'); state.acknowledgments.push({ statusHash: current.sha256, by: ctx.user.username, at: ctx.now }); return event(state, ctx, name); }
    ctx.fail(422, 'Unknown payroll action.');
  },
  validate(state) { const current = state.statuses.at(-1); return { errors: state.acknowledgments.some(row => row.statusHash === current.sha256) ? [] : ['Finance must acknowledge the current provider result.'], warnings: ['Payroll calculations and payee records remain in the external payroll system.'] }; },
  output(state) { return { runReference: state.runReference, periodEnd: state.periodEnd, currentStatus: clone(state.statuses.at(-1)), financeAcknowledgment: clone(state.acknowledgments.at(-1) ?? null) }; }
};

export const workflows = [
  ledgerWorkflow('R48', 'Operating and trust financial reporting', 'Reconcile operating and trust balances separately against reviewed external statement evidence.'),
  ledgerWorkflow('R49', 'Controller reconciliation and corrections', 'Block unmatched entries and retain originals when posting correction entries.'),
  ap,
  ledgerWorkflow('R51', 'Bookkeeping imports and reversals', 'Deduplicate external ledger transactions and reverse entries without deleting history.'),
  billing, ar,
  ledgerWorkflow('R54', 'Trust receipts, returns and reconciliation', 'Record returned receipts, reopen balances, and block signoff on every discrepancy.'),
  recruiting, payroll,
];

// These are operational reports, not archival download endpoints. A returned
// receipt, new payment, changed name set or new payroll result must never reuse
// an earlier approved balance/status as the current authorization artifact.
for (const workflow of workflows) {
  workflow.assertExport = (live, approved, ctx) => {
    if (ctx.hash(live) !== ctx.hash(approved)) ctx.fail(409, 'This financial or clearance output was superseded. Review and approve the current work before exporting.');
    const checks = workflow.validate(live, ctx);
    if (checks.errors.length) ctx.fail(409, checks.errors.join(' '));
  };
}
