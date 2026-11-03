import { FLASH_START } from './commands.js';

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

const FLASH_STEPS = ['Erasing block', 'Writing kb', 'Verifying kb'];
// Share of the whole job: the kernel is much smaller than the rootfs.
const IMAGE_SPANS = { kernel: [0, 25], rootfs: [25, 100] };

// Follows sysupgrade output. Each image is erased, written and verified, each step counting
// 0-100%, so `percent` turns that into one figure for the whole job that never goes backwards.
export class FlashTracker {
  started = false;        // sysupgrade ran, so the flash may have changed something
  complete = false;       // the rootfs was verified or the reboot announced
  handedOff = false;      // flashing moved into RAM: SSH ends here and the writes are still to come
  nothingWritten = false; // sysupgrade itself says it gave up before writing
  percent = 0;
  #image = 'kernel';
  #buffer = '';

  feed(text) {
    this.#buffer += text;
    const lines = this.#buffer.split(/\r|\n/);
    this.#buffer = lines.pop();
    // The unfinished last line is read too, for live progress; reading it again later is harmless.
    for (const line of [...lines, this.#buffer]) this.#line(line);
  }

  #line(line) {
    if (line.includes(FLASH_START)) this.started = true;
    if (line.includes('Handing PID 1 over to the RAM root')) this.handedOff = true;
    if (/nothing was (written|flashed)/i.test(line)) this.nothingWritten = true;
    const update = /Update (kernel|rootfs)/i.exec(line);
    if (update) { this.started = true; this.#image = update[1].toLowerCase(); }
    if (line.includes('Unconditional reboot')) { this.started = true; this.complete = true; }
    const pct = flashPercent(line);
    if (pct === null) return;
    this.started = true;
    const step = FLASH_STEPS.findIndex(s => line.includes(s));
    const [from, to] = IMAGE_SPANS[this.#image];
    this.percent = Math.max(this.percent, Math.round(from + (to - from) * (step + pct / 100) / FLASH_STEPS.length));
    if (this.#image === 'rootfs' && FLASH_STEPS[step] === 'Verifying kb' && pct === 100) this.complete = true;
  }
}

// What to tell the user when the flash command ends. A dropped connection is only good news if
// the output shows the flash got to the end: it can also mean a power or network failure, or that
// sysupgrade moved into RAM (newer firmware does this on purpose) with all the writing still to do.
export function flashOutcome({ disconnected, code }, tracker) {
  const stoppedEarly = `sysupgrade stopped without writing anything (exit code ${code}). See the log above.`;
  if (tracker.nothingWritten) return { kind: 'not-started', message: disconnected ? 'sysupgrade stopped without writing anything and the connection closed. See the log above.' : stoppedEarly };
  if (tracker.handedOff && !tracker.complete) return { kind: 'handed-off', message: 'sysupgrade moved into the camera\'s RAM to flash, so SSH has ended as expected and progress can\'t be shown here. Keep the camera powered: it reboots by itself when it is done. Wait a few minutes, then reconnect and check the firmware version.' };
  if (disconnected) {
    if (tracker.complete) return { kind: 'rebooting', percent: 100, message: 'Flash finished; the camera is rebooting. Give it a minute, then reconnect.' };
    if (tracker.started) return { kind: 'interrupted', message: 'The connection dropped while sysupgrade was running, so the flash may not have completed. Keep the camera powered, wait a few minutes, then reconnect and check the firmware version.' };
    return { kind: 'not-started', message: 'The connection dropped before flashing started. Nothing was written; try again.' };
  }
  if (code === 0) return { kind: 'rebooting', percent: 100, message: 'Done. The camera is rebooting.' };
  if (tracker.started) return { kind: 'failed', message: `sysupgrade failed (exit code ${code}) and the flash may be incomplete. See the log above, and keep the camera powered until you have checked it.` };
  return { kind: 'not-started', message: `Stopped before flashing (exit code ${code}). See the log above.` };
}
