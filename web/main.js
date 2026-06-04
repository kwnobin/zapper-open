// Zapper Open — controller
//
// Drives the ported main-view.js art engine (window.mainViewBus) from the open bridge's
// WebSocket, and wires the cmd-bar (comment inject), session picker, in-canvas approval
// buttons, and the click-a-node -> side terminal flow.

const token = new URLSearchParams(location.search).get('token');
const bus = () => window.mainViewBus;

const sessions = new Map();             // session_id -> { label, event_count, last_seen }
const approvalBySession = new Map();    // session_id -> approval_id (for the in-canvas buttons)
let selected = null;

// ---- websocket -------------------------------------------------------------
let ws;
function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const q = token ? `?token=${encodeURIComponent(token)}` : '';
  ws = new WebSocket(`${proto}://${location.host}/ws${q}`);
  ws.onopen = () => setStatus(true);
  ws.onclose = () => { setStatus(false); setTimeout(connect, 1500); };
  ws.onmessage = (m) => handle(JSON.parse(m.data));
}
function setStatus(up) {
  const el = document.getElementById('status');
  el.style.color = up ? 'var(--green)' : 'var(--red)';
}

function handle(msg) {
  switch (msg.kind) {
    case 'hello':
      msg.sessions.forEach(applySession);
      bus()?.syncNodes(msg.sessions.map((s) => s.session_id));
      msg.bufferedEvents.slice(-40).forEach(applyEvent);
      (msg.pendingApprovals || []).forEach((a) => {
        approvalBySession.set(a.session_id, a.approval_id);
        bus()?.setApproval(a.session_id, a);
        bus()?.setSessionStatus(a.session_id, 'awaiting');
      });
      renderPicker();
      break;
    case 'sessions':
      msg.sessions.forEach(applySession);
      renderPicker();
      break;
    case 'event':
      applyEvent(msg.event);
      break;
    case 'say':
      bus()?.setSay(msg.session_id, msg.text);
      break;
    case 'approval_request':
      applySession({ session_id: msg.session_id, label: sessions.get(msg.session_id)?.label || '' });
      approvalBySession.set(msg.session_id, msg.approval_id);
      bus()?.setApproval(msg.session_id, msg);
      bus()?.setSessionStatus(msg.session_id, 'awaiting');
      break;
    case 'approval_resolved': {
      const sid = [...approvalBySession.entries()].find(([, aid]) => aid === msg.approval_id)?.[0];
      if (sid) {
        approvalBySession.delete(sid);
        bus()?.setApproval(sid, null);
        bus()?.setSessionStatus(sid, 'idle');
      }
      break;
    }
  }
}

function applySession(s) {
  const prev = sessions.get(s.session_id) || {};
  sessions.set(s.session_id, { label: s.label ?? prev.label ?? '', event_count: s.event_count ?? prev.event_count ?? 0, last_seen: s.last_seen ?? prev.last_seen ?? '' });
  bus()?.setNodeLabel(s.session_id, sessions.get(s.session_id).label);
}

function applyEvent(event) {
  if (!event || !event.session_id) return;
  applySession({ session_id: event.session_id, label: sessions.get(event.session_id)?.label || '' });
  bus()?.push(event);
  bus()?.setSessionStatus(event.session_id, event.type === 'Stop' ? 'idle' : 'working');
}

// ---- session picker --------------------------------------------------------
function renderPicker() {
  const sel = document.getElementById('session-picker');
  const prev = sel.value;
  sel.innerHTML = '<option value="__all__">all (timeline)</option>';
  for (const [id, s] of [...sessions.entries()].sort((a, b) => (b[1].last_seen || '').localeCompare(a[1].last_seen || ''))) {
    const o = document.createElement('option');
    o.value = id;
    o.textContent = `${s.label || id.slice(0, 8)} (${s.event_count})`;
    sel.appendChild(o);
  }
  sel.value = prev && (prev === '__all__' || sessions.has(prev)) ? prev : (selected || '__all__');
}

document.getElementById('session-picker').addEventListener('change', (e) => {
  const v = e.target.value;
  if (v === '__all__') selectSession(null);
  else selectSession(v);
});

function selectSession(id) {
  selected = id;
  bus()?.setSelectedSession(id || '__all__');
  const label = id ? (sessions.get(id)?.label || id.slice(0, 8)) : null;
  document.getElementById('cmd-target').textContent = label || 'select a node';
  const has = !!id;
  document.getElementById('cmd-text').disabled = !has;
  document.getElementById('cmd-send').disabled = !has;
  const sel = document.getElementById('session-picker');
  sel.value = id || '__all__';
}

// ---- cmd-bar (comment inject) ----------------------------------------------
function sendComment() {
  const input = document.getElementById('cmd-text');
  const text = input.value.trim();
  if (!selected || !text) return;
  post('/comment', { session_id: selected, text });
  input.value = '';
  document.getElementById('cmd-send').classList.add('firing');
  setTimeout(() => document.getElementById('cmd-send').classList.remove('firing'), 850);
}
document.getElementById('cmd-send').addEventListener('click', sendComment);
document.getElementById('cmd-text').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendComment(); });

// ---- in-canvas approval buttons --------------------------------------------
window.observatoryOnApprovalButton = (sessionId, action) => {
  const approvalId = approvalBySession.get(sessionId);
  if (!approvalId) return;
  post(`/approval/${approvalId}/respond`, { decision: action === 'allow' ? 'allow' : 'deny' });
};

// ---- node click -> side terminal -------------------------------------------
let sideTerm = null;
function tmuxNameFor(sessionId) {
  const label = sessions.get(sessionId)?.label || '';
  return /^[A-Za-z0-9_.\-]+$/.test(label) ? label : (document.getElementById('new-tmux-name').value.trim() || 'main');
}
window.observatoryOnClaudeNodeClick = (sessionId) => {
  selectSession(sessionId);
  const section = document.getElementById('side-terminal-section');
  if (window.matchMedia('(min-width: 800px)').matches && window.mountZapperTerminal) {
    if (sideTerm) sideTerm.dispose();
    const mount = document.getElementById('side-terminal-mount');
    mount.innerHTML = '';
    section.dataset.state = 'loaded';   // make the pane visible first so xterm fits to real size
    sideTerm = window.mountZapperTerminal(mount, tmuxNameFor(sessionId));
  }
};
window.observatoryOnClaudeNodeDoubleClick = (sessionId) => {
  const name = encodeURIComponent(tmuxNameFor(sessionId));
  const t = token ? `&token=${encodeURIComponent(token)}` : '';
  window.open(`/terminal.html?session=${name}${t}`, '_blank');
};

// ---- menu ------------------------------------------------------------------
const ham = document.getElementById('hamburger-toggle');
const panel = document.getElementById('hamburger-panel');
ham.addEventListener('click', () => {
  const open = panel.hasAttribute('hidden');
  if (open) panel.removeAttribute('hidden'); else panel.setAttribute('hidden', '');
  ham.setAttribute('aria-expanded', String(open));
});
function openFullTerminal() {
  const name = encodeURIComponent(document.getElementById('new-tmux-name').value.trim() || 'main');
  const t = token ? `&token=${encodeURIComponent(token)}` : '';
  window.location.href = `/terminal.html?session=${name}${t}`;
}
document.getElementById('open-terminal').addEventListener('click', openFullTerminal);
document.getElementById('header-terminal').addEventListener('click', (e) => { e.preventDefault(); openFullTerminal(); });

// ---- helper ----------------------------------------------------------------
function post(path, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['X-Observatory-Token'] = token;
  return fetch(path, { method: 'POST', headers, body: JSON.stringify(body) }).catch(() => {});
}

connect();
