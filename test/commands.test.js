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
  assert.match(c, /fw_printenv -n soc/);
  assert.match(c, /"\$S" = "ssc338q"/);
  assert.match(c, /md5sum -c \*\.md5sum/);
  assert.match(c, /sysupgrade --force_ver -n -z --kernel=\/tmp\/fw\/\$K --rootfs=\/tmp\/fw\/\$R/);
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
