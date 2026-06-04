// PTY bridge — attaches a browser xterm to a tmux session.
//
// ws /pty/ws?session=<name> spawns `tmux new-session -A -s <name>`, which attaches to
// the session if it exists or creates it otherwise. Run Claude Code inside that tmux
// session and the web terminal shares it: your keyboard and the browser type into the
// same shell. Keystrokes arrive as binary frames; resize as a JSON text frame.

import pty from 'node-pty';
import { execSync } from 'node:child_process';

const VALID_TARGET = /^[A-Za-z0-9_:.-]+$/;
const DEFAULT_TARGET = process.env.ZAPPER_TMUX_DEFAULT || 'main';

// Resolve the user's real login PATH so tmux's child can find tools even when the
// bridge was started from a process with a narrow PATH.
let USER_PATH = process.env.PATH || '';
try {
  const shell = process.env.SHELL || '/bin/zsh';
  const out = execSync(`${shell} -lc 'printf %s "$PATH"'`, { encoding: 'utf8', timeout: 3000 }).trim();
  if (out) USER_PATH = `${out}:${USER_PATH}`;
} catch { /* keep process PATH */ }

export function attachPty(wss) {
  wss.on('connection', (ws, req) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const target = url.searchParams.get('session') || DEFAULT_TARGET;
    if (!VALID_TARGET.test(target)) return ws.close(1008, 'invalid_session_target');

    let term;
    try {
      term = pty.spawn('tmux', ['new-session', '-A', '-s', target], {
        name: 'xterm-256color',
        cols: 120,
        rows: 32,
        encoding: null, // receive Buffers; the client stream-decodes partial UTF-8
        env: { ...process.env, PATH: USER_PATH, LANG: process.env.LANG || 'en_US.UTF-8' }
      });
    } catch (err) {
      console.error('[pty] spawn failed', err);
      return ws.close(1011, 'pty_spawn_failed');
    }

    let killed = false;
    const kill = () => { if (!killed) { killed = true; try { term.kill(); } catch {} } };

    ws.on('message', (data, isBinary) => {
      if (isBinary) return term.write(data); // keystrokes
      try {
        const m = JSON.parse(data.toString('utf8'));
        if (m?.type === 'resize' && Number.isFinite(m.cols) && Number.isFinite(m.rows)) {
          term.resize(m.cols, m.rows);
        }
      } catch { /* ignore non-JSON text */ }
    });

    term.onData((d) => {
      if (ws.readyState !== 1) return;
      try { ws.send(Buffer.isBuffer(d) ? d : Buffer.from(d, 'utf8')); } catch {}
    });
    term.onExit(() => ws.close(1000, 'pty_exited'));
    ws.on('close', kill);
    ws.on('error', kill);
  });
}
