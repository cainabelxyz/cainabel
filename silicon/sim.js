// Gate-level simulator for a CAIN & ABEL netlist. This exact file is what the
// website loads to draw the die, and what the checks run against: there is
// one simulator, not a browser copy of one.
//
// Net layout (the same layout the contract walks):
//   net 0            constant 0
//   net 1            constant 1
//   nets 2 .. 2+I-1  inputs
//   nets .. +F       flip-flop outputs (the architectural state)
//   nets .. +G       gate k drives net 2+I+F+k — the output column is
//                    never stored because it is arithmetic.

export class NetlistSim {
  constructor(netlist) {
    this.netlist = netlist;
    this.numInputs = netlist.inputs.length;
    this.numFFs = netlist.ffs.length;
    this.base = 2 + this.numInputs + this.numFFs;
    this.nets = new Uint8Array(this.base + netlist.gates.length);
    this.nets[1] = 1;
    this.state = new Uint8Array(this.numFFs); // flip-flop Q values
    this.inputIndex = {};
    netlist.inputs.forEach((name, i) => { this.inputIndex[name] = i; });
    this.ffIndex = {};
    netlist.ffs.forEach((ff, i) => { this.ffIndex[ff.name] = i; });
  }

  setInput(name, value) {
    const i = this.inputIndex[name];
    if (i === undefined) throw new Error(`no input ${name}`);
    this.nets[2 + i] = value ? 1 : 0;
  }

  setInputBus(name, width, value) {
    for (let b = 0; b < width; b++) this.setInput(`${name}[${b}]`, (value >> b) & 1);
  }

  // Evaluate every gate in order, then latch every flip-flop at once.
  // Returns nothing; read outputs with getOutput()/getOutputBus() BEFORE
  // stepping if you want pre-edge values, or evaluate() alone for probing.
  evaluate() {
    const nets = this.nets;
    const gates = this.netlist.gates;
    const base = this.base;
    for (let i = 0; i < this.numFFs; i++) nets[2 + this.numInputs + i] = this.state[i];
    for (let k = 0; k < gates.length; k++) {
      const g = gates[k];
      nets[base + k] = (nets[g[0]] & nets[g[1]]) ^ 1;
    }
  }

  latch() {
    const ffs = this.netlist.ffs;
    const next = new Uint8Array(this.numFFs);
    for (let i = 0; i < this.numFFs; i++) next[i] = this.nets[ffs[i].d];
    this.state = next;
  }

  step() { this.evaluate(); this.latch(); }

  getOutput(name) {
    const net = this.netlist.outputs[name];
    if (net === undefined) throw new Error(`no output ${name}`);
    return this.nets[net];
  }

  getOutputBus(name, width) {
    let v = 0;
    for (let b = 0; b < width; b++) v |= this.getOutput(`${name}[${b}]`) << b;
    return v;
  }

  getFF(name) {
    const i = this.ffIndex[name];
    if (i === undefined) throw new Error(`no ff ${name}`);
    return this.state[i];
  }

  getFFBus(name, width) {
    let v = 0;
    for (let b = 0; b < width; b++) v |= this.getFF(`${name}[${b}]`) << b;
    return v;
  }

  setFF(name, value) {
    const i = this.ffIndex[name];
    if (i === undefined) throw new Error(`no ff ${name}`);
    this.state[i] = value ? 1 : 0;
  }

  setFFBus(name, width, value) {
    for (let b = 0; b < width; b++) this.setFF(`${name}[${b}]`, (value >> b) & 1);
  }

  // pack/unpack architectural state as a bigint (how the contract stores it)
  packState() {
    let v = 0n;
    for (let i = this.numFFs - 1; i >= 0; i--) v = (v << 1n) | BigInt(this.state[i]);
    return v;
  }

  unpackState(v) {
    for (let i = 0; i < this.numFFs; i++) { this.state[i] = Number(v & 1n); v >>= 1n; }
  }
}

// ---------------------------------------------------------------------------
// CoreHarness: one CA-8 die wired to a synchronous RAM the way the contract
// wires it. The RAM itself is external to the netlist — the die outputs an
// address and the data arrives on the next edge, the way synchronous memory
// has behaved since the first one was built.
// ---------------------------------------------------------------------------

export class CoreHarness {
  constructor(netlist, ram, startPC) {
    this.sim = new NetlistSim(netlist);
    this.ram = ram;              // Uint16Array(256), shared in the arena
    this.memIn = 0;              // data delivered this edge
    this.inPort = 0;             // sponsor byte
    this.reset(startPC);
  }

  reset(startPC) {
    this.sim.state.fill(0);
    this.sim.setFFBus('pc', 8, startPC & 0xff);
    this.memIn = 0;
  }

  get halted() { return this.sim.getFF('halted') === 1; }

  // one clock edge; returns what the die did on it
  edge() {
    const s = this.sim;
    s.setInputBus('mem_in', 16, this.memIn);
    s.setInputBus('in_port', 8, this.inPort);
    s.evaluate();
    const addr = s.getOutputBus('mem_addr', 8);
    const we = s.getOutput('mem_we');
    const data = s.getOutputBus('mem_out', 16);
    s.latch();
    if (we) this.ram[addr] = data;
    this.memIn = this.ram[addr]; // synchronous read, delivered next edge
    return { addr, we, data, out: s.getFFBus('out', 8), halted: this.halted };
  }
}

// ---------------------------------------------------------------------------
// ArenaHarness: the whole fight at gate level. Two CA-8 dies, one RAM,
// strict alternation — RED takes an edge, then BLUE. This is the exact
// machine the arena contract advances, and the exact one the site draws.
// ---------------------------------------------------------------------------

export const RED_BASE = 0x00;
export const BLUE_BASE = 0x80;

export class ArenaHarness {
  constructor(netlist, redProgram, blueProgram) {
    this.ram = new Uint16Array(256);
    redProgram.forEach((w, i) => { this.ram[(RED_BASE + i) & 0xff] = w; });
    blueProgram.forEach((w, i) => { this.ram[(BLUE_BASE + i) & 0xff] = w; });
    this.red = new CoreHarness(netlist, this.ram, RED_BASE);
    this.blue = new CoreHarness(netlist, this.ram, BLUE_BASE);
    this.round = 0;
  }

  get over() { return this.red.halted || this.blue.halted; }

  get result() {
    if (this.red.halted && this.blue.halted) return 'draw';
    if (this.blue.halted) return 'red';
    if (this.red.halted) return 'blue';
    return null;
  }

  step(redByte = 0, blueByte = 0) {
    this.red.inPort = redByte & 0xff;
    this.blue.inPort = blueByte & 0xff;
    const r = this.red.edge();
    const b = this.blue.edge();
    this.round++;
    return { red: r, blue: b };
  }
}
