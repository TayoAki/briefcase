import { createHash } from 'node:crypto';
import { clean, squash } from '../dist/model.mjs';
import { practice } from '../dist/practice.mjs';

const tokens = value => new Set(clean(value, 180).toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? []);
const normalized = text => squash(text).normalize('NFKC').toLowerCase();
const hashPage = text => createHash('sha256').update(normalized(text)).digest('hex');

export function searchMatter(matter, query, documentId) {
  const terms = [...tokens(query)].slice(0, 6);
  if (!terms.length) return [];
  const matches = [];
  for (const doc of matter.documents.filter(item => !documentId || documentId === item.id)) {
    for (const page of doc.pages) {
      const text = squash(page.text);
      const lower = text.toLowerCase();
      if (!terms.every(term => lower.includes(term))) continue;
      const first = Math.max(0, Math.min(...terms.map(term => lower.indexOf(term))) - 40);
      matches.push({ documentId: doc.id, sha256: doc.sha256, name: doc.name, page: page.number, label: page.label, excerpt: text.slice(first, first + 230) });
      if (matches.length >= 20) return matches;
    }
  }
  return matches;
}

export function caseworkCandidates(matter, doc, previous) {
  const matches = practice(matter).requests.filter(row => !['complete', 'cancelled'].includes(row.status)).flatMap(request => {
    const provider = normalized(request.provider);
    if (provider.length < 4) return [];
    const page = doc.pages.find(page => normalized(page.text).includes(provider));
    if (!page) return [];
    return [{ requestId: request.id, provider: request.provider, from: request.from, to: request.to, followUp: request.followUp,
      evidence: { documentId: doc.id, sha256: doc.sha256, page: page.number, label: page.label, reason: 'Provider name appears on this original page.' } }];
  });
  const current = doc.pages.filter(page => page.method !== 'unreadable').map(page => ({ page: page.number, fingerprint: hashPage(page.text) }));
  const prior = previous?.pages.filter(page => page.method !== 'unreadable').map(page => ({ page: page.number, fingerprint: hashPage(page.text) })) ?? [];
  return {
    matches: matches.slice(0, 20), ambiguous: matches.length > 1, unresolved: matches.length !== 1,
    unreadable: doc.pages.filter(page => page.method === 'unreadable').map(page => page.number),
    comparison: previous ? {
      documentId: doc.id, previousId: previous.id,
      currentOnly: current.filter(page => !prior.some(row => row.fingerprint === page.fingerprint)).map(row => row.page),
      priorOnly: prior.filter(page => !current.some(row => row.fingerprint === page.fingerprint)).map(row => row.page),
      priorUnreadable: previous.pages.filter(page => page.method === 'unreadable').map(page => page.number),
    } : null,
  };
}
