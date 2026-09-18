// Launch-minute helper: fills the $CABEL contract address everywhere at once.
//   node scripts/set-ca.mjs 0xYourTokenAddress
// Writes web/config.js (CA + addresses.token) and, when the local content
// folder exists, KONTEN-ARC/T0-CA-SIAP-POST.txt from the T-0 template.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const ca = (process.argv[2] || '').trim();

if (!/^0x[0-9a-fA-F]{40}$/.test(ca)) {
  console.error('Usage: node scripts/set-ca.mjs 0x<40 hex chars>  — nothing was changed.');
  process.exit(1);
}

const cfgPath = join(root, 'web', 'config.js');
let cfg = readFileSync(cfgPath, 'utf8');
cfg = cfg.replace(/CA: '[^']*'/, `CA: '${ca}'`).replace(/token: '[^']*'/, `token: '${ca}'`);
writeFileSync(cfgPath, cfg);
console.log(`✓ web/config.js → CA ${ca}`);

const tpl = join(root, 'KONTEN-ARC', 'T0-CA-TEMPLATE.txt');
if (existsSync(tpl)) {
  const out = join(root, 'KONTEN-ARC', 'T0-CA-SIAP-POST.txt');
  writeFileSync(out, readFileSync(tpl, 'utf8').replaceAll('<<CA>>', ca));
  console.log('✓ KONTEN-ARC/T0-CA-SIAP-POST.txt — every post filled, ready to copy');
}

console.log('\nNext: upload web/config.js to Hostinger (overwrite). No purge needed.');
