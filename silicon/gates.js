// CAIN & ABEL silicon builder — one primitive: nand(a, b).
// Nets are integers. Net 0 is constant 0, net 1 is constant 1.
// Inputs, flip-flop outputs and gates all allocate nets in creation order,
// so a gate can only name nets that already exist: build order IS
// topological order, and no sort ever has to happen.

export class Builder {
  constructor() {
    this.nodes = [
      { kind: 'const', value: 0, name: 'GND' },
      { kind: 'const', value: 1, name: 'VCC' },
    ];
    this.inputs = [];   // net ids
    this.ffs = [];      // { q: net, d: net|null, name }
    this.gateCount = 0;
    this.outputs = {};  // name -> net
    this.regions = {};  // region name -> [gate net ids] (for the die map)
    this._region = 'misc';
  }

  region(name, fn) {
    const prev = this._region;
    this._region = name;
    const r = fn();
    this._region = prev;
    return r;
  }

  input(name) {
    const id = this.nodes.length;
    this.nodes.push({ kind: 'input', name });
    this.inputs.push(id);
    return id;
  }

  inputBus(name, width) {
    return Array.from({ length: width }, (_, i) => this.input(`${name}[${i}]`));
  }

  ff(name) {
    const id = this.nodes.length;
    const node = { kind: 'ff', name, d: null };
    this.nodes.push(node);
    this.ffs.push({ q: id, node, name });
    return id;
  }

  ffBus(name, width) {
    return Array.from({ length: width }, (_, i) => this.ff(`${name}[${i}]`));
  }

  setD(q, d) {
    const ff = this.ffs.find((f) => f.q === q);
    if (!ff) throw new Error(`setD: net ${q} is not a flip-flop`);
    if (ff.node.d !== null) throw new Error(`setD: ${ff.name} already driven`);
    ff.node.d = d;
  }

  setDBus(qs, ds) {
    if (qs.length !== ds.length) throw new Error('setDBus: width mismatch');
    qs.forEach((q, i) => this.setD(q, ds[i]));
  }

  nand(a, b) {
    if (!Number.isInteger(a) || !Number.isInteger(b) || a >= this.nodes.length || b >= this.nodes.length) {
      throw new Error(`nand: bad nets ${a}, ${b}`);
    }
    const id = this.nodes.length;
    this.nodes.push({ kind: 'nand', a, b, region: this._region });
    this.gateCount++;
    return id;
  }

  output(name, net) {
    this.outputs[name] = net;
  }

  outputBus(name, nets) {
    nets.forEach((n, i) => this.output(`${name}[${i}]`, n));
  }

  // ---- composed logic, all of it NAND underneath ----

  inv(a) { return this.nand(a, a); }
  and(a, b) { return this.inv(this.nand(a, b)); }
  or(a, b) { return this.nand(this.inv(a), this.inv(b)); }
  nor(a, b) { return this.inv(this.or(a, b)); }

  xor(a, b) {
    const n = this.nand(a, b);
    return this.nand(this.nand(a, n), this.nand(b, n));
  }

  xnor(a, b) { return this.inv(this.xor(a, b)); }

  // s ? b : a
  mux(s, a, b) {
    const sn = this.inv(s);
    return this.nand(this.nand(a, sn), this.nand(b, s));
  }

  muxBus(s, a, b) {
    if (a.length !== b.length) throw new Error('muxBus: width mismatch');
    const sn = this.inv(s);
    return a.map((ai, i) => this.nand(this.nand(ai, sn), this.nand(b[i], s)));
  }

  // AND-reduce a list of nets (balanced tree)
  andReduce(nets) {
    if (nets.length === 0) throw new Error('andReduce: empty');
    let layer = nets.slice();
    while (layer.length > 1) {
      const next = [];
      for (let i = 0; i < layer.length; i += 2) {
        if (i + 1 < layer.length) next.push(this.and(layer[i], layer[i + 1]));
        else next.push(layer[i]);
      }
      layer = next;
    }
    return layer[0];
  }

  orReduce(nets) {
    if (nets.length === 0) throw new Error('orReduce: empty');
    // OR(x…) = NOT(AND(NOT x…)) — De Morgan, and the optimiser cancels
    // whatever double negations fall out of the composition.
    return this.inv(this.andReduce(nets.map((n) => this.inv(n))));
  }

  // one-hot mux: sum over k of sel[k] & val[k].
  // t_k = nand(sel, val); result = OR of (sel&val) = NOT(AND of t_k).
  onehotMux(sels, vals) {
    if (sels.length !== vals.length) throw new Error('onehotMux: width mismatch');
    const terms = sels.map((s, i) => this.nand(s, vals[i]));
    return this.inv(this.andReduce(terms));
  }

  onehotMuxBus(sels, buses) {
    const width = buses[0].length;
    return Array.from({ length: width }, (_, bit) =>
      this.onehotMux(sels, buses.map((b) => b[bit])));
  }

  // n-bit decoder: value bits -> 2^n one-hot lines
  decoder(bits) {
    const invs = bits.map((b) => this.inv(b));
    const lines = [];
    for (let v = 0; v < 1 << bits.length; v++) {
      const lits = bits.map((b, i) => ((v >> i) & 1) ? b : invs[i]);
      lines.push(this.andReduce(lits));
    }
    return lines;
  }

  // classic 9-NAND full adder
  fullAdder(a, b, cin) {
    const n1 = this.nand(a, b);
    const n2 = this.nand(a, n1);
    const n3 = this.nand(b, n1);
    const axb = this.nand(n2, n3);           // a xor b
    const n5 = this.nand(axb, cin);
    const n6 = this.nand(axb, n5);
    const n7 = this.nand(cin, n5);
    const sum = this.nand(n6, n7);
    const cout = this.nand(n5, n1);
    return { sum, cout };
  }

  // ripple adder over buses (LSB first). Returns { sum: [], cout }
  adder(a, b, cin) {
    if (a.length !== b.length) throw new Error('adder: width mismatch');
    const sum = [];
    let carry = cin;
    for (let i = 0; i < a.length; i++) {
      const fa = this.fullAdder(a[i], b[i], carry);
      sum.push(fa.sum);
      carry = fa.cout;
    }
    return { sum, cout: carry };
  }

  // +1 incrementer (half-adder chain)
  incrementer(a) {
    const sum = [];
    let carry = 1; // VCC
    for (let i = 0; i < a.length; i++) {
      sum.push(this.xor(a[i], carry));
      carry = this.and(a[i], carry);
    }
    return { sum, cout: carry };
  }

  isZero(bus) {
    // NOT(OR(bits))
    return this.inv(this.orReduce(bus));
  }

  constBus(value, width) {
    return Array.from({ length: width }, (_, i) => ((value >> i) & 1) ? 1 : 0);
  }
}

// ---------------------------------------------------------------------------
// Optimiser: constant folding, duplicate sharing, double-negation
// cancellation, dead-gate removal. Iterates to a fixpoint, then renumbers.
// Returns { netlist, placed, shipped, dropped }.
// ---------------------------------------------------------------------------

export function optimize(builder) {
  const nodes = builder.nodes;
  const alias = new Array(nodes.length).fill(-1); // net -> replacement net
  const resolve = (n) => {
    while (alias[n] !== -1) n = alias[n];
    return n;
  };

  let changed = true;
  while (changed) {
    changed = false;
    const seen = new Map(); // "a,b" -> net
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      if (node.kind !== 'nand' || alias[i] !== -1) continue;
      let a = resolve(node.a);
      let b = resolve(node.b);
      if (a > b) [a, b] = [b, a];
      node.a = a; node.b = b;

      // constant folding
      if (a === 0) { alias[i] = 1; changed = true; continue; }            // nand(0,x)=1
      if (a === 1 && b === 1) { alias[i] = 0; changed = true; continue; } // nand(1,1)=0
      // nand(1,x) = NOT x ; nand(x,x) = NOT x — canonicalise both as NOT(b)
      const isNotOf = (idx) => {
        const g = nodes[idx];
        if (g.kind !== 'nand') return -1;
        const ga = resolve(g.a), gb = resolve(g.b);
        if (ga === gb) return ga;
        if (ga === 1) return gb;
        if (gb === 1) return ga;
        return -1;
      };
      // double negation: NOT(NOT(x)) = x
      const inner = isNotOf(i);
      if (inner !== -1 && inner > 1) {
        const inner2 = isNotOf(inner);
        if (inner2 !== -1) { alias[i] = inner2; changed = true; continue; }
      }
      // duplicate sharing
      const key = a + ',' + b;
      const prev = seen.get(key);
      if (prev !== undefined && prev !== i) { alias[i] = prev; changed = true; continue; }
      seen.set(key, i);
    }
  }

  // resolve FF d's and outputs
  for (const ff of builder.ffs) ff.node.d = resolve(ff.node.d);
  const outputs = {};
  for (const [name, net] of Object.entries(builder.outputs)) outputs[name] = resolve(net);

  // liveness: reachable from outputs + FF d nets
  const live = new Set([0, 1]);
  const stack = [...Object.values(outputs), ...builder.ffs.map((f) => f.node.d)];
  while (stack.length) {
    const n = stack.pop();
    if (live.has(n)) continue;
    live.add(n);
    const node = nodes[n];
    if (node.kind === 'nand') { stack.push(resolve(node.a)); stack.push(resolve(node.b)); }
  }
  // inputs and FF q's always occupy a net slot (they are architectural)
  for (const i of builder.inputs) live.add(i);
  for (const f of builder.ffs) live.add(f.q);

  // renumber: const0, const1, inputs, ff qs, live gates in original order
  const remap = new Map([[0, 0], [1, 1]]);
  let next = 2;
  for (const i of builder.inputs) { remap.set(i, next++); }
  for (const f of builder.ffs) { remap.set(f.q, next++); }
  const gateList = [];
  const gateRegions = [];
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    if (node.kind !== 'nand' || alias[i] !== -1 || !live.has(i)) continue;
    remap.set(i, next++);
    gateList.push(node);
    gateRegions.push(node.region || 'misc');
  }
  const m = (n) => {
    const r = remap.get(resolve(n));
    if (r === undefined) throw new Error(`optimize: unmapped net ${n}`);
    return r;
  };

  const netlist = {
    inputs: builder.inputs.map((i) => builder.nodes[i].name),
    ffs: builder.ffs.map((f) => ({ name: f.name, d: m(f.node.d) })),
    gates: gateList.map((g) => [m(g.a), m(g.b)]),
    regions: gateRegions,
    outputs: Object.fromEntries(Object.entries(outputs).map(([k, v]) => [k, m(v)])),
  };

  let placedGates = 0;
  for (const n of nodes) if (n.kind === 'nand') placedGates++;
  return {
    netlist,
    placed: placedGates,
    shipped: netlist.gates.length,
    dropped: placedGates - netlist.gates.length,
  };
}
