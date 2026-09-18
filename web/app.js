// CAIN & ABEL — the landing page engine. Everything drawn here runs on the
// same netlist the contract walks: web/lib/* are byte-for-byte copies of the
// silicon build's own modules, and netlist.json is the build's own output.

import { ArenaHarness } from './lib/sim.js';
import { assemble, WARRIORS, disassemble } from './lib/asm.js';

const CONFIG = window.CFG || {};

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------------------
// links + contract address bar
// ---------------------------------------------------------------------------

for (const [id, href] of [
  ['link-x', CONFIG.links.x], ['f-x', CONFIG.links.x],
  ['link-tg', CONFIG.links.telegram], ['f-tg', CONFIG.links.telegram],
  ['link-gh', CONFIG.links.github], ['f-gh', CONFIG.links.github],
]) { const el = $(id); if (el && href) el.href = href; }

// CA + buy link: no gating. If config failed to load, the HTML's own
// values stand — never blank anything back to a placeholder.
const CA = CONFIG.CA || CONFIG.addresses?.token || '';
if (CA) {
  document.querySelectorAll('.js-ca').forEach((el) => { el.textContent = CA; });
  const ex = $('ca-explorer');
  if (ex) { ex.hidden = false; ex.href = `${CONFIG.chain.explorer}/token/${CA}`; }
}
if (CONFIG.BUY && CA) {
  document.querySelectorAll('.js-buy').forEach((el) => { el.href = CONFIG.BUY + CA; });
}
if ($('ca-copy')) $('ca-copy').onclick = () => navigator.clipboard.writeText(CA || $('ca').textContent);
if (CA) {
  for (const [id, a] of [['sp-netlist', CONFIG.addresses?.netlist], ['sp-field', CONFIG.addresses?.field], ['sp-token', CA]]) {
    if (a && $(id)) $(id).textContent = a.slice(0, 6) + '…' + a.slice(-4);
  }
}

// ---------------------------------------------------------------------------
// countdown
// ---------------------------------------------------------------------------

const t0 = new Date(CONFIG.launchAtUTC).getTime();
function tickCountdown() {
  const el = $('countdown');
  const d = t0 - Date.now();
  if (d <= 0) { el.innerHTML = 'THE FIELD IS OPEN'; return; }
  const dd = Math.floor(d / 864e5), hh = Math.floor(d / 36e5) % 24,
    mm = Math.floor(d / 6e4) % 60, ss = Math.floor(d / 1e3) % 60;
  el.innerHTML = `${dd}<span>d</span> ${String(hh).padStart(2, '0')}<span>h</span> ${String(mm).padStart(2, '0')}<span>m</span> ${String(ss).padStart(2, '0')}<span>s</span>`;
}
tickCountdown();
setInterval(tickCountdown, 1000);

// ---------------------------------------------------------------------------
// honest numbers straight from the build artifacts
// ---------------------------------------------------------------------------

const fmt = (n) => n.toLocaleString('en-US');
let netlist = null;
try {
  netlist = await fetch('netlist.json').then((r) => r.json());
  const g = netlist.gates.length;
  $('s-gates').textContent = `2 × ${fmt(g)}`;
  $('sp-gates').textContent = `${fmt(g)} per die · ${fmt(2 * g)} at war`;
} catch { /* static preview without a build */ }

try {
  const gas = await fetch('gas-report.json').then((r) => r.json());
  const best = gas.batches.reduce((a, b) => (b.perRound < a.perRound ? b : a));
  $('s-gas').textContent = `${Math.round(best.perRound / 1000)}k`;
  $('tk-gas').textContent = `${fmt(best.perRound)} · measured`;
  const cyc = Math.round(best.perRound / 2);
  $('tk-cycle').textContent = `≈${fmt(cyc)} · measured`;
  // what that round costs right now, in USDC, from Arc's live gas price.
  // Not awaited: the field must never wait on the network.
  if (CONFIG.chain?.rpc) {
    fetch(CONFIG.chain.rpc, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_gasPrice', params: [] }),
    })
      .then((x) => x.json())
      .then((r) => {
        const usd = (best.perRound * Number(BigInt(r.result))) / 1e18;
        $('s-usd').textContent = `$${usd.toFixed(4)}`;
        $('tk-usd').textContent = `$${usd.toFixed(4)} in USDC · live gas`;
      })
      .catch(() => {});
  }
} catch { /* keep static fallbacks */ }

let report = null;
try { report = await fetch('build-report.json').then((r) => r.json()); } catch {}

// checks section
const CHECKS = [
  ['CHECK 01', 'Exhaustive vectors', 'Every ALU-class operation swept against plain arithmetic — every operand pair, both carry states, and the same-register cases no assembler would stop you from writing.',
    report ? `${fmt(report.checks.vectors)} vectors · zero failures` : '528,384 vectors · zero failures'],
  ['CHECK 02', 'An independent model', 'The same instruction set written the ordinary way, in + and &. It exists to disagree with the gates; if it ever does, the build stops and no netlist is written.',
    report ? `${fmt(report.checks.modelEdges)} edges compared` : '95,267 edges compared'],
  ['CHECK 03', 'The arena itself', 'Whole matches — house warriors and random ones — fought twice: once on the gates, once on the model. Same rounds, same battlefield afterwards, same winner, every time.',
    report ? `${fmt(report.checks.arenaRounds)} rounds · every verdict agrees` : '24,466 rounds · every verdict agrees'],
  ['CHECK 04', 'Liveness', 'The shipping warriors must survive 20,000 edges of random input alone, and the self-test must halt, having passed, with the pass byte on its port.',
    'survives · halts · passes'],
  ['CHECK 05', 'The contract itself', 'A correct netlist and a correct interpreter of it are two separate claims. npm run evm deploys the compiled contracts into a real EVM and fights a full match through them, comparing both dies’ every flip-flop, all 256 words of the field and the verdict after every transaction.',
    'the EVM, the gates and the model agree'],
];
$('checks-list').innerHTML = CHECKS.map(([n, t, d, v]) => `
  <div class="checkrow">
    <div class="cn">${n}</div>
    <div class="cd"><b>${t}.</b> ${d}</div>
    <div class="cv">${v}</div>
  </div>`).join('');

// opcode cards
const OPS_DOC = [
  ['dat', 'death. executing it kills the core — and untouched RAM is all DAT', true],
  ['mov rd, rs', 'r[rd] = r[rs]'],
  ['ldi rd, imm', 'r[rd] = imm'],
  ['add rd, rs', 'r[rd] += r[rs] · C, Z'],
  ['sub rd, rs', 'r[rd] -= r[rs] · C, Z'],
  ['nnd rd, rs', '~(rd & rs) — the primitive itself · Z'],
  ['xor rd, rs', 'r[rd] ^= r[rs] · Z'],
  ['shl rd', 'left shift · C = old bit 7, Z'],
  ['shr rd', 'right shift · C = old bit 0, Z'],
  ['ld rd, [rs]', 'read the field. takes a third edge'],
  ['st [rd], rs', 'plant a DAT bomb carrying r[rs]', true],
  ['jmp imm', 'pc = imm'],
  ['jz imm', 'pc = imm if Z'],
  ['jnz imm', 'pc = imm if not Z'],
  ['in rd', "read the keeper's byte"],
  ['out rs', 'show the crowd a byte'],
];
$('ops').innerHTML = OPS_DOC.map(([mn, de, lethal]) => `
  <div class="op${lethal ? ' lethal' : ''}"><div class="mn">${mn}</div><div class="de">${de}</div></div>`).join('');

// warrior cards
const WAR_DESC = {
  DWARF: 'The 1984 classic. Carpet-bombs the enemy half on a stride of four and never touches its own. Brutal against anything bigger than eight words.',
  HUNTER: 'Scans the far half for words whose low byte is alive, and bombs only what it finds. Starves against silence.',
  TURTLE: 'Four words of shell. From word zero its whole body is low-silent — a scanner reads straight past it. Patient, boring, alive.',
};
$('warrior-cards').innerHTML = Object.entries(WAR_DESC).map(([name, desc]) => {
  const src = WARRIORS[name].trim().split('\n')
    .map((l) => l.replace(/(;.*)$/, '<span class="c">$1</span>')).join('\n');
  return `<div class="warrior">
    <div class="whead"><h3>${name}</h3><span class="rec">${assemble(WARRIORS[name]).words.length} WORDS</span></div>
    <pre>${src}</pre>
    <div class="dim" style="padding:0 18px 16px;font-size:13px">${desc}</div>
  </div>`;
}).join('');

// ---------------------------------------------------------------------------
// the live field
// ---------------------------------------------------------------------------

if (netlist) {
  const MATCHUPS = [
    ['DWARF v HUNTER', 'DWARF', 'HUNTER'],
    ['DWARF v TURTLE', 'DWARF', 'TURTLE'],
    ['HUNTER v TURTLE', 'HUNTER', 'TURTLE'],
    ['DWARF v DWARF', 'DWARF', 'DWARF'],
    ['HUNTER v HUNTER', 'HUNTER', 'HUNTER'],
  ];
  const sel = $('matchup');
  sel.innerHTML = MATCHUPS.map(([n], i) => `<option value="${i}">${n}</option>`).join('');

  const cvC = $('cv-cain'), cvA = $('cv-abel'), cvF = $('cv-field');
  const gC = cvC.getContext('2d'), gA = cvA.getContext('2d'), gF = cvF.getContext('2d');

  // die layout: place the gates in a near-square grid, in placement order —
  // the floorplan is the emission order of the placer, region by region
  const G = netlist.gates.length;
  const cols = Math.ceil(Math.sqrt(G * (128 / 128)));
  const cell = Math.floor(128 / Math.ceil(G / cols));
  const REGION_HUES = { CTRL: 45, DECODE: 200, REGS: 285, ALU: 15, PC: 160, FLAGS: 60, IO: 330, misc: 0 };

  let arena, prevC, prevA, owner, rafTimer = null, paused = false;
  let roundsPerSec = 8, lastTick = 0;

  function newMatch() {
    const [, rn, bn] = MATCHUPS[Number(sel.value)];
    const red = assemble(WARRIORS[rn], 0).words;
    const blue = assemble(WARRIORS[bn], 128).words;
    arena = new ArenaHarness(netlist, red, blue);
    prevC = new Uint8Array(arena.red.sim.nets.length);
    prevA = new Uint8Array(arena.blue.sim.nets.length);
    owner = new Uint8Array(256); // 0 empty · 1 cain · 2 abel
    red.forEach((w, i) => { if (w) owner[i] = 1; });
    blue.forEach((w, i) => { if (w) owner[128 + i] = 2; });
    $('die-cain').classList.remove('dead');
    $('die-abel').classList.remove('dead');
    drawAll(null, null);
    setVerdict();
  }

  function setVerdict() {
    const v = $('verdict');
    if (!arena.over) { v.textContent = `ROUND ${arena.round}`; v.style.color = ''; return; }
    const r = arena.result;
    v.textContent = r === 'draw' ? `BOTH FALL · ROUND ${arena.round}`
      : r === 'red' ? `CAIN SURVIVES · ROUND ${arena.round}` : `ABEL SURVIVES · ROUND ${arena.round}`;
    v.style.color = r === 'red' ? 'var(--cain)' : r === 'blue' ? 'var(--abel)' : 'var(--gold)';
  }

  function drawDie(g, harness, prev, hueShiftDead) {
    const nets = harness.sim.nets;
    const base = harness.sim.base;
    g.clearRect(0, 0, 128, 128);
    for (let k = 0; k < G; k++) {
      const x = (k % cols) * cell, y = Math.floor(k / cols) * cell;
      const v = nets[base + k];
      const toggled = v !== prev[base + k];
      const hue = REGION_HUES[netlist.regions[k]] ?? 0;
      if (toggled) g.fillStyle = `hsl(${hue} 90% 65%)`;
      else if (v) g.fillStyle = `hsl(${hue} 40% 26%)`;
      else g.fillStyle = '#16181c';
      g.fillRect(x, y, cell - 0, cell - 0);
    }
    prev.set(nets);
  }

  function drawField(rEv, bEv) {
    {
      gF.clearRect(0, 0, 160, 160);
      const cs = 10; // 16x16 grid, 10px cells
      for (let w = 0; w < 256; w++) {
        const x = (w % 16) * cs, y = Math.floor(w / 16) * cs;
        const word = arena.ram[w];
        const own = owner[w];
        if (word === 0 && own === 0) gF.fillStyle = '#131519';
        else if ((word >> 12) === 0) gF.fillStyle = own === 1 ? '#4a1815' : own === 2 ? '#15293f' : '#2a2118'; // DAT bombs / data
        else gF.fillStyle = own === 1 ? '#c23b36' : own === 2 ? '#3f86c9' : '#8a7a4a';
        gF.fillRect(x, y, cs - 1, cs - 1);
      }
      // program counters as bright cursors
      const pcR = arena.red.sim.getFFBus('pc', 8);
      const pcB = arena.blue.sim.getFFBus('pc', 8);
      gF.fillStyle = arena.red.halted ? '#5b2320' : '#ff6b64';
      gF.fillRect((pcR % 16) * cs, Math.floor(pcR / 16) * cs, cs - 1, cs - 1);
      gF.fillStyle = arena.blue.halted ? '#233a52' : '#7cc0ff';
      gF.fillRect((pcB % 16) * cs, Math.floor(pcB / 16) * cs, cs - 1, cs - 1);
      // fresh writes flash white
      for (const ev of [rEv, bEv]) {
        if (ev && ev.we) {
          gF.fillStyle = '#ffffff';
          gF.fillRect((ev.addr % 16) * cs, Math.floor(ev.addr / 16) * cs, cs - 1, cs - 1);
        }
      }
    }
  }

  function drawMeta() {
    const r = arena.red, b = arena.blue;
    $('meta-cain').textContent = `PC 0x${r.sim.getFFBus('pc', 8).toString(16).padStart(2, '0').toUpperCase()} · OUT ${r.sim.getFFBus('out', 8)} · ${disassemble(arena.ram[r.sim.getFFBus('pc', 8)]) ?? ''}`;
    $('meta-abel').textContent = `PC 0x${b.sim.getFFBus('pc', 8).toString(16).padStart(2, '0').toUpperCase()} · OUT ${b.sim.getFFBus('out', 8)} · ${disassemble(arena.ram[b.sim.getFFBus('pc', 8)]) ?? ''}`;
  }

  function drawAll(rEv, bEv) {
    drawDie(gC, arena.red, prevC);
    drawDie(gA, arena.blue, prevA);
    drawField(rEv, bEv);
    drawMeta();
  }

  function oneRound() {
    if (arena.over) return;
    const byteR = Math.floor(Math.random() * 256);
    const byteB = Math.floor(Math.random() * 256);
    const { red, blue } = arena.step(byteR, byteB);
    if (red.we) owner[red.addr] = 1;
    if (blue.we) owner[blue.addr] = 2;
    drawAll(red, blue);
    if (arena.red.halted) $('die-cain').classList.add('dead');
    if (arena.blue.halted) $('die-abel').classList.add('dead');
    setVerdict();
    if (arena.over) setTimeout(() => { if (arena.over && !paused) newMatch(); }, 3500);
  }

  function loop(ts) {
    rafTimer = requestAnimationFrame(loop);
    if (paused || arena.over) return;
    if (ts - lastTick >= 1000 / roundsPerSec) {
      lastTick = ts;
      oneRound();
    }
  }

  sel.onchange = newMatch;
  $('btn-reset').onclick = newMatch;
  $('btn-step').onclick = () => { paused = true; $('btn-pause').textContent = 'Play'; oneRound(); };
  $('btn-pause').onclick = () => {
    paused = !paused;
    $('btn-pause').textContent = paused ? 'Play' : 'Pause';
    if (!paused && arena.over) newMatch();
  };
  $('speed').onchange = () => { roundsPerSec = Number($('speed').value); };

  newMatch();
  rafTimer = requestAnimationFrame(loop);
}
