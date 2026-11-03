// Builds sensors.json from an OpenIPC/builder checkout: for each device, the image sensors it
// leaves out. Builder device images ship a common set of sensor drivers minus an exclude list
// (devices/<device>/general/scripts/excludes/*.list), so an excluded sensor means "this image
// can't drive that sensor". Usage: node scripts/build-sensor-index.mjs <builder dir> <out file>
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { excludedSensors } from '../commands.js';

const [builder, out] = process.argv.slice(2);
if (!builder || !out) { console.error('usage: build-sensor-index.mjs <builder dir> <out file>'); process.exit(2); }

const devices = {};
for (const name of readdirSync(join(builder, 'devices')).sort()) {
  const dir = join(builder, 'devices', name, 'general', 'scripts', 'excludes');
  if (!existsSync(dir)) continue;
  const text = readdirSync(dir).filter(f => f.endsWith('.list')).map(f => readFileSync(join(dir, f), 'utf8')).join('\n');
  const excluded = excludedSensors(text);
  if (excluded.length) devices[name] = excluded;
}
writeFileSync(out, JSON.stringify({ source: 'OpenIPC/builder', generated: new Date().toISOString(), excluded: devices }, null, 1));
console.log(`${Object.keys(devices).length} devices with sensor exclusions -> ${out}`);
