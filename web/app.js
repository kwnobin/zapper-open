// Zapper Open — dashboard client
//
// Connects to the bridge over WebSocket. Each session is a glowing node on the right;
// each tool event fires an electric arc from "you" (left) to that session's node. Also
// wires the cmd-bar (inject a comment), the session picker/label, the approval modal,
// and the side terminal.

const $ = (id) => document.getElementById(id);
const token = new URLSearchParams(location.search).get('token');

let selected = '';                 // '' = all sessions
const sessionsById = new Map();    // session_id -> session record
const nodes = new Map();           // session_id -> { hue, lastEventMs }
const particles = [];              // electric arcs in flight
const MAX_PARTICLES = 400;
let approvalQueue = [];

// ---- websocket (dashboard events) -----------------------------------------
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
      msg.bufferedEvents.slice(-30).forEach(spawn);
      approvalQueue = msg.pendingApprovals || [];
      showNextApproval();
      break;
    case 'sessions': msg.sessions.forEach(rememberSession); renderPicker(); break;
    case 'event': spawn(msg.event); break;
    case 'approval_request': approvalQueue.push(msg); showNextApproval(); break;
    case 'approval_resolved': dropApproval(msg.approval_id); break;
  }
}

function rememberSession(s) {
  sessionsById.set(s.session_id, s);
  if (!nodes.has(s.session_id)) nodes.set(s.session_id, { hue: sessionHue(s.session_id), lastEventMs: 0 });
}

function sessionHue(id) {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 360;
  return h;
}

function spawn(event) {
  rememberSession({ session_id: event.session_id, label: sessionsById.get(event.session_id)?.label || '', event_count: sessionsById.get(event.session_id)?.event_count || 0, last_seen: '' });
  const node = nodes.get(event.session_id);
  node.lastEventMs = performance.now();
  if (selected && event.session_id !== selected) return;
  if (particles.length >= MAX_PARTICLES) particles.shift();
  particles.push({ sessionId: event.session_id, t: 0, speed: 0.022, seed: Math.random() * 1000 });
}

// ---- layout: node positions ------------------------------------------------
function youAnchor(W, H) { return { x: W * 0.12, y: H * 0.5 }; }

// place each session node down the right side, spread by its order
function nodePos(sessionId, W, H) {
  const ids = [...nodes.keys()];
  const i = ids.indexOf(sessionId);
  const n = Math.max(1, ids.length);
  const x = W * (n > 1 ? 0.74 : 0.8);
  const y = H * (0.5 / n + (0.86 - 0.14) * (i + 0.5) / n + 0.07);
  return { x, y };
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
    const now = performance.now();
    const you = youAnchor(W, H);

    // arcs (additive for the neon glow)
    const ctx = p.drawingContext;
    ctx.globalCompositeOperation = 'lighter';
    for (let i = particles.length - 1; i >= 0; i--) {
      const pt = particles[i];
      pt.t += pt.speed;
      const node = nodes.get(pt.sessionId);
      if (pt.t >= 1 || !node) { particles.splice(i, 1); continue; }
      const to = nodePos(pt.sessionId, W, H);
      drawElectricArc(p, you.x, you.y, to.x, to.y, pt, node.hue);
    }

    // session node glows (still additive)
    for (const [id, node] of nodes) {
      const pos = nodePos(id, W, H);
      const dim = selected && id !== selected ? 0.4 : 1;
      const hot = Math.max(0, 1 - (now - node.lastEventMs) / 900); // recent event -> brighter
      const [r, g, b] = hsb(node.hue);
      const glow = (22 + hot * 26) * dim;
      for (let k = 3; k >= 1; k--) {
        ctx.fillStyle = `rgba(${r},${g},${b},${(0.10 + hot * 0.06) * dim / k})`;
        p.noStroke(); circleCtx(ctx, pos.x, pos.y, glow * k);
      }
    }
    ctx.globalCompositeOperation = 'source-over';

    // node cores + labels
    for (const [id, node] of nodes) {
      const pos = nodePos(id, W, H);
      const dim = selected && id !== selected ? 0.4 : 1;
      const [r, g, b] = hsb(node.hue);
      p.noStroke();
      p.fill(r, g, b, 235 * dim); p.circle(pos.x, pos.y, 13);
      p.fill(255, 255, 255, 180 * dim); p.circle(pos.x, pos.y, 4);
      const s = sessionsById.get(id);
      const name = (s && s.label) ? s.label : id.slice(0, 8);
      p.fill(190, 198, 212, 210 * dim); p.textSize(11); p.textAlign(p.LEFT, p.CENTER);
      p.text(name, pos.x + 12, pos.y);
    }

    // you anchor
    p.noStroke();
    p.fill(120, 140, 175); p.circle(you.x, you.y, 15);
    p.fill(150, 160, 185, 200); p.textSize(11); p.textAlign(p.RIGHT, p.CENTER);
    p.text('you', you.x - 12, you.y);
  };
}, $('sketch'));

// hue (0-360) -> rgb at fixed sat/val, matching the node/arc colour
function hsb(h) {
  const s = 0.72, v = 0.98;
  const c = v * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = v - c;
  let r = 0, g = 0, b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

function circleCtx(ctx, x, y, d) { ctx.beginPath(); ctx.arc(x, y, d / 2, 0, Math.PI * 2); ctx.fill(); }

// electric arc: jagged bezier with outer glow / coloured body / white-hot core
function drawElectricArc(p, fromX, fromY, toX, toY, particle, hue) {
  const c1x = fromX + (toX - fromX) * 0.4, c1y = fromY + (toY - fromY) * 0.15 - 30;
  const c2x = fromX + (toX - fromX) * 0.6, c2y = toY - (toY - fromY) * 0.15 + 30;
  const segments = 14, seed = particle.seed, timeJit = p.millis() / 60;
  const pts = [];
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const bx = p.bezierPoint(fromX, c1x, c2x, toX, t);
    const by = p.bezierPoint(fromY, c1y, c2y, toY, t);
    const tx = p.bezierTangent(fromX, c1x, c2x, toX, t);
    const ty = p.bezierTangent(fromY, c1y, c2y, toY, t);
    const len = Math.hypot(tx, ty) || 1;
    const endFade = Math.sin(t * Math.PI);
    const jit = (p.noise(seed + t * 6, timeJit + i * 0.3) - 0.5) * 18 * endFade;
    pts.push([bx + (-ty / len) * jit, by + (tx / len) * jit]);
  }
  const fade = particle.t < 0.15 ? particle.t / 0.15 : (particle.t > 0.7 ? (1 - particle.t) / 0.3 : 1);
  const a = 255 * fade, [r, g, b] = hsb(hue);
  p.noFill();
  p.stroke(r, g, b, a * 0.16); p.strokeWeight(7); arcPath(p, pts);
  p.stroke(r, g, b, a * 0.9); p.strokeWeight(1.8); arcPath(p, pts);
  p.stroke(255, 255, 255, a * 0.75); p.strokeWeight(0.7); arcPath(p, pts);
}
function arcPath(p, pts) { p.beginShape(); for (const [x, y] of pts) p.vertex(x, y); p.endShape(); }

// ---- session picker + label ------------------------------------------------
function renderPicker() {
  const sel = $('picker');
  const prev = sel.value;
  sel.innerHTML = '<option value="">All sessions (timeline)</option>';
  for (const s of [...sessionsById.values()].sort((a, b) => (b.last_seen || '').localeCompare(a.last_seen || ''))) {
    const o = document.createElement('option');
    o.value = s.session_id; o.textContent = `${s.label || s.session_id.slice(0, 8)} (${s.event_count})`;
    sel.appendChild(o);
  }
  sel.value = sessionsById.has(prev) ? prev : selected;
}

$('picker').onchange = (e) => {
  selected = e.target.value;
  const has = !!selected;
  for (const id of ['comment', 'send', 'label', 'saveLabel']) $(id).disabled = !has;
  if (has) $('label').value = sessionsById.get(selected)?.label || '';
};

$('saveLabel').onclick = () => { if (selected) post(`/sessions/${selected}/label`, { label: $('label').value }); };

// ---- cmd-bar (inject comment) ---------------------------------------------
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
  const a = approvalQueue[0], modal = $('modal');
  if (!a) { modal.classList.add('hidden'); return; }
  const s = sessionsById.get(a.session_id);
  $('modalWho').textContent = (s?.label || a.session_id.slice(0, 12)) + ' is asking';
  $('modalTool').textContent = a.tool_name;
  const inp = a.tool_input || {};
  $('modalDetail').textContent = inp.command || inp.file_path || JSON.stringify(inp, null, 2);
  modal.classList.remove('hidden');
}
function dropApproval(id) { approvalQueue = approvalQueue.filter((a) => a.approval_id !== id); showNextApproval(); }
function respond(decision) {
  const a = approvalQueue[0];
  if (!a) return;
  post(`/approval/${a.approval_id}/respond`, { decision });
  dropApproval(a.approval_id);
}
$('allow').onclick = () => respond('allow');
$('deny').onclick = () => respond('deny');
document.addEventListener('keydown', (e) => {
  if (!$('modal').classList.contains('hidden') && e.key === 'Escape') dropApproval(approvalQueue[0]?.approval_id);
});

// ---- side terminal + full-screen button ------------------------------------
let sideTerm = null;
function attachSideTerminal() {
  const name = $('tmuxname').value.trim() || 'main';
  $('termtarget').textContent = name;
  if (sideTerm) sideTerm.dispose();
  $('term').innerHTML = '';
  if (window.mountZapperTerminal && $('termpane').offsetParent !== null) {
    sideTerm = window.mountZapperTerminal($('term'), name);
  }
}
$('attachTerm').onclick = attachSideTerminal;
$('openTerm').onclick = () => {
  const name = encodeURIComponent($('tmuxname').value.trim() || 'main');
  const t = token ? `&token=${encodeURIComponent(token)}` : '';
  window.open(`/terminal.html?session=${name}${t}`, '_blank');
};

// ---- helper ----------------------------------------------------------------
function post(path, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['X-Observatory-Token'] = token;
  return fetch(path, { method: 'POST', headers, body: JSON.stringify(body) }).catch(() => {});
}

connect();
// auto-attach the side terminal on wide screens
if (window.matchMedia('(min-width: 901px)').matches) setTimeout(attachSideTerminal, 300);
