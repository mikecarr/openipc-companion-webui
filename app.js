import { HelperClient, flashPercent } from './helper-client.js';
import { validate, filterAssets, socFromFilename, scpCommand, flashCommand, sshUrl, tarNames, INFO_COMMAND, parseInfo } from './commands.js';

const $ = id => document.getElementById(id);
const state = { assets: [], filename: '', fromLocal: false, url: null, file: null, helper: null, connected: false, flashing: false };
const releaseCache = new Map();

function remember() {
  try { localStorage.setItem('flasher', JSON.stringify({ ip: $('ip').value, port: $('port').value, soc: $('soc').value, source: $('source').value })); } catch {}
}
function restore() {
  try {
    const s = JSON.parse(localStorage.getItem('flasher') || '{}');
    for (const k of ['ip', 'port', 'soc', 'source']) if (s[k]) $(k).value = s[k];
  } catch {}
}

async function loadReleases() {
  const repo = $('source').value;
  $('status').textContent = 'Loading releases…';
  try {
    if (!releaseCache.has(repo)) {
      const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, { headers: { Accept: 'application/vnd.github+json' } });
      if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
      const rel = await res.json();
      releaseCache.set(repo, { tag: rel.tag_name, assets: rel.assets.map(a => ({ name: a.name, url: a.browser_download_url, size: a.size, updated: a.updated_at })) });
    }
    const rel = releaseCache.get(repo);
    state.assets = rel.assets;
    renderAssets(rel.tag);
  } catch (e) {
    $('status').textContent = `Could not load releases (${e.message}). You can still use a local file.`;
    $('assets').replaceChildren();
  }
}

function renderAssets(tag) {
  const list = filterAssets(state.assets, { soc: $('soc').value.trim(), text: $('filter').value });
  const soc = $('soc').value.trim();
  $('status').textContent = `${list.length} firmware file${list.length === 1 ? '' : 's'} in release ${tag || 'latest'}` + (soc ? ` for ${soc}` : '') + '.';
  $('assets').replaceChildren(...list.map(a => {
    const li = document.createElement('li');
    const pick = document.createElement('button');
    pick.className = 'pick' + (a.name === state.filename && !state.fromLocal ? ' on' : '');
    pick.textContent = a.name;
    pick.title = `${(a.size / 1048576).toFixed(1)} MB`;
    pick.onclick = () => {
      state.filename = a.name; state.fromLocal = false; state.url = a.url; state.file = null;
      if (!$('soc').value.trim()) $('soc').value = socFromFilename(a.name);
      renderAssets(tag); update();
    };
    const dl = document.createElement('a');
    dl.href = a.url; dl.textContent = 'Download'; dl.className = 'dl';
    li.append(pick, dl);
    return li;
  }));
}

async function onLocalFile(file) {
  if (!file) return;
  state.filename = file.name; state.fromLocal = true; state.file = file; state.url = null;
  try {
    const tar = new Uint8Array(await new Response(file.stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
    const names = tarNames(tar);
    const kernel = names.find(n => n.startsWith('uImage.') && !n.endsWith('.md5sum'));
    const rootfs = names.find(n => n.startsWith('rootfs.') && !n.endsWith('.md5sum'));
    const sums = names.filter(n => n.endsWith('.md5sum'));
    if (!kernel || !rootfs || sums.length < 2) {
      $('status').textContent = `${file.name} does not look like OpenIPC firmware (found: ${names.join(', ') || 'nothing'}).`;
    } else {
      const soc = kernel.slice('uImage.'.length);
      $('status').textContent = `${file.name}: kernel ${kernel}, rootfs ${rootfs}, ${sums.length} checksum files.`;
      if (!$('soc').value.trim()) $('soc').value = soc;
      else if ($('soc').value.trim() !== soc) $('status').textContent += ` Warning: this file is for ${soc}, not ${$('soc').value.trim()}.`;
    }
  } catch (e) {
    $('status').textContent = `Could not read ${file.name}: ${e.message}`;
  }
  update();
}

function update() {
  remember();
  const v = { ip: $('ip').value.trim(), port: $('port').value.trim() || '22', soc: $('soc').value.trim(), filename: state.filename };
  const errors = validate(v);
  const link = $('sshLink');
  $('flashBtn').disabled = !!errors.length || !state.connected || state.flashing;
  if (errors.length) {
    $('scpCmd').textContent = $('flashCmd').textContent = errors.join('\n');
    link.setAttribute('aria-disabled', 'true'); link.href = '#';
    return;
  }
  $('scpCmd').textContent = scpCommand(v);
  $('flashCmd').textContent = flashCommand(v);
  link.href = sshUrl(v); link.removeAttribute('aria-disabled');
}

document.addEventListener('click', e => {
  const id = e.target?.dataset?.copy;
  if (!id) return;
  navigator.clipboard.writeText($(id).textContent).then(() => {
    e.target.textContent = 'Copied'; setTimeout(() => (e.target.textContent = 'Copy'), 1500);
  });
});

function applyInfo(text) {
  const info = parseInfo(text);
  if (!info) { $('infoHint').textContent = 'No OPENIPC-INFO line found. Copy the whole line the command printed and try again.'; return false; }
  if (info.soc) $('soc').value = info.soc;
  if (info.flash && !$('filter').value.trim()) $('filter').value = info.flash;
  const labels = { soc: 'SoC', sensor: 'Sensor', flash: 'Flash', host: 'Hostname', ver: 'Firmware' };
  $('infoOut').replaceChildren(...Object.entries(labels).filter(([k]) => info[k]).flatMap(([k, l]) => {
    const dt = document.createElement('dt'); dt.textContent = l;
    const dd = document.createElement('dd'); dd.textContent = info[k];
    return [dt, dd];
  }));
  $('infoOut').hidden = false; $('infoText').hidden = true;
  $('infoHint').textContent = 'Device info loaded.';
  renderAssets(releaseCache.get($('source').value)?.tag); update();
  return true;
}

$('getInfo').addEventListener('click', async () => {
  if (state.helper) {
    try {
      if (!state.connected) await connectCamera();
      $('infoHint').textContent = 'Reading device info…';
      const r = await state.helper.execText(INFO_COMMAND);
      applyInfo(r.out);
    } catch (e) { $('infoHint').textContent = `Could not read device info: ${e.message}`; }
    return;
  }
  try { await navigator.clipboard.writeText(INFO_COMMAND); } catch {}
  const ip = $('ip').value.trim();
  if (ip && !validate({ ip, port: $('port').value || 22, soc: 'x', filename: 'x.tgz' }).length) {
    window.open(sshUrl({ ip, port: $('port').value || 22 }), '_blank');
    $('infoHint').textContent = 'Command copied. Paste it into Secure Shell, select the OPENIPC-INFO line it prints, then click "Paste result".';
  } else {
    $('infoHint').textContent = 'Command copied. Enter the IP address first so Secure Shell can open, or run it in any SSH session.';
  }
});
$('pasteInfo').addEventListener('click', async () => {
  let text = '';
  try { text = await navigator.clipboard.readText(); } catch {}
  if (!applyInfo(text)) { $('infoText').hidden = false; $('infoText').focus(); }
});
$('infoText').addEventListener('input', e => applyInfo(e.target.value));

// ---- Optional local helper: Connect, device info and Flash without copy and paste ----

async function connectCamera() {
  const ip = $('ip').value.trim(), port = $('port').value.trim() || '22';
  if (validate({ ip, port, soc: 'x', filename: 'x.tgz' }).length) throw new Error('enter the camera IP address first');
  $('connectBtn').disabled = true;
  $('infoHint').textContent = `Connecting to ${ip}…`;
  try {
    await state.helper.connect({ host: ip, port, password: $('password').value });
    state.connected = true;
    $('connectBtn').textContent = 'Connected';
    $('infoHint').textContent = `Connected to ${ip}.`;
  } catch (e) {
    state.connected = false;
    $('connectBtn').textContent = 'Connect';
    $('infoHint').textContent = `Could not connect: ${e.message}`;
    throw e;
  } finally {
    $('connectBtn').disabled = false;
    update();
  }
}

function log(text) {
  const el = $('flashLog');
  el.hidden = false;
  el.textContent += text;
  el.scrollTop = el.scrollHeight;
}

async function flash() {
  const v = { ip: $('ip').value.trim(), port: $('port').value.trim() || '22', soc: $('soc').value.trim(), filename: state.filename };
  if (validate(v).length || !state.connected) return;
  if (!confirm(`Flash ${v.filename} to ${v.ip}? The camera will reboot.`)) return;
  state.flashing = true; update();
  const bar = $('flashProgress'), status = $('flashStatus');
  bar.hidden = false; bar.value = 0; $('flashLog').textContent = '';
  let started = false;
  try {
    status.textContent = 'Uploading firmware…';
    await state.helper.upload(`/tmp/${v.filename}`, state.file ? { file: state.file } : { url: state.url }, (sent, total, text) => {
      if (text) { status.textContent = 'Downloading firmware from GitHub…'; return; }
      bar.value = total ? Math.round((sent / total) * 30) : 0;
      status.textContent = `Uploading firmware… ${total ? Math.round((sent / total) * 100) : 0}%`;
    });
    status.textContent = 'Checking and flashing. Do not unplug the camera.';
    let buffer = '';
    const r = await state.helper.exec(flashCommand(v), text => {
      log(text);
      if (text.includes('sysupgrade') || /Update (kernel|rootfs)/i.test(text)) started = true;
      buffer += text;
      const lines = buffer.split(/\r|\n/); buffer = lines.pop();
      for (const line of [...lines, buffer]) {
        const pct = flashPercent(line);
        if (pct !== null) { started = true; bar.value = 30 + Math.round(pct * 0.7); }
      }
    });
    if (r.disconnected) {
      state.connected = false;
      if (started) { bar.value = 100; status.textContent = 'Flash finished; the camera is rebooting. Give it a minute, then reconnect.'; }
      else status.textContent = 'The connection dropped before flashing started. Nothing was written; try again.';
    } else if (r.code === 0) {
      bar.value = 100; status.textContent = 'Done. The camera is rebooting.';
    } else {
      status.textContent = `Stopped before flashing (exit code ${r.code}). See the log above.`;
    }
  } catch (e) {
    status.textContent = `Failed: ${e.message}`;
  } finally {
    state.flashing = false;
    $('connectBtn').textContent = state.connected ? 'Connected' : 'Connect';
    update();
  }
}

async function useHelperIfRunning() {
  const helper = await HelperClient.detect();
  if (!helper) {
    $('helperBadge').hidden = false;
    $('helperBadge').className = 'badge off';
    $('helperBadge').innerHTML = 'Manual mode: no helper found on this computer. <button id="retryHelper" type="button" class="link">Check again</button>';
    $('retryHelper').onclick = () => { $('helperBadge').textContent = 'Looking for helper…'; useHelperIfRunning(); };
    return;
  }
  $('helperBadge').className = 'badge';
  state.helper = helper;
  document.body.classList.add('helper');
  document.querySelectorAll('.helperOnly').forEach(el => (el.hidden = false));
  $('pasteInfo').hidden = true;
  $('helperBadge').hidden = false;
  $('helperBadge').textContent = `Helper ${helper.version} connected: this page can flash directly.`;
  $('infoHint').textContent = 'Enter the root password and click Connect, then Get device info.';
  helper.onclose = () => location.reload();
  update();
}

$('connectBtn').addEventListener('click', () => connectCamera().catch(() => {}));
$('flashBtn').addEventListener('click', flash);
$('password').addEventListener('keydown', e => e.key === 'Enter' && connectCamera().catch(() => {}));
['ip', 'port', 'password'].forEach(id => $(id).addEventListener('input', () => {
  if (state.connected && id !== 'password') { state.connected = false; $('connectBtn').textContent = 'Connect'; }
}));

restore();
['ip', 'port'].forEach(id => $(id).addEventListener('input', update));
$('soc').addEventListener('input', () => { renderAssets(releaseCache.get($('source').value)?.tag); update(); });
$('filter').addEventListener('input', () => renderAssets(releaseCache.get($('source').value)?.tag));
$('source').addEventListener('change', () => { remember(); loadReleases(); });
$('localFile').addEventListener('change', e => onLocalFile(e.target.files[0]));
update();
loadReleases();
useHelperIfRunning();
