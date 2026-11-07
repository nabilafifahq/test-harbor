// Minimal RFC 5322 / MIME reader for one .eml file: From, Subject, Date, Message-ID, the text/plain body
// and attachment names. Enough for order mail; HTML-only mail falls back to tag-stripped text.
const decodeQP = (s) => Buffer.from(s.replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16))), 'latin1').toString('utf8');
const decodeWords = (s) => s.replace(/=\?([^?]+)\?([BQ])\?([^?]*)\?=/gi, (_, cs, enc, txt) => (enc.toUpperCase() === 'B' ? Buffer.from(txt, 'base64').toString('utf8') : decodeQP(txt.replace(/_/g, ' '))));

function split(raw) {
  const m = raw.match(/\r?\n\r?\n/);
  const head = m ? raw.slice(0, m.index) : raw;
  const body = m ? raw.slice(m.index + m[0].length) : '';
  const headers = {};
  for (const line of head.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  return { headers, body };
}

const param = (h, name) => (h || '').match(new RegExp(`${name}\\*?=\\s*"?([^";]+)"?`, 'i'))?.[1] || null;

function decodeBody(headers, body) {
  const enc = (headers['content-transfer-encoding'] || '').toLowerCase();
  if (enc === 'base64') return Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('utf8');
  if (enc === 'quoted-printable') return decodeQP(body);
  return body;
}

function walk(headers, body, out) {
  const type = (headers['content-type'] || 'text/plain').toLowerCase();
  const disp = headers['content-disposition'] || '';
  const filename = param(disp, 'filename') || param(headers['content-type'], 'name');
  if (type.startsWith('multipart/')) {
    const b = param(headers['content-type'], 'boundary');
    if (!b) return;
    for (const part of body.split(new RegExp(`\\r?\\n?--${b.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:--)?[ \\t]*\\r?\\n?`)).slice(1)) {
      if (!part.trim()) continue;
      const p = split(part);
      walk(p.headers, p.body, out);
    }
  } else if (/attachment/i.test(disp) || (filename && !type.startsWith('text/'))) {
    out.attachments.push({ filename: decodeWords(filename || 'attachment'), content_type: type.split(';')[0] });
  } else if (type.startsWith('text/plain') && out.text === null) out.text = decodeBody(headers, body);
  else if (type.startsWith('text/html') && out.html === null) out.html = decodeBody(headers, body);
}

export function parseEml(raw) {
  const { headers, body } = split(String(raw));
  const out = { text: null, html: null, attachments: [] };
  walk(headers, body, out);
  const from = decodeWords(headers.from || '');
  const addr = from.match(/<([^>]+)>/)?.[1] || from.match(/[^\s<>"]+@[^\s<>"]+/)?.[0] || '';
  const name = from.replace(/<[^>]*>/, '').replace(/"/g, '').trim() || addr;
  const text = out.text ?? (out.html ? out.html.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&') : '');
  const date = headers.date ? new Date(headers.date) : null;
  return {
    from_name: name,
    from_email: addr.toLowerCase(),
    subject: decodeWords(headers.subject || ''),
    received_at: date && !Number.isNaN(date.getTime()) ? date.toISOString() : null,
    message_id: headers['message-id'] || null,
    body: text.replace(/\r\n/g, '\n').replace(/\n+$/, ''),
    attachments: out.attachments,
  };
}
