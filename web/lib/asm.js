// The CAIN & ABEL assembler. The workbench loads this exact file, so what
// assembles in a browser is what a warrior carries into the arena.
//
// Syntax:  label:  op operands   ; comment
//   registers r0..r7, immediates 0..255 or 0x.., labels as jump targets.
//   dat            — one dead word (opcode 0). Executing it kills the core.
//   dat 0xNN       — a dead word carrying a byte.

import { OPS } from './cpu.js';

const R = /^r([0-7])$/i;

function parseReg(tok, line) {
  const m = R.exec(tok);
  if (!m) throw new AsmError(line, `expected a register r0..r7, got "${tok}"`);
  return Number(m[1]);
}

function parseMem(tok, line) {
  const m = /^\[(r[0-7])\]$/i.exec(tok);
  if (!m) throw new AsmError(line, `expected [rN], got "${tok}"`);
  return parseReg(m[1], line);
}

export class AsmError extends Error {
  constructor(line, msg) {
    super(`line ${line}: ${msg}`);
    this.line = line;
  }
}

// base: the word address the program is loaded at (0 for RED, 128 for BLUE).
// Labels resolve to base-relative absolute addresses, and two builtins let a
// warrior fight from either side of the battlefield:
//   base  — the address of this program's word 0
//   enemy — the base of the other half
export function assemble(source, base = 0) {
  const lines = source.split('\n');
  const labels = { base: base & 0xff, enemy: (base + 128) & 0xff };
  const items = []; // { line, op, toks }

  // pass 1: strip comments, collect labels, count words
  let addr = 0;
  for (let i = 0; i < lines.length; i++) {
    let text = lines[i].replace(/;.*$/, '').trim();
    if (!text) continue;
    const labelMatch = /^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(text);
    if (labelMatch) {
      labels[labelMatch[1].toLowerCase()] = (base + addr) & 0xff;
      text = labelMatch[2].trim();
      if (!text) continue;
    }
    const toks = text.split(/[\s,]+/).filter(Boolean);
    items.push({ line: i + 1, toks, addr });
    addr++;
    if (addr > 128) throw new AsmError(i + 1, 'program exceeds 128 words (half the battlefield)');
  }

  const parseImm = (tok, line) => {
    const lab = labels[tok.toLowerCase()];
    if (lab !== undefined) return lab;
    const v = /^0x[0-9a-f]+$/i.test(tok) ? parseInt(tok, 16)
      : /^-?\d+$/.test(tok) ? parseInt(tok, 10) : NaN;
    if (Number.isNaN(v)) throw new AsmError(line, `not a number or label: "${tok}"`);
    if (v < -128 || v > 255) throw new AsmError(line, `immediate out of range: ${v}`);
    return v & 0xff;
  };

  // pass 2: encode
  const words = [];
  const meta = []; // per word: { line, text }
  for (const { line, toks } of items) {
    const op = toks[0].toLowerCase();
    const enc = (opc, rd = 0, rs = 0, imm = 0) =>
      ((opc & 0xf) << 12) | ((rd & 7) << 9) | ((rs & 7) << 6) | (imm & 0xff);
    const need = (n) => {
      if (toks.length - 1 !== n) throw new AsmError(line, `${op} takes ${n} operand(s)`);
    };
    let w;
    switch (op) {
      case 'dat': {
        if (toks.length === 1) w = 0;
        else { need(1); w = parseImm(toks[1], line) & 0xff; }
        break;
      }
      case 'mov': need(2); w = enc(OPS.MOV, parseReg(toks[1], line), parseReg(toks[2], line)); break;
      case 'ldi': need(2); w = enc(OPS.LDI, parseReg(toks[1], line), 0, parseImm(toks[2], line)); break;
      case 'add': need(2); w = enc(OPS.ADD, parseReg(toks[1], line), parseReg(toks[2], line)); break;
      case 'sub': need(2); w = enc(OPS.SUB, parseReg(toks[1], line), parseReg(toks[2], line)); break;
      case 'nnd': case 'nand': need(2); w = enc(OPS.NND, parseReg(toks[1], line), parseReg(toks[2], line)); break;
      case 'xor': need(2); w = enc(OPS.XOR, parseReg(toks[1], line), parseReg(toks[2], line)); break;
      case 'shl': need(1); w = enc(OPS.SHL, parseReg(toks[1], line)); break;
      case 'shr': need(1); w = enc(OPS.SHR, parseReg(toks[1], line)); break;
      case 'ld': need(2); w = enc(OPS.LD, parseReg(toks[1], line), parseMem(toks[2], line)); break;
      case 'st': need(2); w = enc(OPS.ST, parseMem(toks[1], line), parseReg(toks[2], line)); break;
      case 'jmp': need(1); w = enc(OPS.JMP, 0, 0, parseImm(toks[1], line)); break;
      case 'jz': need(1); w = enc(OPS.JZ, 0, 0, parseImm(toks[1], line)); break;
      case 'jnz': need(1); w = enc(OPS.JNZ, 0, 0, parseImm(toks[1], line)); break;
      case 'in': need(1); w = enc(OPS.IN, parseReg(toks[1], line)); break;
      case 'out': need(1); w = enc(OPS.OUT, 0, parseReg(toks[1], line)); break;
      default: throw new AsmError(line, `unknown instruction "${op}"`);
    }
    meta.push({ line, text: toks.join(' ') });
    words.push(w);
  }
  return { words, labels, meta };
}

export function disassemble(word) {
  const op = (word >> 12) & 0xf, rd = (word >> 9) & 7, rs = (word >> 6) & 7, imm = word & 0xff;
  switch (op) {
    case OPS.DAT: return word === 0 ? 'dat' : (word & 0xff00) === 0 ? `dat 0x${imm.toString(16).padStart(2, '0')}` : `dat? 0x${word.toString(16)}`;
    case OPS.MOV: return `mov r${rd}, r${rs}`;
    case OPS.LDI: return `ldi r${rd}, ${imm}`;
    case OPS.ADD: return `add r${rd}, r${rs}`;
    case OPS.SUB: return `sub r${rd}, r${rs}`;
    case OPS.NND: return `nnd r${rd}, r${rs}`;
    case OPS.XOR: return `xor r${rd}, r${rs}`;
    case OPS.SHL: return `shl r${rd}`;
    case OPS.SHR: return `shr r${rd}`;
    case OPS.LD: return `ld r${rd}, [r${rs}]`;
    case OPS.ST: return `st [r${rd}], r${rs}`;
    case OPS.JMP: return `jmp ${imm}`;
    case OPS.JZ: return `jz ${imm}`;
    case OPS.JNZ: return `jnz ${imm}`;
    case OPS.IN: return `in r${rd}`;
    case OPS.OUT: return `out r${rs}`;
  }
}

// ---------------------------------------------------------------------------
// The house warriors. RED loads at word 0, BLUE at word 128, and a program
// may be at most 128 words. Untouched RAM is DAT, so a stray jump is death.
// ---------------------------------------------------------------------------

export const WARRIORS = {
  // Carpet-bombs the enemy half on a stride of 4, and never its own.
  DWARF: `
; DWARF — the 1984 classic, retold in CAIN & ABEL asm.
; 32 DAT bombs on a stride of 4 cover the enemy half, then the lap repeats.
; "enemy" assembles to the other half's base, so it fights from either side.
        in   r0          ; the bomb carries the sponsor's byte
        ldi  r7, 4       ; the stride
        ldi  r2, 1
reload: ldi  r1, enemy   ; first bomb lands on their doorstep
        ldi  r6, 32      ; bombs per lap
loop:   st   [r1], r0    ; drop one
        out  r1          ; show the crowd where it landed
        add  r1, r7      ; walk
        sub  r6, r2
        jnz  loop
        jmp  reload
`,
  // Scans enemy territory for words whose low byte is alive, bombs the hit.
  HUNTER: `
; HUNTER — scans the far half for code, bombs only what it finds.
; ld does not touch the flags, so the read is tested with an add of zero:
; r5 is born zero at reset and nothing here ever writes it.
        in   r0          ; signature byte
        ldi  r7, 1
init:   ldi  r1, enemy   ; start of their territory
        ldi  r6, 128     ; words to sweep
scan:   ld   r3, [r1]    ; read the low byte of the word
        add  r3, r5      ; set Z from what came back
        jnz  hit         ; something lives here
        add  r1, r7      ; next word
        sub  r6, r7
        jnz  scan
        jmp  init
hit:    st   [r1], r0    ; bomb it
        out  r1          ; announce the kill square
        add  r1, r7
        sub  r6, r7
        jnz  scan
        jmp  init
`,
  // Runs in a tight loop doing nothing bombable-sized: small target, no output.
  TURTLE: `
; TURTLE — four words of shell. Small target, patient, boring, alive.
loop:   in   r0
        out  r0
        jmp  loop
`,
  // The self-test: exercises every class of instruction, then halts on purpose.
  SELFTEST: `
; SELF-TEST — computes, remembers, decides, then halts having passed.
        ldi  r0, 21
        ldi  r1, 2
        add  r0, r0      ; 42
        out  r0          ; the answer on the port
        ldi  r2, 100
        st   [r2], r0    ; park it in RAM
        ld   r3, [r2]    ; read it back
        sub  r3, r0      ; should be zero
        jz   pass
        jmp  fail
pass:   ldi  r4, 1
        out  r4
        dat              ; a pass halts
fail:   ldi  r4, 255
        out  r4
        dat
`,
};
