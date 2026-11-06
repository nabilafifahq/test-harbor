// Order Desk front end. Plain ES modules, no framework: hash routes, one state object, server does search and sort.
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const icon = (n, cls = '') => `<svg class="ic ${cls}" aria-hidden="true"><use href="/icons.svg#i-${n}"></use></svg>`;
const money = (n) => (n == null ? '' : Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const TZ = 'America/New_York';
const time = (iso) => new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: TZ });
const stamp = (iso) => new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: TZ });
const initials = (name) => String(name || '?').split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

const VIEWS = [
  ['inbox', 'Inbox', 'inbox'], ['mine', 'Assigned to me', 'assignment_ind'], ['unassigned', 'Unassigned', 'person_off'],
  ['waiting', 'Waiting on customer', 'hourglass_top'], ['auto', 'Auto-processed', 'task_alt'], ['resolved', 'Resolved', 'done_all'], ['all', 'All tickets', 'dataset'],
];
const LABELS = { Orders: '#3FA7E0', Changes: '#1D4577', Billing: '#B35C00', Sales: '#146C2E', Escalations: '#B3261E', Noise: '#74869B', Other: '#45566B' };
const STATUS = { new: 'New', open: 'Open', pending_customer: 'Waiting on customer', resolved: 'Resolved', closed: 'Closed' };
const FLAG_TEXT = {
  SECURITY_INJECTION: ['Injection attempt', 'bad', 'shield'], CREDIT_BLOCK: ['Credit block', 'bad', 'payments'], PRICE_DISPUTE: ['Price dispute', 'bad', 'receipt_long'],
  STOCK_SHORT: ['Stock short', 'bad', 'inventory_2'], DISCONTINUED: ['Discontinued', 'bad', 'block'], UNVERIFIED_SENDER: ['Unverified sender', 'bad', 'person_off'],
  UNKNOWN_SENDER: ['New sender', 'bad', 'person_off'], PO_REVISION: ['PO revision', 'bad', 'swap_horiz'], UNKNOWN_PRODUCT: ['Unknown item', 'bad', 'error'],
  SKU_CORRECTED: ['SKU corrected', 'warn', 'edit_note'], UNIT_UNCLEAR: ['Unit unclear', 'warn', 'help'], AMBIGUOUS_PRODUCT: ['Which item?', 'warn', 'help'],
  DATE_IN_PAST: ['Date passed', 'warn', 'schedule'], MISSING_ATTACHMENT: ['No attachment', 'warn', 'error'], FROM_HISTORY: ['From history', 'warn', 'history'],
  NOTHING_TO_ORDER: ['No items', 'warn', 'help'], DUPLICATE: ['Duplicate', 'info', 'done_all'], LINE_EXCLUDED: ['Line skipped', 'info', 'info'], MODEL_UNAVAILABLE: ['Rules only', 'info', 'info'],
  ORDER_NOT_FOUND: ['Order not found', 'bad', 'error'],
};
const SORTS = [['priority', 'Priority, then due time'], ['sla', 'Due soonest'], ['newest', 'Newest first'], ['oldest', 'Oldest first'], ['value', 'Highest value'], ['customer', 'Customer A to Z']];
const ROLE = { ops: 'Operations', credit: 'Credit and AR', admin: 'Admin' };

const state = { me: null, list: null, params: { view: 'inbox', q: '', sort: 'priority', page: 1, priority: '', status: '', label: '', flag: '' }, selected: new Set(), cursor: 0, rail: false };

async function api(path, opts = {}) {
  const res = await fetch(path, { credentials: 'same-origin', headers: { 'content-type': 'application/json' }, ...opts, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !path.includes('/login')) { state.me = null; location.hash = '#/signin'; throw new Error('Please sign in.'); }
  if (!res.ok) throw Object.assign(new Error(data.error || `Request failed (${res.status})`), { status: res.status });
  return data;
}

function snack(text, action) {
  $('.snackbar')?.remove();
  const el = document.createElement('div');
  el.className = 'snackbar'; el.setAttribute('role', 'status');
  el.innerHTML = `<span>${esc(text)}</span>${action ? `<button>${esc(action.label)}</button>` : ''}`;
  if (action) el.querySelector('button').onclick = () => { el.remove(); action.run(); };
  document.body.append(el);
  setTimeout(() => el.remove(), 5000);
}

// ---------------------------------------------------------------- sign in
function renderSignin(error = '') {
  document.title = 'Sign in · Order Desk';
  $('#root').innerHTML = `
  <main class="signin" id="main">
    <div class="signin-card">
      <div>
        <div class="brand"><div class="brand-mark">H<span>P</span></div><span class="brand-name">Order Desk</span></div>
        <h1 class="headline-s">Sign in</h1>
        <p class="muted">Use your Harbor Point account to review the orders the agent prepared from today's inbox.</p>
        <h2 class="title-s" style="margin-top:32px">Demo accounts</h2>
        <p class="body-s muted">Pick a role to fill the username. The password is in the submission note.</p>
        <div class="demo-accounts">
          ${[['ops', 'Jo Park', 'Operations: reviews and approves orders'], ['credit', 'Rina Hartono', 'Credit and AR: releases credit blocks and price exceptions'], ['admin', 'Alex Morgan', 'Admin: security flags and demo reset']].map(([u, n, d]) => `
            <button type="button" data-user="${u}"><span class="avatar">${initials(n)}</span><span><span class="title-s">${n}</span><br><span class="body-s muted">${d}</span></span></button>`).join('')}
        </div>
      </div>
      <form id="signin" novalidate>
        <div class="outlined"><input id="u" name="username" autocomplete="username" placeholder=" " required><label for="u">Username</label></div>
        <div class="outlined"><input id="p" name="password" type="password" autocomplete="current-password" placeholder=" " required><label for="p">Password</label>
          <button type="button" class="icon-btn" id="peek" aria-label="Show password">${icon('visibility')}</button></div>
        <p class="err" id="signin-err" role="alert">${error ? `${icon('error')} ${esc(error)}` : ''}</p>
        <div class="actions" style="justify-content:flex-end;margin-top:24px"><button class="btn btn-filled" id="go">Sign in</button></div>
      </form>
    </div>
  </main>`;
  $$('.demo-accounts button').forEach((b) => b.onclick = () => { $('#u').value = b.dataset.user; $('#p').focus(); });
  $('#peek').onclick = () => { const p = $('#p'); const show = p.type === 'password'; p.type = show ? 'text' : 'password'; $('#peek').setAttribute('aria-label', show ? 'Hide password' : 'Show password'); $('#peek').innerHTML = icon(show ? 'visibility_off' : 'visibility'); };
  $('#signin').onsubmit = async (e) => {
    e.preventDefault();
    const u = $('#u').value.trim(), p = $('#p').value;
    if (!u || !p) { $('#signin-err').innerHTML = `${icon('error')} Enter a username and password.`; return; }
    $('#go').disabled = true; $('#go').textContent = 'Signing in';
    try { await api('/api/login', { method: 'POST', body: { username: u, password: p } }); state.me = null; location.hash = '#/tickets'; route(); }
    catch (err) { $('#signin-err').innerHTML = `${icon('error')} ${esc(err.message)}`; $('#go').disabled = false; $('#go').textContent = 'Sign in'; }
  };
  $('#u').focus();
}

// ---------------------------------------------------------------- shell
function shell(active) {
  const me = state.me;
  const c = state.list?.counts || {};
  const lc = state.list?.label_counts || {};
  $('#root').innerHTML = `
  <div class="shell ${state.rail ? 'rail' : ''}" id="shell">
    <header class="topbar">
      <button class="icon-btn" id="menu-btn" aria-label="Toggle navigation">${icon('menu', 'ic-lg')}</button>
      <a class="brand" href="#/tickets"><div class="brand-mark">H<span>P</span></div><span class="brand-name">Order Desk</span></a>
      <div class="search" role="search">
        <div class="search-box">${icon('search', 'ic-lg')}
          <input id="q" type="search" placeholder="Search tickets, customers, SKUs" value="${esc(state.params.q)}" aria-label="Search tickets" autocomplete="off">
          ${state.params.q ? `<button class="icon-btn" id="q-clear" aria-label="Clear search">${icon('close')}</button>` : ''}
        </div>
        <div class="search-hints" id="hints">
          ${[['priority:urgent', 'Most urgent tickets'], ['is:unassigned', 'Nobody has picked these up'], ['customer:bluefin', 'One customer'], ['sku:HPS-1408', 'Tickets with this SKU'], ['flag:credit_block', 'Waiting on credit'], ['is:overdue', 'Past their due time']].map(([q, d]) => `<button type="button" data-q="${q}">${icon('search')}<code>${q}</code><span class="muted">${d}</span></button>`).join('')}
        </div>
      </div>
      <div class="topbar-right">
        <span class="tag info hide-sm" title="All times and due dates use this clock">${icon('schedule')} Demo clock ${stamp(me?.demo_now || '2026-11-02T12:00:00-05:00')}</span>
        <button class="icon-btn" id="help-btn" aria-label="How Order Desk works">${icon('help', 'ic-lg')}</button>
        <button class="icon-btn" id="me-btn" aria-label="Account" aria-haspopup="menu"><span class="avatar">${initials(me?.user.display_name)}</span></button>
      </div>
    </header>
    <div class="banner" id="banner">${me && !me.durable ? `${icon('info')} Demo storage: the data resets to this morning's inbox when the server restarts.` : ''}</div>
    <nav class="drawer" aria-label="Main">
      <button class="fab" id="next-btn" title="Open the most urgent ticket you can take">${icon('bolt', 'ic-lg')}<span class="lbl">Work next</span></button>
      ${VIEWS.map(([k, l, ic]) => `<a class="nav-item" href="#/tickets?view=${k}" ${active === k ? 'aria-current="page"' : ''} title="${l}">${icon(ic)}<span class="lbl">${l}</span><span class="count">${c[k] ?? ''}</span></a>`).join('')}
      <div class="nav-head label-m">Labels</div>
      ${Object.entries(LABELS).filter(([k]) => k !== 'Other').map(([k, col]) => `<a class="nav-item" href="#/tickets?view=all&label=${k.toLowerCase()}" ${active === `label:${k.toLowerCase()}` ? 'aria-current="page"' : ''} title="${k}"><span class="dot" style="background:${col}"></span><span class="lbl">${k}</span><span class="count">${lc[k] ?? ''}</span></a>`).join('')}
      <div class="nav-head label-m">Workspace</div>
      <a class="nav-item" href="#/stock" ${active === 'stock' ? 'aria-current="page"' : ''} title="Stock today">${icon('inventory_2')}<span class="lbl">Stock today</span></a>
      <a class="nav-item" href="#/audit" ${active === 'audit' ? 'aria-current="page"' : ''} title="Audit log">${icon('history')}<span class="lbl">Audit log</span></a>
      <a class="nav-item" href="#/results" ${active === 'results' ? 'aria-current="page"' : ''} title="Results">${icon('insights')}<span class="lbl">Results</span></a>
    </nav>
    <main class="main" id="main" tabindex="-1"></main>
  </div>`;
  $('#menu-btn').onclick = () => { if (innerWidth <= 860) $('#shell').classList.toggle('open'); else { state.rail = !state.rail; $('#shell').classList.toggle('rail', state.rail); } };
  const q = $('#q');
  const hints = $('#hints');
  q.onfocus = () => hints.classList.toggle('show', !q.value);
  q.oninput = debounce(() => { hints.classList.toggle('show', !q.value); go({ q: q.value, page: 1 }); }, 250);
  $$('#hints button').forEach((b) => b.onmousedown = (e) => { e.preventDefault(); q.value = b.dataset.q; hints.classList.remove('show'); go({ q: q.value, page: 1, view: 'all' }); });
  $('#q-clear')?.addEventListener('click', () => go({ q: '', page: 1 }));
  $('#help-btn').onclick = openHelp;
  $('#me-btn').onclick = (e) => openMenu(e.currentTarget, [
    { html: `<span class="avatar sm">${initials(me.user.display_name)}</span><span>${esc(me.user.display_name)}<br><span class="body-s muted">${ROLE[me.user.role]}</span></span>`, disabled: true },
    'hr',
    ...(me.user.role === 'admin' ? [{ html: `${icon('refresh')} Reset demo to 07:00`, run: resetDemo }] : []),
    { html: `${icon('logout')} Sign out`, run: async () => { await api('/api/logout', { method: 'POST' }); state.me = null; location.hash = '#/signin'; } },
  ]);
  $('#next-btn').onclick = () => { const id = state.list?.next_up; if (id) location.hash = `#/t/${id}`; else snack('Nothing waiting for you. Nice.'); };
}

function openMenu(anchor, items, align = 'right') {
  closeMenus();
  const m = document.createElement('div');
  m.className = 'menu'; m.setAttribute('role', 'menu');
  m.innerHTML = items.map((it, i) => (it === 'hr' ? '<hr>' : `<button role="menuitem${it.checked !== undefined ? 'radio' : ''}" ${it.checked !== undefined ? `aria-checked="${it.checked}"` : ''} data-i="${i}" ${it.disabled ? 'disabled' : ''}>${it.html}</button>`)).join('');
  document.body.append(m);
  const r = anchor.getBoundingClientRect();
  m.style.top = `${r.bottom + 4 + scrollY}px`;
  m.style.left = align === 'right' ? `${Math.max(8, r.right - m.offsetWidth)}px` : `${r.left}px`;
  $$('button', m).forEach((b) => b.onclick = () => { closeMenus(); items[b.dataset.i].run?.(); });
  $('button:not([disabled])', m)?.focus();
  setTimeout(() => document.addEventListener('click', closeMenus, { once: true }), 0);
}
function closeMenus() { $$('.menu').forEach((m) => m.remove()); }

function openHelp() {
  const s = document.createElement('div');
  s.innerHTML = `<div class="scrim"></div><aside class="sheet" role="dialog" aria-modal="true" aria-labelledby="help-t">
    <div style="display:flex;align-items:center"><h2 class="title-l" id="help-t" style="margin:0;flex:1">How Order Desk works</h2><button class="icon-btn" aria-label="Close">${icon('close')}</button></div>
    <ol>
      <li><b>Every email becomes a ticket.</b> The agent reads it, finds the customer, the items, prices, stock and credit, using read-only tools on the ERP.</li>
      <li><b>Clean orders go through on their own.</b> A known contact, every SKU and quantity written out, stock and credit fine: the order is written and the ticket lands in Auto-processed. You can still see every step it took.</li>
      <li><b>Everything else waits for you</b> in the Inbox, sorted by priority and due time. The agent has already drafted the order or the question to the customer.</li>
      <li><b>You decide.</b> Open a ticket, read what the agent found, edit quantities if needed, then approve, ask the customer, or close it. Before you approve, the page tells you exactly what will change in the ERP.</li>
      <li><b>Some decisions need a role.</b> Credit blocks and price exceptions need Credit and AR. Security flags need Admin.</li>
      <li><b>Everything is recorded</b> in the Audit log: what the agent did, who approved what, and why.</li>
    </ol>
    <h3 class="title-s">Keyboard</h3>
    <p class="body-s"><code>/</code> search · <code>j</code> <code>k</code> move · <code>Enter</code> open · <code>Esc</code> back · <code>n</code> work next</p>
    <h3 class="title-s">Search operators</h3>
    <p class="body-s"><code>priority:</code> urgent, high, normal, low · <code>status:</code> new, open, pending_customer · <code>label:</code> orders, changes, billing · <code>customer:</code> · <code>sku:</code> · <code>flag:</code> · <code>is:</code> unassigned, mine, overdue, flagged</p>
  </aside>`;
  document.body.append(s);
  const close = () => s.remove();
  $('.scrim', s).onclick = close; $('.sheet button', s).onclick = close;
  s.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  $('.sheet button', s).focus();
}

async function resetDemo() {
  if (!confirmText('Reset all tickets, orders and stock to the 07:00 snapshot? Everyone gets signed out.')) return;
  snack('Resetting the demo. This takes a few seconds.');
  await api('/api/admin/reset', { method: 'POST' }).catch((e) => snack(e.message));
  location.hash = '#/signin';
}
function confirmText(t) { return window.confirm(t); }

// ---------------------------------------------------------------- ticket list
function go(patch) {
  const p = { ...state.params, ...patch };
  const qs = new URLSearchParams(Object.entries(p).filter(([k, v]) => v && !(k === 'page' && v === 1) && !(k === 'sort' && v === 'priority')));
  location.hash = `#/tickets?${qs}`;
}

async function renderList(params) {
  state.params = { view: 'inbox', q: '', sort: 'priority', page: 1, priority: '', status: '', label: '', flag: '', ...params, page: Number(params.page) || 1 };
  const active = state.params.label && state.params.view === 'all' && !state.params.q ? `label:${state.params.label}` : state.params.view;
  if (!$('#shell')) shell(active);
  const main = $('#main');
  main.innerHTML = `<div class="toolbar">${'<span class="chip" style="width:120px"></span>'.repeat(3)}</div>${'<div class="skel"></div>'.repeat(8)}`;
  let data;
  try {
    const qs = new URLSearchParams(Object.entries(state.params).filter(([, v]) => v));
    data = await api(`/api/tickets?${qs}`);
  } catch (e) {
    if (e.status === 401) return;
    main.innerHTML = `<div class="empty">${icon('error')}<div class="title-m">The ticket list did not load.</div><div class="muted">${esc(e.message)}</div><button class="btn btn-tonal" id="retry">${icon('refresh')} Try again</button></div>`;
    $('#retry').onclick = () => renderList(params);
    return;
  }
  state.list = data;
  shell(active);
  drawList();
}

function drawList() {
  const data = state.list, p = state.params;
  const main = $('#main');
  const viewName = (VIEWS.find(([k]) => k === p.view) || [])[1] || 'Tickets';
  const filterChip = (key, label, options) => {
    const val = p[key];
    return `<button class="chip ${val ? 'on' : ''}" data-filter="${key}" aria-haspopup="menu">${val ? icon('check_circle') : ''}${esc(val ? `${label}: ${options.find(([k]) => k === val)?.[1] || val}` : label)}${icon('expand_more')}</button>`;
  };
  const f = data.facets;
  const opts = {
    priority: ['urgent', 'high', 'normal', 'low'].map((k) => [k, `${k[0].toUpperCase()}${k.slice(1)} (${f.priority[k] || 0})`]),
    status: Object.entries(STATUS).map(([k, v]) => [k, `${v} (${f.status[k] || 0})`]),
    label: Object.keys(LABELS).map((k) => [k.toLowerCase(), `${k} (${f.label[k] || 0})`]),
    flag: Object.keys(f.flags).sort((a, b) => f.flags[b] - f.flags[a]).map((k) => [k.toLowerCase(), `${FLAG_TEXT[k]?.[0] || k} (${f.flags[k]})`]),
  };
  const from = (data.page - 1) * data.size + 1, to = Math.min(data.page * data.size, data.total);
  const sel = state.selected;
  main.innerHTML = `
    <div class="toolbar">
      <h1 class="title-m" style="margin:0 8px 0 4px">${esc(p.q ? 'Search results' : p.label && p.view === 'all' ? p.label[0].toUpperCase() + p.label.slice(1) : viewName)}</h1>
      ${filterChip('priority', 'Priority', opts.priority)}${filterChip('status', 'Status', opts.status)}${filterChip('label', 'Label', opts.label)}${filterChip('flag', 'Flag', opts.flag)}
      ${['priority', 'status', 'label', 'flag'].some((k) => p[k]) ? `<button class="btn btn-text" id="clear-filters">Clear filters</button>` : ''}
      <span class="spacer"></span>
      <button class="chip" id="sort-btn" aria-haspopup="menu">${icon('sort')} ${esc(SORTS.find(([k]) => k === p.sort)?.[1])}</button>
      <div class="pager"><span>${data.total ? `${from} to ${to} of ${data.total}` : '0'}</span>
        <button class="icon-btn" id="prev" aria-label="Previous page" ${data.page <= 1 ? 'disabled' : ''}>${icon('chevron_left')}</button>
        <button class="icon-btn" id="nextp" aria-label="Next page" ${to >= data.total ? 'disabled' : ''}>${icon('chevron_right')}</button></div>
    </div>
    ${sel.size ? `<div class="bulkbar"><b>${sel.size} selected on this page</b><button class="btn btn-filled" id="bulk-assign">${icon('assignment_ind')} Assign to me</button><button class="btn btn-text" id="bulk-clear">Clear selection</button></div>` : ''}
    ${data.items.length ? `
    <ul class="list" role="listbox" aria-label="Tickets" tabindex="0">
      <li class="row" style="min-height:40px;cursor:default;font-size:12px;color:var(--on-surface-variant)" aria-hidden="true">
        <input type="checkbox" id="sel-all" aria-label="Select all tickets on this page" ${data.items.every((t) => sel.has(t.id)) ? 'checked' : ''}><span>Ticket</span><span>Customer</span><span>Subject and agent summary</span><span class="hide-sm">Flags</span><span class="num hide-md">Value</span><span class="num hide-sm">Due</span><span></span>
      </li>
      ${data.items.map((t, i) => {
        const late = ['new', 'open'].includes(t.status) && t.sla_due_at < data.demo_now;
        const flags = t.flags.filter((c) => FLAG_TEXT[c]);
        return `<li class="row ${t.status === 'new' ? 'unread' : ''} ${sel.has(t.id) ? 'sel' : ''}" role="option" data-id="${t.id}" aria-selected="${i === state.cursor}" tabindex="-1">
          <input type="checkbox" data-sel="${t.id}" aria-label="Select ${t.ticket_no}" ${sel.has(t.id) ? 'checked' : ''}>
          <span><span class="prio prio-${t.priority}" title="Priority ${t.priority}">${t.ticket_no.replace('HP-', '')}</span></span>
          <span class="cust" title="${esc(t.customer_name)}">${esc(t.customer_name)}</span>
          <span class="line"><span class="subj">${esc(t.subject)}</span> <span class="muted">· ${esc(t.summary)}</span></span>
          <span class="tags hide-sm">${t.lane === 'auto_committed' ? `<span class="tag ok">${icon('task_alt')} Written to ERP</span>` : ''}${flags.slice(0, 2).map((c) => `<span class="tag ${FLAG_TEXT[c][1]}">${icon(FLAG_TEXT[c][2])}${FLAG_TEXT[c][0]}</span>`).join('')}${flags.length > 2 ? `<span class="tag">+${flags.length - 2}</span>` : ''}${t.status === 'pending_customer' ? `<span class="tag info">${icon('hourglass_top')} Waiting</span>` : t.suggested === 'ask_customer' && ['new', 'open'].includes(t.status) ? `<span class="tag info">${icon('send')} Ask customer</span>` : ''}</span>
          <span class="num hide-md">${t.total ? money(t.total) : ''}</span>
          <span class="sla hide-sm ${late ? 'late' : ''}" title="Due ${stamp(t.sla_due_at)}">${['resolved', 'closed'].includes(t.status) ? STATUS[t.status] : `${late ? 'Late ' : ''}${time(t.sla_due_at)}`}</span>
          <span>${t.assignee ? `<span class="avatar sm" title="${esc(t.assignee_name)}">${initials(t.assignee_name)}</span>` : ''}</span>
        </li>`;
      }).join('')}
    </ul>` : `<div class="empty">${icon(p.q ? 'search' : 'task_alt')}<div class="title-m">${p.q ? 'No tickets match that search.' : `Nothing in ${esc(viewName)}.`}</div><div class="muted">${p.q ? 'Try fewer words, or one of the operators in the search box.' : 'New tickets appear here as emails arrive.'}</div></div>`}`;

  $$('[data-filter]').forEach((b) => b.onclick = (e) => { e.stopPropagation(); const k = b.dataset.filter; openMenu(b, [{ html: 'Any', checked: !p[k], run: () => go({ [k]: '', page: 1 }) }, ...opts[k].map(([v, l]) => ({ html: esc(l), checked: p[k] === v, run: () => go({ [k]: v, page: 1 }) }))], 'left'); });
  $('#clear-filters')?.addEventListener('click', () => go({ priority: '', status: '', label: '', flag: '', page: 1 }));
  $('#sort-btn').onclick = (e) => { e.stopPropagation(); openMenu(e.currentTarget, SORTS.map(([k, l]) => ({ html: l, checked: p.sort === k, run: () => go({ sort: k, page: 1 }) }))); };
  $('#prev')?.addEventListener('click', () => go({ page: data.page - 1 }));
  $('#nextp')?.addEventListener('click', () => go({ page: data.page + 1 }));
  $$('.row[data-id]').forEach((r) => r.onclick = (e) => { if (e.target.matches('input')) return; location.hash = `#/t/${r.dataset.id}`; });
  $$('[data-sel]').forEach((c) => c.onchange = () => { c.checked ? sel.add(c.dataset.sel) : sel.delete(c.dataset.sel); drawList(); });
  $('#sel-all')?.addEventListener('change', (e) => { data.items.forEach((t) => (e.target.checked ? sel.add(t.id) : sel.delete(t.id))); drawList(); });
  $('#bulk-clear')?.addEventListener('click', () => { sel.clear(); drawList(); });
  $('#bulk-assign')?.addEventListener('click', async () => {
    const ids = [...sel];
    for (const id of ids) await api(`/api/tickets/${id}/assign`, { method: 'POST', body: { assignee: 'me' } }).catch(() => {});
    sel.clear(); snack(`${ids.length} ticket${ids.length > 1 ? 's' : ''} assigned to you.`); renderList(state.params);
  });
}

// ---------------------------------------------------------------- ticket detail
async function refreshCounts() {
  try { state.list = await api(`/api/tickets?${new URLSearchParams({ view: state.params.view || 'inbox', size: '1' })}`); } catch { /* counts are a convenience */ }
}
async function renderTicket(id) {
  await refreshCounts();
  shell(state.params.view);
  const main = $('#main');
  main.innerHTML = `<div class="detail">${'<div class="skel" style="border-radius:16px;margin-bottom:12px;height:120px"></div>'.repeat(3)}</div>`;
  let t;
  try { t = await api(`/api/tickets/${id}`); }
  catch (e) { if (e.status === 401) return; main.innerHTML = `<div class="empty">${icon('error')}<div class="title-m">${esc(e.message)}</div><a class="btn btn-tonal" href="#/tickets">Back to tickets</a></div>`; return; }
  document.title = `${t.ticket_no} · ${t.customer_name || t.email.from_name} · Order Desk`;
  const p = t.proposal;
  const me = state.me.user;
  const flags = t.flags || [];
  const editable = t.can.approve && p.kind === 'order';
  const cr = p.credit;
  const users = t.users;
  const committed = t.erp_status === 'committed';
  const roleNeeded = flags.some((f) => f.code === 'SECURITY_INJECTION') ? 'admin' : flags.some((f) => ['CREDIT_BLOCK', 'PRICE_DISPUTE'].includes(f.code)) ? 'credit' : null;

  const ordersHtml = (p.orders || []).map((o, oi) => `
    <h3 class="title-s" style="margin:16px 0 4px">${p.orders.length > 1 ? `Order ${oi + 1} of ${p.orders.length}: ` : ''}deliver to ${esc(o.ship_to_name)} <span class="muted">(${o.ship_to_id})</span></h3>
    <div style="overflow-x:auto"><table>
      <thead><tr><th>SKU</th><th>Item</th><th class="num">Qty</th><th class="num">Unit price</th><th>Price from</th><th class="num">Available</th><th class="num">Line total</th></tr></thead>
      <tbody>${o.lines.map((l, li) => `<tr>
        <td><b>${l.sku}</b>${l.inferred ? `<br><span class="tag warn" title="Matched from: ${esc(l.from_text || '')}">${icon('edit_note')} read from text</span>` : ''}</td>
        <td>${esc(l.name)}<br><span class="body-s muted">${esc(l.pack)}${l.status !== 'ACTIVE' ? ` · <span style="color:var(--error)">discontinued${l.replaced_by ? `, successor ${l.replaced_by}` : ''}</span>` : ''}</span></td>
        <td class="num">${editable ? `<input class="qty" type="number" min="0" step="1" inputmode="numeric" data-o="${oi}" data-l="${li}" value="${l.qty}" aria-label="Quantity of ${l.sku}">` : l.qty} <span class="body-s muted">${l.sell_uom}</span></td>
        <td class="num">${money(l.unit_price)}</td>
        <td>${l.price_source === 'contract' ? '<span class="tag ok">Contract</span>' : '<span class="tag">List</span>'}</td>
        <td class="num" style="${l.stock_ok ? '' : 'color:var(--error);font-weight:650'}">${l.available}</td>
        <td class="num">${money(l.line_value)}</td></tr>`).join('')}
      </tbody></table></div>`).join('');

  const creditHtml = cr ? (() => {
    const lim = cr.credit_limit || 1;
    const used = Math.min(100, ((cr.open_balance + cr.open_orders_value) / lim) * 100);
    const thisPct = Math.max(0, Math.min(100 - used, (cr.order_value / lim) * 100));
    const over = cr.headroom_after < 0;
    return `<div class="title-s" style="margin-top:16px">Credit after this order</div>
      <div class="meter" role="img" aria-label="Credit used ${money(cr.exposure_after)} of ${money(cr.credit_limit)}"><i class="used" style="width:${used}%"></i><i class="${over ? 'over' : 'this'}" style="width:${over ? 100 - used : thisPct}%"></i></div>
      <div class="body-s muted">Open balance ${money(cr.open_balance)} + open orders ${money(cr.open_orders_value)} + this order ${money(cr.order_value)} = <b style="color:${over ? 'var(--error)' : 'inherit'}">${money(cr.exposure_after)}</b> of ${money(cr.credit_limit)} limit${over ? `, <b style="color:var(--error)">${money(-cr.headroom_after)} over</b>` : `, ${money(cr.headroom_after)} left`}. Account ${esc(cr.status)}.</div>`;
  })() : '';

  const changeHtml = p.kind === 'change' && p.target ? `
    <p>Change to <b>${p.target.so_number}</b> (PO ${esc(p.target.customer_po)}), status <b>${esc(p.target.status)}</b>.</p>
    <table><thead><tr><th>Change</th><th>SKU</th><th>Item</th><th class="num">From</th><th class="num">To</th><th class="num">Value change</th></tr></thead><tbody>
    ${(p.ops || []).map((o) => `<tr><td>${o.op === 'set_qty' ? 'Change quantity' : 'Add line'}</td><td><b>${o.sku}</b></td><td>${esc(o.name)}</td><td class="num">${o.op === 'set_qty' ? o.from : ''}</td><td class="num">${o.op === 'set_qty' ? o.to : o.qty}</td><td class="num">${money(o.delta_value)}</td></tr>`).join('')}
    </tbody></table>` : '';
  const cancelHtml = p.kind === 'cancel' && p.target ? `<p>Cancel <b>${p.target.so_number}</b> (PO ${esc(p.target.customer_po)}), status <b>${esc(p.target.status)}</b>. Allocated stock goes back to available:</p>
    <table><thead><tr><th>SKU</th><th class="num">Ordered</th><th class="num">Shipped</th><th class="num">Released</th></tr></thead><tbody>${p.target.lines.map((l) => `<tr><td><b>${l.sku}</b></td><td class="num">${l.qty_ordered}</td><td class="num">${l.qty_shipped}</td><td class="num">${l.qty_ordered - l.qty_shipped}</td></tr>`).join('')}</tbody></table>` : '';

  const consequence = t.can.approve ? `
    <div class="consequence" id="consequence">
      <div class="title-s">${icon('info')} What approving does</div>
      <ul>
        ${p.kind === 'order' ? `<li>Writes ${p.orders.length} sales order${p.orders.length > 1 ? 's' : ''} for ${esc(t.customer_name)} into the ERP, status OPEN, PO ${esc(p.customer_po || 'none')}.</li><li>Allocates the stock above. Prices are looked up again at that moment; your edits only change quantities.</li>` : ''}
        ${p.kind === 'change' ? `<li>Updates ${p.target?.so_number} in place and allocates the extra stock.</li>` : ''}
        ${p.kind === 'cancel' ? `<li>Sets ${p.target?.so_number} to CANCELLED and releases its stock. This cannot be undone from here.</li>` : ''}
        ${cr && cr.headroom_after < 0 ? `<li style="color:var(--error)">Goes ${money(-cr.headroom_after)} over the credit limit. Only Credit and AR can release it, with a reason.</li>` : ''}
        ${cr && cr.status !== 'ACTIVE' ? `<li style="color:var(--error)">The account is on ${esc(cr.status)}. Only Credit and AR can release it, with a reason.</li>` : ''}
        <li>Records your name and reason in the audit log. The customer is not emailed automatically.</li>
      </ul>
      <div class="field"><label for="reason">Reason ${roleNeeded === 'credit' || p.kind === 'cancel' ? '(required)' : '(optional)'}</label><textarea id="reason" placeholder="What did you check?"></textarea></div>
      ${cr && (cr.headroom_after < 0 || cr.status !== 'ACTIVE') ? `<label style="display:flex;gap:8px;align-items:center"><input type="checkbox" id="override"> Release the credit block for this order</label>` : ''}
      <div class="actions">
        <button class="btn btn-filled" id="approve">${icon('check_circle')} ${p.kind === 'cancel' ? 'Cancel the order in ERP' : p.kind === 'change' ? 'Apply change in ERP' : 'Approve and write to ERP'}</button>
        <button class="btn btn-danger" id="reject">${icon('cancel')} Reject</button>
      </div>
      <div id="act-msg" role="alert"></div>
    </div>` : roleNeeded && !committed && !['resolved', 'closed'].includes(t.status) ? `<div class="callout info">${icon('lock')}<div>This ticket needs the <b>${ROLE[roleNeeded]}</b> role to approve. You can still assign it, add a note or reply to the customer.</div></div>` : '';

  const assigneeName = users.find((u) => u.username === t.assignee)?.display_name;
  const auditRows = [...t.audit.map((a) => ({ at: a.at, who: a.actor, type: a.actor_type, what: a.action.replace(/_/g, ' '), detail: a.detail })), ...t.comments.map((c) => ({ at: c.at, who: c.display_name || c.author, type: 'note', what: 'note', body: c.body })), ...t.outbox.map((o) => ({ at: o.at, who: o.sent_by, type: 'human', what: 'reply queued', body: o.body }))].sort((a, b) => new Date(a.at) - new Date(b.at));

  main.innerHTML = `
  <div class="detail">
    <div class="detail-head">
      <a class="icon-btn" href="#/tickets?${new URLSearchParams(Object.entries(state.params).filter(([, v]) => v && v !== 1))}" aria-label="Back to the list">${icon('arrow_back', 'ic-lg')}</a>
      <h1 class="title-l">${esc(t.email.subject)}</h1>
      <div class="actions" style="margin:0">
        <button class="chip" id="assign-btn" aria-haspopup="menu">${t.assignee ? `<span class="avatar sm">${initials(assigneeName)}</span> ${esc(assigneeName)}` : `${icon('assignment_ind')} Assign`}${icon('expand_more')}</button>
        <button class="chip" id="status-btn" aria-haspopup="menu">${esc(STATUS[t.status])}${icon('expand_more')}</button>
      </div>
    </div>
    <div class="meta-row">
      <span class="tag navy">${t.ticket_no}</span>
      <span class="prio prio-${t.priority}">${t.priority[0].toUpperCase()}${t.priority.slice(1)} priority</span>
      <span class="tag"><span class="dot" style="background:${LABELS[t.label] || '#45566B'}"></span>${esc(t.label)}</span>
      <span class="tag">${esc(t.intent.replace(/_/g, ' '))}</span>
      <span class="body-s muted">Received ${time(t.email.received_at)} · due ${time(t.sla_due_at)} · ${esc(t.email.email_id)}</span>
      ${committed ? `<span class="tag ok">${icon('task_alt')} In ERP${p.so_numbers ? `: ${p.so_numbers.join(', ')}` : p.cancelled ? `: ${p.cancelled} cancelled` : p.changed ? `: ${p.changed} changed` : ''}</span>` : ''}
    </div>
    <div class="cols">
      <div>
        <section class="card tonal" aria-label="Agent summary">
          <h2>${icon('support_agent')} What the agent found</h2>
          <p style="margin-top:0">${esc(t.summary)}</p>
          ${flags.map((f) => `<div class="callout ${f.severity === 'bad' ? 'bad' : f.severity === 'info' ? 'info' : 'warn'}">${icon(FLAG_TEXT[f.code]?.[2] || 'info')}<div><b>${esc(FLAG_TEXT[f.code]?.[0] || f.code)}.</b> ${esc(f.text)}</div></div>`).join('')}
          ${p.evidence ? `<div class="callout info">${icon('receipt_long')}<div>${esc(p.evidence)}</div></div>` : ''}
          ${p.related?.length ? `<p class="body-s muted">Earlier tickets from this customer today: ${p.related.map((r) => `<a href="#/t/${r}">${r}</a>`).join(', ')}</p>` : ''}
        </section>
        ${(p.orders?.length || changeHtml || cancelHtml) ? `<section class="card" aria-label="Proposal">
          <h2>${icon(p.kind === 'cancel' ? 'cancel' : p.kind === 'change' ? 'swap_horiz' : 'shopping_cart')} ${p.kind === 'quote' ? 'Quote draft' : p.kind === 'change' ? 'Proposed change' : p.kind === 'cancel' ? 'Proposed cancellation' : 'Proposed order'}</h2>
          ${ordersHtml}${changeHtml}${cancelHtml}
          ${p.total != null && p.orders?.length ? `<div class="num title-m" style="margin-top:12px">Total ${money(p.total)} USD</div>` : ''}
          ${creditHtml}
          ${consequence}
        </section>` : consequence ? `<section class="card">${consequence}</section>` : ''}
        <section class="card" aria-label="Reply">
          <h2>${icon('send')} ${p.questions?.length ? 'Ask the customer' : 'Reply to the customer'}</h2>
          ${p.questions?.length ? `<ul class="body-s">${p.questions.map((q) => `<li>${esc(q)}</li>`).join('')}</ul>` : ''}
          <div class="field"><label for="reply">Message to ${esc(t.email.from_email)}</label><textarea id="reply" rows="7">${esc(p.reply_draft || '')}</textarea></div>
          <div class="actions"><button class="btn btn-tonal" id="send-reply">${icon('send')} Queue reply</button><span class="body-s muted">The demo keeps replies in an outbox; nothing is emailed.</span></div>
        </section>
        <section class="card" aria-label="Original email">
          <h2>${icon('mark_email_unread')} Original email</h2>
          <div class="body-s muted" style="margin-bottom:8px">From <b>${esc(t.email.from_name)}</b> &lt;${esc(t.email.from_email)}&gt; · ${stamp(t.email.received_at)}</div>
          <pre class="mail">${esc(t.email.body)}</pre>
        </section>
      </div>
      <aside>
        ${t.customer_id ? `<section class="card"><h2>${icon('person')} ${esc(t.customer_name)}</h2>
          <dl class="kv"><dt>Customer</dt><dd>${t.customer_id}</dd><dt>Status</dt><dd>${t.customer_status === 'ACTIVE' ? '<span class="tag ok">ACTIVE</span>' : `<span class="tag bad">${esc(t.customer_status)}</span>`}</dd><dt>Terms</dt><dd>${esc(t.payment_terms)}</dd><dt>Credit limit</dt><dd>${money(t.credit_limit)}</dd><dt>Open balance</dt><dd>${money(t.open_balance)}</dd></dl></section>` : ''}
        <section class="card"><h2>${icon('checklist')} Checks</h2>
          ${t.checks.length ? `<ul class="checks">${t.checks.map((c) => `<li>${icon(c.pass ? 'check_circle' : 'cancel', c.pass ? 'pass' : 'fail')}<span>${esc(c.label)}${c.detail && !c.pass ? `<br><span class="muted">${esc(c.detail)}</span>` : ''}</span></li>`).join('')}</ul>
          <p class="body-s muted">${t.lane === 'auto_committed' ? 'All checks passed, so the agent wrote the order on its own.' : 'A ticket is written to the ERP on its own only when every check passes.'}</p>` : '<p class="muted body-s">No ERP checks for this kind of email.</p>'}
        </section>
        <section class="card"><h2>${icon('support_agent')} Agent steps</h2>
          <ol class="timeline">${t.trace.map((s) => `<li><b>${esc(s.tool.replace(/_/g, ' '))}</b><details><summary>input and output</summary><pre>${esc(JSON.stringify({ input: s.input, output: s.output }, null, 2))}</pre></details></li>`).join('')}</ol>
          <p class="body-s muted">Reader: ${esc(t.model === 'rules' ? 'deterministic rules (no model configured)' : t.model)}. All tools are read-only.</p>
        </section>
        <section class="card"><h2>${icon('history')} Activity</h2>
          <ol class="timeline">${auditRows.map((a) => `<li class="${a.type === 'human' || a.type === 'note' ? 'human' : ''}"><b>${esc(a.who)}</b> ${esc(a.what)} <span class="body-s muted">${time(a.at)}</span>${a.body ? `<div class="body-s" style="white-space:pre-wrap">${esc(a.body)}</div>` : a.detail && Object.keys(a.detail).length ? `<details><summary>details</summary><pre>${esc(JSON.stringify(a.detail, null, 2))}</pre></details>` : ''}</li>`).join('')}</ol>
          <div class="field"><label for="note">Internal note</label><textarea id="note" rows="2" placeholder="Visible to the team only"></textarea></div>
          <button class="btn btn-text" id="add-note">${icon('add_comment')} Add note</button>
        </section>
      </aside>
    </div>
  </div>`;

  const msg = (text, ok) => { const el = $('#act-msg'); if (el) el.innerHTML = `<p class="err" style="${ok ? 'color:var(--success)' : ''}">${icon(ok ? 'check_circle' : 'error')} ${esc(text)}</p>`; };
  $('#approve')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const reason = $('#reason').value.trim();
    const override = $('#override')?.checked;
    if ((roleNeeded === 'credit' || p.kind === 'cancel') && !reason) { msg('Add a reason first. It goes into the audit log.'); $('#reason').focus(); return; }
    let orders;
    if (editable) {
      orders = JSON.parse(JSON.stringify(p.orders));
      $$('.qty').forEach((i) => { orders[i.dataset.o].lines[i.dataset.l].qty = Number(i.value); });
      if ($$('.qty').some((i) => !Number.isInteger(Number(i.value)) || Number(i.value) < 0)) { msg('Quantities must be whole numbers.'); return; }
    }
    btn.disabled = true; btn.textContent = 'Writing to the ERP';
    try {
      const r = await api(`/api/tickets/${id}/approve`, { method: 'POST', body: { orders, reason, credit_override: override, row_version: t.row_version } });
      snack(r.so_numbers ? `Written to the ERP: ${r.so_numbers.join(', ')}` : r.cancelled ? `${r.cancelled} cancelled` : `${r.changed} updated`);
      renderTicket(id);
    } catch (err) { msg(err.message); btn.disabled = false; btn.innerHTML = `${icon('check_circle')} Try again`; }
  });
  $('#reject')?.addEventListener('click', async () => {
    const reason = $('#reason').value.trim();
    if (!reason) { msg('Add a short reason so the next person knows why.'); $('#reason').focus(); return; }
    try { await api(`/api/tickets/${id}/reject`, { method: 'POST', body: { reason, row_version: t.row_version } }); snack('Ticket closed.'); renderTicket(id); } catch (err) { msg(err.message); }
  });
  $('#send-reply').onclick = async () => {
    try { const r = await api(`/api/tickets/${id}/reply`, { method: 'POST', body: { body: $('#reply').value } }); snack(r.status === 'pending_customer' ? 'Reply queued. Ticket moved to Waiting on customer.' : 'Reply queued.'); renderTicket(id); }
    catch (err) { snack(err.message); }
  };
  $('#add-note').onclick = async () => { try { await api(`/api/tickets/${id}/comment`, { method: 'POST', body: { body: $('#note').value } }); renderTicket(id); } catch (err) { snack(err.message); } };
  $('#assign-btn').onclick = (e) => { e.stopPropagation(); openMenu(e.currentTarget, [{ html: `${icon('person')} Assign to me`, run: () => act('assign', { assignee: 'me' }) }, ...users.filter((u) => u.username !== me.username).map((u) => ({ html: `<span class="avatar sm">${initials(u.display_name)}</span> ${esc(u.display_name)} <span class="muted body-s">${ROLE[u.role]}</span>`, run: () => act('assign', { assignee: u.username }) })), 'hr', { html: `${icon('person_off')} Unassign`, run: () => act('assign', { assignee: null }) }]); };
  $('#status-btn').onclick = (e) => { e.stopPropagation(); openMenu(e.currentTarget, ['open', 'pending_customer', 'resolved', 'closed'].map((s) => ({ html: STATUS[s], checked: t.status === s, run: () => act('status', { status: s }) }))); };
  async function act(action, body) { try { await api(`/api/tickets/${id}/${action}`, { method: 'POST', body }); renderTicket(id); } catch (err) { snack(err.message); } }
  main.focus();
}

// ---------------------------------------------------------------- stock, audit, results
async function renderStock() {
  shell('stock');
  const main = $('#main');
  main.innerHTML = '<div class="page"><div class="skel"></div></div>';
  const rows = await api('/api/stock');
  let sort = 'short';
  const draw = (filter = '') => {
    const f = filter.toLowerCase();
    const list = rows.filter((r) => !f || `${r.sku} ${r.name} ${r.category}`.toLowerCase().includes(f))
      .sort(sort === 'short' ? (a, b) => b.short_by - a.short_by || b.pending_demand - a.pending_demand || a.sku.localeCompare(b.sku) : (a, b) => a.sku.localeCompare(b.sku));
    $('#stock-body').innerHTML = list.map((r) => `<tr><td><b>${r.sku}</b></td><td>${esc(r.name)}</td><td class="num">${r.on_hand}</td><td class="num">${r.allocated}</td><td class="num" style="${r.available <= 5 ? 'color:var(--error);font-weight:650' : ''}">${r.available}</td><td class="num">${r.pending_demand || ''}</td><td class="num">${r.short_by ? `<span class="tag bad">${r.short_by} short</span>` : ''}</td><td class="num">${r.incoming ? `${r.incoming} on ${String(r.next_in).slice(0, 10)}` : ''}</td><td class="body-s muted">${r.pending_tickets.join(', ')}</td></tr>`).join('');
  };
  main.innerHTML = `<div class="page"><h1 class="title-l">Stock today</h1><p class="muted">Available stock after everything written to the ERP so far, and how much the tickets still open would take.</p>
    <div class="toolbar" style="padding-left:0;border:0"><div class="search-box" style="height:40px;max-width:360px">${icon('search')}<input id="sf" placeholder="Filter by SKU or item" aria-label="Filter stock"></div>
    <button class="chip on" id="s-short">Shortfalls first</button><button class="chip" id="s-sku">By SKU</button></div>
    <div style="overflow-x:auto"><table><thead><tr><th>SKU</th><th>Item</th><th class="num">On hand</th><th class="num">Allocated</th><th class="num">Available</th><th class="num">Asked in open tickets</th><th class="num">Gap</th><th class="num">Incoming</th><th>Tickets</th></tr></thead><tbody id="stock-body"></tbody></table></div></div>`;
  draw();
  $('#sf').oninput = debounce((e) => draw(e.target.value), 150);
  $('#s-short').onclick = () => { sort = 'short'; $('#s-short').classList.add('on'); $('#s-sku').classList.remove('on'); draw($('#sf').value); };
  $('#s-sku').onclick = () => { sort = 'sku'; $('#s-sku').classList.add('on'); $('#s-short').classList.remove('on'); draw($('#sf').value); };
}

async function renderAudit(q = '', type = '') {
  shell('audit');
  const main = $('#main');
  const rows = await api(`/api/audit?${new URLSearchParams({ q, actor_type: type })}`);
  main.innerHTML = `<div class="page"><h1 class="title-l">Audit log</h1><p class="muted">Every agent step and every human decision, newest first. Entries cannot be edited from the app.</p>
    <div class="toolbar" style="padding-left:0;border:0"><div class="search-box" style="height:40px;max-width:360px">${icon('search')}<input id="af" value="${esc(q)}" placeholder="Search actions, tickets, people" aria-label="Search audit log"></div>
    ${[['', 'Everyone'], ['agent', 'Agent'], ['human', 'People'], ['system', 'System']].map(([k, l]) => `<button class="chip ${type === k ? 'on' : ''}" data-t="${k}">${l}</button>`).join('')}</div>
    <div style="overflow-x:auto"><table><thead><tr><th>Time</th><th>Who</th><th>Ticket</th><th>Action</th><th>Details</th></tr></thead><tbody>
    ${rows.map((a) => `<tr><td class="body-s">${stamp(a.at)}</td><td><span class="avatar sm ${a.actor_type === 'agent' ? 'agent' : ''}">${a.actor_type === 'agent' ? 'AI' : initials(a.actor)}</span> ${esc(a.actor)}</td><td>${a.email_id ? `<a href="#/t/${a.email_id}">${esc(a.ticket_no || a.email_id)}</a>` : ''}</td><td>${esc(a.action.replace(/_/g, ' '))}</td><td class="body-s muted" style="max-width:520px">${esc(JSON.stringify(a.detail))}</td></tr>`).join('')}
    </tbody></table></div></div>`;
  $('#af').oninput = debounce((e) => { renderAudit(e.target.value, type).then(() => { const el = $('#af'); el.focus(); el.setSelectionRange(el.value.length, el.value.length); }); }, 300);
  $$('[data-t]').forEach((b) => b.onclick = () => renderAudit($('#af').value, b.dataset.t));
}

async function renderResults() {
  shell('results');
  const main = $('#main');
  const r = await api('/api/results');
  const laneName = { auto_committed: 'Auto-processed', needs_review: 'Needs review', waiting_on_customer: 'Ask customer', no_action: 'No action' };
  main.innerHTML = `<div class="page"><h1 class="title-l">Results on the 2 November inbox</h1>
    <p class="muted">How the agent routed each of the 40 emails, compared with the hand-checked labels in <code>data/golden_labels.json</code>. Reader: ${esc(r.model === 'rules' ? 'deterministic rules, no model' : r.model)}.</p>
    <div class="kpis">
      <div class="kpi"><b>${r.lane_agreement}/${r.scored}</b>routing matches the labels</div>
      <div class="kpi"><b>${r.unsafe_auto_commits}</b>orders written that should have waited (target 0)</div>
      <div class="kpi"><b>${r.lanes.auto_committed || 0}</b>written to the ERP with no person, ${r.missed_auto_commits} missed</div>
      <div class="kpi"><b>${r.orders_written}</b>sales orders written today, ${money(r.value_written)} USD</div>
    </div>
    <div style="overflow-x:auto"><table><thead><tr><th>Ticket</th><th>Email</th><th>Customer</th><th>Intent</th><th>Agent routed to</th><th>Label says</th><th>Match</th></tr></thead><tbody>
    ${r.per.map((x) => `<tr><td><a href="#/t/${x.email_id}">${x.ticket_no}</a></td><td>${x.email_id}</td><td>${esc(x.customer_name || 'Unknown sender')}</td><td>${esc(x.intent.replace(/_/g, ' '))}</td><td>${laneName[x.lane]}</td><td>${laneName[x.expected_lane] || ''}</td><td>${x.expected_lane ? (x.lane === x.expected_lane ? icon('check_circle', 'pass') : icon('cancel', 'fail')) : ''}</td></tr>`).join('')}
    </tbody></table></div></div>`;
}

// ---------------------------------------------------------------- router and keyboard
async function route() {
  closeMenus();
  const [path, query = ''] = location.hash.slice(1).split('?');
  if (path === '/signin') return renderSignin();
  if (!state.me) {
    try { state.me = await api('/api/me'); } catch { return renderSignin(); }
  }
  const params = Object.fromEntries(new URLSearchParams(query));
  if (path.startsWith('/t/')) return renderTicket(path.slice(3));
  if (path === '/stock') return renderStock();
  if (path === '/audit') return renderAudit();
  if (path === '/results') return renderResults();
  document.title = 'Tickets · Order Desk';
  return renderList(params);
}

document.addEventListener('keydown', (e) => {
  if (e.target.matches('input, textarea, select') || e.metaKey || e.ctrlKey || e.altKey) { if (e.key === 'Escape') e.target.blur(); return; }
  const rows = $$('.row[data-id]');
  if (e.key === '/') { e.preventDefault(); $('#q')?.focus(); }
  else if (e.key === 'n') $('#next-btn')?.click();
  else if (e.key === 'Escape' && location.hash.startsWith('#/t/')) history.back();
  else if (rows.length && (e.key === 'j' || e.key === 'k')) {
    state.cursor = Math.max(0, Math.min(rows.length - 1, state.cursor + (e.key === 'j' ? 1 : -1)));
    rows.forEach((r, i) => r.setAttribute('aria-selected', i === state.cursor));
    rows[state.cursor].scrollIntoView({ block: 'nearest' });
  } else if (rows.length && e.key === 'Enter') location.hash = `#/t/${rows[state.cursor].dataset.id}`;
});
addEventListener('hashchange', () => { if (!location.hash.startsWith('#/tickets')) state.cursor = 0; route(); });
route();
