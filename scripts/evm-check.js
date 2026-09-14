// CHECK 05 · the contract itself. The four silicon checks prove the netlist.
// This one proves the assembly that walks it: the compiled contracts go into
// a real EVM, a match runs through them round by round, and after every
// transaction the packed state and all sixteen battlefield slots are
// compared against the independent model. Gas is measured, not estimated.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { createVM } from '@ethereumjs/vm';
import { Address, hexToBytes, bytesToHex } from '@ethereumjs/util';
import { keccak256 } from 'ethereum-cryptography/keccak.js';
import { assemble, WARRIORS } from '../silicon/asm.js';
import { ArenaModel } from '../silicon/model.js';
import { buildBlob, dataContractCreationCode } from './blob.js';

const require = createRequire(import.meta.url);
const solc = require('solc');

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const netlist = JSON.parse(readFileSync(join(root, 'web', 'netlist.json'), 'utf8'));

// ---------------------------------------------------------------------------
// tiny ABI helpers — the contracts are ours, the encoding is simple
// ---------------------------------------------------------------------------

const sel = (sig) => Buffer.from(keccak256(Buffer.from(sig)).slice(0, 4));
const word = (v) => {
  const b = Buffer.alloc(32);
  let x = BigInt(v);
  for (let i = 31; i >= 0; i--) { b[i] = Number(x & 0xffn); x >>= 8n; }
  return b;
};
const addrWord = (a) => word(BigInt('0x' + a.toString('hex')));

function encodeCreateMatch(red, blue) {
  const head = [word(0x40), word(0x40 + 32 + red.length * 32)];
  const tail1 = [word(red.length), ...red.map((w) => word(w))];
  const tail2 = [word(blue.length), ...blue.map((w) => word(w))];
  return Buffer.concat([sel('createMatch(uint16[],uint16[])'), ...head, ...tail1, ...tail2]);
}

// ---------------------------------------------------------------------------

console.log('CAIN & ABEL EVM check (check 05)');
console.log('=============================');

// compile
const sources = {};
for (const f of ['CainToken.sol', 'Field.sol']) {
  sources[f] = { content: readFileSync(join(root, 'contracts', f), 'utf8') };
}
const input = {
  language: 'Solidity',
  sources,
  settings: {
    optimizer: { enabled: true, runs: 500 },

    evmVersion: 'paris',
    outputSelection: { '*': { '*': ['evm.bytecode.object', 'evm.deployedBytecode.object', 'abi'] } },
  },
};
const compiled = JSON.parse(solc.compile(JSON.stringify(input)));
const errors = (compiled.errors || []).filter((e) => e.severity === 'error');
if (errors.length) {
  for (const e of errors) console.error(e.formattedMessage);
  process.exit(1);
}
for (const e of compiled.errors || []) if (e.severity === 'warning') console.log('warn:', e.formattedMessage.split('\n')[0]);
const tokenBin = compiled.contracts['CainToken.sol'].CainToken.evm.bytecode.object;
const fieldBin = compiled.contracts['Field.sol'].Field.evm.bytecode.object;
console.log(`compiled: CainToken ${tokenBin.length / 2} bytes, Field ${fieldBin.length / 2} bytes of creation code`);
const fieldRuntime = compiled.contracts['Field.sol'].Field.evm.deployedBytecode.object.length / 2;
console.log(`Field runtime: ${fieldRuntime} of the 24,576-byte ceiling`);

const vm = await createVM();
const deployer = new Address(hexToBytes('0x' + '11'.repeat(20)));
const sponsorRed = new Address(hexToBytes('0x' + '22'.repeat(20)));
const sponsorBlue = new Address(hexToBytes('0x' + '33'.repeat(20)));

const CALLDATA_GAS = (data) => {
  let g = 0;
  for (const b of data) g += b === 0 ? 4 : 16;
  return g;
};

async function call(caller, to, data, { deploy = false } = {}) {
  const res = await vm.evm.runCall({
    caller,
    origin: caller,
    to: deploy ? undefined : to,
    data: new Uint8Array(data),
    gasLimit: 1_000_000_000n,
  });
  if (res.execResult.exceptionError) {
    const ret = Buffer.from(res.execResult.returnValue || []).toString('hex');
    throw new Error(`revert: ${res.execResult.exceptionError.error} ${ret}`);
  }
  const gas = Number(res.execResult.executionGasUsed) + 21000 + CALLDATA_GAS(data);
  return { res, gas, created: res.createdAddress, ret: Buffer.from(res.execResult.returnValue || []) };
}

// deploy the silicon
const blob = buildBlob(netlist);
const dataDeploy = await call(deployer, null, dataContractCreationCode(blob), { deploy: true });
const netlistAddr = dataDeploy.created;
console.log(`\ngate table deployed: ${blob.length} bytes as code · ${dataDeploy.gas.toLocaleString('en-US')} gas`);

// deploy the token
const tokenDeploy = await call(deployer, null, Buffer.from(tokenBin, 'hex'), { deploy: true });
const tokenAddr = tokenDeploy.created;
console.log(`CainToken deployed · ${tokenDeploy.gas.toLocaleString('en-US')} gas`);

// deploy the field: emission 10 CAIN / round, pot 5 CAIN / round
const EMISSION = 10n * 10n ** 18n;
const POT = 5n * 10n ** 18n;
const fieldArgs = Buffer.concat([
  addrWord(Buffer.from(netlistAddr.bytes)), addrWord(Buffer.from(tokenAddr.bytes)), word(EMISSION), word(POT),
]);
const fieldDeploy = await call(deployer, null, Buffer.concat([Buffer.from(fieldBin, 'hex'), fieldArgs]), { deploy: true });
const fieldAddr = fieldDeploy.created;
console.log(`Field deployed · ${fieldDeploy.gas.toLocaleString('en-US')} gas`);

// fund the mining reserve: 400M CAIN
await call(deployer, tokenAddr, Buffer.concat([
  sel('transfer(address,uint256)'), addrWord(Buffer.from(fieldAddr.bytes)), word(400_000_000n * 10n ** 18n),
]));

// ---------------------------------------------------------------------------
// the match: DWARF (red) vs HUNTER (blue), gates in the EVM vs the model
// ---------------------------------------------------------------------------

const red = assemble(WARRIORS.DWARF, 0).words;
const blue = assemble(WARRIORS.HUNTER, 128).words;
const model = new ArenaModel(red, blue);

const created = await call(sponsorRed, fieldAddr, encodeCreateMatch(red, blue));
console.log(`\nmatch created: DWARF (red) vs HUNTER (blue) · ${created.gas.toLocaleString('en-US')} gas`);
const matchId = 1n;

function packCore(m) {
  let v = 0n;
  const put = (val, bits, at) => { v |= (BigInt(val) & ((1n << BigInt(bits)) - 1n)) << BigInt(at); };
  for (let r = 0; r < 8; r++) put(m.regs[r], 8, r * 8);
  put(m.pc, 8, 64);
  put(m.flagZ, 1, 72);
  put(m.flagC, 1, 73);
  put(m.phase, 2, 74);
  put(m.rdLatch, 3, 76);
  put(m.halted ? 1 : 0, 1, 79);
  put(m.out, 8, 80);
  return v;
}

async function readPacked() {
  const r = await call(deployer, fieldAddr, Buffer.concat([sel('packedState(uint256)'), word(matchId)]));
  return BigInt('0x' + r.ret.toString('hex'));
}
async function readRam() {
  const r = await call(deployer, fieldAddr, Buffer.concat([sel('ramOf(uint256)'), word(matchId)]));
  const out = new Uint16Array(256);
  for (let s = 0; s < 16; s++) {
    const slot = BigInt('0x' + r.ret.subarray(s * 32, s * 32 + 32).toString('hex'));
    for (let l = 0; l < 16; l++) out[s * 16 + l] = Number((slot >> BigInt(l * 16)) & 0xffffn);
  }
  return out;
}

// model mirrors the contract's byte latching
let lastRed = 0, lastBlue = 0;
const stepEnc = (side, byte, rounds) => Buffer.concat([
  sel('step(uint256,uint8,uint8,uint32)'), word(matchId), word(side), word(byte), word(rounds),
]);

if (process.env.PROFILE) {
  const tally = {};
  vm.evm.events.on('step', (data) => {
    const op = data.opcode.name;
    if (!tally[op]) tally[op] = { n: 0, gas: 0 };
    tally[op].n++;
    tally[op].gas += Number(data.opcode.fee) + Number(data.opcode.dynamicFee ?? 0n);
  });
  await call(sponsorRed, fieldAddr, stepEnc(0, 0x42, 1));
  const rows = Object.entries(tally).sort((a, b) => b[1].gas - a[1].gas);
  let tot = 0;
  for (const [, v] of rows) tot += v.gas;
  console.log(`\nopcode gas profile of one 1-round step (${tot.toLocaleString('en-US')} gas in execution):`);
  for (const [op, v] of rows.slice(0, 15)) {
    console.log(`  ${op.padEnd(12)} x${String(v.n).padStart(7)}  ${v.gas.toLocaleString('en-US').padStart(10)} gas`);
  }
  process.exit(0);
}

const batches = [
  { side: 0, byte: 0x42, rounds: 1, who: sponsorRed },
  { side: 1, byte: 0x99, rounds: 8, who: sponsorBlue },
  { side: 0, byte: 0x42, rounds: 32, who: sponsorRed },
  { side: 1, byte: 0x07, rounds: 64, who: sponsorBlue },
  { side: 0, byte: 0x42, rounds: 128, who: sponsorRed },
  { side: 0, byte: 0x42, rounds: 256, who: sponsorRed },
];
const gasRows = [];
let totalRounds = 0;
for (const b of batches) {
  const before = (await readPacked()) >> 248n;
  if (before !== 0n) break;
  const r = await call(b.who, fieldAddr, stepEnc(b.side, b.byte, b.rounds));
  // mirror in the model
  if (b.side === 0) lastRed = b.byte; else lastBlue = b.byte;
  let done = 0;
  for (let i = 0; i < b.rounds && !model.over; i++) { model.step(lastRed, lastBlue); done++; }
  totalRounds += done;
  gasRows.push({ rounds: done, gas: r.gas, perRound: Math.round(r.gas / done) });

  const packed = await readPacked();
  const wantRed = packCore(model.red), wantBlue = packCore(model.blue);
  const gotRed = packed & ((1n << 88n) - 1n);
  const gotBlue = (packed >> 88n) & ((1n << 88n) - 1n);
  if (gotRed !== wantRed) throw new Error(`round ${totalRounds}: RED state ${gotRed.toString(16)} vs model ${wantRed.toString(16)}`);
  if (gotBlue !== wantBlue) throw new Error(`round ${totalRounds}: BLUE state mismatch`);
  const round = Number((packed >> 224n) & 0xffffffn);
  if (round !== model.round) throw new Error(`round counter ${round} vs model ${model.round}`);
  const status = Number(packed >> 248n);
  const wantStatus = model.result === null ? 0 : { red: 1, blue: 2, draw: 3 }[model.result];
  if (status !== wantStatus) throw new Error(`status ${status} vs model ${wantStatus}`);
  const ram = await readRam();
  for (let i = 0; i < 256; i++) if (ram[i] !== model.ram[i]) throw new Error(`RAM[${i}] ${ram[i]} vs ${model.ram[i]}`);
  console.log(`  batch of ${String(done).padStart(3)} round(s): ${r.gas.toLocaleString('en-US').padStart(10)} gas · ${Math.round(r.gas / done).toLocaleString('en-US').padStart(8)} per round · state, RAM and verdict agree`);
  if (status !== 0) {
    console.log(`  verdict: ${['live', 'RED wins', 'BLUE wins', 'draw'][status]} at round ${round} — the EVM and the model agree`);
    break;
  }
}

// pot claim sanity
const winnerSide = model.result === 'red' ? sponsorRed : sponsorBlue;
const balBefore = await call(deployer, tokenAddr, Buffer.concat([sel('balanceOf(address)'), addrWord(Buffer.from(winnerSide.bytes))]));
const claim = await call(winnerSide, fieldAddr, Buffer.concat([sel('claimPot(uint256)'), word(matchId)]));
const balAfter = await call(deployer, tokenAddr, Buffer.concat([sel('balanceOf(address)'), addrWord(Buffer.from(winnerSide.bytes))]));
const won = (BigInt('0x' + balAfter.ret.toString('hex')) - BigInt('0x' + balBefore.ret.toString('hex'))) / 10n ** 18n;
console.log(`\npot claimed by the winning side: ${won} CAIN · ${claim.gas.toLocaleString('en-US')} gas`);

const gasReport = {
  generated: new Date().toISOString(),
  deploy: { gateTable: dataDeploy.gas, token: tokenDeploy.gas, field: fieldDeploy.gas, fieldRuntimeBytes: fieldRuntime },
  createMatch: created.gas,
  batches: gasRows,
  perRoundAtBatch64: gasRows.find((r) => r.rounds >= 64)?.perRound ?? null,
  note: 'measured in a real EVM against the compiled contracts, 21000 intrinsic and calldata included',
};
writeFileSync(join(root, 'web', 'gas-report.json'), JSON.stringify(gasReport, null, 2));
console.log('\ngas report written: web/gas-report.json');
console.log('CHECK 05 PASS — the EVM, the gates and the model agree, block for block');
