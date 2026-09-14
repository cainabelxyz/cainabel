// CA-8: the CAIN & ABEL die. Eight registers of eight bits, an 8-bit PC over
// 256 words of shared RAM, two flags, sixteen opcodes — placed one NAND at a
// time. Two of these dies share one RAM in the arena, and the only thing a
// store can write is a DAT bomb carrying the sponsor's byte.
//
// Instruction word, 16 bits:  [15:12] op · [11:9] rd · [8:6] rs · [7:0] imm
//
// op 0  DAT          executing it kills the core — untouched RAM is lethal
// op 1  MOV rd, rs   r[rd] = r[rs]
// op 2  LDI rd, imm  r[rd] = imm
// op 3  ADD rd, rs   r[rd] += r[rs]           C = carry, Z
// op 4  SUB rd, rs   r[rd] -= r[rs]           C = no borrow, Z
// op 5  NND rd, rs   r[rd] = ~(r[rd] & r[rs])              Z
// op 6  XOR rd, rs   r[rd] ^= r[rs]                        Z
// op 7  SHL rd       r[rd] <<= 1              C = old bit7, Z
// op 8  SHR rd       r[rd] >>= 1              C = old bit0, Z
// op 9  LD  rd, [rs] r[rd] = low byte of RAM[r[rs]]   (takes a third edge)
// op 10 ST  [rd], rs RAM[r[rd]] = r[rs] zero-extended — opcode 0: a DAT bomb
// op 11 JMP imm      pc = imm
// op 12 JZ  imm      pc = imm if Z
// op 13 JNZ imm      pc = imm if not Z
// op 14 IN  rd       r[rd] = the sponsor's byte
// op 15 OUT rs       out port = r[rs]
//
// Every instruction retires in two edges (fetch, execute) except ld, which
// takes three: the address latches on one edge and the data arrives on the
// next, the way synchronous memory has behaved since the first one was built.

import { Builder, optimize } from './gates.js';

export const OPS = {
  DAT: 0, MOV: 1, LDI: 2, ADD: 3, SUB: 4, NND: 5, XOR: 6, SHL: 7,
  SHR: 8, LD: 9, ST: 10, JMP: 11, JZ: 12, JNZ: 13, IN: 14, OUT: 15,
};

export function buildCore() {
  const b = new Builder();

  // ---- ports ----
  const memIn = b.inputBus('mem_in', 16);   // RAM word addressed last edge
  const inPort = b.inputBus('in_port', 8);  // this side's sponsor byte

  // ---- architectural state: 88 flip-flops ----
  const regs = [];
  for (let r = 0; r < 8; r++) regs.push(b.ffBus(`r${r}`, 8));
  const pc = b.ffBus('pc', 8);
  const flagZ = b.ff('flagZ');
  const flagC = b.ff('flagC');
  const phase = b.ffBus('phase', 2);        // 00 fetch · 01 exec · 10 mem
  const rdLatch = b.ffBus('rdLatch', 3);
  const halted = b.ff('halted');
  const out = b.ffBus('out', 8);

  // ---- control: phase decode ----
  const ctrl = b.region('CTRL', () => {
    const p0 = phase[0], p1 = phase[1];
    const np0 = b.inv(p0), np1 = b.inv(p1);
    const isFetch = b.and(np1, np0);
    const isExec = b.and(np1, p0);
    const isMem = b.and(p1, np0);
    const alive = b.inv(halted);
    const execLive = b.and(isExec, alive);
    return { isFetch, isExec, isMem, alive, execLive };
  });

  // ---- decode: op field to sixteen one-hot lines ----
  const dec = b.region('DECODE', () => {
    const opBits = [memIn[12], memIn[13], memIn[14], memIn[15]];
    const lines = b.decoder(opBits);
    const rdBits = [memIn[9], memIn[10], memIn[11]];
    const rsBits = [memIn[6], memIn[7], memIn[8]];
    const imm = memIn.slice(0, 8);
    const rdDec = b.decoder(rdBits);
    const rsDec = b.decoder(rsBits);
    return { lines, rdBits, rsBits, rdDec, rsDec, imm };
  });
  const op = (name) => dec.lines[OPS[name]];

  // ---- register file: two read ports ----
  const rf = b.region('REGS', () => {
    const rdVal = b.onehotMuxBus(dec.rdDec, regs);
    const rsVal = b.onehotMuxBus(dec.rsDec, regs);
    return { rdVal, rsVal };
  });

  // ---- ALU: one adder, rode by add and sub the way cmp rides it ----
  const alu = b.region('ALU', () => {
    const a = rf.rdVal, c = rf.rsVal;
    const isSub = op('SUB');
    const bEff = c.map((bit) => b.xor(bit, isSub));
    const add = b.adder(a, bEff, isSub);
    const nnd = a.map((bit, i) => b.nand(bit, c[i]));
    const xor = a.map((bit, i) => b.xor(bit, c[i]));
    const shl = [0, ...a.slice(0, 7)];
    const shr = [...a.slice(1), 0];
    const selAdd = b.or(op('ADD'), isSub);
    const sels = [selAdd, op('NND'), op('XOR'), op('SHL'), op('SHR')];
    const outBus = b.onehotMuxBus(sels, [add.sum, nnd, xor, shl, shr]);
    const isAlu = b.orReduce(sels);
    const zero = b.isZero(outBus);
    const carry = b.onehotMux(
      [selAdd, op('SHL'), op('SHR')],
      [add.cout, a[7], a[0]],
    );
    const carryWrites = b.orReduce([selAdd, op('SHL'), op('SHR')]);
    return { out: outBus, isAlu, zero, carry, carryWrites };
  });

  // ---- writeback ----
  b.region('REGS', () => {
    // exec-op selects must be gated with isExec: during the mem edge the
    // memory word on mem_in is data, and data must not decode into a select
    const wbSels = [
      b.and(ctrl.isExec, op('MOV')),
      b.and(ctrl.isExec, op('LDI')),
      b.and(ctrl.isExec, alu.isAlu),
      b.and(ctrl.isExec, op('IN')),
      ctrl.isMem,
    ];
    const wbVals = [rf.rsVal, dec.imm, alu.out, inPort, memIn.slice(0, 8)];
    const wbData = b.onehotMuxBus(wbSels, wbVals);
    const execWrites = b.orReduce([op('MOV'), op('LDI'), alu.isAlu, op('IN')]);
    const we = b.or(b.and(ctrl.execLive, execWrites), b.and(ctrl.isMem, ctrl.alive));
    const wAddrBits = dec.rdBits.map((bit, i) => b.mux(ctrl.isMem, bit, rdLatch[i]));
    const wDec = b.decoder(wAddrBits);
    for (let r = 0; r < 8; r++) {
      const wr = b.and(wDec[r], we);
      b.setDBus(regs[r], b.muxBus(wr, regs[r], wbData));
    }
  });

  // ---- program counter ----
  b.region('PC', () => {
    const inc = b.incrementer(pc);
    const takeJmp = b.orReduce([
      op('JMP'),
      b.and(op('JZ'), flagZ),
      b.and(op('JNZ'), b.inv(flagZ)),
    ]);
    const target = b.muxBus(takeJmp, inc.sum, dec.imm);
    b.setDBus(pc, b.muxBus(ctrl.execLive, pc, target));
  });

  // ---- flags ----
  b.region('FLAGS', () => {
    const zWe = b.and(ctrl.execLive, alu.isAlu);
    const cWe = b.and(ctrl.execLive, alu.carryWrites);
    b.setD(flagZ, b.mux(zWe, flagZ, alu.zero));
    b.setD(flagC, b.mux(cWe, flagC, alu.carry));
  });

  // ---- phase machine, halt, rd latch ----
  b.region('CTRL', () => {
    // fetch(00) -> exec(01) -> mem(10) only for ld, else back to fetch
    const goMem = b.and(ctrl.isExec, op('LD'));
    const nextP0 = ctrl.isFetch;               // exec only ever follows fetch
    const nextP1 = goMem;
    const p0d = b.mux(ctrl.alive, phase[0], nextP0);
    const p1d = b.mux(ctrl.alive, phase[1], nextP1);
    b.setD(phase[0], p0d);
    b.setD(phase[1], p1d);
    b.setD(halted, b.or(halted, b.and(ctrl.isExec, op('DAT'))));
    const latchRd = b.and(ctrl.execLive, op('LD'));
    b.setDBus(rdLatch, dec.rdBits.map((bit, i) => b.mux(latchRd, rdLatch[i], bit)));
  });

  // ---- I/O and the memory port ----
  b.region('IO', () => {
    const outWe = b.and(ctrl.execLive, op('OUT'));
    b.setDBus(out, b.muxBus(outWe, out, rf.rsVal));

    const selLD = b.and(ctrl.isExec, op('LD'));
    const selST = b.and(ctrl.isExec, op('ST'));
    const selPC = b.inv(b.or(selLD, selST));
    const memAddr = b.onehotMuxBus([selLD, selST, selPC], [rf.rsVal, rf.rdVal, pc]);
    b.outputBus('mem_addr', memAddr);
    b.outputBus('mem_out', [...rf.rsVal, ...b.constBus(0, 8)]);
    b.output('mem_we', b.and(selST, ctrl.alive));
  });

  b.outputBus('out_port', out);
  b.output('halted_o', halted);

  return b;
}

export function buildNetlist() {
  const b = buildCore();
  return { builder: b, ...optimize(b) };
}
