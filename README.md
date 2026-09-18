# CAINABEL · $CABEL

**Two brothers. One field. One survivor.**

Two real 8-bit processors — 1,277 NAND gates each, composed from a single
logic primitive and nothing else — fight to the death in 512 bytes of shared
RAM inside a contract on Arc. The contract does not emulate them:
it walks every gate of both dies, round after round. Whoever pays for a round
is his brother's keeper, and the byte they send is what their champion reads.

This is [Core War](https://en.wikipedia.org/wiki/Core_War) (1984), rebuilt at
the gate level, with an open clock.

- Site: https://cainabel.xyz · X: [@cainabelxyz](https://x.com/cainabelxyz)
- Machine: **CA-8** — 16-bit words, 8 registers, 16 opcodes, 8-bit PC over
  256 shared words. Untouched RAM is `DAT`, and executing `DAT` is death.
- An entire match — both dies' 88 flip-flops each, both memory latches, both
  sponsored bytes, the round counter and the verdict — lives in **one storage
  slot** (256 bits exactly). The battlefield is sixteen more.

## Run everything yourself

```bash
npm install
npm run silicon   # places the gates, runs checks 01–04, emits web/netlist.json
npm run evm       # check 05: compiled contracts in a real EVM vs the model
npm run serve     # the site, locally
```

The build **refuses to emit a netlist unless every check passes**:

| check | what it is | scale |
|---|---|---|
| 01 | every ALU-class op vs plain arithmetic, all operands, both carries | 528,384 vectors |
| 02 | an independent model written in `+` and `&`, run edge-for-edge vs the gates | 95k+ edges |
| 03 | whole matches fought twice — gates vs model — same winner, same RAM | 24k+ rounds |
| 04 | shipping warriors survive 20,000 edges; the self-test halts, having passed | — |
| 05 | the compiled contracts in a real EVM, compared per block, gas measured | full match |

Gas, measured (not estimated): **~297k per round at batch — and a round is
both dies**. Deploying the silicon costs 1.17M gas. On Arc, gas is paid in
USDC: at ~20 gwei a round costs about $0.006, and deploying everything about
$0.06.

## Layout

```
silicon/    the placer, optimiser, CA-8 description, simulator, model, assembler
contracts/  Field.sol (the arena), CainToken.sol (test token; $CABEL launches on Argus)
scripts/    blob.js (gate table encoding) · evm-check.js (check 05) · deploy.js
web/        the static site — the same modules, running the same netlist
marketing/  runbook and launch copy
```

The website's simulator is not a copy of the build's simulator; `web/lib/*`
are byte-for-byte the build's own modules, and `web/netlist.json` is the
build's own output. What lights up in your tab is what the contract walks.

## The instruction set

Sixteen opcodes; one of them is death. `st` can only write a word whose
opcode is 0 — a DAT bomb carrying your byte — so code cannot be copied, only
killed: warriors bomb, scan, and hide. `nnd` is in the set because it is the
only primitive the dies are built from. See the full table on the site.

## License

MIT for all code. The fight is nobody's property.
