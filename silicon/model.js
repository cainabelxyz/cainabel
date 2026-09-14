// The independent model: the CA-8 instruction set written the ordinary way,
// in + and &. It exists to disagree with the gates. If it ever does, the
// build stops. It follows the exact same edge protocol as the die: fetch,
// execute, and a third edge for ld, with the RAM external and synchronous.

import { OPS } from './cpu.js';

const FETCH = 0, EXEC = 1, MEM = 2;

export class CoreModel {
  constructor(ram, startPC) {
    this.ram = ram;               // Uint16Array(256), shared in the arena
    this.regs = new Uint8Array(8);
    this.pc = startPC & 0xff;
    this.flagZ = 0;
    this.flagC = 0;
    this.phase = FETCH;
    this.rdLatch = 0;
    this.halted = false;
    this.out = 0;
    this.memIn = 0;               // word delivered this edge
    this.inPort = 0;
  }

  edge() {
    if (this.halted) {
      // a dead die holds every flip-flop; its memory port stays quiet
      this.memIn = this.ram[this.pc];
      return;
    }
    let addr = this.pc, we = false, data = 0;

    if (this.phase === FETCH) {
      this.phase = EXEC;
      addr = this.pc;
    } else if (this.phase === EXEC) {
      const instr = this.memIn;
      const op = (instr >> 12) & 0xf;
      const rd = (instr >> 9) & 0x7;
      const rs = (instr >> 6) & 0x7;
      const imm = instr & 0xff;
      const a = this.regs[rd], c = this.regs[rs];
      let nextPC = (this.pc + 1) & 0xff;
      this.phase = FETCH;

      switch (op) {
        case OPS.DAT: this.halted = true; break; // pc still advances this edge, as the gates do
        case OPS.MOV: this.regs[rd] = c; break;
        case OPS.LDI: this.regs[rd] = imm; break;
        case OPS.ADD: {
          const r = a + c;
          this.regs[rd] = r & 0xff;
          this.flagC = r > 0xff ? 1 : 0;
          this.flagZ = (r & 0xff) === 0 ? 1 : 0;
          break;
        }
        case OPS.SUB: {
          const r = a + ((~c) & 0xff) + 1;
          this.regs[rd] = r & 0xff;
          this.flagC = r > 0xff ? 1 : 0;   // no borrow
          this.flagZ = (r & 0xff) === 0 ? 1 : 0;
          break;
        }
        case OPS.NND: {
          const r = (~(a & c)) & 0xff;
          this.regs[rd] = r;
          this.flagZ = r === 0 ? 1 : 0;
          break;
        }
        case OPS.XOR: {
          const r = a ^ c;
          this.regs[rd] = r;
          this.flagZ = r === 0 ? 1 : 0;
          break;
        }
        case OPS.SHL: {
          const r = (a << 1) & 0xff;
          this.regs[rd] = r;
          this.flagC = (a >> 7) & 1;
          this.flagZ = r === 0 ? 1 : 0;
          break;
        }
        case OPS.SHR: {
          const r = a >> 1;
          this.regs[rd] = r;
          this.flagC = a & 1;
          this.flagZ = r === 0 ? 1 : 0;
          break;
        }
        case OPS.LD:
          this.phase = MEM;
          this.rdLatch = rd;
          addr = c;
          break;
        case OPS.ST:
          addr = a;
          we = true;
          data = c;                        // high byte zero: a DAT bomb
          break;
        case OPS.JMP: nextPC = imm; break;
        case OPS.JZ: if (this.flagZ) nextPC = imm; break;
        case OPS.JNZ: if (!this.flagZ) nextPC = imm; break;
        case OPS.IN: this.regs[rd] = this.inPort; break;
        case OPS.OUT: this.out = c; break;
      }
      this.pc = nextPC;
      if (op !== OPS.LD && op !== OPS.ST) addr = this.pc;
    } else { // MEM
      this.regs[this.rdLatch] = this.memIn & 0xff;
      this.phase = FETCH;
      addr = this.pc;
    }

    if (we) this.ram[addr] = data;
    this.memIn = this.ram[addr];
  }
}

// ---------------------------------------------------------------------------
// The arena at the model level: two cores, one RAM, strict alternation.
// A round is one edge for RED then one edge for BLUE. The match ends when a
// core executes DAT (bombed, or its own mistake); the survivor wins.
// ---------------------------------------------------------------------------

export const RED_BASE = 0x00;
export const BLUE_BASE = 0x80;

export class ArenaModel {
  constructor(redProgram, blueProgram) {
    this.ram = new Uint16Array(256);
    redProgram.forEach((w, i) => { this.ram[(RED_BASE + i) & 0xff] = w; });
    blueProgram.forEach((w, i) => { this.ram[(BLUE_BASE + i) & 0xff] = w; });
    this.red = new CoreModel(this.ram, RED_BASE);
    this.blue = new CoreModel(this.ram, BLUE_BASE);
    this.round = 0;
  }

  get over() { return this.red.halted || this.blue.halted; }

  get result() {
    if (this.red.halted && this.blue.halted) return 'draw';
    if (this.blue.halted) return 'red';
    if (this.red.halted) return 'blue';
    return null;
  }

  // one round: both dies take an edge, red first
  step(redByte = 0, blueByte = 0) {
    this.red.inPort = redByte & 0xff;
    this.blue.inPort = blueByte & 0xff;
    this.red.edge();
    this.blue.edge();
    this.round++;
  }
}
