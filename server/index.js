// Zapper Open — bridge server
//
// One small Node process (Express + WebSocket) that:
//   1. receives Claude Code hook events over HTTP and broadcasts them to the browser
//   2. holds a per-session queue of "comments" the browser injects into the next turn
//   3. blocks on tool-permission decisions until the browser answers (or times out)
//
// Everything is in-memory. Restart the process and state resets. That is fine for a
// single-user local dashboard. No database, no auth provider, no cloud.

import express from 'express';
import fs from 'node:fs/promises';
import http from 'node:http';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { attachPty } from './pty.js';

const HOST = process.env.ZAPPER_HOST || '127.0.0.1';
const PORT = Number(process.env.ZAPPER_PORT || 8089);
const TOKEN = process.env.ZAPPER_TOKEN || '';
// How long the server waits for a browser approval before giving up. On timeout the
// hook returns no decision, so Claude Code falls back to its own terminal prompt.
const APPROVAL_TIMEOUT_MS = Number(process.env.ZAPPER_APPROVAL_TIMEOUT_MS || 120_000);
// Tools that require a permission decision. Everything else is auto-allowed.
const NEEDS_GATING = new Set(['Bash', 'Edit', 'Write', 'NotebookEdit']);
const MAX_EVENTS = 500;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.join(__dirname, '..', 'web');
const startedAt = Date.now();

// ---------------------------------------------------------------------------
// in-memory state
// ---------------------------------------------------------------------------
const events = [];                 // ring buffer of recent events (for new clients)
const sessions = new Map();        // session_id -> { first_seen, last_seen, event_count, label, injectQueue }
const approvals = new Map();       // approval_id -> { resolve, timer, tool_name, tool_input, session_id }

function nowIso() { return new Date().toISOString(); }

function registerSession(id, ts) {
  if (sessions.has(id)) return false;
  sessions.set(id, { first_seen: ts, last_seen: ts, event_count: 0, label: '', injectQueue: [] });
  return true;
}

function pushEvent(type, sessionId, data) {
  const ts = nowIso();
  const created = registerSession(sessionId, ts);
  const s = sessions.get(sessionId);
  s.last_seen = ts;
  s.event_count += 1;
  const event = { type, session_id: sessionId, timestamp: ts, data };
  events.push(event);
  if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
  broadcast({ kind: 'event', event });
  if (created) broadcast({ kind: 'sessions', sessions: listSessions() });
  return event;
}

function listSessions() {
  return [...sessions.entries()]
    .map(([session_id, s]) => ({
      session_id, label: s.label,
      first_seen: s.first_seen, last_seen: s.last_seen, event_count: s.event_count
    }))
    .sort((a, b) => b.last_seen.localeCompare(a.last_seen));
}

function listPendingApprovals() {
  return [...approvals.entries()].map(([approval_id, a]) => ({
    approval_id, tool_name: a.tool_name, tool_input: a.tool_input, session_id: a.session_id
  }));
}

// ---------------------------------------------------------------------------
// approval: a Promise that the browser (or a timeout) resolves
// ---------------------------------------------------------------------------
function requestApproval({ tool_name, tool_input, session_id }) {
  const approval_id = crypto.randomUUID();
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  const timer = setTimeout(() => {
    if (approvals.delete(approval_id)) resolve({ decision: 'timeout' });
  }, APPROVAL_TIMEOUT_MS);
  approvals.set(approval_id, { resolve, timer, tool_name, tool_input, session_id, promise });
  return { approval_id, promise };
}

function respondApproval(approval_id, decision, reason) {
  const a = approvals.get(approval_id);
  if (!a) return false;
  clearTimeout(a.timer);
  approvals.delete(approval_id);
  a.resolve({ decision, reason });
  return true;
}

// ---------------------------------------------------------------------------
// http + websocket plumbing
// ---------------------------------------------------------------------------
const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });
const ptyWss = new WebSocketServer({ noServer: true });
attachPty(ptyWss);

function broadcast(message) {
  const payload = JSON.stringify(message);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) client.send(payload);
  }
}

app.use(express.json({ limit: '256kb' }));

const AUTH_COOKIE = 'zapper_auth';
function readCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return '';
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    if (part.slice(0, i).trim() !== name) continue;
    try { return decodeURIComponent(part.slice(i + 1).trim()); } catch { return part.slice(i + 1).trim(); }
  }
  return '';
}

// Optional shared-token gate. /health stays open so the hook health-probe always works.
// A valid ?token= or header sets an auth cookie, so the browser's later asset/WS requests
// (which carry no token) authenticate by cookie.
app.use((req, res, next) => {
  if (!TOKEN || req.path === '/health') return next();
  const viaQueryOrHeader = req.get('X-Observatory-Token') === TOKEN || req.query.token === TOKEN;
  const ok = viaQueryOrHeader || readCookie(req, AUTH_COOKIE) === TOKEN;
  if (!ok) return res.status(401).json({ error: 'unauthorized' });
  if (viaQueryOrHeader) {
    res.setHeader('Set-Cookie', `${AUTH_COOKIE}=${encodeURIComponent(TOKEN)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`);
  }
  next();
});

app.use(express.static(webDir, { etag: false, setHeaders: (r) => r.setHeader('Cache-Control', 'no-store') }));

app.get('/health', (_req, res) => {
  res.json({ ok: true, uptime_s: Math.round((Date.now() - startedAt) / 1000), sessions: sessions.size });
});

app.get('/sessions', (_req, res) => res.json({ sessions: listSessions() }));

// ---- hook ingest -----------------------------------------------------------
// Simple forwarders: record the event, broadcast it, return {}.
const forward = (type) => (req, res) => {
  const sessionId = req.body?.session_id;
  if (!sessionId) return res.status(400).json({ error: 'session_id required' });
  pushEvent(type, sessionId, req.body || {});
  res.json({});
};
app.post('/hooks/post-tool-use', forward('PostToolUse'));
app.post('/hooks/session-start', forward('SessionStart'));

// Stop: record the event, then (async) read the transcript and broadcast the last
// assistant line as a "say" bubble on the node. Generic — no summary marker required.
app.post('/hooks/stop', (req, res) => {
  const sessionId = req.body?.session_id;
  if (!sessionId) return res.status(400).json({ error: 'session_id required' });
  pushEvent('Stop', sessionId, req.body || {});
  res.json({});
  const transcriptPath = req.body?.transcript_path;
  if (typeof transcriptPath === 'string' && transcriptPath) {
    setTimeout(() => emitSay(sessionId, transcriptPath), 1000); // let the transcript flush
  }
});

async function emitSay(sessionId, transcriptPath) {
  try {
    const text = await fs.readFile(transcriptPath, 'utf8');
    let last = '';
    for (const line of text.split('\n')) {
      if (!line) continue;
      try {
        const o = JSON.parse(line);
        if (o.type !== 'assistant') continue;
        for (const c of (o.message?.content || [])) {
          if (c.type === 'text' && typeof c.text === 'string' && c.text.trim()) last = c.text.trim();
        }
      } catch { /* skip malformed line */ }
    }
    if (last) broadcast({ kind: 'say', session_id: sessionId, text: last.replace(/\s+/g, ' ').slice(0, 80) });
  } catch { /* no transcript */ }
}

// UserPromptSubmit: drain this session's comment queue and hand it back to Claude Code
// as additionalContext, so it lands at the front of the next turn.
app.post('/hooks/user-prompt-submit', (req, res) => {
  const sessionId = req.body?.session_id;
  if (!sessionId) return res.status(400).json({ error: 'session_id required' });
  pushEvent('UserPromptSubmit', sessionId, { prompt: req.body?.prompt || '' });
  const s = sessions.get(sessionId);
  const notes = s ? s.injectQueue.splice(0, s.injectQueue.length) : [];
  broadcast({ kind: 'inject_consumed', session_id: sessionId, count: notes.length });
  if (notes.length === 0) return res.json({});
  const additionalContext =
    '--- [Zapper] comments injected from the dashboard ---\n' +
    notes.map((n) => `- ${n.text}`).join('\n') +
    '\n---';
  res.json({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext } });
});

// PreToolUse: the permission gate.
app.post('/hooks/pre-tool-use', async (req, res) => {
  const sessionId = req.body?.session_id;
  const toolName = req.body?.tool_name;
  if (!sessionId || !toolName) return res.status(400).json({ error: 'session_id and tool_name required' });
  const toolInput = (req.body?.tool_input && typeof req.body.tool_input === 'object') ? req.body.tool_input : {};

  pushEvent('PreToolUse', sessionId, { tool_name: toolName, tool_input: toolInput });

  // non-gating tools (Read, Grep, Glob, ...) are allowed automatically
  if (!NEEDS_GATING.has(toolName)) {
    return res.json({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', permissionDecisionReason: `auto-allow ${toolName}` } });
  }

  // gating tool: ask the browser and wait
  const { approval_id, promise } = requestApproval({ tool_name: toolName, tool_input: toolInput, session_id: sessionId });
  broadcast({ kind: 'approval_request', approval_id, tool_name: toolName, tool_input: toolInput, session_id: sessionId, timestamp: nowIso() });

  const decision = await promise;
  if (decision.decision === 'timeout') {
    broadcast({ kind: 'approval_resolved', approval_id, decision: 'timeout' });
    return res.json({}); // no decision -> Claude Code falls back to its terminal prompt
  }
  const permissionDecision = decision.decision === 'allow' ? 'allow' : 'deny';
  res.json({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision, permissionDecisionReason: decision.reason || `dashboard ${decision.decision}` } });
});

// ---- browser actions -------------------------------------------------------
app.post('/comment', (req, res) => {
  const { session_id, text } = req.body || {};
  if (!session_id || !text) return res.status(400).json({ error: 'session_id and text required' });
  const s = sessions.get(session_id);
  if (!s) return res.status(404).json({ error: 'unknown session' });
  s.injectQueue.push({ text: String(text), timestamp: nowIso() });
  broadcast({ kind: 'inject_queued', session_id, size: s.injectQueue.length });
  res.json({ ok: true, queued: s.injectQueue.length });
});

app.post('/approval/:id/respond', (req, res) => {
  const { decision, reason } = req.body || {};
  if (decision !== 'allow' && decision !== 'deny') return res.status(400).json({ error: 'decision must be allow or deny' });
  const ok = respondApproval(req.params.id, decision, reason);
  broadcast({ kind: 'approval_resolved', approval_id: req.params.id, decision });
  res.json({ ok });
});

app.post('/sessions/:id/label', (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s) return res.status(404).json({ error: 'unknown session' });
  s.label = String(req.body?.label || '').slice(0, 60);
  broadcast({ kind: 'sessions', sessions: listSessions() });
  res.json({ ok: true });
});

// ---- websocket -------------------------------------------------------------
function handleUpgrade(req, socket, head) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const authed = !TOKEN || url.searchParams.get('token') === TOKEN || readCookie(req, AUTH_COOKIE) === TOKEN;
  if (!authed) return socket.destroy();
  if (url.pathname === '/ws') {
    return wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  }
  if (url.pathname === '/pty/ws') {
    return ptyWss.handleUpgrade(req, socket, head, (ws) => ptyWss.emit('connection', ws, req));
  }
  socket.destroy();
}
server.on('upgrade', handleUpgrade);

wss.on('connection', (ws) => {
  ws.send(JSON.stringify({
    kind: 'hello',
    bufferedEvents: events.slice(-200),
    sessions: listSessions(),
    pendingApprovals: listPendingApprovals()
  }));
});

server.listen(PORT, HOST, () => console.log(`[zapper] listening on http://${HOST}:${PORT}`));

// When bound to an external address (e.g. a Tailscale IP for phone access), also bind
// loopback so the hooks' default 127.0.0.1 target keeps working. Set ZAPPER_TOKEN when
// exposing beyond localhost.
if (HOST !== '127.0.0.1' && HOST !== 'localhost') {
  const loopback = http.createServer(app);
  loopback.on('upgrade', handleUpgrade);
  loopback.listen(PORT, '127.0.0.1', () => console.log(`[zapper] also on http://127.0.0.1:${PORT}`));
}
