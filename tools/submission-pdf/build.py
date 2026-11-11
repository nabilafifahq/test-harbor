"""Builds the submission PDF from real runs: the model eval results (eval-results branch) and the rules-only run (data.json)."""
import json, html, io, base64, sys
from pathlib import Path
import qrcode, qrcode.image.svg

ROOT = Path(__file__).resolve().parent
import glob
# Model runs saved by scripts/eval.mjs on the eval-results branch. Report runs also saved their readings.
_dirs = sorted(glob.glob(str(ROOT / 'eval-runs/*')))
_rep = [d for d in _dirs if glob.glob(d + '/*.reads.json')] or _dirs
RUNS = [json.load(open([f for f in glob.glob(d + '/*.json') if not f.endswith('.reads.json')][0])) for d in _rep[-3:]]
R = RUNS[0]
PER = sorted(R['per'], key=lambda x: x['ticket_no'])
RULES = json.loads((ROOT / 'data.json').read_text())['results']  # the rules-only run, kept for comparison
def span(key):
    v = sorted(r[key] for r in RUNS)
    return f'{v[0]}' if v[0] == v[-1] else f'{v[0]} to {v[-1]}'
COST = sorted(r['cost_usd'] for r in RUNS)
SECS = sorted(r['seconds'] for r in RUNS)
LIVE = 'https://harbor-point-order-desk.vercel.app'
REPO = 'https://github.com/nabilafifahq/test-harbor'
e = html.escape

NAVY, BLUE, SKY, LIGHT, INK, MUTED, LINE = '#0B2545', '#2C6CBC', '#71C3F7', '#F5F5F5', '#0E1C2E', '#45566B', '#D5E1EC'
GOOD, WARN, BAD, GREY = '#146C2E', '#8A5A00', '#B3261E', '#8A97A8'

def money(v): return f'{v:,.2f}'

# ------------------------------------------------------------------ SVG helpers
def box(x, y, w, h, title, lines=(), fill='#fff', stroke=LINE, title_fill=INK, sw=1.2, r=10, size=12.5):
    out = [f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{r}" fill="{fill}" stroke="{stroke}" stroke-width="{sw}"/>']
    ty = y + 22 if lines else y + h / 2 + 4.5
    out.append(f'<text x="{x + w / 2}" y="{ty}" text-anchor="middle" font-size="{size}" font-weight="650" fill="{title_fill}">{e(title)}</text>')
    for i, l in enumerate(lines):
        out.append(f'<text x="{x + w / 2}" y="{y + 40 + i * 15}" text-anchor="middle" font-size="10.5" fill="{MUTED if title_fill == INK else title_fill}">{e(l)}</text>')
    return ''.join(out)

def arrow(d, color=GREY, dash=False):
    return f'<path d="{d}" fill="none" stroke="{color}" stroke-width="1.4" marker-end="url(#ah)"{" stroke-dasharray=\"4 4\"" if dash else ""}/>'

def label(x, y, t, anchor='middle', size=10, fill=MUTED, weight=500):
    return f'<text x="{x}" y="{y}" text-anchor="{anchor}" font-size="{size}" font-weight="{weight}" fill="{fill}">{e(t)}</text>'

DEFS = f'<defs><marker id="ah" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="{GREY}"/></marker></defs>'

def svg(w, h, body, title):
    return f'<svg viewBox="0 0 {w} {h}" width="100%" role="img" aria-label="{e(title)}" font-family="Google Sans Flex, sans-serif">{DEFS}{body}</svg>'

# ------------------------------------------------------------------ diagrams
def pipeline():
    b = []
    y, h, w = 50, 82, 100
    cols = [(8, 'New mail', ['inbox, form', 'or webhook']), (120, 'Queue', ['read in the', 'background']),
            (232, 'Model agent', ['10 read-only tools,', 'drafts, suggests']), (344, 'Rules reader', ['second reading,', 'the fallback']), (456, '12 checks', ['plain code', 'picks the lane'])]
    for x, t, ls in cols:
        acc = t in ('12 checks', 'Model agent')
        b.append(box(x, y, w, h, t, ls, fill='#E8F3FD' if acc else '#fff', stroke=BLUE if acc else LINE, sw=2 if acc else 1.2))
    for x in (108, 220, 332, 444):
        b.append(arrow(f'M{x} {y + h / 2}H{x + 10}'))
    outs = [('Written to ERP alone', 'all 12 checks pass', '#E3F4E8', GOOD, R['lanes'].get('auto_committed', 0)),
            ('Review queue', 'the right role decides', '#E8F3FD', BLUE, R['lanes'].get('needs_review', 0)),
            ('Customer asked', 'only a question is open', '#FFF3D6', WARN, R['lanes'].get('waiting_on_customer', 0)),
            ('Closed, no action', 'spam, auto-reply, duplicate', '#F1F3F6', GREY, R['lanes'].get('no_action', 0))]
    bx, bw, oh, gap = 612, 204, 36, 7
    top = y + h / 2 - (4 * oh + 3 * gap) / 2
    for i, (t, sub, fill, col, n) in enumerate(outs):
        yy = top + i * (oh + gap)
        b.append(f'<rect x="{bx}" y="{yy}" width="{bw}" height="{oh}" rx="9" fill="{fill}" stroke="{col}" stroke-width="1.2"/>')
        b.append(f'<text x="{bx + 12}" y="{yy + 15}" font-size="11.5" font-weight="650" fill="{INK}">{e(t)}</text>')
        b.append(f'<text x="{bx + 12}" y="{yy + 29}" font-size="9.5" fill="{MUTED}">{e(sub)}</text>')
        b.append(f'<text x="{bx + bw - 12}" y="{yy + 24}" text-anchor="end" font-size="16" font-weight="700" fill="{col}">{n}</text>')
        b.append(arrow(f'M556 {y + h / 2}C586 {y + h / 2} 582 {yy + oh / 2} {bx - 2} {yy + oh / 2}'))
    b.append(f'<rect x="8" y="{top + 4 * oh + 3 * gap + 14}" width="808" height="26" rx="8" fill="{LIGHT}" stroke="{LINE}"/>')
    b.append(label(412, top + 4 * oh + 3 * gap + 31, 'Audit log: every model reading (tools, tokens, cost), every check and every human decision, with who, when and why', size=10.5, fill=INK))
    return svg(824, top + 4 * oh + 3 * gap + 44, ''.join(b), 'How one email moves from inbox to ERP')

_cf = R['check_fail_counts']
CHECKS = [(c, n, _cf.get(c, 0)) for c, n in [('I01', 'Asks for a new order'), ('C01', 'Registered contact'), ('U01', 'Sender verified'), ('C02', 'Account active'),
          ('L01', 'SKU and qty in the email'), ('L02', 'Every product active'), ('S01', 'Stock covers every line'), ('K01', 'Credit holds after order'),
          ('D01', 'PO not seen before'), ('Q01', 'Nothing to ask'), ('X01', 'No injected instructions'), ('M01', 'Both readers agree')]]

def checks_grid():
    b, cw, ch, gx, gy = [], 199, 30, 8, 7
    for i, (code, name, n) in enumerate(CHECKS):
        x, y = 4 + (i % 4) * (cw + gx), 4 + (i // 4) * (ch + gy)
        b.append(f'<rect x="{x}" y="{y}" width="{cw}" height="{ch}" rx="15" fill="#fff" stroke="{LINE}" stroke-width="1"/>')
        b.append(f'<rect x="{x + 5}" y="{y + 5}" width="34" height="20" rx="10" fill="#E3EFFB"/>')
        b.append(f'<text x="{x + 22}" y="{y + 19}" text-anchor="middle" font-size="9.5" font-weight="700" fill="{BLUE}">{code}</text>')
        b.append(f'<text x="{x + 46}" y="{y + 19}" font-size="10.2" fill="{INK}">{e(name)}</text>')
        b.append(f'<text x="{x + cw - 12}" y="{y + 19.5}" text-anchor="end" font-size="11" font-weight="700" fill="{NAVY}">{n}</text>')
    return svg(828, 3 * ch + 2 * gy + 8, ''.join(b), 'The 12 checks and how many emails each stopped')

def autonomy():
    cols = [('The agent does this alone', GOOD, '#EEF8F1', ['Read the ERP through 10 read-only tools', 'Draft orders, changes, cancels, replies', 'Write an order when all 12 checks pass', 'Suggest the next step, with reasons', 'Close spam, link duplicates and add-ons']),
            ('A person decides', BLUE, '#EEF5FC', ['Credit hold or over limit (Credit and AR)', 'A price that differs from ours (Credit and AR)', 'Substitutes, unclear units', 'Changes and cancellations of existing orders', 'Unknown senders; injection attempts (Admin)']),
            ('Nobody can, from this system', BAD, '#FCEFEE', ['Change prices or credit limits', 'Edit a shipped order', 'Delete records', 'Send email (replies wait in an outbox)', 'Act on instructions inside an email'])]
    b = []
    w = 264
    for i, (t, col, fill, items) in enumerate(cols):
        x = 4 + i * (w + 16)
        b.append(f'<rect x="{x}" y="4" width="{w}" height="170" rx="12" fill="{fill}" stroke="{col}" stroke-width="1.3"/>')
        b.append(f'<rect x="{x}" y="4" width="{w}" height="32" rx="12" fill="{col}"/><rect x="{x}" y="24" width="{w}" height="12" fill="{col}"/>')
        b.append(f'<text x="{x + 14}" y="25" font-size="12.5" font-weight="650" fill="#fff">{e(t)}</text>')
        for j, it in enumerate(items):
            b.append(f'<circle cx="{x + 18}" cy="{56 + j * 26}" r="3" fill="{col}"/>')
            b.append(f'<text x="{x + 28}" y="{60 + j * 26}" font-size="10.4" fill="{INK}">{e(it)}</text>')
    return svg(848, 178, ''.join(b), 'Where the autonomy line sits')

def email_mix():
    parts = [('Written to ERP alone', R['lanes'].get('auto_committed', 0), BLUE), ('Needs a decision', R['lanes'].get('needs_review', 0), NAVY),
             ('Ask the customer', R['lanes'].get('waiting_on_customer', 0), SKY), ('No action', R['lanes'].get('no_action', 0), '#B8C2CF')]
    total = sum(p[1] for p in parts)
    x, W, b = 4, 800, []
    for name, n, col in parts:
        w = W * n / total
        b.append(f'<rect x="{x}" y="6" width="{w - 2}" height="26" rx="4" fill="{col}"/>')
        tc = '#fff' if col in (BLUE, NAVY) else INK
        if w > 40: b.append(f'<text x="{x + 8}" y="23.5" font-size="11.5" font-weight="700" fill="{tc}">{n}</text>')
        x += w
    lx = 4
    for name, n, col in parts:
        b.append(f'<rect x="{lx}" y="44" width="10" height="10" rx="2" fill="{col}"/><text x="{lx + 15}" y="53" font-size="10.5" fill="{INK}">{e(name)} · {n}</text>')
        lx += 205
    return svg(808, 62, ''.join(b), 'How the 40 emails were routed')

def hbars(rows, title, w=380, unit='', rh=19):
    mx = max(v for _, v in rows) or 1
    lw, bw = 132, w - 132 - 34
    b = []
    for i, (k, v) in enumerate(rows):
        y = 6 + i * rh
        b.append(f'<text x="{lw - 8}" y="{y + 12}" text-anchor="end" font-size="10" fill="{INK}">{e(k)}</text>')
        b.append(f'<rect x="{lw}" y="{y + 3}" width="{max(3, bw * v / mx)}" height="12" rx="3" fill="{BLUE}"/>')
        b.append(f'<text x="{lw + bw * v / mx + 6}" y="{y + 13}" font-size="10" font-weight="650" fill="{INK}">{v}{unit}</text>')
    return svg(w, 10 + len(rows) * rh, ''.join(b), title)

def phases():
    cols = [('Phase 0', 'Shared context', ['Brief and 40 emails', 'Priced every email', 'CONTEXT.md for agents']),
            ('Phase 1', 'Plan, design, QA', ['A1 architecture', 'A2 UI/UX (Claude Design)', 'A3 QA reviewer, 5 rounds', '96 findings, 0 blockers']),
            ('Phase 2', 'Build', ['B1 to B10: data, reader,', 'matcher, checks, commit,', 'tickets, auth, console,', 'deploy']),
            ('Phase 3', 'Ship and polish', ['Vercel + Neon, CI', 'Responsive sign-in', 'Palette, motion, states']),
            ('Phase 4', 'Model agent', ['B13 to B18: tool calling,', 'two readers, queue,', 'new mail, edits, eval', f'{len(RUNS)} report runs, 0 unsafe'])]
    b, w = [], 156
    for i, (p, t, ls) in enumerate(cols):
        x = 4 + i * (w + 18)
        acc = i in (1, 4)
        b.append(f'<rect x="{x}" y="4" width="{w}" height="128" rx="12" fill="{"#E8F3FD" if acc else "#fff"}" stroke="{BLUE if acc else LINE}" stroke-width="{1.8 if acc else 1.2}"/>')
        b.append(f'<text x="{x + 14}" y="24" font-size="10" font-weight="650" fill="{BLUE}">{p.upper()}</text>')
        b.append(f'<text x="{x + 14}" y="42" font-size="13" font-weight="650" fill="{INK}">{e(t)}</text>')
        for j, l in enumerate(ls):
            b.append(f'<text x="{x + 14}" y="{64 + j * 16}" font-size="10.3" fill="{MUTED}">{e(l)}</text>')
        if i < 4: b.append(arrow(f'M{x + w + 2} 68H{x + w + 16}'))
    return svg(856, 136, ''.join(b), 'How the work was directed')

def architecture():
    b = []
    b.append(box(8, 70, 120, 64, 'Reviewer', ['browser, any device']))
    b.append(f'<rect x="168" y="8" width="420" height="230" rx="14" fill="#F7FAFD" stroke="{BLUE}" stroke-width="1.3" stroke-dasharray="5 4"/>')
    b.append(label(184, 28, 'Vercel project harbor-point-order-desk', 'start', 11, BLUE, 650))
    b.append(box(184, 42, 180, 56, 'Console', ['public/: HTML, CSS, JS, fonts']))
    b.append(box(184, 112, 180, 112, 'API function', ['api/index.js to src/app.js', 'sessions, roles, queue,', 'search, actions, audit']))
    b.append(box(392, 42, 180, 182, 'Agent and commit', ['queue.js: background runs', 'model-agent.js: tool loop', 'extract.js: rules reader', 'BM25, edit distance matcher', '12 checks, priority, due', 'commitProposal: only writer'], fill='#E8F3FD', stroke=BLUE, sw=1.8))
    b.append(box(628, 70, 188, 92, 'Neon Postgres', ['ERP tables, tickets,', 'comments, outbox,', 'audit log, sessions']))
    b.append(f'<rect x="628" y="180" width="188" height="44" rx="10" fill="#fff" stroke="{BLUE}"/>')
    b.append(label(722, 199, 'DeepInfra', 'middle', 11.5, INK, 650))
    b.append(label(722, 214, 'DeepSeek V4 Flash, tool calling', 'middle', 9.5))
    b.append(arrow('M128 92H182'))
    b.append(arrow('M128 116C150 116 160 168 182 168'))
    b.append(arrow('M364 168H390'))
    b.append(arrow('M572 116H626'))
    b.append(arrow('M572 200H626'))
    b.append(label(599, 194, 'HTTPS', 'middle', 9))
    b.append(label(146, 86, 'HTTPS', 'middle', 9))
    b.append(label(608, 110, 'SQL, TLS', 'middle', 9))
    return svg(824, 244, ''.join(b), 'System architecture')

def cicd():
    b, w, h = [], 150, 62
    b.append(box(4, 42, w, h, 'git push to main', ['nabilafifahq/test-harbor']))
    b.append(box(200, 4, 296, h, 'GitHub Actions: ci', ['unit, smoke and model-agent tests,', 'boot on Postgres 17 and sign in'], fill='#E8F3FD', stroke=BLUE, sw=1.8))
    row = [(200, 'Vercel build', ['static files plus', 'one function']), (366, 'Production', ['harbor-point-order-desk', '.vercel.app']), (532, 'First request', ['seeds Neon once,', 'then serves the queue'])]
    for i, (x, t, ls) in enumerate(row):
        b.append(box(x, 80, w, h, t, ls))
        if i < 2: b.append(arrow(f'M{x + w + 1} {80 + h / 2}H{x + w + 14}'))
    b.append(arrow(f'M{4 + w + 1} 64C176 64 176 35 198 35'))
    b.append(arrow(f'M{4 + w + 1} 82C176 82 176 111 198 111'))
    b.append(box(512, 4, 170, h, 'eval-model', ['40 emails, real model,', 'on demand or eval/*']))
    b.append(f'<text x="700" y="30" font-size="10" fill="{MUTED}">Both start from</text><text x="700" y="44" font-size="10" fill="{MUTED}">the same push.</text>')
    b.append(f'<text x="700" y="104" font-size="10" fill="{MUTED}">Rollback: promote the</text><text x="700" y="118" font-size="10" fill="{MUTED}">previous deployment.</text>')
    return svg(830, 146, ''.join(b), 'CI/CD pipeline')

def roadmap():
    items = [('Domain and SSO', 'company .com, single sign-on'), ('Finer roles', 'limits by value, four-eyes on price'), ('Security', 'OWASP ASVS L2, scanning in CI'),
             ('Hosting', 'VPS or own hardware, when load needs it'), ('Models', 'local model, second API model'), ('Onboarding', 'guided first ticket, practice mode'), ('Mailbox', 'IMAP or Graph, into the queue')]
    b, w = [], 112
    for i, (t, s) in enumerate(items):
        x = 4 + i * (w + 6)
        b.append(f'<path d="M{x} 6H{x + w - 10}L{x + w} 30L{x + w - 10} 54H{x}L{x + 10} 30Z" fill="{"#E8F3FD" if i % 2 == 0 else "#F3F8FD"}" stroke="{BLUE}" stroke-width="1"/>')
        b.append(f'<text x="{x + w / 2 + 2}" y="26" text-anchor="middle" font-size="10.4" font-weight="650" fill="{INK}">{e(t)}</text>')
        b.append(f'<text x="{x + w / 2 + 2}" y="72" text-anchor="middle" font-size="8.8" fill="{MUTED}">{e(s.split(", ")[0])}</text>')
        if ', ' in s: b.append(f'<text x="{x + w / 2 + 2}" y="84" text-anchor="middle" font-size="8.8" fill="{MUTED}">{e(s.split(", ", 1)[1])}</text>')
    return svg(830, 90, ''.join(b), 'Path to production')

def qr_svg(url):
    img = qrcode.make(url, image_factory=qrcode.image.svg.SvgPathImage, box_size=10, border=1)
    s = io.BytesIO(); img.save(s)
    return s.getvalue().decode()

# ------------------------------------------------------------------ data tables
FLAG_NAME = {'CREDIT_BLOCK': 'Credit block', 'STOCK_SHORT': 'Stock short', 'FROM_HISTORY': 'Rebuilt from history', 'SECURITY_INJECTION': 'Injection attempt', 'UNVERIFIED_SENDER': 'Unverified sender',
             'UNKNOWN_SENDER': 'New sender', 'DUPLICATE': 'Duplicate PO', 'DISCONTINUED': 'Discontinued item', 'SKU_CORRECTED': 'SKU corrected', 'MISSING_ATTACHMENT': 'Missing attachment',
             'PRICE_DISPUTE': 'Price dispute', 'AMBIGUOUS_PRODUCT': 'Which item?', 'UNIT_UNCLEAR': 'Unit unclear', 'DATE_IN_PAST': 'Date passed', 'LINE_EXCLUDED': 'Line skipped', 'PO_REVISION': 'PO revision',
             'ORDER_NOT_FOUND': 'Order not found', 'MODEL_FALLBACK': 'Rules reader used', 'COMMIT_REFUSED': 'ERP refused'}
NEXT = {'create_order': 'Create order', 'change_order': 'Change order', 'cancel_order': 'Cancel order', 'send_quote': 'Send quote', 'ask_customer': 'Ask customer',
        'route_to_credit_ar': 'To Credit and AR', 'route_to_sales': 'To sales', 'escalate_to_person': 'To a person', 'close_no_action': 'Close'}
LANE = {'auto_committed': 'Written to ERP', 'needs_review': 'Review', 'waiting_on_customer': 'Ask customer', 'no_action': 'No action'}
LANE_CLS = {'auto_committed': 'ok', 'needs_review': 'info', 'waiting_on_customer': 'warn', 'no_action': 'mute'}
flag_rows = sorted([(FLAG_NAME.get(k, k), v) for k, v in R['flag_counts'].items() if k in FLAG_NAME], key=lambda x: (-x[1], x[0]))

def why(t):
    named = list(dict.fromkeys(FLAG_NAME[f] for f in t['flags'] if f in FLAG_NAME))
    if named: return named[0] + (f' +{len(named) - 1}' if len(named) > 1 else '')
    if t['lane'] == 'auto_committed': return 'All 12 checks passed'
    failed = {c.split(':')[0]: c.split(': ', 1)[1] if ': ' in c else '' for c in t['failed_checks']}
    intent = t['intent'].replace('_', ' ')
    if t['lane'] == 'no_action': return intent.capitalize()
    if 'Q01' in failed: return 'Quantity missing' if failed['Q01'].startswith('How many') else 'Question open'
    if 'I01' in failed: return intent.capitalize() + ('; on credit hold' if failed.get('C02') == 'CREDIT_HOLD' else '')
    if 'L01' in failed: return 'Lines read from free text'
    if 'M01' in failed: return 'Readers differ'
    return intent.capitalize()

def email_table():
    rows = []
    for t in PER:
        ok = t['lane'] == t['expected_lane']
        rows.append(f'<tr><td>{t["ticket_no"].replace("HP-", "")}</td><td>{t["email_id"]}</td><td>{e(t["customer_name"] or "New sender")}</td><td>{e(t["intent"].replace("_", " "))}</td>'
                    f'<td>{e(NEXT.get(t["next_action"], ""))}</td><td><span class="pill {LANE_CLS[t["lane"]]}">{LANE[t["lane"]]}</span></td><td class="num">{money(t["total"]) if t["total"] else ""}</td><td>{e(why(t))}</td><td class="c">{"Yes" if ok else "No"}</td></tr>')
    return ''.join(rows)

# ------------------------------------------------------------------ page content
AGENT_ERRORS = [
    ('Auto-commit trusted the model\'s reading of SKUs and quantities', 'QA reviewer, round 1 (blocker)', 'Commit only if every SKU and quantity is in the email itself (L01)'),
    ('Credit counted today\'s orders twice', 'QA reviewer, round 1', 'Credit computed after the writes, in the commit transaction'),
    ('Database plan would use up Neon free compute on day 17', 'QA reviewer, from the vendor pricing page', 'No polling; the app wakes only on requests'),
    ('One keystroke wrote to the ERP; credit showed 616.00 over instead of 216.00', 'QA reviewer, design round', 'Consequence block before approval; overage = exposure minus limit'),
    ('"Our usual" picked up the order the agent wrote an hour earlier', 'Reading the E036 output', 'History limited to orders before the business day'),
    ('"33 gal" read as 33 cases; "a large outdoor event" as one', 'Printing all 40 readings before wiring', 'Size lookahead; a phrase must name a product noun'),
    ('Price disputes and substitutes routed to "ask the customer"', 'Rules run stuck at 35 of 40', 'Severe flags always go to review'),
    ('The part deciding each email was still the rules reader; the model was off', 'Nabila, re-reading the brief', 'Model agent with tool calling (B13 to B15)'),
    ('Fallback let the rules reader write orders alone while the model was down', 'Writing the model-failure test', 'Model failure means a person approves'),
    ('Readers-agree check compared raw SKUs and ignored delivery sites', 'Eval run 1 (10 of 37 agreed); E005 screenshot', 'Both readings resolved the same way, sites compared'),
    ('Model wrote "x" as the unit in "HPS-1408 x 4"; clean E001 was held back', 'Eval run 2', '"x" and "qty" are not units'),
    ('Model\'s own questions moved E021 and E027 to ask the customer', 'Eval runs 2 and 3', 'Model questions are suggestions; code questions decide'),
]

TASKS = [
    ('B1', 'Data load', 'Postgres schema mirroring the ERP CSVs plus tickets, comments, outbox, audit, users, sessions; tickets HP-1001 up by arrival', 'npm test loads 40 emails; available >= 0 enforced by a CHECK'),
    ('B2', 'Email reader without a model', 'Intent, SKU lines in four layouts, free-text lines, ship-to labels, exclusions, PO, prices, dates', 'Print all 40 extractions before wiring; sizes, %, codes never read as quantity'),
    ('B3', 'Product matcher', 'Exact SKU, then edit distance 1 confirmed by the description, then BM25 with synonyms; ties within 10% become a question', 'algo tests: big toilet paper rolls = HPS-1104, HPS-1035 = HPS-1305, gloves = ambiguous'),
    ('B4', 'Checks and lanes', '11 checks as data; auto-commit only if all pass; severe flags to review with the right role', 'Exactly E001, E003, E015, E038 commit; lane agreement printed'),
    ('B5', 'Commit code', 'One transaction; lock ticket, customer, inventory rows; re-read price, stock, status, credit; order, change, cancel', 'E019 refused, E006 needs Credit, E017 frees 20 cases, E004 sets 25, second commit is a no-op'),
    ('B6', 'Tickets', 'Status, priority, due time, assignee, notes, replies to an outbox, row-version conflicts', 'Reply moves to waiting; stale version returns 409'),
    ('B7', 'Sign-in and roles', 'Argon2id, httpOnly cookie, hashed token, idle and absolute timeouts, lockout, Origin check, server-side roles', 'CI signs in; ops gets 403 on a credit release'),
    ('B8', 'Queue API', 'Views, Gmail-style operators, inverted-index prefix search, facets, stable sort, pages, Work next min-heap', 'priority:urgent returns 4; sku:HPS-1408 returns only those tickets'),
    ('B9', 'Console', 'Material 3 shapes, Google Sans Flex, sprite icons, collapsible drawer, consequence block, keyboard', 'No horizontal scroll at 390 px; no console errors'),
    ('B10', 'Deploy', 'Vercel static + one function, Neon via integration, GitHub Actions, seed once across instances', 'CI green; live URL serves 40 tickets'),
    ('B11', 'Responsive sign-in', 'Form level with the heading on desktop, first under it on phones; tables scroll inside cards', 'No element wider than the main area at 1440, 1280, 768, 390'),
    ('B12', 'Palette, states, motion', 'One palette for sign-in and app; ripple, press, hover, selected, disabled, loading; reduced motion honoured', 'Screenshots of each state; white on blue at 5.3:1'),
]
TASKS2 = [
    ('B13', 'Model agent', 'Tool calling on DeepInfra; 10 read-only tools and submit_draft; email as data in <email> tags; 12 turns; invalid drafts go back with the errors; models tried in order', 'Scripted-model test runs the loop; validateDraft rejects a made-up intent, a non-SKU, 2.5 cases'),
    ('B14', 'Two readers, one decision', 'Rules reader reads every email too; check M01: same intent, items, quantities, sites; model failure means a person approves', 'One extra case on E001 stops the commit; a 503 on E003 leaves it for a person; rules run still 40 of 40'),
    ('B15', 'Background queue', 'Reads in parallel (8), decisions in arrival order under a lock; stop under 100 s left; waitUntil; one retry; a bad email parks itself', 'Tickets appear wave by wave against a slow fake model; two runs at once process each email once'),
    ('B16', 'New mail in', 'RFC 5322 and MIME parser; seed from data/inbox/*.eml; New email form; /api/inbound webhook with a token; inbox cap 300', 'Parser matches the JSON export on all 40; a pasted E006 becomes HP-1041 with a credit block'),
    ('B17', 'Reviewer edits', 'Change SKU, quantity, delivery address; add and remove lines; preview prices, stock, credit; prices from priceFor; diff audited', 'E006 with line 1 at 5 plus HPS-1408 previews 469.00, 69.00 over; a foreign ship-to is refused'),
    ('B18', 'Model eval in CI', '40 emails through the real model; routing, intent, unsafe, fallbacks, readers agreeing, tokens, cost; every difference with the model\'s reasoning', 'Runs on eval/* pushes; results saved on the eval-results branch; fails on any unsafe commit'),
]

DECISIONS = [
    ('Plan v1', 'Next.js on Vercel, Neon, Anthropic API', 'Architecture agent'),
    ('Plan v2', 'One Rust binary on Fly.io', 'Owner asked for light and scalable'),
    ('Plan v3', 'Home server, local or free models, self-hosted Postgres', 'Owner asked for free models and own hardware'),
    ('Shipped 1.0', 'Node on Vercel, Neon, rules reader, optional model', 'A 10-minute first build, then hosting on Vercel'),
    ('Shipped 1.1', 'Model agent on DeepInfra, rules cross-check, queue', 'The brief asks for an agent that decides'),
]

# Routing agreement per model eval run on 7 November, from the eval-model job summaries (runs 1 to 4) and the
# eval-results branch (runs 5 onward). The text under a gap is the fix made between those runs.
EVAL_HISTORY = [('1', 39), ('2', 38), ('3', 38), ('4', 39), ('5', 40), ('6', 40), ('7', 40)] + [(str(8 + i), r['lane_agreement']) for i, r in enumerate(RUNS)]
EVAL_FIXES = [(1, 'a', 'A SKU the model corrected counts as a correction; M01 resolves both readings the same way'), (2, 'b', '"x" and "qty" are not units; model questions only count on orders'), (4, 'c', 'Model questions become suggestions; an add-on naming no order is a new order')]

def eval_chart():
    b, bw, gap, x0, base, top = [], 44, 14, 40, 200, 40
    lo, hi = 35, 40
    yv = lambda v: base - (v - lo) / (hi - lo) * (base - top)
    for v in range(lo, hi + 1):
        b.append(f'<line x1="{x0 - 6}" x2="{x0 + len(EVAL_HISTORY) * (bw + gap)}" y1="{yv(v)}" y2="{yv(v)}" stroke="{LINE}" stroke-width=".8"/>')
        b.append(f'<text x="{x0 - 10}" y="{yv(v) + 3.5}" text-anchor="end" font-size="9.5" fill="{MUTED}">{v}</text>')
    for i, (name, v) in enumerate(EVAL_HISTORY):
        x = x0 + i * (bw + gap)
        report = i >= len(EVAL_HISTORY) - len(RUNS)
        col = BLUE if report else ('#9CC5EC' if v < 40 else SKY)
        b.append(f'<path d="M{x} {base}V{yv(v) + 4}Q{x} {yv(v)} {x + 4} {yv(v)}H{x + bw - 4}Q{x + bw} {yv(v)} {x + bw} {yv(v) + 4}V{base}Z" fill="{col}"/>')
        b.append(f'<text x="{x + bw / 2}" y="{yv(v) - 5}" text-anchor="middle" font-size="10" font-weight="650" fill="{INK}">{v}</text>')
        b.append(f'<text x="{x + bw / 2}" y="{base + 14}" text-anchor="middle" font-size="9.5" fill="{MUTED}">{name}</text>')
    for after, tag, _ in EVAL_FIXES:
        x = x0 + after * (bw + gap) - gap / 2
        b.append(f'<line x1="{x}" x2="{x}" y1="{top - 14}" y2="{base}" stroke="{WARN}" stroke-width="1.2" stroke-dasharray="3 3"/>')
        b.append(f'<circle cx="{x}" cy="{top - 22}" r="8" fill="#FFF0CC" stroke="{WARN}"/><text x="{x}" y="{top - 18.5}" text-anchor="middle" font-size="10" font-weight="700" fill="{WARN}">{tag}</text>')
    xr = x0 + (len(EVAL_HISTORY) - len(RUNS)) * (bw + gap)
    b.append(f'<path d="M{xr} {base + 24}H{xr + len(RUNS) * (bw + gap) - gap}" stroke="{BLUE}" stroke-width="1.5"/>')
    b.append(f'<text x="{xr + (len(RUNS) * (bw + gap) - gap) / 2}" y="{base + 37}" text-anchor="middle" font-size="9.5" font-weight="650" fill="{BLUE}">report runs</text>')
    b.append(f'<text x="{x0 + (bw + gap) * 4 + (3 * (bw + gap) - gap) / 2}" y="{base + 37}" text-anchor="middle" font-size="9.5" fill="{MUTED}">after the last fix</text>')
    b.append(f'<path d="M{x0 + (bw + gap) * 4} {base + 24}H{x0 + (bw + gap) * 7 - gap}" stroke="{SKY}" stroke-width="1.5"/>')
    return svg(x0 + len(EVAL_HISTORY) * (bw + gap) + 10, base + 44, ''.join(b), 'Routing agreement per model eval run')

img = lambda name: (ROOT / 'shots' / name).as_uri()
font = (ROOT.parents[1] / 'public/fonts/google-sans-flex-latin-wght.woff2').as_uri()

def kpi(value, label_, compare):
    return f'<div class="kpi"><div class="kv">{value}</div><div class="kl">{e(label_)}</div><div class="kc">{e(compare)}</div></div>'

auto_val = sum(t['total'] or 0 for t in PER if t['lane'] == 'auto_committed')

HTML = f'''<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Harbor Point Order Desk: Submission</title>
<style>
@font-face {{ font-family: 'Google Sans Flex'; src: url('{font}') format('woff2-variations'); font-weight: 100 1000; }}
@page {{ size: A4; margin: 14mm 15mm 16mm; }}
* {{ box-sizing: border-box; }}
body {{ margin: 0; font-family: 'Google Sans Flex', sans-serif; color: {INK}; font-size: 9.6pt; line-height: 1.42; font-variant-numeric: tabular-nums; -webkit-print-color-adjust: exact; print-color-adjust: exact; }}
h1, h2, h3 {{ margin: 0; font-weight: 600; letter-spacing: -.1px; }}
.page {{ page-break-after: always; break-after: page; }}
.page:last-child {{ page-break-after: auto; }}
.sec-tag {{ display: inline-block; font-size: 8pt; font-weight: 700; letter-spacing: .8px; color: {BLUE}; text-transform: uppercase; margin-bottom: 2mm; }}
h1.sec {{ font-size: 20pt; line-height: 1.15; color: {NAVY}; margin-bottom: 1.5mm; }}
.lead {{ font-size: 11pt; line-height: 1.45; color: {INK}; margin: 0 0 4mm; max-width: 170mm; }}
h2 {{ font-size: 11.5pt; color: {NAVY}; margin: 5mm 0 2mm; display: flex; align-items: center; gap: 2mm; }}
h2::before {{ content: ''; width: 3px; height: 12pt; background: {BLUE}; border-radius: 2px; }}
p {{ margin: 0 0 2mm; }}
.muted {{ color: {MUTED}; }}
table {{ width: 100%; border-collapse: collapse; font-size: 8.6pt; }}
th {{ text-align: left; font-weight: 650; color: {MUTED}; font-size: 7.8pt; text-transform: uppercase; letter-spacing: .4px; padding: 1.6mm 2mm; border-bottom: 1.2px solid {NAVY}; }}
td {{ padding: 1.5mm 2mm; border-bottom: .6px solid {LINE}; vertical-align: top; }}
td.num, th.num {{ text-align: right; }}
td.c, th.c {{ text-align: center; }}
tr {{ break-inside: avoid; }}
.grid2 {{ display: grid; grid-template-columns: 1fr 1fr; gap: 5mm; }}
.grid3 {{ display: grid; grid-template-columns: repeat(3, 1fr); gap: 3.5mm; }}
.card {{ border: .8px solid {LINE}; border-radius: 3mm; padding: 3mm 3.5mm; break-inside: avoid; }}
.card.blue {{ background: #EEF5FC; border-color: #BFD9F2; }}
.card h3 {{ font-size: 10pt; color: {NAVY}; margin-bottom: 1mm; }}
.figure {{ margin: 2mm 0 1mm; break-inside: avoid; }}
.cap {{ font-size: 8pt; color: {MUTED}; margin-top: 1mm; }}
.kpis {{ display: grid; grid-template-columns: repeat(4, 1fr); gap: 3mm; margin: 2mm 0 3mm; }}
.kpi {{ background: #F3F8FD; border-radius: 3mm; padding: 3mm; border: .8px solid #D8E8F7; }}
.kv {{ font-size: 18pt; font-weight: 650; color: {NAVY}; line-height: 1.1; }}
.kl {{ font-size: 8.6pt; font-weight: 600; margin-top: .8mm; }}
.kc {{ font-size: 7.8pt; color: {MUTED}; }}
.pill {{ display: inline-block; padding: .2mm 2mm; border-radius: 10px; font-size: 7.6pt; font-weight: 650; white-space: nowrap; }}
.pill.ok {{ background: #DDF2E3; color: {GOOD}; }} .pill.info {{ background: #E3EFFB; color: {BLUE}; }} .pill.warn {{ background: #FFF0CC; color: {WARN}; }} .pill.mute {{ background: #ECEFF3; color: {MUTED}; }}
code, .mono {{ font-family: ui-monospace, 'SFMono-Regular', Menlo, monospace; font-size: 8pt; background: #F1F5FA; padding: .2mm 1.2mm; border-radius: 1mm; }}
.cmd {{ background: {NAVY}; color: #E8F1FB; border-radius: 3mm; padding: 3mm 4mm; font-family: ui-monospace, Menlo, monospace; font-size: 8.4pt; line-height: 1.6; }}
.cmd .c {{ color: {SKY}; }}
.shot {{ width: 100%; border-radius: 2.5mm; border: .8px solid {LINE}; display: block; }}
/* cover */
.cover {{ position: relative; height: 267mm; }}
.band {{ height: 72mm; border-radius: 5mm; background: linear-gradient(90deg, {BLUE} 0%, {SKY} 55%, {LIGHT} 100%); padding: 12mm 12mm; color: #fff; position: relative; }}
.mark {{ width: 13mm; height: 13mm; border-radius: 3.5mm; background: #fff; color: {NAVY}; display: inline-flex; align-items: center; justify-content: center; font-weight: 750; font-size: 13pt; }}
.mark span {{ color: {BLUE}; }}
.band h1 {{ font-size: 28pt; line-height: 1.1; margin-top: 7mm; color: #fff; }}
.band .sub {{ font-size: 12pt; margin-top: 2mm; color: #F2F8FE; max-width: 120mm; }}
.toc {{ margin-top: 8mm; }}
.toc .row {{ display: grid; grid-template-columns: 11mm 1fr 68mm 14mm; align-items: center; padding: 2.6mm 0; border-bottom: .7px solid {LINE}; }}
.toc .n {{ font-weight: 700; color: {BLUE}; font-size: 12pt; }}
.toc .t {{ font-weight: 600; font-size: 11pt; }}
.toc .d {{ color: {MUTED}; font-size: 8.6pt; }}
.toc .pg {{ text-align: right; color: {MUTED}; }}
.access {{ display: grid; grid-template-columns: 1fr 34mm; gap: 6mm; margin-top: 8mm; padding: 5mm; border-radius: 4mm; background: #F3F8FD; border: .8px solid #D8E8F7; align-items: center; }}
.access .url {{ font-size: 13pt; font-weight: 650; color: {BLUE}; }}
.access svg {{ width: 34mm; height: 34mm; }}
.doc-control {{ margin-top: 7mm; }}
.doc-control td:first-child {{ width: 32mm; color: {MUTED}; }}
.small {{ font-size: 8.2pt; }}
.task td:first-child {{ font-weight: 700; color: {BLUE}; width: 9mm; }}
.task td:nth-child(2) {{ font-weight: 650; width: 30mm; }}
.task td:last-child {{ color: {MUTED}; width: 52mm; }}
.emails td {{ padding: 1.05mm 1.6mm; font-size: 7.9pt; }}
.emails th {{ padding: 1.2mm 1.6mm; }}
.assume td {{ padding: .75mm 2mm; font-size: 7.9pt; line-height: 1.3; }}
.errs td {{ padding: .75mm 2mm; line-height: 1.3; }}
.emails {{ table-layout: fixed; }}
.emails td {{ white-space: nowrap; overflow: hidden; text-overflow: ellipsis; padding: .6mm 1.2mm !important; font-size: 7.6pt !important; }}
.emails th {{ white-space: nowrap; letter-spacing: 0; padding: 1mm 1.2mm !important; }}
.page.tight h2 {{ margin-top: 3.4mm; }}
.page.res h1.sec {{ font-size: 16pt; }}
.page.res .kpi {{ padding: 2.2mm 2.6mm; }}
.page.res .kv {{ font-size: 15pt; }}
.page.res h2 {{ margin: 3.5mm 0 1.5mm; }}
.page.res .card {{ padding: 2.4mm 3mm; }}
.page.tight .lead {{ margin-bottom: 2mm; }}
ul.tight {{ margin: 0; padding-left: 4.5mm; }} ul.tight li {{ margin-bottom: 1mm; }}
</style></head><body>

<!-- COVER -->
<section class="page cover">
  <div class="band">
    <div class="mark">H<span>P</span></div>
    <h1>Harbor Point Order Desk</h1>
    <div class="sub">Agent-native order-to-cash: a language model reads every order email through read-only ERP tools and drafts the order; code checks it; people approve anything with risk in it.</div>
  </div>
  <div class="toc">
    {''.join(f'<div class="row"><div class="n">{n}</div><div class="t">{t}</div><div class="d">{d}</div><div class="pg">p. {pg}</div></div>' for n, t, d, pg in [
      (1, 'Product brief', 'user, problem, scope, autonomy line, measures', 2), (2, 'Task breakdown', 'how the coding agents were directed', 4),
      (3, 'Repository', 'architecture, run locally, deployment', 7), (4, 'Live URL and logins', 'where to click first', 8), (5, 'Results and agent log', '40 emails, mistakes and fixes', 9),
      ('A', 'Appendix', 'one ticket, and the 40 emails one by one', 10)])}
  </div>
  <div class="access">
    <div>
      <div class="muted small">Live console</div>
      <div class="url">harbor-point-order-desk.vercel.app</div>
      <div style="margin-top:3mm" class="small"><b>Sign in</b> as <code>ops</code>, <code>credit</code> or <code>admin</code>. Password: <code>harbor-point-demo-2026</code></div>
      <div style="margin-top:1.5mm" class="small"><b>Repository</b> github.com/nabilafifahq/test-harbor</div>
    </div>
    {qr_svg(LIVE)}
  </div>
  <table class="doc-control small">
    <tr><td>Document</td><td>HP-O2C-SUB-001, version 1.2, 9 November 2026</td></tr>
    <tr><td>Owner</td><td>Nabila</td></tr>
    <tr><td>Standards</td><td>ISO/IEC 25010:2023 quality model; ISO/IEC/IEEE 29148:2018 requirements; ISO/IEC/IEEE 42010:2022 architecture description; OWASP Top 10:2025 and OWASP Top 10 for LLM Applications 2025</td></tr>
    <tr><td>Data</td><td>ERP snapshot of 07:00, Monday 2 November 2026, and the 40 emails of that day. Every company and person is fictional</td></tr>
    <tr><td>Model</td><td>DeepSeek V4 Flash (deepseek-ai/DeepSeek-V4-Flash-0731) on DeepInfra; results from {len(RUNS)} report runs of the eval-model job on 7 November 2026 and the production run on 9 November 2026</td></tr>
  </table>
</section>

<!-- 1 PRODUCT BRIEF -->
<section class="page">
  <div class="sec-tag">1 · Product brief</div>
  <h1 class="sec">An agent does the reading and the lookups; people make the calls that carry risk</h1>
  <p class="lead">On the 40 emails of 2 November the model agent wrote the {R['lanes'].get('auto_committed', 0)} clean orders on its own, held the other {40 - R['lanes'].get('auto_committed', 0)} for the right person with the draft ready, and wrote nothing it should not have, in each of {len(RUNS)} report runs and in production.</p>
  <div class="grid2">
    <div><h2>Who uses it</h2><p>The order desk team, three to five people who turn customer emails into ERP orders every morning. Credit and AR decide credit holds, price exceptions, returns and invoice questions. An admin owns security flags.</p></div>
    <div><h2>The problem</h2><p>Four of the 40 emails are clean orders. The other 36 hide a reason to stop: a credit hold, a discontinued glove, a SKU with two digits swapped, a price "Mike offered", an order in Spanish, a PO sent twice, an email telling "the automated system" to give 50% off. Typing is slow; checking is where the expensive mistakes happen.</p></div>
  </div>
  <h2>What we built: one email, start to finish</h2>
  <div class="figure">{pipeline()}</div>
  <h2>Where the line sits</h2>
  <div class="figure">{autonomy()}<div class="cap">The right-hand column has no tool and no endpoint, so a model cannot be talked into it.</div></div>
  <h2>The 12 checks behind "written to ERP alone"</h2>
  <div class="figure">{checks_grid()}<div class="cap">Number on the right: emails that check stopped in report run 1. One email can fail several checks. L01 also fails when the customer states a price or a line was read from free text.</div></div>
</section>

<section class="page">
  <div class="sec-tag">1 · Product brief, continued</div>
  <div class="grid2">
    <div>
      <h2 style="margin-top:0">What we did not build</h2>
      <table class="small"><tr><th>Left out</th><th>Why</th></tr>
        <tr><td>IMAP or Graph mailbox</td><td>Mail comes in as .eml files, the New email form or a webhook; replies wait in an outbox</td></tr>
        <tr><td>Reading attachments</td><td>E023 promises a PO that never arrived; the agent asks for it</td></tr>
        <tr><td>Merging follow-ups</td><td>Same-day add-ons become linked tickets, so a person sees both</td></tr>
        <tr><td>Model questions routing tickets</td><td>Shown to the reviewer as suggestions; only questions the code raises send a ticket to Waiting</td></tr>
      </table>
    </div>
    <div>
      <h2 style="margin-top:0">How we measure it in production</h2>
      <table class="small"><tr><th>Measure</th><th>Target</th></tr>
        <tr><td>Orders written alone that should have waited</td><td><b>0</b> per month</td></tr>
        <tr><td>Lane agreement on a weekly sample of 50</td><td>95% or more before a lane is switched on</td></tr>
        <tr><td>Emails written with no human edit</td><td>Up from 10%; each new lane starts in shadow mode</td></tr>
        <tr><td>Email to order, median</td><td>Under 15 min clean, under 2 h reviewed</td></tr>
        <tr><td>Reviewer edits per approved draft</td><td>Falling week on week</td></tr>
        <tr><td>Tickets past due time</td><td>Under 5%</td></tr>
      </table>
      <div class="cap">All values are targets for production, not results.</div>
    </div>
  </div>
  <h2>Assumptions</h2>
  <table class="small assume"><tr><th style="width:8mm">#</th><th style="width:104mm">Assumption</th><th>Why</th></tr>
    {''.join(f'<tr><td>A{i}</td><td>{e(a)}</td><td class="muted">{e(w)}</td></tr>' for i, (a, w) in enumerate([
      ('Credit exposure = open balance + unshipped open orders + the new order', 'An order written an hour ago is real exposure'),
      ('Stock is allocated when the order is written, first come first served', 'Drafts holding stock would let a stalled ticket block a clean one'),
      ('"Thursday" means the coming day of this week', 'That is how the team reads it'),
      ('A requested date in the past is asked about, never guessed', 'E032 asks for Friday 30 October; either part could be the typo'),
      ('A sender at a customer domain who is not a registered contact is unverified', 'E013 covers for a contact who emails herself the same morning'),
      ('"Our usual" = lines common to the last two orders before today', 'Orders the agent wrote this morning are not a habit'),
      ('Same PO and same lines = duplicate; same PO, different lines = revision', 'A resend must not double an order'),
      ('A unit that does not match the selling unit is asked, never rounded', '"6 boxes" of gloves sold in cases of 10 boxes'),
      ('Contract prices apply only inside their dates', 'E024 asks for a contract price that expired on 30 September'),
      ('Auto-replies are never answered', 'Answering one starts a mail loop'),
      ('Demo due times use a fixed clock of 12:00 on 2 November', 'Priorities read correctly against the inbox day'),
      ('A same-day add-on naming no order is a new order linked to the earlier one', 'E026 says add these, with no PO; changing an order would be a guess'),
      ('When the model and the rules reader disagree, a person decides', 'Two readers agreeing is the bar for writing alone')], 1))}
  </table>
  <h2>Hosting today and the path to production</h2>
  <p class="small">Today: Vercel, Neon Postgres through the Vercel integration, deployed from GitHub on every push; DeepSeek V4 Flash on DeepInfra for the model. One Node process and Postgres, so it moves without a rewrite. Next:</p>
  <div class="figure">{roadmap()}</div>
</section>

<!-- 2 TASK BREAKDOWN -->
<section class="page">
  <div class="sec-tag">2 · Task breakdown</div>
  <h1 class="sec">Agents got a goal, a spec and a check they had to pass and paste back</h1>
  <p class="lead">Three agents planned, designed and reviewed in parallel; the build ran task by task under <code>CLAUDE.md</code>, whose four rules every agent followed: think first, simplest code, surgical changes, prove it with a check.</p>
  <div class="figure">{phases()}</div>
  <h2>Phase 1 agents</h2>
  <table class="small"><tr><th style="width:36mm">Agent</th><th>Spec excerpt</th><th style="width:58mm">Acceptance</th></tr>
    <tr><td><b>A1 Architecture and product</b></td><td>"Every number in the golden labels is recomputed from erp.sqlite by a script. Enforce the autonomy line by capability and code, not by prompt."</td><td class="muted">Label script exits non-zero on any mismatch; copy lint at zero; brief within 2 pages</td></tr>
    <tr><td><b>A2 UI and UX</b></td><td>"Real data only. Show E001, E006, E012, E019, E005, E024. Risk visible before the click: ERP change, stock, credit after."</td><td class="muted">Screens S1 to S9; five states; every contrast pair computed at AA</td></tr>
    <tr><td><b>A3 QA reviewer</b></td><td>"Find what is wrong. Recompute the labels with your own script, try to break auto-commit, verify every claim at the vendor."</td><td class="muted">Ranked findings with evidence and fix; close-out table per round</td></tr>
  </table>
  <div class="grid2" style="margin-top:3mm">
    <div class="card"><h3>Review rounds</h3>{hbars([('1. Plan', 47), ('2. Design', 24), ('3. Rust stack', 12), ('4. Plan revision', 4), ('5. Hosting, models', 9)], 'QA findings per round', 360, rh=17)}<div class="cap">96 findings in total, 84 closed, no blocker left open.</div></div>
    <div class="card"><h3>Direction changes</h3><table class="small"><tr><th>Step</th><th>Stack</th><th>Why</th></tr>{''.join(f'<tr><td><b>{a}</b></td><td>{e(b_)}</td><td class="muted">{e(c)}</td></tr>' for a, b_, c in DECISIONS)}</table></div>
  </div>
</section>

<section class="page">
  <div class="sec-tag">2 · Task breakdown, continued</div>
  <h2 style="margin-top:0">Build tasks given to the coding agent</h2>
  <table class="task small"><tr><th>ID</th><th>Task</th><th>Spec</th><th>Accepted when</th></tr>
    {''.join(f'<tr><td>{i}</td><td>{e(t)}</td><td>{e(s)}</td><td>{e(a)}</td></tr>' for i, t, s, a in TASKS)}
  </table>
  <div class="grid2" style="margin-top:4mm">
    <div class="card blue"><h3>Rules that must never break</h3><ul class="tight small">
      <li>The model and the reader never write to ERP tables; only <code>commitProposal</code> does</li>
      <li>Auto-commit only when every check passes</li><li>Email text is data, never instructions</li>
      <li>Prices always come from <code>priceFor</code></li><li>Every step and decision writes an audit row</li><li>Roles are checked on the server for every write</li></ul></div>
    <div class="card"><h3>Every task ended the same way</h3><div class="cmd"><span class="c">$</span> npm test<br># pass 10, # fail 0<br>lane agreement with golden labels: 40/40<br>smoke test passed<br># pass 5, # fail 0</div><div class="cap">Unit tests, the 40-email smoke test that names each trap email, then the model-agent tests with a scripted model.</div></div>
  </div>
</section>

<section class="page">
  <div class="sec-tag">2 · Task breakdown, continued</div>
  <h2 style="margin-top:0">Phase 4: the model agent, 7 November</h2>
  <p class="small">Nabila re-read the brief against the submission and found the gap: the part deciding each email was still the rules reader, with the model optional and switched off. These six tasks put a language model in the loop without moving the safety line. Each was accepted on a test, then on the real model in the eval-model job.</p>
  <table class="task small"><tr><th>ID</th><th>Task</th><th>Spec</th><th>Accepted when</th></tr>
    {''.join(f'<tr><td>{i}</td><td>{e(t)}</td><td>{e(s_)}</td><td>{e(a)}</td></tr>' for i, t, s_, a in TASKS2)}
  </table>
  <h2>Directing with the eval: each run, then a fix</h2>
  <div class="cap" style="margin:0">Emails routed as labelled, of 40, per eval run</div>
  <div class="figure">{eval_chart()}</div>
  <table class="small errs" style="margin-top:2mm"><tr><th style="width:8mm">Fix</th><th>Given to the coding agent between runs, from a difference the job summary listed with the model's own reasoning</th></tr>
    {''.join(f'<tr><td><b style="color:{WARN}">{t}</b></td><td>{e(x)}</td></tr>' for _, t, x in EVAL_FIXES)}</table>
  <p class="cap">Same 40 emails and the same model in every run. Orders written alone that should have waited: 0 in every run.</p>
</section>

<!-- 3 REPOSITORY -->
<section class="page tight">
  <div class="sec-tag">3 · Repository</div>
  <h1 class="sec">One Node process, Postgres and a static console; three runtime dependencies</h1>
  <p class="lead">Repository <b>nabilafifahq/test-harbor</b>. The README has the full guide; this page is the map.</p>
  <h2>Architecture</h2>
  <div class="figure">{architecture()}</div>
  <h2>How it is deployed</h2>
  <div class="figure">{cicd()}</div>
  <div class="grid2">
    <div><h2>Run it locally</h2><div class="cmd"><span class="c">$</span> npm ci<br><span class="c">$</span> LLM_API_KEY=&lt;DeepInfra key&gt; npm start<br><span class="c">$</span> npm test<br><span class="c">$</span> LLM_API_KEY=&lt;key&gt; npm run eval</div>
      <p class="small" style="margin-top:2mm">No database setup: without <code>DATABASE_URL</code> the app runs Postgres in-process. Without a key it runs the rules reader alone; <code>AGENT_REPLAY</code> replays a recorded model run; <code>LLM_BASE_URL</code> points at Ollama or llama.cpp instead.</p></div>
    <div><h2>Where things live</h2><table class="small"><tr><th>Path</th><th>What</th></tr>
      <tr><td><code>src/model-agent.js</code></td><td>tool specs, loop, draft validation</td></tr><tr><td><code>src/queue.js</code></td><td>background runs</td></tr>
      <tr><td><code>src/agent.js</code></td><td>tools, matcher, checks, commit</td></tr><tr><td><code>src/extract.js</code></td><td>rules reader</td></tr>
      <tr><td><code>src/eml.js</code></td><td>.eml parser</td></tr><tr><td><code>scripts/eval.mjs</code></td><td>scores the model on 40 emails</td></tr>
      <tr><td><code>public/</code></td><td>console, no build step</td></tr></table></div>
  </div>
  <h2>Computer science inside</h2>
  <table class="small errs"><tr><th>Problem</th><th>Technique</th></tr>
    <tr><td>"the big toilet paper rolls" to a SKU</td><td>BM25 ranking with English and Spanish synonyms and a head-noun rule</td></tr>
    <tr><td>HPS-1035 does not exist</td><td>Damerau-Levenshtein distance: HPS-1305 is one transposition away</td></tr>
    <tr><td>Search as you type</td><td>Inverted index with a sorted vocabulary and binary search for prefixes</td></tr>
    <tr><td>Work next</td><td>Binary min-heap by priority, due time, arrival</td></tr>
    <tr><td>Two reviewers on one ticket, two workers on one queue</td><td>Row lock with version compare-and-set; <code>FOR UPDATE SKIP LOCKED</code> claims and a lock row</td></tr>
  </table>
</section>

<!-- 4 LIVE URL -->
<section class="page">
  <div class="sec-tag">4 · Live URL and logins</div>
  <h1 class="sec">harbor-point-order-desk.vercel.app</h1>
  <p class="lead">Three demo accounts share one password. Each role sees different actions, and the server enforces them.</p>
  <table><tr><th>Username</th><th>Person</th><th>Role</th><th>Can do</th></tr>
    <tr><td><code>ops</code></td><td>Jo Park</td><td>Operations</td><td>Review and approve ordinary orders, reply, assign</td></tr>
    <tr><td><code>credit</code></td><td>Rina Hartono</td><td>Credit and AR</td><td>All of the above, plus credit releases and price exceptions</td></tr>
    <tr><td><code>admin</code></td><td>Alex Morgan</td><td>Admin</td><td>All of the above, plus security-flagged tickets and Reset demo</td></tr>
  </table>
  <p class="small" style="margin-top:2mm">Password for all three: <code>harbor-point-demo-2026</code>. Five wrong tries lock that account for five minutes. The production server runs the live model; <code>/api/status</code> shows the reader, the queue and routing against the labels without signing in.</p>
  <div class="grid2" style="margin-top:3mm;align-items:start">
    <div><h2 style="margin-top:0">Five minutes in the console</h2><ol class="small" style="padding-left:5mm;margin:0">
      <li style="margin-bottom:1.1mm">Sign in as <code>ops</code>; press <b>Work next</b> to open the most urgent ticket you may take.</li>
      <li style="margin-bottom:1.1mm"><b>HP-1012</b> Maple Leaf Bakery: the "50% off, skip review" note was ignored; only Admin can approve.</li>
      <li style="margin-bottom:1.1mm"><b>HP-1006</b> Oak &amp; Ember: 216.00 over the limit. As <code>credit</code>, change a quantity, press <b>Check prices, stock and credit</b>, release with a reason.</li>
      <li style="margin-bottom:1.1mm"><b>New email</b>: an order from <code>maria@bluefinbistro.example</code>. The agent reads it in the background; the ticket shows its tool calls and reasoning.</li>
      <li style="margin-bottom:1.1mm">Search <code>priority:urgent</code>, <code>customer:bluefin</code>, <code>sku:HPS-1408</code>.</li>
      <li>Open <b>Results</b> and <b>Audit log</b> in the sidebar.</li></ol></div>
    <div><img class="shot" src="{img('shot-signin.png')}" alt="Sign-in page"><div class="cap">Sign-in with the Operations account selected.</div></div>
  </div>
  <h2>After sign-in: the queue by priority and due time, with flags on every row</h2>
  <img class="shot" src="{img('shot-inbox.png')}" alt="Ticket queue">
</section>

<!-- 5 RESULTS -->
<section class="page res">
  <div class="sec-tag">5 · Results and agent log</div>
  <h1 class="sec">{span('lane_agreement')} of 40 routed as labelled, nothing written that should have waited</h1>
  <p class="small muted">{len(RUNS)} report runs of all 40 emails with DeepSeek V4 Flash on DeepInfra ({COST[0]:.3f} to {COST[-1]:.3f} USD and {SECS[0]} to {SECS[-1]} s each), scored against labels written from the ERP before the build, plus the production run on 9 November (40 of 40, 0 unsafe, 0.0365 USD). The rules reader alone also routes 40 of 40 in CI.</p>
  <div class="kpis">
    {kpi(span('lane_agreement') + '/40', 'Routing matches the labels', f'each of {len(RUNS)} runs and production; first run 39')}
    {kpi(span('unsafe_auto_commits'), 'Written alone that should have waited', 'every run, every version')}
    {kpi(R['lanes'].get('auto_committed', 0), 'Orders written with no person', f'{money(auto_val)} USD; {span("missed_auto_commits")} clean orders missed')}
    {kpi(f"{span('readers_agree')}/{R['readers_compared']}", 'Model and rules read the same', 'the rest go to a person')}
  </div>
  <div class="grid2">
    <div class="card"><h3>What the checks caught</h3>{hbars(flag_rows, 'Flags raised across the 40 emails', 380, rh=11.5)}<div class="cap">Tickets with each flag; one ticket can carry several.</div></div>
    <div class="card"><h3>Where it gets things wrong</h3><ul class="tight small">
      <li><b>The model varies run to run</b> at temperature 0 (a unit read as "x", extra questions). Each variation moved one lane; none wrote an order.</li>
      <li><b>Intent {span('intent_agreement')} of 40.</b> Two naming differences and four add-ons the labels call additions; we keep them as linked new orders.</li>
      <li><b>Readers disagree on {R['readers_compared'] - R['readers_agree']} emails</b>, each where the model reads more than the rules can: change lines, "the usual" from history, "matching lids", items in a return or complaint. They wait for a person, so automation stays at the rules reader's level.</li>
      <li><b>"Next Tuesday"</b> on a Monday is read as tomorrow by the rules reader.</li></ul></div>
  </div>
  <h2>Where the coding agents went wrong, and the fix</h2>
  <table class="small errs"><tr><th style="width:5mm">#</th><th>What went wrong</th><th style="width:44mm">How it was caught</th><th style="width:58mm">Fix</th></tr>
    {''.join(f'<tr><td>{i}</td><td>{e(a)}</td><td class="muted">{e(b_)}</td><td>{e(c)}</td></tr>' for i, (a, b_, c) in enumerate(AGENT_ERRORS, 1))}
  </table>
</section>

<!-- APPENDIX -->
<section class="page">
  <div class="sec-tag">Appendix A · One ticket</div>
  <h1 class="sec">HP-1006: what a reviewer sees before writing to the ERP</h1>
  <p class="lead">Oak &amp; Ember asks for two items. The draft is priced and in stock, but the order takes the account 216.00 over its credit limit, so only Credit and AR can release it.</p>
  <img class="shot" src="{img('shot-ticket.png')}" alt="Ticket detail for HP-1006">
  <div class="grid3" style="margin-top:4mm">
    <div class="card"><h3>What the agent found</h3><p class="small">The request in one line, then the flag that stopped it, with its numbers.</p></div>
    <div class="card"><h3>Proposed order</h3><p class="small">Each line with where its price came from and stock available. Below it, credit after this order and the role that may approve.</p></div>
    <div class="card"><h3>Agent run</h3><p class="small">The model, its suggested next step and reasoning, its tool calls with inputs and outputs, tokens and cost. Checks in plain words beside it.</p></div>
  </div>
</section>

<section class="page">
  <div class="sec-tag">Appendix B · The 40 emails</div>
  <h1 class="sec" style="font-size:15pt;margin-bottom:1mm">Every email, where it went and why</h1>
  <p class="small muted" style="margin-bottom:2mm">Report run 1. Suggests: the model's next step. Label: the routing matches the hand-checked label.</p>
  <table class="emails">
  <thead><tr><th style="width:12mm">Ticket</th><th style="width:11mm">Email</th><th style="width:34mm">Customer</th><th style="width:21mm">Request</th><th style="width:22mm">Suggests</th><th style="width:24mm">Routed to</th><th class="num" style="width:17mm">USD</th><th>Main reason</th><th class="c" style="width:11mm">Label</th></tr></thead>{email_table()}</table>
</section>
</body></html>'''

(ROOT / 'submission.html').write_text(HTML)
print('html bytes', len(HTML), 'flags', flag_rows)
