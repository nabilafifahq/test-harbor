// Deterministic reading of an email. Runs on every email, with or without a model.
// Output is a draft only: anything not written as an exact SKU is marked inferred and goes to a person.

const NUMBER_WORDS = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twelve: 12, fifteen: 15, twenty: 20 };
const UNIT_RE = '(cs|cases?|cajas?|boxes|box|rolls?|rollos?|bags?|each|ea|pcs|pieces)';
const SKU_RE = /HPS-\d{4}/g;

export function detectIntent(email) {
  const subj = String(email.subject || '').toLowerCase();
  const low = `${subj}\n${email.body}`.toLowerCase();
  if (/automatic reply|out of the office|out of office/.test(low)) return 'auto_reply';
  if (/\bseo\b|page 1 of google|free audit|unsubscribe/.test(low)) return 'spam';
  if (/\bcancel\b/.test(subj) || /^please cancel/m.test(low)) return 'cancellation';
  if (/\bquote\b/.test(low)) return 'quote_request';
  if (/take (the other|them|it)?.*back|\breturn\b|reduce the invoice/.test(low)) return 'return_request';
  if (/\binvoice\b/.test(low)) return 'invoice_dispute';
  if (/never came|nobody called|not here/.test(low)) return 'complaint';
  if (/(instead of|small change|change to our|make it \d+)/.test(low) && /(SO-\d+|\bPO\b)/i.test(email.body)) return 'order_change';
  return 'new_order';
}

function qtyFrom(token) {
  if (/^\d+$/.test(token)) return Number(token);
  return NUMBER_WORDS[token] ?? null;
}

// Lines that quote a SKU: "HPS-1408  x 4", "HPS-1103 - 15 cases", "HPS-1301,All purpose cleaner conc,6"
function skuLines(body) {
  const lines = [];
  for (const raw of body.split('\n')) {
    const skus = raw.match(SKU_RE);
    if (!skus) continue;
    const rest = raw.replace(SKU_RE, ' ');
    let qty = null, unit = null;
    const mx = rest.match(/\bx\s*(\d+)/i);
    const mu = rest.match(new RegExp(`(\\d+)\\s*${UNIT_RE}\\b`, 'i'));
    const fields = raw.split(',');
    const last = fields.length > 1 ? fields[fields.length - 1].trim() : '';
    if (mx) qty = Number(mx[1]);
    else if (mu) { qty = Number(mu[1]); unit = mu[2]; }
    else if (/^\d+$/.test(last)) qty = Number(last);
    else { const all = rest.match(/(?<![\w.-])\d+(?![\w.-])/g); if (all) qty = Number(all[all.length - 1]); }
    lines.push({ sku: skus[0], description: raw.replace(/^[\s\-*•]+/, '').trim(), qty, unit_text: unit, quoted_sku: true });
  }
  return lines;
}

// Free text: "Downtown: 4 cs hand sanitizer refills, 6 cs 33 gal bags", "Dinner napkins - 10 cs", "a box of foil"
function freeTextLines(body) {
  const out = [];
  let previousPhrase = '';
  for (let raw of body.split('\n')) {
    if (SKU_RE.test(raw)) { SKU_RE.lastIndex = 0; continue; }
    SKU_RE.lastIndex = 0;
    raw = raw.replace(/^[\s\-*•>]+/, '').trim();
    if (!raw || /^(from|subject|to|sent|date):/i.test(raw) || /^-{3,}/.test(raw)) continue;
    let label = null;
    const lm = raw.match(/^([A-Za-z][A-Za-z .&'-]{1,30}):\s+(.+)$/);
    if (lm && lm[1].split(/\s+/).length <= 3) { label = lm[1]; raw = lm[2]; }
    for (const sentence of raw.split(/(?<=[.!?])\s+/)) {
      for (let clause of sentence.split(/,|;|\band\b|\bplus\b|\balso\b/i)) {
        clause = clause.trim().replace(/[.!?]+$/, '');
        if (!clause) continue;
        let qty = null, unit = null, phrase = null;
        const tail = clause.match(new RegExp(`^(.*?[a-z].*?)\\s*[-:–]\\s*(\\d+)\\s*${UNIT_RE}?\\s*$`, 'i'));
        // A digit quantity must not be a size (33 gal, 16oz, 9x9), a percentage or part of a code (BV-0420).
        const NUM = '(?<![\\w.$/%-])(\\d+)(?![\\w%.]|\\s*(?:gal|gallon|galones|oz|in\\b|ml|ft|ply|l\\b|%))';
        if (tail) { phrase = tail[1]; qty = Number(tail[2]); unit = tail[3] || null; }
        else {
          const m = clause.match(new RegExp(`${NUM}\\s*(?:${UNIT_RE}\\b\\.?\\s*)?(?:of\\s+)?(?:the\\s+)?(.+)$`, 'i'))
            || clause.match(new RegExp(`\\b(a|an|one|two|three|four|five|six|seven|eight|nine|ten)\\s+${UNIT_RE}\\b\\s*(?:of\\s+)?(?:the\\s+)?(.+)$`, 'i'));
          if (m) { qty = qtyFrom(m[1].toLowerCase()); unit = m[2] || null; phrase = m[3]; }
        }
        if (!phrase || qty === null) continue;
        const paren = (phrase.match(/\(([^)]*)\)/) || [])[1] || '';
        phrase = phrase.replace(/\(.*?\)/g, ' ').replace(/\b(at|by|on|thx|pls|thanks|please)\b.*$/i, '').trim();
        if (paren) phrase = `${phrase} ${paren}`.trim();
        if (!phrase) continue;
        if (phrase.split(/\s+/).length === 1 && previousPhrase && !/glove|cup|liner|bag|towel|tissue|napkin|straw|lid|kit|filter|foil|film|soap|sanitizer|cleaner|spray|clamshell/i.test(phrase)) phrase = `${phrase} ${previousPhrase}`;
        const priceM = clause.match(/\$\s?(\d+(?:\.\d+)?)/);
        out.push({ sku: null, description: phrase, qty, unit_text: unit, label, customer_stated_price: priceM ? Number(priceM[1]) : null, quoted_sku: false });
        previousPhrase = phrase.replace(/\b(small|medium|large|\d+)\b/gi, '').trim();
      }
    }
  }
  return out;
}

// Mentions without a quantity ("some more of the 33 gal trash bags and the disinfectant spray")
function mentions(body) {
  return body.split(/\n|,|\band\b|\./).map((s) => s.replace(/^.*?\b(of|send|need)\s+(the\s+)?/i, '').trim()).filter((s) => s.split(/\s+/).length >= 2 && s.length < 60)
    .map((s) => ({ sku: null, description: s, qty: null, unit_text: null, quoted_sku: false, mention_only: true }));
}

export function extract(email) {
  const body = String(email.body || '');
  const intent = detectIntent(email);
  let lines = skuLines(body);
  if (['new_order', 'quote_request', 'order_change'].includes(intent)) {
    const ft = intent === 'order_change' ? [] : freeTextLines(body);
    lines = [...lines, ...ft];
  }
  const exclusions = [...body.matchAll(/\b(?:skip|except|without)\s+(?:the\s+)?([a-z][a-z ]{2,30}?)(?=[,.]|\s+we\b|$)/gim)].map((m) => m[1].trim());
  const changeOps = [];
  if (intent === 'order_change') {
    for (const raw of body.split('\n')) {
      const mk = raw.match(/^\s*[-*]?\s*([^:]+):.*?make it (\d+)\s*(?:cases?)?\s*instead of (\d+)/i);
      if (mk) changeOps.push({ op: 'set_qty', description: mk[1].trim(), to: Number(mk[2]), from: Number(mk[3]) });
      const ad = raw.match(/\badd (\d+)\s*(?:cs|cases?)?\s*(?:of\s+)?(.+)$/i);
      if (ad) changeOps.push({ op: 'add_line', description: ad[2].trim(), qty: Number(ad[1]) });
    }
  }
  const po = body.match(/\bPO[:#\s]+([A-Z]{2,4}-[A-Z0-9-]+)/) || String(email.subject).match(/\b(?:PO\s+)?([A-Z]{2,4}-(?:PO-)?\d{3,})\b/);
  const so = body.match(/\bSO-\d{5}\b/);
  const priceM = body.match(/\$\s?(\d+(?:\.\d+)?)/);
  const dateText = (body.match(/\b(today|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b[^.\n]*/i) || body.match(/\b(nov|november|oct|october|dec|december)\.?\s+\d{1,2}\b/i) || body.match(/\b\d{1,2}\/\d{1,2}\b/) || [null])[0];
  return {
    intent,
    lines,
    mentions: intent === 'new_order' && !lines.length ? mentions(body) : [],
    exclusions,
    change_ops: changeOps,
    customer_po: po ? po[1] : null,
    references_so: so ? so[0] : null,
    customer_stated_price: priceM ? Number(priceM[1]) : null,
    requested_date_text: dateText,
    mentions_attachment: /\battached\b|\battachment\b/i.test(body),
    from_history: /same as last time|the usual|our usual/i.test(body),
    language: /\b(por favor|gracias|cajas|buenos)\b/i.test(body) ? 'es' : 'en',
  };
}
