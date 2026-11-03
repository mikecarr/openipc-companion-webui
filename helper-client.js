// Talks to the optional local helper (openipc-helper) over ws://127.0.0.1:47811.
// The helper only runs commands and uploads files; all flashing logic stays in this page.

export const HELPER_URL = 'ws://127.0.0.1:47811';
const FINAL = new Set(['ok', 'error', 'exit', 'hello']);

export class HelperClient {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.onclose = null;
    ws.onmessage = e => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      const p = this.pending.get(msg.id);
      if (!p) return;
      if (!FINAL.has(msg.type)) { p.onEvent?.(msg); return; }
      this.pending.delete(msg.id);
      msg.type === 'error' ? p.reject(new Error(msg.message)) : p.resolve(msg);
    };
    ws.onclose = () => {
      for (const p of this.pending.values()) p.reject(new Error('helper disconnected'));
      this.pending.clear();
      this.onclose?.();
    };
  }

  // Resolves with a connected client, or null if no helper is running.
  static async detect(url = HELPER_URL, timeoutMs = 1500) {
    let ws;
    try { ws = new WebSocket(url); } catch { return null; }
    const opened = await new Promise(resolve => {
      const t = setTimeout(() => resolve(false), timeoutMs);
      ws.onopen = () => { clearTimeout(t); resolve(true); };
      ws.onerror = () => { clearTimeout(t); resolve(false); };
    });
    if (!opened) { try { ws.close(); } catch {} return null; }
    const client = new HelperClient(ws);
    try {
      client.version = (await client.request('hello')).version;
      return client;
    } catch { return null; }
  }

  request(op, params = {}, onEvent, binary) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, onEvent });
      this.ws.send(JSON.stringify({ id, op, ...params }));
      if (binary) this.ws.send(binary);
    });
  }

  connect({ host, port, password }) { return this.request('connect', { host, port: Number(port) || 22, user: 'root', password }); }

  // Runs a command; onText gets output as it arrives. Resolves with { code, disconnected }.
  exec(cmd, onText) { return this.request('exec', { cmd }, m => m.type === 'output' && onText?.(m.text)); }

  async execText(cmd) {
    let out = '';
    const r = await this.exec(cmd, t => (out += t));
    return { ...r, out };
  }

  // source: { url } for a GitHub release asset, or { file } (a File/Blob) from the page.
  async upload(remotePath, source, onProgress) {
    const onEvent = m => m.type === 'progress' ? onProgress?.(m.sent, m.total) : m.type === 'status' && onProgress?.(0, 0, m.text);
    if (source.url) return this.request('upload', { remotePath, url: source.url }, onEvent);
    const bytes = await source.file.arrayBuffer();
    return this.request('upload', { remotePath, size: bytes.byteLength }, onEvent, bytes);
  }

  close() { return this.request('close'); }
}

// sysupgrade / flashcp progress lines, as parsed by Companion's FirmwareTabViewModel.
const PERCENT_RE = /(?:Erasing block|Writing kb|Verifying kb):.*\((\d{1,3})%\)/;
export function flashPercent(line) {
  const m = PERCENT_RE.exec(line.replace(/\x1B\[[0-9;]*[mK]/g, ''));
  return m ? Number(m[1]) : null;
}
