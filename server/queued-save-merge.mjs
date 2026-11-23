import { escapeXml, plainXml } from './queued-save-documents.mjs';
import { normalizedFact, saveDigest } from './queued-save-payload.mjs';
import { ServiceError } from './service-error.mjs';

const factLine = fact => (fact.conflict ? '【信息冲突】' : '') + fact.text + '（' + fact.date + '）';
const links = urls => urls.map((url, index) => ' <a href="' + escapeXml(url) + '">来源 ' + (index + 1) + '</a>').join('');
const paragraphs = content => [...content.matchAll(/<(p|li)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/gi)].map(match => match[2]);

function paragraphFor(content, fact) {
  const expected = normalizedFact(fact.text);
  // Compare within one block so unrelated facts elsewhere in the document do not
  // accidentally satisfy this update. This also recognizes legacy dated entries.
  return paragraphs(content).find(block => {
    const text = plainXml(block);
    return normalizedFact(text).includes(expected) &&
      (text.includes(fact.date) || text.includes(fact.date.replaceAll('-', '/')));
  });
}

function headingFor(content, dimension) {
  for (const heading of content.matchAll(/<h[1-9]\s+([^>]*)>([\s\S]*?)<\/h[1-9]>/gi)) {
    if (normalizedFact(plainXml(heading[2]).replace(/^\s*\d+[.、]\s*/, '')) !== normalizedFact(dimension)) continue;
    const id = /(?:^|\s)(?:id|block-id)="([\w-]+)"/.exec(heading[1])?.[1];
    if (id) return id;
  }
}

export async function mergeQueuedFacts({ documents, store, task, url, facts, check }) {
  const app = task.feishuApp;
  let doc = await documents.read(app, url);
  const key = 'save-facts:' + (doc.id || url);
  const recorded = store.setting(key) ?? {};
  const dimensions = new Map();
  for (const fact of facts) {
    const entries = dimensions.get(fact.dimension) ?? [];
    entries.push(fact);
    dimensions.set(fact.dimension, entries);
  }
  let added = 0, conflicts = 0;
  for (const [dimension, entries] of dimensions) {
    const anchor = headingFor(doc.content, dimension);
    let needsHeading = !anchor;
    for (const fact of entries) {
      const identity = saveDigest(fact.date + ':' + normalizedFact(fact.key));
      const variant = saveDigest(normalizedFact(fact.text));
      const entry = recorded[identity] ?? { variants: [], sources: [] };
      const matched = paragraphFor(doc.content, fact);
      const alreadySaved = Boolean(matched) || entry.variants.includes(variant) || entry.variants.length > 0 && !fact.conflict;
      const missingSources = fact.sources.filter(url => !entry.sources.includes(saveDigest(url)) &&
        !matched?.includes('href="' + escapeXml(url) + '"') &&
        !doc.content.includes(escapeXml('补充来源（' + fact.date + '）') + ' <a href="' + escapeXml(url) + '"'));
      if (!alreadySaved || missingSources.length) {
        const text = alreadySaved ? '补充来源（' + fact.date + '）' : factLine(fact);
        const sources = alreadySaved ? missingSources : fact.sources;
        const block = '<p>' + escapeXml(text) + links(sources) + '</p>';
        const currentAnchor = headingFor(doc.content, dimension);
        check();
        await documents.update(app, url, doc.revision, (needsHeading && !currentAnchor ? '<h2>' + escapeXml(dimension) + '</h2>' : '') + block, currentAnchor);
        doc = await documents.read(app, url);
        if (!alreadySaved && !paragraphFor(doc.content, fact) ||
          alreadySaved && !missingSources.every(url => doc.content.includes('href="' + escapeXml(url) + '"'))) {
          throw new ServiceError(503, '飞书尚未读回本次事实，平台将重新核对');
        }
        needsHeading = false;
        if (!alreadySaved) { added++; if (fact.conflict) conflicts++; }
      }
      entry.variants = [...new Set([...entry.variants, variant])];
      entry.sources = [...new Set([...entry.sources, ...fact.sources.map(saveDigest)])];
      recorded[identity] = entry;
      store.saveSetting(key, recorded);
    }
  }
  return { added, conflicts, dimensions: [...dimensions.keys()] };
}
