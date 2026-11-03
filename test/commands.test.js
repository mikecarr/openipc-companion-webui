import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validate, socFromFilename, filterAssets, scpCommand, flashCommand, sshUrl, tarNames } from '../commands.js';

test('soc from asset names', () => {
  assert.equal(socFromFilename('ssc338q_fpv_openipc-thinker-aio-nor.tgz'), 'ssc338q');
  assert.equal(socFromFilename('openipc.ssc338q-nor-fpv.tgz'), 'ssc338q');
});

test('filter by soc and words', () => {
  const a = ['openipc.ssc338q-nor-fpv.tgz', 'openipc.ssc30kq-nor-fpv.tgz', 'ssc338q_fpv_openipc-thinker-aio-nor.tgz', 'notes.txt'].map(name => ({ name }));
  assert.deepEqual(filterAssets(a, { soc: 'ssc338q', text: 'thinker' }).map(x => x.name), ['ssc338q_fpv_openipc-thinker-aio-nor.tgz']);
  assert.equal(filterAssets(a, {}).length, 3);
});

test('validation rejects shell metacharacters', () => {
  assert.ok(validate({ ip: '1.2.3.4;rm', port: 22, soc: 'ssc338q', filename: 'a.tgz' }).length);
  assert.ok(validate({ ip: '1.2.3.4', port: 22, soc: 'ssc338q', filename: '$(x).tgz' }).length);
  assert.equal(validate({ ip: '1.2.3.4', port: 22, soc: 'ssc338q', filename: 'a.tgz' }).length, 0);
});

test('scp uses legacy protocol and port flag', () => {
  assert.equal(scpCommand({ ip: '10.0.0.5', port: 22, filename: 'f.tgz' }), 'scp -O ~/Downloads/f.tgz root@10.0.0.5:/tmp/');
  assert.equal(scpCommand({ ip: '10.0.0.5', port: 2222, filename: 'f.tgz' }), 'scp -O -P 2222 ~/Downloads/f.tgz root@10.0.0.5:/tmp/');
  assert.equal(sshUrl({ ip: '10.0.0.5', port: 2222 }), 'ssh://root@10.0.0.5:2222');
});

test('flash command checks soc and runs sysupgrade with kernel and rootfs', () => {
  const c = flashCommand({ soc: 'ssc338q', filename: 'f.tgz' });
  assert.match(c, /fw_printenv soc 2>\/dev\/null \| sed/);
  assert.doesNotMatch(c, /fw_printenv -n/);
  assert.match(c, /"\$S" = "ssc338q"/);
  assert.match(c, /md5sum -c \*\.md5sum/);
  assert.match(c, /sysupgrade --force_ver -n -z --kernel="\$K" --rootfs="\$R"/);
  assert.ok(c.startsWith('(') && c.endsWith(')'));
});

test('tar names', () => {
  const block = (name, size) => { const h = new Uint8Array(512); new TextEncoder().encodeInto(name, h); new TextEncoder().encodeInto(size.toString(8).padStart(11, '0'), h.subarray(124)); h[156] = 48; return h; };
  const tar = new Uint8Array(512 * 5);
  tar.set(block('uImage.ssc338q', 3), 0);
  tar.set(block('rootfs.squashfs.ssc338q', 0), 1024);
  assert.deepEqual(tarNames(tar), ['uImage.ssc338q', 'rootfs.squashfs.ssc338q']);
});

import { INFO_COMMAND, parseInfo } from '../commands.js';

test('parse device info line', () => {
  const i = parseInfo('root@cam:~# OPENIPC-INFO soc=ssc338q;sensor=imx415;flash=NOR_FLASH;host=openipc-ssc338q;ver=2.6.10.21\n');
  assert.deepEqual(i, { soc: 'ssc338q', sensor: 'imx415', flash: 'nor', host: 'openipc-ssc338q', ver: '2.6.10.21' });
  assert.equal(parseInfo('nothing here'), null);
  assert.equal(parseInfo('OPENIPC-INFO soc=$(evil);host=x').soc, undefined);
  assert.equal(parseInfo('OPENIPC-INFO flash=nand0').flash, 'nand');
});

test('info command prints a parseable line', async () => {
  const { execFileSync } = await import('node:child_process');
  const out = execFileSync('sh', ['-c', INFO_COMMAND], { encoding: 'utf8' });
  assert.ok(parseInfo(out));
});

import { flashPercent } from '../helper-client.js';

test('flash progress lines', () => {
  assert.equal(flashPercent('Writing kb: 4096/8192 (50%)'), 50);
  assert.equal(flashPercent('\x1B[1mErasing block: 3/64 (4%)\x1B[0m'), 4);
  assert.equal(flashPercent('Update rootfs from /tmp/fw/rootfs'), null);
});

import { flashFromFilename } from '../commands.js';

test('filter by device flash type', () => {
  assert.equal(flashFromFilename('ssc338q_fpv_openipc-thinker-aio-nor.tgz'), 'nor');
  assert.equal(flashFromFilename('openipc.ssc338q-nand-fpv.tgz'), 'nand');
  assert.equal(flashFromFilename('ssc338q_rubyfpv.tgz'), '');
  const a = ['ssc338q_fpv_a-b-nor.tgz', 'ssc338q_fpv_a-b-nand.tgz', 'ssc338q_rubyfpv.tgz', 'ssc30kq_fpv_a-b-nor.tgz'].map(name => ({ name }));
  assert.deepEqual(filterAssets(a, { soc: 'ssc338q', flash: 'nor' }).map(x => x.name), ['ssc338q_fpv_a-b-nor.tgz', 'ssc338q_rubyfpv.tgz']);
});

import { parseEnv, groupEnv, parseMtdparts } from '../commands.js';

test('fw_printenv parsing and grouping', () => {
  const env = parseEnv('soc=ssc338q\nbootargs=console=ttyS0,115200 mem=64M\nipaddr=192.168.1.10\nzzz=1\naaa=2\n## Error\n\n');
  assert.deepEqual(env.map(e => e.key), ['soc', 'bootargs', 'ipaddr', 'zzz', 'aaa']);
  assert.equal(env[1].value, 'console=ttyS0,115200 mem=64M');
  assert.deepEqual(groupEnv(env).map(g => [g.name, g.items.map(i => i.key)]),
    [['Hardware', ['soc']], ['Network', ['ipaddr']], ['Boot', ['bootargs']], ['Other', ['aaa', 'zzz']]]);
});

test('mtdparts', () => {
  assert.deepEqual(parseMtdparts('mtdparts=NOR_FLASH:256k(boot),64k(env),2048k(kernel),5120k(rootfs),-(rootfs_data)'), {
    device: 'NOR_FLASH',
    parts: [{ size: '256 KB', name: 'boot' }, { size: '64 KB', name: 'env' }, { size: '2048 KB', name: 'kernel' }, { size: '5120 KB', name: 'rootfs' }, { size: 'rest', name: 'rootfs_data' }],
  });
  assert.equal(parseMtdparts('garbage'), null);
});

import { excludedSensors, deviceForAsset, supportsSensor } from '../commands.js';

test('sensor exclusions from builder lists', () => {
  const list = '/etc/sensors/imx307.bin\n#\n/lib/modules/4.9.84/kernel/fs/nfs/nfs.ko\n/lib/modules/4.9.84/sigmastar/sensor_imx347_mipi.ko\n/usr/lib/sensors/libsns_ar0237.so\n/etc/sensors/ov2735_mipi_1080p.ini\n';
  assert.deepEqual(excludedSensors(list), ['ar0237', 'imx307', 'imx347', 'ov2735']);
  const index = { excluded: { 'ssc338q_apfpv_greg-generic-bu-eu': ['imx347'], 'ssc338q_apfpv_greg-generic-bu': ['x'] } };
  assert.equal(deviceForAsset('ssc338q_apfpv_greg-generic-bu-eu-nor.tgz', Object.keys(index.excluded)), 'ssc338q_apfpv_greg-generic-bu-eu');
  assert.equal(supportsSensor('ssc338q_apfpv_greg-generic-bu-eu.tgz', 'imx347', index), false);
  assert.equal(supportsSensor('ssc338q_apfpv_greg-generic-bu-eu.tgz', 'imx415', index), true);
  assert.equal(supportsSensor('openipc.ssc338q-nor-fpv.tgz', 'imx347', index), true);
  assert.equal(filterAssets([{ name: 'ssc338q_apfpv_greg-generic-bu-eu.tgz' }, { name: 'openipc.ssc338q-nor-fpv.tgz' }], { soc: 'ssc338q', sensor: 'imx347', sensorIndex: index }).length, 1);
});

import { infoFromEnv } from '../commands.js';

test('device info falls back to full env', () => {
  const env = parseEnv('soc=SSC338Q\nsensor=imx415_mipi\nbootargs=console=ttyS0 mtdparts=NOR_FLASH:256k(boot),-(rest)\n');
  assert.deepEqual(infoFromEnv({ soc: '', host: 'cam' }, env), { soc: 'ssc338q', sensor: 'imx415', flash: 'nor', host: 'cam' });
  assert.equal(parseInfo('OPENIPC-INFO soc=SSC338Q;sensor=IMX415').soc, 'ssc338q');
});

test('mtdparts resolves ${var} sizes from the environment', () => {
  const value = 'mtdparts=NOR_FLASH:256k(boot),${rootmtd}(rootfs),-(rootfs_data)';
  assert.deepEqual(parseMtdparts(value, { rootmtd: '8192k' }).parts, [
    { size: '256 KB', name: 'boot' }, { size: '8192 KB', name: 'rootfs' }, { size: 'rest', name: 'rootfs_data' },
  ]);
});

test('mtdparts keeps a partition whose size variable is unknown', () => {
  const parts = parseMtdparts('NOR_FLASH:${rootmtd}(rootfs),-(rootfs_data)').parts;
  assert.deepEqual(parts[0], { size: '?', name: 'rootfs' });
});

import { FlashTracker, flashOutcome } from '../helper-client.js';

const FLASH_LOG = {
  kernel: 'Update kernel from /tmp/uImage.ssc338q\nErasing block: 32/32 (100%)\rWriting kb: 1990/1990 (100%)\rVerifying kb: 1990/1990 (100%)\n',
  rootfsMid: 'Update rootfs from /tmp/rootfs.squashfs.ssc338q\nErasing block: 16/32 (50%)',
  rootfsEnd: '\rErasing block: 32/32 (100%)\rWriting kb: 7896/7896 (100%)\rVerifying kb: 7896/7896 (100%)\n',
};

test('flash progress never moves backwards across kernel and rootfs steps', () => {
  const t = new FlashTracker();
  const seen = [];
  for (const line of ['Update kernel from /tmp/k\n', 'Erasing block: 32/32 (100%)\r', 'Writing kb: 1/1990 (0%)\r', 'Writing kb: 1990/1990 (100%)\r', 'Verifying kb: 1/1990 (0%)\r', 'Verifying kb: 1990/1990 (100%)\n', 'Update rootfs from /tmp/r\n', 'Erasing block: 1/32 (3%)\r', 'Writing kb: 1/7896 (0%)\r', 'Verifying kb: 7896/7896 (100%)\n']) {
    t.feed(line);
    seen.push(t.percent);
  }
  assert.deepEqual(seen, [...seen].sort((a, b) => a - b));
  assert.equal(seen.at(-1), 100);
  assert.ok(seen[5] < 50, 'the kernel is the smaller part of the job');
});

test('flash tracker handles lines split across chunks', () => {
  const t = new FlashTracker();
  t.feed('Update rootfs from /tmp/r\nVerifying kb: 7896/78');
  t.feed('96 (100%)\n');
  assert.equal(t.complete, true);
});

test('flash tracker only reports complete after the rootfs is verified or reboot is announced', () => {
  const t = new FlashTracker();
  t.feed(FLASH_LOG.kernel);
  assert.equal(t.started, true);
  assert.equal(t.complete, false);
  const r = new FlashTracker();
  r.feed('OverlayFS\nUnconditional reboot\n');
  assert.equal(r.complete, true);
});

const tracked = text => { const t = new FlashTracker(); t.feed(text); return t; };

test('dropped connection after a verified rootfs counts as finished', () => {
  const o = flashOutcome({ disconnected: true, code: -1 }, tracked(FLASH_LOG.kernel + FLASH_LOG.rootfsMid + FLASH_LOG.rootfsEnd));
  assert.equal(o.kind, 'rebooting');
  assert.equal(o.percent, 100);
});

test('dropped connection in the middle of a write is not reported as success', () => {
  const o = flashOutcome({ disconnected: true, code: -1 }, tracked(FLASH_LOG.kernel + FLASH_LOG.rootfsMid));
  assert.equal(o.kind, 'interrupted');
  assert.doesNotMatch(o.message, /finished/i);
  assert.equal(o.percent, undefined);
});

test('dropped connection before sysupgrade started says nothing was written', () => {
  const o = flashOutcome({ disconnected: true, code: -1 }, tracked('uImage.ssc338q: OK\n'));
  assert.equal(o.kind, 'not-started');
  assert.doesNotMatch(o.message, /Nothing was written/, 'a missing marker may just mean the output was lost');
  assert.match(o.message, /keep the camera powered/i);
});

test('non-zero exit before sysupgrade is reported as stopped before flashing', () => {
  const o = flashOutcome({ disconnected: false, code: 1 }, tracked('STOP: camera SoC is hi3516, firmware is for ssc338q\n'));
  assert.equal(o.kind, 'not-started');
  assert.match(o.message, /Stopped before flashing \(exit code 1\)/);
});

test('non-zero exit after writing began is not reported as stopped before flashing', () => {
  const o = flashOutcome({ disconnected: false, code: 1 }, tracked(FLASH_LOG.kernel));
  assert.equal(o.kind, 'failed');
  assert.doesNotMatch(o.message, /before flashing/);
  assert.match(o.message, /exit code 1/);
});

test('exit code zero after the reboot line is done', () => {
  const o = flashOutcome({ disconnected: false, code: 0 }, tracked(FLASH_LOG.kernel + 'Unconditional reboot\n'));
  assert.equal(o.kind, 'rebooting');
  assert.equal(o.percent, 100);
});

test('exit code zero without the end of the flash is not success', () => {
  // The helper can report 0 when no exit status arrived, for example if the process was killed.
  const o = flashOutcome({ disconnected: false, code: 0 }, tracked(FLASH_LOG.kernel + FLASH_LOG.rootfsMid));
  assert.equal(o.kind, 'interrupted');
  assert.equal(o.percent, undefined);
});

// Wording from the camera's /usr/sbin/sysupgrade (2.6.11.02), which moves flashing into RAM.
const HANDOFF = 'Protected: flashing continues even if this terminal disconnects.\nMoving the flash phase into RAM\nHanding PID 1 over to the RAM root.\nSSH, the WebUI and every other login end here; the flash carries on without them.\n';

test('flash command announces sysupgrade right before running it', () => {
  assert.match(flashCommand({ soc: 'ssc338q', filename: 'f.tgz' }), /echo OPENIPC-FLASH-START && sysupgrade /);
});

test('dropped connection after the start marker never claims nothing was written', () => {
  const o = flashOutcome({ disconnected: true, code: -1 }, tracked('OPENIPC-FLASH-START\nOpenIPC System Updater\n'));
  assert.equal(o.kind, 'interrupted');
  assert.doesNotMatch(o.message, /Nothing was written/);
});

test('the word sysupgrade alone does not mean flashing started', () => {
  assert.equal(tracked('tar: /tmp/sysupgrade-x.tgz: unexpected end of file\n').started, false);
});

test('handing off to RAM is reported as still flashing, not finished', () => {
  const o = flashOutcome({ disconnected: true, code: -1 }, tracked('OPENIPC-FLASH-START\n' + HANDOFF));
  assert.equal(o.kind, 'handed-off');
  assert.match(o.message, /keep the camera powered/i);
  assert.doesNotMatch(o.message, /finished|Nothing was written/i);
  assert.equal(o.percent, undefined);
});

test('handing off to RAM is still flashing even if the session closes cleanly', () => {
  assert.equal(flashOutcome({ disconnected: false, code: 0 }, tracked('OPENIPC-FLASH-START\n' + HANDOFF)).kind, 'handed-off');
});

test('sysupgrade refusing to write is reported as nothing written', () => {
  const o = flashOutcome({ disconnected: false, code: 1 }, tracked('OPENIPC-FLASH-START\nThe new rootfs does not fit. Nothing was written.\n'));
  assert.equal(o.kind, 'not-started');
  assert.match(o.message, /without writing/);
  assert.match(o.message, /exit code 1/);
});

test('a failed handoff that reboots without flashing is reported as nothing written', () => {
  const o = flashOutcome({ disconnected: true, code: -1 }, tracked('OPENIPC-FLASH-START\n' + HANDOFF + 'PID 1 did not hand over; rebooting (nothing was flashed)\n'));
  assert.equal(o.kind, 'not-started');
  assert.match(o.message, /without writing/);
});

// Runs INFO_COMMAND with stand-ins for the camera's tools.
async function infoWith(tools) {
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { execFileSync } = await import('node:child_process');
  const dir = mkdtempSync(join(tmpdir(), 'info-'));
  for (const [name, body] of Object.entries(tools)) writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return parseInfo(execFileSync('/bin/sh', ['-c', INFO_COMMAND], { env: { PATH: `${dir}:/usr/bin:/bin` }, stdio: ['ignore', 'pipe', 'ignore'] }).toString());
}

const LSMOD = `cat <<'L'
sensor_imx415_star6e    14192  0
mi_sensor              21952  0
mhal                 1629881  8 sensor_imx415_star6e,mi_venc
L`;

test('info falls back to the loaded sensor driver when the environment has no sensor', async () => {
  const i = await infoWith({ fw_printenv: '[ "$1" = soc ] && echo soc=ssc338q || exit 1', lsmod: LSMOD });
  assert.equal(i.sensor, 'imx415');
});

test('info prefers the sensor set in the environment over the loaded driver', async () => {
  const i = await infoWith({ fw_printenv: 'echo "$1=imx335"', lsmod: LSMOD });
  assert.equal(i.sensor, 'imx335');
});

test('info leaves the sensor empty when neither source has one', async () => {
  const i = await infoWith({ fw_printenv: 'exit 1', lsmod: 'echo "mi_sensor 21952 0"' });
  assert.ok(!i.sensor);
});

test('a refusal after writing began is not reported as nothing written', () => {
  const o = flashOutcome({ disconnected: false, code: 1 }, tracked(FLASH_LOG.kernel + 'Update rootfs from /tmp/r\nImage too big. Nothing was written.\n'));
  assert.equal(o.kind, 'failed');
  assert.doesNotMatch(o.message, /without writing/);
});

test('a handoff that exits with an error over a live session is a failure', () => {
  const o = flashOutcome({ disconnected: false, code: 1 }, tracked('OPENIPC-FLASH-START\n' + HANDOFF));
  assert.equal(o.kind, 'failed');
  assert.match(o.message, /exit code 1/);
});

test('a non-zero exit after the flash reached the end still counts as finished', () => {
  const o = flashOutcome({ disconnected: false, code: 137 }, tracked(FLASH_LOG.kernel + FLASH_LOG.rootfsMid + FLASH_LOG.rootfsEnd + 'Unconditional reboot\n'));
  assert.equal(o.kind, 'rebooting');
});

test('mtdparts keeps a partition whose variable holds an unusual size', () => {
  assert.deepEqual(parseMtdparts('NOR:${a}(x),${b}(y),${constructor}(z)', { a: '0x800000', b: '' }).parts, [
    { size: '?', name: 'x' }, { size: '?', name: 'y' }, { size: '?', name: 'z' },
  ]);
});

test('flash command stops before the checksum step when the archive has no kernel or rootfs', () => {
  const c = flashCommand({ soc: 'ssc338q', filename: 'f.tgz' });
  assert.ok(c.indexOf('STOP: no uImage') > 0 && c.indexOf('STOP: no uImage') < c.indexOf('md5sum -c'));
});

import { TerminalLog } from '../helper-client.js';

const shown = (...chunks) => { const l = new TerminalLog(); chunks.forEach(c => l.feed(c)); return l.text; };

test('log: a carriage return makes the next text replace the line', () => {
  assert.equal(shown('Writing kb: 1/2 (50%)\rWriting kb: 2/2 (100%)\nDone\n'), 'Writing kb: 2/2 (100%)\nDone\n');
});

test('log: text printed after a progress line stays on that line', () => {
  assert.equal(shown('\rErasing @ 1 - 0% complete. Cleanmarker at 1.\rErasing @ 2 - 50% complete. Cleanmarker at 2.\nUnconditional reboot\n'),
    'Erasing @ 2 - 50% complete. Cleanmarker at 2.\nUnconditional reboot\n');
});

test('log: a progress line is kept when the next output starts a new line', () => {
  assert.equal(shown('Verifying kb: 9/9 (100%)\r\nKernel updated\n'), 'Verifying kb: 9/9 (100%)\nKernel updated\n');
});

test('log: a carriage return at the end of a chunk still applies', () => {
  assert.equal(shown('Writing kb: 1/2 (50%)\r', 'Writing kb: 2/2 (100%)'), 'Writing kb: 2/2 (100%)');
});

test('log: colour codes are removed, even when split across chunks', () => {
  assert.equal(shown('\x1B[1;33mOverlay', 'FS\x1B[', '0m\n'), 'OverlayFS\n');
});

test('log: a pending carriage return does not hide the line before more output', () => {
  assert.equal(shown('Writing kb: 1/2 (50%)\r'), 'Writing kb: 1/2 (50%)');
});
