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
