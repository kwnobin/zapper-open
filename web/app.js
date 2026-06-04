// Zapper Open — dashboard client
//
// Connects to the bridge over WebSocket, draws one particle per tool event flowing
// left (you) -> right (Claude), lets you filter by session, send comments into the
// next turn, and approve/deny gated tools from a modal.

const $ = (id) => document.getElementById(id);
const token = new URLSearchParams(location.search).get('token');

let selected = '';                 // '' = all sessions
const sessionsById = new Map();
const particles = [];
const MAX_PARTICLES = 400;
let approvalQueue = [];            // pending approval requests, shown one at a time

// ---- websocket -------------------------------------------------------------
let ws;
function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const q = token ? `?token=${encodeURIComponent(token)}` : '';
  ws = new WebSocket(`${proto}://${location.host}/ws${q}`);
  ws.onopen = () => $('status').className = 'dot up';
  ws.onclose = () => { $('status').className = 'dot down'; setTimeout(connect, 1500); };
  ws.onmessage = (m) => handle(JSON.parse(m.data));
}

function handle(msg) {
  switch (msg.kind) {
    case 'hello':
      msg.sessions.forEach(rememberSession);
      renderPicker();
      msg.bufferedEvents.slice(-40).forEach(spawn);
      approvalQueue = msg.pendingApprovals || [];
      showNextApproval();
      break;
    case 'sessions': msg.sessions.forEach(rememberSession); renderPicker(); break;
    case 'event': spawn(msg.event); break;
    case 'approval_request': approvalQueue.push(msg); showNextApproval(); break;
    case 'approval_resolved': dropApproval(msg.approval_id); break;
  }
}

function rememberSession(s) { sessionsById.set(s.session_id, s); }

// ---- particles -------------------------------------------------------------
// deterministic hue per session id, so each session keeps a stable colour
function sessionHue(id) {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 360;
  return h;
}
// distinct shapes/tints per tool family
function toolStyle(type, data) {
  const tool = data?.tool_name || type;
  if (tool === 'Bash') return { shape: 'square' };
  if (tool === 'Edit' || tool === 'Write' || tool === 'NotebookEdit') return { shape: 'triangle' };
  if (type === 'UserPromptSubmit') return { shape: 'ring' };
  return { shape: 'circle' };
}

function spawn(event) {
  if (selected && event.session_id !== selected) return;
  if (particles.length >= MAX_PARTICLES) particles.shift();
  particles.push({
    t: 0,
    hue: sessionHue(event.session_id),
    style: toolStyle(event.type, event.data),
    y: Math.random()
  });
}

// ---- p5 sketch -------------------------------------------------------------
new p5((p) => {
  p.setup = () => {
    const host = $('sketch');
    const c = p.createCanvas(host.clientWidth, host.clientHeight);
    c.parent(host);
    p.windowResized = () => p.resizeCanvas(host.clientWidth, host.clientHeight);
  };

  p.draw = () => {
    p.background(11, 14, 20);
    const W = p.width, H = p.height;
    // endpoints: you (left) and Claude (right)
    p.noStroke();
    p.fill(120, 140, 170); p.circle(40, H / 2, 16);
    p.fill(150, 120, 220); p.circle(W - 40, H / 2, 16);
    p.fill(110, 120, 140); p.textSize(11);
    p.text('you', 30, H / 2 - 16); p.text('Claude', W - 60, H / 2 - 16);

    p.colorMode(p.HSB, 360, 100, 100, 1);
    for (let i = particles.length - 1; i >= 0; i--) {
      const pt = particles[i];
      pt.t += 0.012;
      if (pt.t >= 1) { particles.splice(i, 1); continue; }
      const x = 40 + (W - 80) * pt.t;
      const y = H * (0.2 + 0.6 * pt.y);
      const a = Math.sin(pt.t * Math.PI);             // fade in/out
      p.fill(pt.hue, 70, 95, a);
      drawShape(p, pt.style.shape, x, y, 9);
    }
    p.colorMode(p.RGB, 255);
  };
}, $('sketch'));

function drawShape(p, shape, x, y, r) {
  if (shape === 'square') p.rect(x - r / 2, y - r / 2, r, r, 2);
  else if (shape === 'triangle') p.triangle(x, y - r, x - r, y + r, x + r, y + r);
  else if (shape === 'ring') { p.noFill(); p.stroke(p.color(0, 0, 100)); p.strokeWeight(2); p.circle(x, y, r * 1.6); p.noStroke(); }
  else p.circle(x, y, r);
}

// ---- session picker + label ------------------------------------------------
function renderPicker() {
  const sel = $('picker');
  const prev = sel.value;
  sel.innerHTML = '<option value="">All sessions (timeline)</option>';
  for (const s of [...sessionsById.values()].sort((a, b) => b.last_seen.localeCompare(a.last_seen))) {
    const name = s.label || s.session_id.slice(0, 8);
    const o = document.createElement('option');
    o.value = s.session_id; o.textContent = `${name} (${s.event_count})`;
    sel.appendChild(o);
  }
  sel.value = sessionsById.has(prev) ? prev : selected;
}

$('picker').onchange = (e) => {
  selected = e.target.value;
  const has = !!selected;
  $('comment').disabled = !has;
  $('send').disabled = !has;
  $('label').disabled = !has;
  $('saveLabel').disabled = !has;
  if (has) $('label').value = sessionsById.get(selected)?.label || '';
};

$('saveLabel').onclick = () => {
  if (!selected) return;
  post(`/sessions/${selected}/label`, { label: $('label').value });
};

// ---- comment ---------------------------------------------------------------
function sendComment() {
  const text = $('comment').value.trim();
  if (!selected || !text) return;
  post('/comment', { session_id: selected, text });
  $('comment').value = '';
}
$('send').onclick = sendComment;
$('comment').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendComment(); });

// ---- approval modal --------------------------------------------------------
function showNextApproval() {
  const a = approvalQueue[0];
  const modal = $('modal');
  if (!a) { modal.classList.add('hidden'); return; }
  const s = sessionsById.get(a.session_id);
  $('modalWho').textContent = (s?.label || a.session_id.slice(0, 12)) + ' is asking';
  $('modalTool').textContent = a.tool_name;
  const inp = a.tool_input || {};
  $('modalDetail').textContent = inp.command || inp.file_path || JSON.stringify(inp, null, 2);
  modal.classList.remove('hidden');
}
function dropApproval(id) {
  approvalQueue = approvalQueue.filter((a) => a.approval_id !== id);
  showNextApproval();
}
function respond(decision) {
  const a = approvalQueue[0];
  if (!a) return;
  post(`/approval/${a.approval_id}/respond`, { decision });
  dropApproval(a.approval_id);
}
$('allow').onclick = () => respond('allow');
$('deny').onclick = () => respond('deny');
document.addEventListener('keydown', (e) => {
  if ($('modal').classList.contains('hidden')) return;
  if (e.key === 'Escape') dropApproval(approvalQueue[0]?.approval_id);
});

// ---- helper ----------------------------------------------------------------
function post(path, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['X-Observatory-Token'] = token;
  return fetch(path, { method: 'POST', headers, body: JSON.stringify(body) }).catch(() => {});
}

connect();
