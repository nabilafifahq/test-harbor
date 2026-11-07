// A stand-in for an OpenAI-compatible model server, for running the console end to end without a key.
// Turn 1 looks up the sender; turn 2 submits what the rules reader reads. Slow on purpose (FAKE_DELAY_MS).
// Usage: node test/fake-model.mjs  then  LLM_BASE_URL=http://localhost:3600/v1 LLM_MODEL=fake npm start
import http from 'node:http';
import { extract } from '../src/extract.js';

const delay = Number(process.env.FAKE_DELAY_MS || 400);
http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', async () => {
    const { messages } = JSON.parse(body || '{}');
    const text = messages[0].content;
    const m = text.match(/<email>\nFrom: (.*) <([^>]+)>\nReceived: .*\nSubject: (.*)\nAttachments: (.*)\n\n([\s\S]*)\n<\/email>/);
    const email = { email_id: 'X', from_name: m[1], from_email: m[2], subject: m[3], body: m[5], attachments: m[4] === 'none' ? [] : [{ filename: m[4] }] };
    let call;
    if (messages.length === 1) call = { name: 'find_sender', arguments: JSON.stringify({ email: email.from_email }) };
    else {
      const r = extract(email);
      call = { name: 'submit_draft', arguments: JSON.stringify({
        intent: r.intent, next_action: r.intent === 'new_order' ? 'create_order' : r.intent === 'spam' || r.intent === 'auto_reply' ? 'close_no_action' : 'escalate_to_person', customer_id: null,
        lines: r.lines.map((l) => ({ sku: l.sku || null, qty: l.qty ?? null, unit_as_written: l.unit_text || null, text: `${l.label ? `${l.label}: ` : ''}${l.description || l.sku || ''}`, customer_stated_price: l.customer_stated_price ?? null })),
        customer_po: r.customer_po, order_ref: r.references_so, requested_date_text: r.requested_date_text, questions: [], suspicious_instructions: false, language: r.language,
        reasoning: `Fake model: ${r.intent.replace(/_/g, ' ')} with ${r.lines.length} line(s), copied from the rules reader.`,
      }) };
    }
    await new Promise((ok) => setTimeout(ok, delay));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '', tool_calls: [{ id: `c${messages.length}`, type: 'function', function: call }] } }], usage: { prompt_tokens: 2400, completion_tokens: 180 } }));
  });
}).listen(Number(process.env.PORT || 3600), () => console.log('fake model on', process.env.PORT || 3600));
