// The workbench: two editors, one practice field, and the exact calldata a
// match would sign. Assembler, dies and field are the build's own modules.

import { ArenaHarness } from './lib/sim.js';
import { assemble, WARRIORS, AsmError, disassemble } from './lib/asm.js';

const CONFIG = window.CFG || {};

const $ = (id) => document.getElementById(id);
const netlist = await fetch('netlist.json').then((r) => r.json());

// ---------------------------------------------------------------------------
// editors
// ---------------------------------------------------------------------------

const SAMPLES = { DWARF: WARRIORS.DWARF, HUNTER: WARRIORS.HUNTER, TURTLE: WARRIORS.TURTLE, 'SELF-TEST': WARRIORS.SELFTEST };

const sides = {
  cain: { base: 0, words: null },
  abel: { base: 128, words: null },
};
let account = null;

for (const side of ['cain', 'abel']) {
  const sel = $(`sample-${side}`);
  sel.innerHTML = Object.keys(SAMPLES).map((n) => `<option>${n}</option>`).join('');
  sel.value = side === 'cain' ? 'DWARF' : 'HUNTER';
  $(`src-${side}`).value = SAMPLES[sel.value].trim() + '\n';
  sel.onchange = () => { $(`src-${side}`).value = SAMPLES[sel.value].trim() + '\n'; doAssemble(side); };
  $(`asm-${side}`).onclick = () => doAssemble(side);
  $(`src-${side}`).addEventListener('input', () => {
    sides[side].words = null;
    const st = $(`st-${side}`);
    st.textContent = 'edited — assemble again';
    st.className = 'estatus';
    updateCalldata();
  });
}

function doAssemble(side) {
  const st = $(`st-${side}`);
  try {
    const { words } = assemble($(`src-${side}`).value, sides[side].base);
    sides[side].words = words;
    st.textContent = `OK — ${words.length} word${words.length === 1 ? '' : 's'} of ${128}`;
    st.className = 'estatus ok';
  } catch (e) {
    sides[side].words = null;
    st.textContent = e instanceof AsmError ? e.message : String(e.message || e);
    st.className = 'estatus err';
  }
  updateCalldata();
  return sides[side].words;
}

// ---------------------------------------------------------------------------
// the practice field
// ---------------------------------------------------------------------------

const cvC = $('cv-cain'), cvA = $('cv-abel'), cvF = $('cv-field');
const gC = cvC.getContext('2d'), gA = cvA.getContext('2d'), gF = cvF.getContext('2d');
const G = netlist.gates.length;
const cols = Math.ceil(Math.sqrt(G));
const cell = Math.floor(128 / Math.ceil(G / cols));
const REGION_HUES = { CTRL: 45, DECODE: 200, REGS: 285, ALU: 15, PC: 160, FLAGS: 60, IO: 330, misc: 0 };

let arena = null, prevC, prevA, owner;
let paused = true, roundsPerSec = 8, lastTick = 0;

function newFight() {
  const red = sides.cain.words ?? doAssemble('cain');
  const blue = sides.abel.words ?? doAssemble('abel');
  if (!red || !blue) { $('verdict').textContent = 'FIX THE ERRORS FIRST'; return; }
  arena = new ArenaHarness(netlist, red, blue);
  prevC = new Uint8Array(arena.red.sim.nets.length);
  prevA = new Uint8Array(arena.blue.sim.nets.length);
  owner = new Uint8Array(256);
  red.forEach((w, i) => { if (w) owner[i] = 1; });
  blue.forEach((w, i) => { if (w) owner[128 + i] = 2; });
  $('die-cain').classList.remove('dead');
  $('die-abel').classList.remove('dead');
  paused = false;
  $('btn-pause').textContent = 'Pause';
  drawAll(null, null);
}

function drawDie(g, harness, prev) {
  const nets = harness.sim.nets, base = harness.sim.base;
  g.clearRect(0, 0, 128, 128);
  for (let k = 0; k < G; k++) {
    const x = (k % cols) * cell, y = Math.floor(k / cols) * cell;
    const v = nets[base + k];
    const hue = REGION_HUES[netlist.regions[k]] ?? 0;
    if (v !== prev[base + k]) g.fillStyle = `hsl(${hue} 90% 65%)`;
    else if (v) g.fillStyle = `hsl(${hue} 40% 26%)`;
    else g.fillStyle = '#16181c';
    g.fillRect(x, y, cell, cell);
  }
  prev.set(nets);
}

function drawField(rEv, bEv) {
  gF.clearRect(0, 0, 160, 160);
  const cs = 10;
  for (let w = 0; w < 256; w++) {
    const x = (w % 16) * cs, y = Math.floor(w / 16) * cs;
    const word = arena.ram[w], own = owner[w];
    if (word === 0 && own === 0) gF.fillStyle = '#131519';
    else if ((word >> 12) === 0) gF.fillStyle = own === 1 ? '#4a1815' : own === 2 ? '#15293f' : '#2a2118';
    else gF.fillStyle = own === 1 ? '#c23b36' : own === 2 ? '#3f86c9' : '#8a7a4a';
    gF.fillRect(x, y, cs - 1, cs - 1);
  }
  const pcR = arena.red.sim.getFFBus('pc', 8), pcB = arena.blue.sim.getFFBus('pc', 8);
  gF.fillStyle = arena.red.halted ? '#5b2320' : '#ff6b64';
  gF.fillRect((pcR % 16) * cs, Math.floor(pcR / 16) * cs, cs - 1, cs - 1);
  gF.fillStyle = arena.blue.halted ? '#233a52' : '#7cc0ff';
  gF.fillRect((pcB % 16) * cs, Math.floor(pcB / 16) * cs, cs - 1, cs - 1);
  for (const ev of [rEv, bEv]) {
    if (ev && ev.we) {
      gF.fillStyle = '#ffffff';
      gF.fillRect((ev.addr % 16) * cs, Math.floor(ev.addr / 16) * cs, cs - 1, cs - 1);
    }
  }
}

function drawCore(side, harness) {
  const s = harness.sim;
  const pc = s.getFFBus('pc', 8);
  $(`meta-${side}`).textContent =
    `PC 0x${pc.toString(16).padStart(2, '0').toUpperCase()} · ${disassemble(arena.ram[pc]) ?? ''}`;
  $(`regs-${side}`).innerHTML = Array.from({ length: 8 }, (_, r) =>
    `<div class="r"><span class="rl">r${r}</span>${s.getFFBus(`r${r}`, 8)}</div>`).join('');
  const z = s.getFF('flagZ'), c = s.getFF('flagC');
  $(`cs-${side}`).innerHTML =
    `<span>OUT <b>${s.getFFBus('out', 8)}</b></span><span>FLAGS <b>${z ? 'Z' : '·'}${c ? 'C' : '·'}</b></span>` +
    `<span>PHASE <b>${['FETCH', 'EXEC', 'MEM'][s.getFFBus('phase', 2)] ?? '?'}</b></span>` +
    `<span>${harness.halted ? '<b class="cain">SLAIN</b>' : '<b style="color:var(--ok)">ALIVE</b>'}</span>`;
}

function drawAll(rEv, bEv) {
  if (!arena) return;
  drawDie(gC, arena.red, prevC);
  drawDie(gA, arena.blue, prevA);
  drawField(rEv, bEv);
  drawCore('cain', arena.red);
  drawCore('abel', arena.blue);
  const v = $('verdict');
  if (!arena.over) { v.textContent = `ROUND ${arena.round}`; v.style.color = ''; }
  else {
    const r = arena.result;
    v.textContent = r === 'draw' ? `BOTH FALL · ROUND ${arena.round}`
      : r === 'red' ? `CAIN SURVIVES · ROUND ${arena.round}` : `ABEL SURVIVES · ROUND ${arena.round}`;
    v.style.color = r === 'red' ? 'var(--cain)' : r === 'blue' ? 'var(--abel)' : 'var(--gold)';
  }
}

function oneRound() {
  if (!arena || arena.over) return;
  const { red, blue } = arena.step(Number($('byte-cain').value) & 0xff, Number($('byte-abel').value) & 0xff);
  if (red.we) owner[red.addr] = 1;
  if (blue.we) owner[blue.addr] = 2;
  if (arena.red.halted) $('die-cain').classList.add('dead');
  if (arena.blue.halted) $('die-abel').classList.add('dead');
  drawAll(red, blue);
}

function loop(ts) {
  requestAnimationFrame(loop);
  if (paused || !arena || arena.over) return;
  if (ts - lastTick >= 1000 / roundsPerSec) { lastTick = ts; oneRound(); }
}

$('btn-fight').onclick = newFight;
$('btn-pause').onclick = () => { paused = !paused; $('btn-pause').textContent = paused ? 'Play' : 'Pause'; };
$('btn-step').onclick = () => { if (!arena) newFight(); paused = true; $('btn-pause').textContent = 'Play'; oneRound(); };
$('speed').onchange = () => { roundsPerSec = Number($('speed').value); };

doAssemble('cain');
doAssemble('abel');
newFight();
paused = true;
$('btn-pause').textContent = 'Play';
requestAnimationFrame(loop);

// ---------------------------------------------------------------------------
// on-chain: the exact calldata, then the wallet
// ---------------------------------------------------------------------------

function selector() { return '0x7de73ddc'; } // keccak('createMatch(uint16[],uint16[])')[0:4]

function pad(hex) { return hex.padStart(64, '0'); }
function buildCalldata() {
  const r = sides.cain.words, b = sides.abel.words;
  if (!r || !b) return null;
  const head = pad((0x40).toString(16)) + pad((0x40 + 32 + r.length * 32).toString(16));
  const t1 = pad(r.length.toString(16)) + r.map((w) => pad(w.toString(16))).join('');
  const t2 = pad(b.length.toString(16)) + b.map((w) => pad(w.toString(16))).join('');
  return selector() + head + t1 + t2;
}

function updateCalldata() {
  const cal = buildCalldata();
  $('calldata').textContent = cal ?? 'assemble both warriors to build the call';
  $('btn-send').disabled = !(cal && CONFIG.addresses.field && account);
}

$('btn-copy-cal').onclick = () => {
  const cal = buildCalldata();
  if (cal) navigator.clipboard.writeText(cal);
};

$('btn-connect').onclick = async () => {
  if (!window.ethereum) { $('deploy-note').innerHTML = 'No wallet found in this browser — install one, or copy the calldata and send it your own way.'; return; }
  const accs = await window.ethereum.request({ method: 'eth_requestAccounts' });
  account = accs[0];
  $('btn-connect').textContent = account.slice(0, 6) + '…' + account.slice(-4);
  try {
    await window.ethereum.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: '0x' + CONFIG.chain.id.toString(16) }],
    });
  } catch (e) {
    if (e.code === 4902) {
      await window.ethereum.request({
        method: 'wallet_addEthereumChain',
        params: [{
          chainId: '0x' + CONFIG.chain.id.toString(16),
          chainName: CONFIG.chain.name,
          rpcUrls: [CONFIG.chain.rpc],
          nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
          blockExplorerUrls: [CONFIG.chain.explorer],
        }],
      });
    }
  }
  updateCalldata();
};

$('btn-send').onclick = async () => {
  const cal = buildCalldata();
  if (!cal || !CONFIG.addresses.field || !account) return;
  const tx = await window.ethereum.request({
    method: 'eth_sendTransaction',
    params: [{ from: account, to: CONFIG.addresses.field, data: cal }],
  });
  $('deploy-note').innerHTML = `Match transaction sent: <span class="mono">${tx}</span> — once mined, anyone can step it. Including you.`;
};

if (!CONFIG.addresses.field) {
  $('btn-send').textContent = 'createMatch() · opens at T-0';
}
updateCalldata();
