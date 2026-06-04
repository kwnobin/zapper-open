// Shared xterm.js -> /pty/ws helper. Used by the dashboard's side terminal and by the
// full-screen terminal.html. Keystrokes are sent as binary frames; resize as JSON text.
window.mountZapperTerminal = function (el, session) {
  const token = new URLSearchParams(location.search).get('token');
  const term = new Terminal({
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    fontSize: 13,
    cursorBlink: true,
    theme: { background: '#090c12', foreground: '#d7dce5' }
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(el);
  try { fit.fit(); } catch {}

  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const q = new URLSearchParams({ session });
  if (token) q.set('token', token);
  const ws = new WebSocket(`${proto}://${location.host}/pty/ws?${q.toString()}`);
  ws.binaryType = 'arraybuffer';

  const sendResize = () => {
    if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
  };

  ws.onopen = () => { try { fit.fit(); } catch {} sendResize(); };
  ws.onmessage = (e) => {
    if (typeof e.data === 'string') term.write(e.data);
    else term.write(new Uint8Array(e.data));
  };
  ws.onclose = (e) => term.write(`\r\n[connection closed: ${e.reason || e.code}]\r\n`);

  const enc = new TextEncoder();
  term.onData((d) => { if (ws.readyState === 1) ws.send(enc.encode(d)); });

  const ro = new ResizeObserver(() => { try { fit.fit(); } catch {} sendResize(); });
  ro.observe(el);

  return { term, ws, dispose() { ro.disconnect(); try { ws.close(); } catch {} term.dispose(); } };
};
