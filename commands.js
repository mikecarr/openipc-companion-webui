// Pure helpers: build the commands the user runs. No DOM, so they can be unit tested in Node.

const IP_RE = /^[A-Za-z0-9.:\-\[\]]+$/;      // IPv4, IPv6 or hostname
const SOC_RE = /^[a-z0-9]+$/;
const FILE_RE = /^[A-Za-z0-9._+\-]+\.tgz$/;

export function validate({ ip, port, soc, filename }) {
  const errors = [];
  if (!ip || !IP_RE.test(ip)) errors.push('Enter the camera IP address.');
  const p = Number(port || 22);
  if (!Number.isInteger(p) || p < 1 || p > 65535) errors.push('SSH port must be 1 to 65535.');
  if (!soc || !SOC_RE.test(soc)) errors.push('Enter the SoC in lower case, for example ssc338q.');
  if (!filename || !FILE_RE.test(filename)) errors.push('Pick a .tgz firmware file.');
  return errors;
}

// Guess the SoC from a release asset name.
//   builder:  ssc338q_fpv_openipc-thinker-aio-nor.tgz
//   firmware: openipc.ssc338q-nor-fpv.tgz
export function socFromFilename(name) {
  let m = /^openipc\.([a-z0-9]+)-/.exec(name);
  if (m) return m[1];
  m = /^([a-z0-9]+)_/.exec(name);
  return m ? m[1] : '';
}

// Flash type from an asset name: ...-nor.tgz, ...-nand.tgz, openipc.ssc338q-nor-fpv.tgz. '' if not stated.
export function flashFromFilename(name) {
  const m = /[-_.](nand|nor)(?=[-_.])/i.exec(name);
  return m ? m[1].toLowerCase() : '';
}

// soc and flash come from the device; files that don't name a flash type are kept.
export function filterAssets(assets, { soc = '', flash = '', text = '' } = {}) {
  const words = text.toLowerCase().split(/[\s,]+/).filter(Boolean);
  return assets
    .filter(a => a.name.endsWith('.tgz'))
    .filter(a => !soc || socFromFilename(a.name) === soc.toLowerCase())
    .filter(a => !flash || !flashFromFilename(a.name) || flashFromFilename(a.name) === flash)
    .filter(a => words.every(w => a.name.toLowerCase().includes(w)))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// Upload, run on the user's computer. -O forces the legacy SCP protocol:
// OpenSSH 9+ defaults to SFTP and the camera has no SFTP server.
export function scpCommand({ ip, port = 22, filename }) {
  const p = Number(port) === 22 ? '' : ` -P ${Number(port)}`;
  return `scp -O${p} ~/Downloads/${filename} root@${hostForScp(ip)}:/tmp/`;
}

function hostForScp(ip) {
  return ip.includes(':') && !ip.startsWith('[') ? `[${ip}]` : ip;
}

// Flash, pasted into Secure Shell on the camera. Mirrors Companion's SysUpgradeService:
// check SoC, unpack, verify checksums, then sysupgrade --kernel --rootfs.
// Runs in a subshell so a failed check stops the chain without closing the SSH session.
export function flashCommand({ soc, filename }) {
  return [
    '(',
    `S=$(fw_printenv -n soc);`,
    `[ "$S" = "${soc}" ] || { echo "STOP: camera SoC is $S, firmware is for ${soc}"; exit 1; };`,
    `rm -rf /tmp/fw && mkdir /tmp/fw &&`,
    `tar -xzf /tmp/${filename} -C /tmp/fw && rm -f /tmp/${filename} &&`,
    `cd /tmp/fw && K=$(ls uImage.* | grep -v md5sum) && R=$(ls rootfs.* | grep -v md5sum) &&`,
    `md5sum -c *.md5sum &&`,
    `sysupgrade --force_ver -n -z --kernel=/tmp/fw/$K --rootfs=/tmp/fw/$R`,
    ')',
  ].join(' ');
}

export function sshUrl({ ip, port = 22 }) {
  const p = Number(port) === 22 ? '' : `:${Number(port)}`;
  return `ssh://root@${hostForScp(ip)}${p}`;
}

// List file names in an uncompressed tar (ustar). Used to sanity-check a local .tgz.
export function tarNames(bytes) {
  const names = [];
  const dec = new TextDecoder();
  let off = 0;
  while (off + 512 <= bytes.length) {
    const h = bytes.subarray(off, off + 512);
    if (h.every(b => b === 0)) break;
    const str = (s, n) => dec.decode(h.subarray(s, s + n)).replace(/\0.*$/s, '');
    const name = (str(345, 155) ? str(345, 155) + '/' : '') + str(0, 100);
    const size = parseInt(str(124, 12).trim() || '0', 8);
    const type = String.fromCharCode(h[156] || 48);
    if (type === '0' || type === '\0') names.push(name.replace(/^\.\//, ''));
    off += 512 + Math.ceil(size / 512) * 512;
  }
  return names;
}

// Device info: one line the user runs in Secure Shell. The output is a single
// "OPENIPC-INFO key=value;..." line the page can parse back from the clipboard.
export const INFO_COMMAND =
  `echo "OPENIPC-INFO soc=$(fw_printenv -n soc 2>/dev/null);sensor=$(fw_printenv -n sensor 2>/dev/null);` +
  `flash=$(cat /sys/class/mtd/mtd0/type 2>/dev/null || grep -o 'mtdparts=[^:]*' /proc/cmdline | cut -d= -f2);host=$(hostname -s);` +
  `ver=$(sed -n 's/^OPENIPC_VERSION=//p' /etc/os-release | tr -d '\\"')"`;

export function parseInfo(text) {
  const m = /OPENIPC-INFO\s+(\S.*)/.exec(text || '');
  if (!m) return null;
  const info = {};
  for (const part of m[1].trim().split(';')) {
    const i = part.indexOf('=');
    if (i > 0) info[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  if (info.soc && !SOC_RE.test(info.soc)) delete info.soc;
  if (info.flash) info.flash = /nand/i.test(info.flash) ? 'nand' : 'nor';
  return info;
}

// ---- fw_printenv (U-Boot environment) ----

// "key=value" per line; values may themselves contain "=".
export function parseEnv(text) {
  const out = [];
  for (const line of (text || '').split(/\r?\n/)) {
    const i = line.indexOf('=');
    if (i > 0 && /^[A-Za-z0-9_.\-]+$/.test(line.slice(0, i))) out.push({ key: line.slice(0, i), value: line.slice(i + 1) });
  }
  return out;
}

const ENV_GROUPS = [
  ['Hardware', ['soc', 'sensor', 'wlandev', 'wlanssid', 'totalmem', 'osmem', 'rmem', 'mmz', 'hwid', 'board', 'vendor']],
  ['Network', ['ipaddr', 'serverip', 'netmask', 'gatewayip', 'ethaddr', 'ethact', 'phyaddru', 'phyaddrd', 'dnsip']],
  ['Boot', ['bootcmd', 'bootargs', 'bootdelay', 'baudrate', 'mtdparts', 'mtdids', 'kernaddr', 'rootaddr', 'upgrade', 'setnor8m', 'setnor16m', 'setnand', 'uknor8m', 'uknor16m', 'urnor8m', 'urnor16m', 'uknand', 'urnand', 'stdin', 'stdout', 'stderr', 'verify', 'bootfile']],
];

// Known keys into Hardware / Network / Boot in a fixed order; everything else under Other, sorted.
export function groupEnv(entries) {
  const byKey = new Map(entries.map(e => [e.key, e]));
  const used = new Set();
  const groups = [];
  for (const [name, keys] of ENV_GROUPS) {
    const items = keys.filter(k => byKey.has(k)).map(k => (used.add(k), byKey.get(k)));
    if (items.length) groups.push({ name, items });
  }
  const rest = entries.filter(e => !used.has(e.key)).sort((a, b) => a.key.localeCompare(b.key));
  if (rest.length) groups.push({ name: 'Other', items: rest });
  return groups;
}

// "mtdparts=NOR_FLASH:256k(boot),64k(env),2048k(kernel),-(rootfs_data)" -> device + partitions.
export function parseMtdparts(value) {
  const m = /(?:mtdparts=)?([^:\s]+):(\S+)/.exec(value || '');
  if (!m) return null;
  const parts = m[2].split(',').map(p => {
    const pm = /^(-|[0-9]+[kKmM]?)(?:@\S+?)?\(([^)]+)\)/.exec(p);
    return pm ? { size: pm[1] === '-' ? 'rest' : pm[1].toUpperCase().replace(/([KM])$/, ' $1B'), name: pm[2] } : null;
  }).filter(Boolean);
  return parts.length ? { device: m[1], parts } : null;
}
