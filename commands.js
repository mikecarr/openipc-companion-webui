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

export function filterAssets(assets, { soc = '', text = '' } = {}) {
  const words = text.toLowerCase().split(/[\s,]+/).filter(Boolean);
  return assets
    .filter(a => a.name.endsWith('.tgz'))
    .filter(a => !soc || socFromFilename(a.name) === soc.toLowerCase())
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
