import { validate, filterAssets, socFromFilename, scpCommand, flashCommand, sshUrl, tarNames, INFO_COMMAND, parseInfo } from './commands.js';

const $ = id => document.getElementById(id);
const state = { assets: [], filename: '', fromLocal: false };
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
      state.filename = a.name; state.fromLocal = false;
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
  state.filename = file.name; state.fromLocal = true;
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

restore();
['ip', 'port'].forEach(id => $(id).addEventListener('input', update));
$('soc').addEventListener('input', () => { renderAssets(releaseCache.get($('source').value)?.tag); update(); });
$('filter').addEventListener('input', () => renderAssets(releaseCache.get($('source').value)?.tag));
$('source').addEventListener('change', () => { remember(); loadReleases(); });
$('localFile').addEventListener('change', e => onLocalFile(e.target.files[0]));
update();
loadReleases();
