import { test } from 'node:test';
import assert from 'node:assert/strict';
import { words, productTokens, bm25, editDistance, lowerBound, InvertedIndex, MinHeap, sortBy, parseQuery, facets } from '../src/algo.js';

test('words keeps codes whole', () => {
  assert.deepEqual(words('Order SO-24051 for HPS-1408, E012!'), ['order', 'so-24051', 'for', 'hps-1408', 'e012']);
});

test('productTokens splits sizes, singularises and maps Spanish', () => {
  assert.deepEqual(productTokens('16oz clear cups'), ['16', 'oz', 'clear', 'cup']);
  assert.deepEqual(productTokens('bolsas de basura negras de 55 galones'), ['liner', 'trash', 'black', '55', 'gal']);
  assert.ok(productTokens('the big toilet paper rolls').includes('jumbo'));
});

test('bm25 ranks the specific product first', () => {
  const docs = [
    { id: 'HPS-1103', text: 'Toilet Tissue, 2-ply, Standard Roll Paper' },
    { id: 'HPS-1104', text: 'Jumbo Toilet Tissue, 9in Roll Paper' },
    { id: 'HPS-1201', text: 'Trash Liners, 33 gal, Black Liners' },
  ];
  assert.equal(bm25(docs).score('the big toilet paper rolls')[0].id, 'HPS-1104');
  assert.equal(bm25(docs).score('33 gal bags')[0].id, 'HPS-1201');
});

test('editDistance counts an adjacent swap as one edit', () => {
  assert.equal(editDistance('HPS-1035', 'HPS-1305'), 1);
  assert.equal(editDistance('kitten', 'sitting'), 3);
  assert.equal(editDistance('', 'abc'), 3);
});

test('lowerBound finds the insertion point', () => {
  const a = ['apple', 'blue', 'bluefin', 'cup'];
  assert.equal(lowerBound(a, 'blue'), 1);
  assert.equal(lowerBound(a, 'c'), 3);
  assert.equal(lowerBound(a, 'zzz'), 4);
});

test('InvertedIndex does prefix AND search', () => {
  const ix = new InvertedIndex();
  ix.add('E001', 'Bluefin Bistro cutlery HPS-1408');
  ix.add('E030', 'Bluefin Bistro invoice question');
  ix.add('E006', 'Oak and Ember clamshells');
  assert.deepEqual([...ix.search('blue')].sort(), ['E001', 'E030']);
  assert.deepEqual([...ix.search('blue inv')], ['E030']);
  assert.deepEqual([...ix.search('hps-14')], ['E001']);
  assert.equal(ix.search(''), null);
});

test('MinHeap pops in priority order', () => {
  const h = new MinHeap((a, b) => a.p - b.p || a.t - b.t);
  [{ p: 2, t: 1 }, { p: 0, t: 5 }, { p: 0, t: 2 }, { p: 3, t: 0 }, { p: 1, t: 9 }].forEach((x) => h.push(x));
  const out = [];
  while (h.size) out.push(h.pop());
  assert.deepEqual(out.map((x) => `${x.p}.${x.t}`), ['0.2', '0.5', '1.9', '2.1', '3.0']);
});

test('sortBy is multi-key and stable', () => {
  const rows = [{ n: 'b', v: 1 }, { n: 'a', v: 2 }, { n: 'c', v: 1 }];
  assert.deepEqual(sortBy(rows, [{ get: (r) => r.v, dir: 'desc' }, { get: (r) => r.n }]).map((r) => r.n), ['a', 'b', 'c']);
});

test('parseQuery reads operators and free text', () => {
  assert.deepEqual(parseQuery('priority:high customer:"oak & ember" gloves'), { filters: { priority: ['high'], customer: ['oak & ember'] }, text: 'gloves' });
});

test('facets counts values', () => {
  assert.deepEqual(facets([{ s: 'open', f: ['a', 'b'] }, { s: 'open', f: ['a'] }], ['s', 'f']), { s: { open: 2 }, f: { a: 2, b: 1 } });
});
