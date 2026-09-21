// readit-idgaf dashboard. Plain ES module, no build step. All text is inserted with
// textContent (never innerHTML), because URLs, errors and logs come from arbitrary web pages.

const REFRESH_MS = 5000;
const LEVELS = { 10: 'trace', 20: 'debug', 30: 'info', 40: 'warn', 50: 'error', 60: 'fatal' };

const state = {
  tab: 'usage',
  range: '7d',
  status: '',
  q: '',
  level: 30,
  open: new Set(),
  details: new Map(),
  info: null,
};

// ---------- helpers ----------

/** Creates an element. `attrs` keys starting with "on" become listeners. */
function h(tag, attrs = {}, ...children) {
  const el =
    tag === 'svg' || attrs.svg
      ? document.createElementNS('http://www.w3.org/2000/svg', tag)
      : document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false || key === 'svg') continue;
    if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else if (key === 'class') el.setAttribute('class', value);
    // CSSOM, not the style attribute: the CSP forbids inline style attributes.
    else if (key === 'style') Object.assign(el.style, value);
    else el.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

function svg(tag, attrs = {}, ...children) {
  return h(tag, { ...attrs, svg: true }, ...children);
}

const $ = (sel) => document.querySelector(sel);

async function api(path, options = {}) {
  const init = {
    ...options,
    headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
    credentials: 'same-origin',
  };
  let res;
  try {
    res = await fetch(path, init);
  } catch {
    // Network error (e.g. a stale connection through the WSL relay). Every endpoint is safe to
    // repeat (saving a credential upserts by domain), so retry once before giving up.
    try {
      res = await fetch(path, init);
    } catch {
      throw new Error('Could not reach the dashboard server. Is `pnpm dashboard` still running?');
    }
  }
  const body = res.headers.get('content-type')?.includes('json')
    ? await res.json()
    : await res.text();
  if (!res.ok)
    throw new Error(typeof body === 'string' ? body : body.error || `HTTP ${res.status}`);
  return body;
}

function fmtNum(n) {
  if (n === null || n === undefined) return '—';
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e4) return `${(n / 1e3).toFixed(0)}k`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(Math.round(n));
}

function fmtMs(ms) {
  if (ms === null || ms === undefined) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)} s`;
  return `${(ms / 60000).toFixed(1)} min`;
}

function fmtAgo(ts) {
  if (!ts) return '—';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 0) return fmtIn(ts);
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

function fmtIn(ts) {
  const s = Math.round((ts - Date.now()) / 1000);
  if (s <= 0) return 'expired';
  if (s < 3600) return `in ${Math.round(s / 60)}m`;
  if (s < 86400) return `in ${Math.round(s / 3600)}h`;
  return `in ${Math.round(s / 86400)}d`;
}

function fmtTime(ts) {
  return new Date(ts).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'medium' });
}

function fmtClock(ts) {
  return new Date(ts).toLocaleTimeString(undefined, { hour12: false });
}

function splitUrl(url) {
  if (!url) return { host: '', path: '' };
  try {
    const u = new URL(url);
    return { host: u.hostname.replace(/^www\./, ''), path: `${u.pathname}${u.search}` };
  } catch {
    return { host: url, path: '' };
  }
}

let toastTimer;
function toast(message) {
  const el = $('#toast');
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 3500);
}

function setPressed(group, value) {
  for (const b of group.querySelectorAll('button'))
    b.setAttribute('aria-pressed', String(b.dataset.value === value));
}

// ---------- usage ----------

function kpi(label, value, sub, cls) {
  return h(
    'div',
    { class: `kpi ${cls ?? ''}` },
    h('div', { class: 'label' }, label),
    h('div', { class: 'value' }, value),
    h('div', { class: 'sub' }, sub)
  );
}

function renderKpis(stats) {
  const t = stats.totals;
  const failed = t.calls - t.ok;
  const rate = t.calls ? `${Math.round((t.ok / t.calls) * 100)}%` : '—';
  $('#kpis').replaceChildren(
    kpi('Calls', fmtNum(t.calls), `${fmtNum(failed)} not ok`),
    kpi('Success rate', rate, `${fmtNum(t.ok)} ok`),
    kpi(
      'Blocked / login',
      fmtNum(t.blocked + t.login),
      `${t.blocked} challenge · ${t.login} login wall`,
      t.blocked + t.login > 0 ? 'bad' : ''
    ),
    kpi(
      'Latency p50',
      fmtMs(stats.latency.p50),
      `p95 ${fmtMs(stats.latency.p95)} · max ${fmtMs(stats.latency.max)}`
    ),
    kpi('Served', `${fmtNum(t.chars)}`, 'characters returned to agents')
  );
}

function dayRange(days) {
  const out = [];
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  for (let i = days - 1; i >= 0; i--) {
    const x = new Date(d);
    x.setDate(d.getDate() - i);
    out.push(x.toLocaleDateString('en-CA'));
  }
  return out;
}

function renderChart(perDay) {
  const byDay = new Map(perDay.map((d) => [d.day, d]));
  const days =
    state.range === '24h'
      ? dayRange(2)
      : state.range === '7d'
        ? dayRange(7)
        : state.range === '30d'
          ? dayRange(30)
          : perDay.map((d) => d.day);
  const container = $('#chart');
  if (days.length === 0 || perDay.length === 0) {
    container.replaceChildren(h('div', { class: 'empty' }, 'No calls in this range yet.'));
    return;
  }
  const W = Math.max(320, Math.round(container.clientWidth || 1000));
  const H = 150;
  const pad = { l: 28, r: 6, t: 8, b: 20 };
  const max = Math.max(
    1,
    ...days.map((day) => (byDay.get(day)?.ok ?? 0) + (byDay.get(day)?.failed ?? 0))
  );
  const slot = (W - pad.l - pad.r) / days.length;
  const bw = Math.max(2, Math.min(36, slot * 0.62));
  const y = (v) => pad.t + (H - pad.t - pad.b) * (1 - v / max);
  const root = svg('svg', {
    viewBox: `0 0 ${W} ${H}`,
    role: 'img',
    'aria-label': 'Calls per day',
  });

  for (const v of [0, Math.ceil(max / 2), max]) {
    root.append(svg('line', { class: 'grid', x1: pad.l, x2: W - pad.r, y1: y(v), y2: y(v) }));
    root.append(
      svg('text', { class: 'axis', x: pad.l - 6, y: y(v) + 3, 'text-anchor': 'end' }, String(v))
    );
  }
  const every = Math.ceil(days.length / 10);
  days.forEach((day, i) => {
    const d = byDay.get(day) ?? { ok: 0, failed: 0 };
    const x = pad.l + slot * i + (slot - bw) / 2;
    const g = svg('g', {}, svg('title', {}, `${day}: ${d.ok} ok, ${d.failed} failed`));
    if (d.ok)
      g.append(
        svg('rect', { class: 'ok', x, width: bw, y: y(d.ok), height: y(0) - y(d.ok), rx: 2 })
      );
    if (d.failed)
      g.append(
        svg('rect', {
          class: 'bad',
          x,
          width: bw,
          y: y(d.ok + d.failed),
          height: y(d.ok) - y(d.ok + d.failed) - (d.ok ? 1 : 0),
          rx: 2,
        })
      );
    root.append(g);
    if (i % every === 0)
      root.append(
        svg(
          'text',
          { class: 'axis', x: x + bw / 2, y: H - 5, 'text-anchor': 'middle' },
          day.slice(5)
        )
      );
  });
  container.replaceChildren(root);
}

function miniTable(el, head, rows) {
  if (rows.length === 0) {
    el.replaceChildren(h('tbody', {}, h('tr', {}, h('td', { class: 'empty' }, 'Nothing yet'))));
    return;
  }
  el.replaceChildren(
    h(
      'thead',
      {},
      h(
        'tr',
        {},
        head.map(([label, num]) => h('th', { class: num ? 'num' : '' }, label))
      )
    ),
    h('tbody', {}, rows)
  );
}

function renderBreakdowns(stats) {
  const maxHost = Math.max(1, ...stats.topHosts.map((x) => x.calls));
  miniTable(
    $('#hosts'),
    [['Host'], ['Calls', true], ['Failed', true], ['Last', true]],
    stats.topHosts.map((x) =>
      h(
        'tr',
        {},
        h(
          'td',
          { title: x.name },
          x.name,
          h('div', { class: 'bar' }, h('i', { style: { width: `${(x.calls / maxHost) * 100}%` } }))
        ),
        h('td', { class: 'num' }, fmtNum(x.calls)),
        h('td', { class: 'num' }, x.failed ? fmtNum(x.failed) : '—'),
        h('td', { class: 'num muted' }, fmtAgo(x.lastAt))
      )
    )
  );
  miniTable(
    $('#adapters'),
    [['Adapter'], ['Calls', true], ['Failed', true], ['Avg', true]],
    stats.byAdapter.map((x) =>
      h(
        'tr',
        {},
        h('td', {}, x.name),
        h('td', { class: 'num' }, fmtNum(x.calls)),
        h('td', { class: 'num' }, x.failed ? fmtNum(x.failed) : '—'),
        h('td', { class: 'num' }, fmtMs(x.avgMs))
      )
    )
  );
  miniTable(
    $('#tools'),
    [['Tool'], ['Calls', true], ['Failed', true]],
    stats.byTool.map((x) =>
      h(
        'tr',
        {},
        h('td', {}, x.name),
        h('td', { class: 'num' }, fmtNum(x.calls)),
        h('td', { class: 'num' }, x.failed ? fmtNum(x.failed) : '—')
      )
    )
  );
}

function logLine(log, compact) {
  let data = null;
  if (log.data) {
    try {
      const parsed = JSON.parse(log.data);
      delete parsed.tool;
      delete parsed.adapter;
      data = Object.keys(parsed).length ? JSON.stringify(parsed) : null;
    } catch {
      data = log.data;
    }
  }
  const ctx = compact
    ? null
    : [log.component, log.callId ? `call ${log.callId.slice(0, 8)}` : null, `pid ${log.pid}`]
        .filter(Boolean)
        .join(' · ');
  return h(
    'div',
    { class: 'log' },
    h(
      'span',
      { class: 't', title: fmtTime(log.time) },
      compact ? fmtClock(log.time) : fmtTime(log.time)
    ),
    h('span', { class: `lv l${log.level}` }, LEVELS[log.level] ?? log.level),
    h(
      'div',
      {},
      h('div', {}, log.msg, ctx ? h('span', { class: 'ctx' }, `  ${ctx}`) : null),
      data ? h('div', { class: 'data' }, data) : null
    )
  );
}

function detailRow(call) {
  const detail = state.details.get(call.id);
  const cell = h('td', { colspan: 7 });
  if (!detail) {
    cell.append(h('div', { class: 'muted' }, 'Loading…'));
  } else {
    const c = detail.call;
    let args = c.args;
    try {
      args = JSON.stringify(JSON.parse(c.args), null, 2);
    } catch {
      // keep raw
    }
    cell.append(
      h(
        'dl',
        { class: 'detail-grid' },
        h('dt', {}, 'URL'),
        h(
          'dd',
          { class: 'mono' },
          c.url ? h('a', { href: c.url, target: '_blank', rel: 'noreferrer noopener' }, c.url) : '—'
        ),
        h('dt', {}, 'Started'),
        h('dd', {}, `${fmtTime(c.startedAt)} · ${fmtMs(c.durationMs)}`),
        h('dt', {}, 'Client'),
        h('dd', {}, `${c.client ?? 'unknown'} · pid ${c.pid}`),
        c.source ? [h('dt', {}, 'Source'), h('dd', {}, c.source)] : null,
        c.error ? [h('dt', {}, 'Error'), h('dd', {}, h('pre', {}, c.error))] : null,
        h('dt', {}, 'Arguments'),
        h('dd', {}, h('pre', {}, args ?? '—'))
      ),
      h('h2', {}, `Log (${detail.logs.length})`),
      ...(detail.logs.length
        ? detail.logs.map((l) => logLine(l, true))
        : [h('div', { class: 'muted' }, 'No log lines for this call.')])
    );
  }
  return h('tr', { class: 'detail' }, cell);
}

async function toggleCall(id) {
  if (state.open.has(id)) {
    state.open.delete(id);
  } else {
    state.open.add(id);
    try {
      state.details.set(id, await api(`/api/calls/${id}`));
    } catch (error) {
      toast(error.message);
    }
  }
  refresh();
}

function renderCalls(calls) {
  const table = $('#calls');
  if (calls.length === 0) {
    table.replaceChildren(
      h(
        'tbody',
        {},
        h(
          'tr',
          {},
          h(
            'td',
            { class: 'empty' },
            state.q || state.status
              ? 'No calls match the filter.'
              : 'No calls yet. Ask your agent to read a page.'
          )
        )
      )
    );
    return;
  }
  const rows = [];
  for (const c of calls) {
    const { host, path } = splitUrl(c.url);
    const isOpen = state.open.has(c.id);
    rows.push(
      h(
        'tr',
        {
          class: `row ${isOpen ? 'open' : ''}`,
          onclick: () => toggleCall(c.id),
          tabindex: 0,
          onkeydown: (e) => e.key === 'Enter' && toggleCall(c.id),
          'aria-expanded': String(isOpen),
        },
        h('td', { class: 'when', title: fmtTime(c.startedAt) }, fmtAgo(c.startedAt)),
        h('td', {}, h('span', { class: `pill ${c.status}` }, c.status)),
        h('td', { class: 'tag' }, c.tool),
        h(
          'td',
          { class: 'target' },
          host ? h('span', { class: 'host' }, host) : h('span', { class: 'muted' }, '—'),
          path && path !== '/' ? h('span', { class: 'path', title: c.url }, path) : null,
          c.error ? h('span', { class: 'err', title: c.error }, c.error) : null
        ),
        h('td', { class: 'tag' }, [c.adapter, c.source].filter(Boolean).join(' · ') || '—'),
        h('td', { class: 'num' }, fmtMs(c.durationMs)),
        h('td', { class: 'num' }, c.chars ? fmtNum(c.chars) : '—')
      )
    );
    if (isOpen) rows.push(detailRow(c));
  }
  table.replaceChildren(
    h(
      'thead',
      {},
      h(
        'tr',
        {},
        h('th', {}, 'When'),
        h('th', {}, 'Status'),
        h('th', {}, 'Tool'),
        h('th', {}, 'Target'),
        h('th', {}, 'Adapter · source'),
        h('th', { class: 'num' }, 'Time'),
        h('th', { class: 'num' }, 'Chars')
      )
    ),
    h('tbody', {}, rows)
  );
}

async function loadUsage() {
  const params = new URLSearchParams({ limit: '100' });
  if (state.status) params.set('status', state.status);
  if (state.q) params.set('q', state.q);
  const [stats, calls] = await Promise.all([
    api(`/api/stats?range=${state.range}`),
    api(`/api/calls?${params}`),
  ]);
  // Refresh the details of expanded rows so running calls update.
  await Promise.all(
    [...state.open].map(async (id) =>
      state.details.set(id, await api(`/api/calls/${id}`).catch(() => state.details.get(id)))
    )
  );
  renderKpis(stats);
  renderChart(stats.perDay);
  renderBreakdowns(stats);
  renderCalls(calls);
}

// ---------- logs ----------

async function loadLogs() {
  const logs = await api(`/api/logs?level=${state.level}&limit=400`);
  $('#logs').replaceChildren(
    ...(logs.length
      ? logs.map((l) => logLine(l, false))
      : [h('div', { class: 'empty' }, 'No log lines yet.')])
  );
}

// ---------- credentials ----------

function credCard(c) {
  const facts = [];
  if (c.expiresAt) {
    const soon = c.expiresAt - Date.now() < 7 * 864e5;
    const gone = c.expiresAt < Date.now();
    facts.push(
      h(
        'span',
        { class: gone ? 'bad' : soon ? 'warn' : '', title: fmtTime(c.expiresAt) },
        gone ? 'Expired' : `Expires ${fmtIn(c.expiresAt)}`
      )
    );
  }
  facts.push(
    h(
      'span',
      { title: c.lastInjectedAt ? fmtTime(c.lastInjectedAt) : '' },
      c.lastInjectedAt
        ? `Injected ${fmtAgo(c.lastInjectedAt)}`
        : 'Not injected yet (next browser start)'
    )
  );
  facts.push(h('span', { title: fmtTime(c.updatedAt) }, `Saved ${fmtAgo(c.updatedAt)}`));

  return h(
    'div',
    { class: 'cred' },
    h(
      'div',
      { class: `avatar ${c.kind}` },
      c.kind === 'reddit' ? 'r/' : c.domain.slice(0, 1).toUpperCase()
    ),
    h(
      'div',
      {},
      h(
        'div',
        { class: 'title' },
        h('strong', {}, c.domain),
        h('span', { class: 'pill' }, c.kind),
        c.label ? h('span', { class: 'muted' }, c.label) : null
      ),
      h('div', { class: 'preview mono' }, c.preview),
      h('div', { class: 'facts' }, facts)
    ),
    h(
      'button',
      {
        class: 'btn ghost danger',
        onclick: async () => {
          if (
            !confirm(
              `Remove the credential for ${c.domain}? Its cookies are also removed from the agent's browser on the next call.`
            )
          )
            return;
          try {
            await api(`/api/credentials/${c.id}`, { method: 'DELETE' });
            toast(`Removed ${c.domain}`);
            loadCredentials();
          } catch (error) {
            toast(error.message);
          }
        },
      },
      'Remove'
    )
  );
}

async function loadCredentials() {
  const [creds, info] = await Promise.all([
    api('/api/credentials'),
    state.info ?? api('/api/info'),
  ]);
  state.info = info;
  $('#cred-list').replaceChildren(
    ...(creds.length
      ? creds.map(credCard)
      : [
          h(
            'div',
            { class: 'cred-empty' },
            h('p', {}, 'No credentials yet.'),
            h('p', {}, 'Add your Reddit session so the agent reads Reddit logged in as you.')
          ),
        ])
  );
  $('#storage-note').replaceChildren(
    h(
      'p',
      {},
      h('strong', {}, 'How they are stored. '),
      'Cookie values are encrypted with AES-256-GCM before they touch the database, and are never shown again after saving (only the last 4 characters).'
    ),
    h(
      'p',
      {},
      'Database: ',
      h('code', {}, info.dbPath),
      ' · Key: ',
      h('code', {}, info.keyFile),
      ' (0600). Losing the key makes saved credentials unreadable; just add them again.'
    ),
    h(
      'p',
      {},
      'On each browser start (and on the next call after you change something here) the cookies are injected into the profile at ',
      h('code', {}, info.profileDir),
      '. Adding a credential for a domain that already has one replaces it.'
    )
  );
}

// ---------- add-credential dialog ----------

const dialog = $('#cred-dialog');
const form = $('#cred-form');

function dialogHead(title) {
  return h(
    'div',
    { class: 'dialog-head' },
    h('h1', { id: 'dialog-title' }, title),
    h(
      'button',
      { type: 'button', class: 'x', 'aria-label': 'Close', onclick: () => dialog.close() },
      '×'
    )
  );
}

function stepChoose() {
  form.replaceChildren(
    dialogHead('Add credential'),
    h('p', { class: 'muted' }, 'What is it for?'),
    h(
      'div',
      { class: 'choices' },
      h(
        'button',
        { type: 'button', class: 'choice', onclick: stepReddit },
        h('strong', {}, 'Reddit'),
        h('span', {}, 'Paste one cookie (reddit_session). The agent reads Reddit logged in as you.')
      ),
      h(
        'button',
        { type: 'button', class: 'choice', onclick: stepGeneric },
        h('strong', {}, 'Other site'),
        h('span', {}, 'Paste the cookies of any site you are logged in to.')
      )
    )
  );
}

function errorBox() {
  return h('div', { class: 'form-error', hidden: true });
}

function actions(back, submitLabel) {
  return h(
    'div',
    { class: 'actions' },
    h('button', { type: 'button', class: 'btn ghost', onclick: back }, '← Back'),
    h(
      'div',
      { class: 'right' },
      h('button', { type: 'button', class: 'btn', onclick: () => dialog.close() }, 'Cancel'),
      h('button', { type: 'submit', class: 'btn primary' }, submitLabel)
    )
  );
}

async function submit(payload, err) {
  const button = form.querySelector('button[type=submit]');
  button.disabled = true;
  err.hidden = true;
  try {
    const saved = await api('/api/credentials', { method: 'POST', body: JSON.stringify(payload) });
    dialog.close();
    toast(`Saved ${saved.domain}. The agent's browser picks it up on its next call.`);
    loadCredentials();
  } catch (error) {
    err.textContent = error.message;
    err.hidden = false;
  } finally {
    button.disabled = false;
  }
}

function stepReddit() {
  const value = h('textarea', {
    name: 'value',
    rows: 3,
    required: true,
    spellcheck: 'false',
    autocomplete: 'off',
    placeholder: 'eyJhbGciOi…',
  });
  const label = h('input', {
    type: 'text',
    name: 'label',
    placeholder: 'e.g. u/yourname',
    autocomplete: 'off',
  });
  const err = errorBox();
  form.onsubmit = (e) => {
    e.preventDefault();
    submit({ kind: 'reddit', value: value.value, label: label.value || undefined }, err);
  };
  form.replaceChildren(
    dialogHead('Reddit session'),
    h(
      'ol',
      { class: 'steps' },
      h(
        'li',
        {},
        'Open ',
        h('strong', {}, 'reddit.com'),
        ' in your normal browser, logged in to the account the agent should use.'
      ),
      h(
        'li',
        {},
        'Open DevTools: ',
        h('kbd', {}, 'F12'),
        ' (or ',
        h('kbd', {}, 'Ctrl+Shift+I'),
        ').'
      ),
      h(
        'li',
        {},
        h('strong', {}, 'Chrome / Edge: '),
        'Application tab → Storage → Cookies → ',
        h('code', {}, 'https://www.reddit.com'),
        '. ',
        h('strong', {}, 'Firefox: '),
        'Storage tab → Cookies.'
      ),
      h(
        'li',
        {},
        'Find the row ',
        h('code', {}, 'reddit_session'),
        '. Double-click its ',
        h('em', {}, 'Value'),
        ', select all and copy.'
      ),
      h('li', {}, 'Paste it below.')
    ),
    h(
      'div',
      { class: 'hint' },
      'reddit_session is HttpOnly, so page scripts and most extensions cannot read it — DevTools is the reliable way. Logging out of Reddit in your browser invalidates it; then just paste a fresh one here.'
    ),
    h('label', { class: 'field' }, 'reddit_session value', value),
    h(
      'label',
      { class: 'field' },
      h('span', {}, 'Label ', h('span', { class: 'opt' }, '(optional)')),
      label
    ),
    err,
    actions(stepChoose, 'Save credential')
  );
  value.focus();
}

function stepGeneric() {
  const domain = h('input', {
    type: 'text',
    name: 'domain',
    required: true,
    placeholder: 'example.com',
    autocomplete: 'off',
    spellcheck: 'false',
  });
  const cookies = h('textarea', {
    name: 'cookies',
    rows: 6,
    required: true,
    spellcheck: 'false',
    autocomplete: 'off',
    placeholder: 'session=abc123; other=xyz',
  });
  const label = h('input', {
    type: 'text',
    name: 'label',
    placeholder: 'e.g. work account',
    autocomplete: 'off',
  });
  const err = errorBox();
  const help = h('div', { class: 'hint' });
  const formats = {
    header: [
      'Easiest — copy the whole Cookie header:',
      h(
        'ol',
        { class: 'steps' },
        h('li', {}, 'Open the site logged in, then DevTools → Network, and reload the page.'),
        h('li', {}, 'Click the first request (the page itself) → Headers → Request Headers.'),
        h('li', {}, 'Right-click ', h('code', {}, 'cookie'), ' → Copy value, and paste it here.')
      ),
    ],
    json: [
      'From a cookie extension (Cookie-Editor, EditThisCookie): use Export → JSON and paste the array. Domain, path, expiry and flags are kept.',
    ],
    rows: [
      'Individual cookies: one ',
      h('code', {}, 'name=value'),
      ' per line, or rows copied from DevTools → Application → Cookies (tab-separated).',
    ],
  };
  const pick = (key) => {
    setPressed(seg, key);
    help.replaceChildren(...formats[key]);
  };
  const seg = h(
    'div',
    { class: 'seg small formats', role: 'group' },
    h(
      'button',
      { type: 'button', 'data-value': 'header', onclick: () => pick('header') },
      'Cookie header'
    ),
    h(
      'button',
      { type: 'button', 'data-value': 'json', onclick: () => pick('json') },
      'Extension JSON'
    ),
    h('button', { type: 'button', 'data-value': 'rows', onclick: () => pick('rows') }, 'name=value')
  );
  form.onsubmit = (e) => {
    e.preventDefault();
    submit(
      {
        kind: 'generic',
        domain: domain.value,
        cookies: cookies.value,
        label: label.value || undefined,
      },
      err
    );
  };
  form.replaceChildren(
    dialogHead('Cookies for another site'),
    h('label', { class: 'field' }, 'Domain', domain),
    h('div', { class: 'field' }, h('span', { class: 'field' }, 'How to copy'), seg, help),
    h('label', { class: 'field' }, 'Cookies', cookies),
    h(
      'label',
      { class: 'field' },
      h('span', {}, 'Label ', h('span', { class: 'opt' }, '(optional)')),
      label
    ),
    err,
    actions(stepChoose, 'Save credential')
  );
  pick('header');
  domain.focus();
}

$('#add-cred').addEventListener('click', () => {
  form.onsubmit = (e) => e.preventDefault();
  stepChoose();
  dialog.showModal();
});

// ---------- wiring ----------

let searchTimer;
let refreshing = false;

async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try {
    if (state.tab === 'usage') await loadUsage();
    else if (state.tab === 'logs') await loadLogs();
    else await loadCredentials();
    $('#updated').textContent = `Updated ${fmtClock(Date.now())}`;
  } catch (error) {
    $('#updated').textContent = error.message.includes('Not authorized')
      ? 'Not authorized — reopen the printed URL'
      : `Error: ${error.message}`;
  } finally {
    refreshing = false;
  }
}

function showTab(tab) {
  state.tab = tab;
  for (const b of document.querySelectorAll('.tabs button'))
    b.setAttribute('aria-selected', String(b.dataset.tab === tab));
  for (const s of document.querySelectorAll('main > section')) s.hidden = s.id !== `tab-${tab}`;
  try {
    localStorage.setItem('readit.tab', tab);
  } catch {
    // storage unavailable
  }
  refresh();
}

for (const b of document.querySelectorAll('.tabs button'))
  b.addEventListener('click', () => showTab(b.dataset.tab));

$('#range').addEventListener('click', (e) => {
  const v = e.target.closest('button')?.dataset.value;
  if (!v) return;
  state.range = v;
  setPressed($('#range'), v);
  refresh();
});

$('#status-filter').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  state.status = b.dataset.value;
  setPressed($('#status-filter'), state.status);
  refresh();
});

$('#level-filter').addEventListener('click', (e) => {
  const v = e.target.closest('button')?.dataset.value;
  if (!v) return;
  state.level = Number(v);
  setPressed($('#level-filter'), v);
  refresh();
});

$('#search').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.q = e.target.value.trim();
    refresh();
  }, 250);
});

$('#clear-history').addEventListener('click', async () => {
  if (!confirm('Delete all recorded calls and logs? Credentials are kept.')) return;
  try {
    await api('/api/history', { method: 'DELETE' });
    state.open.clear();
    state.details.clear();
    toast('History cleared');
    refresh();
  } catch (error) {
    toast(error.message);
  }
});

setInterval(() => {
  if (document.visibilityState === 'visible' && !dialog.open && state.tab !== 'credentials')
    refresh();
}, REFRESH_MS);

let initial = 'usage';
try {
  initial = localStorage.getItem('readit.tab') || 'usage';
} catch {
  // storage unavailable
}
showTab(['usage', 'logs', 'credentials'].includes(initial) ? initial : 'usage');
