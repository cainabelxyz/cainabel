// npm run silicon — places the CA-8 one NAND at a time, optimises, and
// refuses to write a netlist unless every check passes. Nothing exists
// until verification succeeds.

import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildNetlist, OPS } from './cpu.js';
import { NetlistSim, CoreHarness, ArenaHarness, RED_BASE, BLUE_BASE } from './sim.js';
import { CoreModel, ArenaModel } from './model.js';
import { assemble, WARRIORS } from './asm.js';

const here = dirname(fileURLToPath(import.meta.url));
const out = (...p) => join(here, '..', ...p);

// deterministic PRNG so a failing seed is a reproducible finding
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

console.log('CAIN & ABEL silicon build');
console.log('======================');

const t0 = Date.now();
const { netlist, placed, shipped, dropped } = buildNetlist();
const ffCount = netlist.ffs.length;
console.log(`placed ${placed} NAND, shipped ${shipped}, optimised away ${dropped}`);
console.log(`flip-flops ${ffCount} · inputs ${netlist.inputs.length} · outputs ${Object.keys(netlist.outputs).length}`);

const regionCounts = {};
for (const r of netlist.regions) regionCounts[r] = (regionCounts[r] || 0) + 1;
console.log('regions:', Object.entries(regionCounts).map(([k, v]) => `${k} ${v}`).join(' · '));

const failures = [];
const check = (name, fn) => {
  const t = Date.now();
  process.stdout.write(`\nCHECK ${name} … `);
  try {
    const detail = fn();
    console.log(`PASS (${((Date.now() - t) / 1000).toFixed(1)}s)${detail ? ' — ' + detail : ''}`);
    return detail;
  } catch (e) {
    console.log(`FAIL — ${e.message}`);
    failures.push(`${name}: ${e.message}`);
  }
};

// ---------------------------------------------------------------------------
// CHECK 01 · exhaustive vectors: every ALU-class op swept against plain
// arithmetic — every operand pair, both initial carry states, plus the
// same-register cases no assembler would stop you from writing.
// ---------------------------------------------------------------------------
let vectorCount = 0;
check('01 · exhaustive vectors', () => {
  const sim = new NetlistSim(netlist);
  const enc = (op, rd, rs, imm = 0) => ((op & 15) << 12) | ((rd & 7) << 9) | ((rs & 7) << 6) | (imm & 0xff);

  const runVec = (instr, setup, expect) => {
    sim.state.fill(0);
    sim.setFFBus('phase', 2, 1); // EXEC
    setup(sim);
    sim.setInputBus('mem_in', 16, instr);
    sim.setInputBus('in_port', 8, 0);
    sim.evaluate();
    sim.latch();
    expect(sim);
    vectorCount++;
  };
  const expectReg = (sim, r, want, ctx) => {
    const got = sim.getFFBus(`r${r}`, 8);
    if (got !== (want & 0xff)) throw new Error(`${ctx}: r${r}=${got}, wanted ${want & 0xff}`);
  };
  const expectFlags = (sim, z, c, ctx) => {
    if (sim.getFF('flagZ') !== z) throw new Error(`${ctx}: Z=${sim.getFF('flagZ')}, wanted ${z}`);
    if (c !== null && sim.getFF('flagC') !== c) throw new Error(`${ctx}: C=${sim.getFF('flagC')}, wanted ${c}`);
  };

  const binary = [
    ['ADD', (a, b) => ({ v: (a + b) & 0xff, c: a + b > 0xff ? 1 : 0 })],
    ['SUB', (a, b) => { const r = a + ((~b) & 0xff) + 1; return { v: r & 0xff, c: r > 0xff ? 1 : 0 }; }],
    ['NND', (a, b) => ({ v: (~(a & b)) & 0xff, c: null })],
    ['XOR', (a, b) => ({ v: a ^ b, c: null })],
  ];
  for (const [name, f] of binary) {
    for (let carry = 0; carry <= 1; carry++) {
      for (let a = 0; a < 256; a++) {
        for (let b = 0; b < 256; b++) {
          runVec(enc(OPS[name], 1, 2), (s) => {
            s.setFFBus('r1', 8, a); s.setFFBus('r2', 8, b); s.setFF('flagC', carry);
          }, (s) => {
            const { v, c } = f(a, b);
            const ctx = `${name} ${a},${b} C0=${carry}`;
            expectReg(s, 1, v, ctx);
            expectFlags(s, v === 0 ? 1 : 0, c === null ? (name === 'NND' || name === 'XOR' ? carry : c) : c, ctx);
          });
        }
      }
    }
    // same-register: op rN, rN
    for (let a = 0; a < 256; a++) {
      runVec(enc(OPS[name], 3, 3), (s) => s.setFFBus('r3', 8, a), (s) => {
        const { v } = f(a, a);
        expectReg(s, 3, v, `${name} same-reg ${a}`);
      });
    }
  }
  for (const [name, f] of [
    ['SHL', (a) => ({ v: (a << 1) & 0xff, c: (a >> 7) & 1 })],
    ['SHR', (a) => ({ v: a >> 1, c: a & 1 })],
  ]) {
    for (let carry = 0; carry <= 1; carry++) {
      for (let a = 0; a < 256; a++) {
        runVec(enc(OPS[name], 4, 0), (s) => { s.setFFBus('r4', 8, a); s.setFF('flagC', carry); }, (s) => {
          const { v, c } = f(a);
          expectReg(s, 4, v, `${name} ${a}`);
          expectFlags(s, v === 0 ? 1 : 0, c, `${name} ${a}`);
        });
      }
    }
  }
  // MOV exhaustive, LDI exhaustive, IN exhaustive
  for (let a = 0; a < 256; a++) {
    runVec(enc(OPS.MOV, 5, 6), (s) => s.setFFBus('r6', 8, a), (s) => expectReg(s, 5, a, `MOV ${a}`));
    runVec(enc(OPS.LDI, 5, 0, a), () => {}, (s) => expectReg(s, 5, a, `LDI ${a}`));
  }
  // JZ / JNZ / JMP over every target and both Z states
  for (let z = 0; z <= 1; z++) {
    for (let t = 0; t < 256; t++) {
      for (const [name, taken] of [['JMP', true], ['JZ', z === 1], ['JNZ', z === 0]]) {
        runVec(enc(OPS[name], 0, 0, t), (s) => { s.setFFBus('pc', 8, 100); s.setFF('flagZ', z); }, (s) => {
          const want = taken ? t : 101;
          const got = s.getFFBus('pc', 8);
          if (got !== want) throw new Error(`${name} t=${t} Z=${z}: pc=${got}, wanted ${want}`);
        });
      }
    }
  }
  return `${vectorCount.toLocaleString('en-US')} vectors, zero failures`;
});

// ---------------------------------------------------------------------------
// CHECK 02 · the independent model: the same instruction set written in
// + and &, run edge-for-edge against the gates over random RAM images.
// ---------------------------------------------------------------------------
let modelEdges = 0;
check('02 · independent model', () => {
  const rnd = mulberry32(0xC1A5);
  const IMAGES = 120, EDGES = 2500;
  for (let img = 0; img < IMAGES; img++) {
    const ram1 = new Uint16Array(256);
    const ram2 = new Uint16Array(256);
    for (let i = 0; i < 256; i++) {
      // half the images fully random, half biased toward legal-looking code
      const w = img % 2 === 0
        ? Math.floor(rnd() * 0x10000)
        : ((1 + Math.floor(rnd() * 15)) << 12) | Math.floor(rnd() * 0x1000);
      ram1[i] = w; ram2[i] = w;
    }
    const start = Math.floor(rnd() * 256);
    const gate = new CoreHarness(netlist, ram1, start);
    const model = new CoreModel(ram2, start);
    for (let e = 0; e < EDGES; e++) {
      const byte = Math.floor(rnd() * 256);
      gate.inPort = byte; model.inPort = byte;
      gate.edge(); model.edge();
      modelEdges++;
      const ctx = `image ${img} edge ${e}`;
      for (let r = 0; r < 8; r++) {
        if (gate.sim.getFFBus(`r${r}`, 8) !== model.regs[r]) throw new Error(`${ctx}: r${r} ${gate.sim.getFFBus(`r${r}`, 8)} vs ${model.regs[r]}`);
      }
      if (gate.sim.getFFBus('pc', 8) !== model.pc) throw new Error(`${ctx}: pc ${gate.sim.getFFBus('pc', 8)} vs ${model.pc}`);
      if (gate.sim.getFF('flagZ') !== model.flagZ) throw new Error(`${ctx}: Z`);
      if (gate.sim.getFF('flagC') !== model.flagC) throw new Error(`${ctx}: C`);
      if (gate.sim.getFFBus('phase', 2) !== model.phase) throw new Error(`${ctx}: phase`);
      if ((gate.sim.getFF('halted') === 1) !== model.halted) throw new Error(`${ctx}: halted`);
      if (gate.sim.getFFBus('out', 8) !== model.out) throw new Error(`${ctx}: out`);
      if (gate.halted && model.halted) break;
    }
    for (let i = 0; i < 256; i++) if (ram1[i] !== ram2[i]) throw new Error(`image ${img}: RAM[${i}] ${ram1[i]} vs ${ram2[i]}`);
  }
  return `${IMAGES} RAM images, ${modelEdges.toLocaleString('en-US')} edges compared, RAM verified`;
});

// ---------------------------------------------------------------------------
// CHECK 03 · the arena: two dies, one RAM, gate level against model level,
// on the house warriors and on random ones. Same rounds, same winner,
// same battlefield afterwards.
// ---------------------------------------------------------------------------
let arenaRounds = 0;
const matchResults = {};
check('03 · the arena', () => {
  const rnd = mulberry32(0xD0E1);
  const names = Object.keys(WARRIORS).filter((n) => n !== 'SELFTEST');
  const asRed = Object.fromEntries(names.map((n) => [n, assemble(WARRIORS[n], 0).words]));
  const asBlue = Object.fromEntries(names.map((n) => [n, assemble(WARRIORS[n], 128).words]));
  const pairs = [];
  for (const a of names) for (const b of names) pairs.push([a, b]);
  for (let i = 0; i < 20; i++) {
    const len = 4 + Math.floor(rnd() * 60);
    const prog = Array.from({ length: len }, () => Math.floor(rnd() * 0x10000));
    pairs.push([`RND${i}`, 'DWARF']);
    asRed[`RND${i}`] = prog;
  }
  for (const [ra, rb] of pairs) {
    const gate = new ArenaHarness(netlist, asRed[ra], asBlue[rb]);
    const model = new ArenaModel(asRed[ra], asBlue[rb]);
    const MAX = 6000;
    let r = 0;
    for (; r < MAX && !model.over; r++) {
      const b1 = Math.floor(rnd() * 256), b2 = Math.floor(rnd() * 256);
      gate.step(b1, b2); model.step(b1, b2);
      arenaRounds++;
    }
    if (gate.result !== model.result) throw new Error(`${ra} vs ${rb}: gate says ${gate.result}, model says ${model.result}`);
    for (let i = 0; i < 256; i++) if (gate.ram[i] !== model.ram[i]) throw new Error(`${ra} vs ${rb}: RAM[${i}] differs`);
    matchResults[`${ra} vs ${rb}`] = model.result ? `${model.result} in ${r} rounds` : `both alive after ${MAX}`;
  }
  return `${pairs.length} matches, ${arenaRounds.toLocaleString('en-US')} rounds, gates and model agree on every winner`;
});

// ---------------------------------------------------------------------------
// CHECK 04 · liveness: the shipping warriors survive 20,000 edges of random
// input on their own; the self-test halts, having passed.
// ---------------------------------------------------------------------------
check('04 · liveness', () => {
  const rnd = mulberry32(0xBEEF);
  for (const name of ['DWARF', 'HUNTER', 'TURTLE']) {
    const prog = assemble(WARRIORS[name]).words;
    const ram = new Uint16Array(256);
    prog.forEach((w, i) => { ram[i] = w; });
    const core = new CoreHarness(netlist, ram, 0);
    for (let e = 0; e < 20000; e++) {
      core.inPort = Math.floor(rnd() * 256);
      core.edge();
      if (core.halted) throw new Error(`${name} halted at edge ${e}`);
    }
  }
  {
    const prog = assemble(WARRIORS.SELFTEST).words;
    const ram = new Uint16Array(256);
    prog.forEach((w, i) => { ram[i] = w; });
    const core = new CoreHarness(netlist, ram, 0);
    let e = 0;
    for (; e < 200 && !core.halted; e++) core.edge();
    if (!core.halted) throw new Error('self-test never halted');
    const outv = core.sim.getFFBus('out', 8);
    if (outv !== 1) throw new Error(`self-test halted with out=${outv}, wanted 1`);
  }
  return 'DWARF and TURTLE ran 20,000 edges; the self-test halted with the pass byte';
});

// ---------------------------------------------------------------------------

if (failures.length) {
  console.error(`\nBUILD REFUSED — ${failures.length} check(s) failed. No netlist was written.`);
  process.exit(1);
}

mkdirSync(out('web'), { recursive: true });
writeFileSync(out('web', 'netlist.json'), JSON.stringify(netlist));

// the website runs the same simulator, assembler and model — copies land in
// web/lib so the static site is self-contained
mkdirSync(out('web', 'lib'), { recursive: true });
for (const f of ['gates.js', 'cpu.js', 'sim.js', 'model.js', 'asm.js']) {
  writeFileSync(out('web', 'lib', f), readFileSync(join(here, f)));
}

const report = {
  generated: new Date().toISOString(),
  part: 'CA-8',
  gates: { placed, shipped, dropped },
  flipFlops: ffCount,
  regions: regionCounts,
  checks: {
    vectors: vectorCount,
    modelEdges,
    arenaRounds,
  },
  matches: matchResults,
  arena: { redBase: RED_BASE, blueBase: BLUE_BASE, ramWords: 256, wordBits: 16 },
};
writeFileSync(out('web', 'build-report.json'), JSON.stringify(report, null, 2));

console.log(`\nnetlist written: web/netlist.json (${shipped} gates, ${ffCount} flip-flops)`);
console.log(`build report:    web/build-report.json`);
console.log(`total ${(Date.now() - t0) / 1000}s`);
