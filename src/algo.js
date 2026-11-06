// Small, tested building blocks. Each one is plain JavaScript with no dependency, so it is easy to read and port.
// test/algo.test.mjs covers every export.

// ---------------------------------------------------------------------------------------------
// 1. Tokenising. `words` is for search (keeps codes like hps-1408, so-24051, e012 whole).
//    `productTokens` is for product matching (splits 16oz into 16 oz, singularises, maps synonyms
//    including the Spanish words seen in the inbox).
// ---------------------------------------------------------------------------------------------
export function words(text) {
  return String(text ?? '').toLowerCase().match(/[a-z0-9#]+(?:-[a-z0-9]+)*/g) || [];
}

const SYN = {
  bag: 'liner', bolsa: 'liner', basura: 'trash', negra: 'black', negro: 'black',
  guante: 'glove', nitrilo: 'nitrile', caja: 'case', rollo: 'roll', transparente: 'cling',
  servilleta: 'napkin', big: 'jumbo', regular: 'standard', gallon: 'gal', galone: 'gal', galon: 'gal',
  l: 'large', m: 'medium', talla: '', clamshell: 'clamshell', container: 'clamshell',
  cutlery: 'cutlery', utensil: 'cutlery', paper_towel: 'towel', sanitiser: 'sanitizer',
};
const STOP = new Set(['the', 'of', 'and', 'a', 'an', 'for', 'with', 'to', 'de', 'la', 'las', 'los', 'el', 'please', 'send', 'need', 'our', 'we', 'some', 'more', 'cs', 'case', 'x', 'fit', 'fits', 'one', 'ones', 'ply', 'kitchen']);

export function singular(w) {
  if (w.length <= 3 || /\d/.test(w)) return w;
  if (w.endsWith('ies')) return w.slice(0, -3) + 'y';
  if (/(ss|us)$/.test(w)) return w;
  if (w.endsWith('es') && /(ches|shes|xes|oes)$/.test(w)) return w.slice(0, -2);
  if (w.endsWith('s')) return w.slice(0, -1);
  return w;
}

export function productTokens(text) {
  const t = String(text ?? '').toLowerCase()
    .replace(/(\d)(oz|in|ml|ft|gal|l)\b/g, '$1 $2')
    .replace(/#\s*(\d+)/g, ' #$1 ');
  const out = [];
  for (const raw of t.match(/#?[a-z0-9]+(?:x[0-9]+)?/g) || []) {
    let w = singular(raw);
    if (w in SYN) w = SYN[w];
    if (!w || STOP.has(w)) continue;
    out.push(w);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// 2. BM25 ranking (Robertson and Zaragoza). Used to match a phrase such as "the big toilet paper
//    rolls" against the 30-line catalog. IDF makes rare words like "jumbo" count more than
//    common ones like "paper".
// ---------------------------------------------------------------------------------------------
export function bm25(docs, { k1 = 1.2, b = 0.75 } = {}) {
  const toks = docs.map((d) => productTokens(d.text));
  const N = docs.length;
  const avgdl = toks.reduce((s, t) => s + t.length, 0) / Math.max(N, 1);
  const df = new Map();
  for (const t of toks) for (const w of new Set(t)) df.set(w, (df.get(w) || 0) + 1);
  const idf = (w) => Math.log(1 + (N - (df.get(w) || 0) + 0.5) / ((df.get(w) || 0) + 0.5));
  return {
    tokensOf: (i) => toks[i],
    score(query) {
      const q = productTokens(query);
      return docs.map((d, i) => {
        const tf = new Map();
        for (const w of toks[i]) tf.set(w, (tf.get(w) || 0) + 1);
        let s = 0;
        for (const w of q) {
          const f = tf.get(w) || 0;
          if (f) s += idf(w) * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * toks[i].length) / avgdl)));
        }
        return { id: d.id, score: s, doc: d };
      }).sort((x, y) => y.score - x.score);
    },
  };
}

// ---------------------------------------------------------------------------------------------
// 3. Edit distance, optimal string alignment variant of Damerau-Levenshtein. A swap of two
//    neighbouring characters costs 1, so "HPS-1035" is distance 1 from "HPS-1305".
//    O(n*m) time and memory with n, m the string lengths.
// ---------------------------------------------------------------------------------------------
export function editDistance(a, b) {
  a = String(a); b = String(b);
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}

// ---------------------------------------------------------------------------------------------
// 4. Binary search: index of the first element >= x in a sorted array. O(log n).
// ---------------------------------------------------------------------------------------------
export function lowerBound(sorted, x) {
  let lo = 0, hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sorted[mid] < x) lo = mid + 1; else hi = mid;
  }
  return lo;
}

// ---------------------------------------------------------------------------------------------
// 5. Inverted index with prefix search. Each word maps to the set of ticket ids containing it.
//    The vocabulary is kept sorted so a prefix ("blue" finds "bluefin") is a binary search plus
//    a short scan. A multi-word query intersects the sets, smallest first.
// ---------------------------------------------------------------------------------------------
export class InvertedIndex {
  constructor() { this.postings = new Map(); this.vocab = null; }
  add(id, text) {
    for (const w of words(text)) {
      if (!this.postings.has(w)) this.postings.set(w, new Set());
      this.postings.get(w).add(id);
    }
    this.vocab = null;
  }
  #sortedVocab() { return this.vocab || (this.vocab = [...this.postings.keys()].sort()); }
  prefix(p) {
    const v = this.#sortedVocab();
    const out = new Set();
    for (let i = lowerBound(v, p); i < v.length && v[i].startsWith(p); i++) for (const id of this.postings.get(v[i])) out.add(id);
    return out;
  }
  search(query) {
    const terms = words(query);
    if (!terms.length) return null;
    const sets = terms.map((t) => this.prefix(t)).sort((x, y) => x.size - y.size);
    let acc = sets[0];
    for (const s of sets.slice(1)) acc = new Set([...acc].filter((id) => s.has(id)));
    return acc;
  }
}

// ---------------------------------------------------------------------------------------------
// 6. Binary min-heap priority queue. push and pop are O(log n). Used for "Work next": the most
//    urgent ticket by priority, then SLA due time, then arrival.
// ---------------------------------------------------------------------------------------------
export class MinHeap {
  constructor(compare) { this.a = []; this.cmp = compare; }
  get size() { return this.a.length; }
  peek() { return this.a[0]; }
  push(x) {
    const a = this.a; a.push(x);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.cmp(a[i], a[p]) >= 0) break;
      [a[i], a[p]] = [a[p], a[i]]; i = p;
    }
  }
  pop() {
    const a = this.a;
    if (!a.length) return undefined;
    const top = a[0], last = a.pop();
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < a.length && this.cmp(a[l], a[m]) < 0) m = l;
        if (r < a.length && this.cmp(a[r], a[m]) < 0) m = r;
        if (m === i) break;
        [a[i], a[m]] = [a[m], a[i]]; i = m;
      }
    }
    return top;
  }
}

// ---------------------------------------------------------------------------------------------
// 7. Multi-key stable sort. Array.prototype.sort is stable since ES2019, so ties keep their
//    previous order. Keys are applied left to right.
// ---------------------------------------------------------------------------------------------
export function sortBy(items, keys) {
  return [...items].sort((x, y) => {
    for (const { get, dir = 'asc' } of keys) {
      const a = get(x), b = get(y);
      if (a === b) continue;
      if (a === null || a === undefined) return 1;
      if (b === null || b === undefined) return -1;
      const c = a < b ? -1 : 1;
      return dir === 'desc' ? -c : c;
    }
    return 0;
  });
}

// ---------------------------------------------------------------------------------------------
// 8. Search operators in the style of Gmail: `priority:high customer:bluefin sku:HPS-1408 gloves`.
// ---------------------------------------------------------------------------------------------
export const OPERATORS = ['status', 'priority', 'label', 'customer', 'sku', 'assignee', 'flag', 'lane', 'is'];
export function parseQuery(q) {
  const filters = {}, text = [];
  for (const part of String(q ?? '').match(/(\w+):("[^"]*"|\S+)|\S+/g) || []) {
    const m = part.match(/^(\w+):(.+)$/);
    if (m && OPERATORS.includes(m[1].toLowerCase())) (filters[m[1].toLowerCase()] ||= []).push(m[2].replace(/"/g, '').toLowerCase());
    else text.push(part);
  }
  return { filters, text: text.join(' ') };
}

// Facet counts in one pass: { status: { open: 12, ... }, priority: {...} }
export function facets(items, fields) {
  const out = Object.fromEntries(fields.map((f) => [f, {}]));
  for (const it of items) for (const f of fields) {
    const vals = Array.isArray(it[f]) ? it[f] : [it[f]];
    for (const v of vals) if (v !== null && v !== undefined) out[f][v] = (out[f][v] || 0) + 1;
  }
  return out;
}
