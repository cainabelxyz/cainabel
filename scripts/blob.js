// The gate table blob, exactly as Field.sol documents it — shared by the
// EVM check and the deploy script so there is only one encoding anywhere.
//
//   u16 numFFs · u16 numGates · u16 outNets[25] (mem_addr 0..7,
//   mem_out 0..15, mem_we) · u16 ffD[88] · numGates x (u16 a, u16 b),
//   padded with (0,0) entries to a multiple of 8 gates so the walker can
//   take eight at a stride. nand(0,0) = 1 lands in pad nets nobody reads.

export function buildBlob(nl) {
  const expectInputs = [];
  for (let i = 0; i < 16; i++) expectInputs.push(`mem_in[${i}]`);
  for (let i = 0; i < 8; i++) expectInputs.push(`in_port[${i}]`);
  if (JSON.stringify(nl.inputs) !== JSON.stringify(expectInputs)) {
    throw new Error('input order changed — the contract net layout no longer holds');
  }
  const ffNames = nl.ffs.map((f) => f.name);
  const expectFFs = [];
  for (let r = 0; r < 8; r++) for (let b = 0; b < 8; b++) expectFFs.push(`r${r}[${b}]`);
  for (let b = 0; b < 8; b++) expectFFs.push(`pc[${b}]`);
  expectFFs.push('flagZ', 'flagC', 'phase[0]', 'phase[1]', 'rdLatch[0]', 'rdLatch[1]', 'rdLatch[2]', 'halted');
  for (let b = 0; b < 8; b++) expectFFs.push(`out[${b}]`);
  if (JSON.stringify(ffNames) !== JSON.stringify(expectFFs)) {
    throw new Error('flip-flop order changed — BIT_HALTED / BIT_OUT constants no longer hold');
  }
  const numFFs = nl.ffs.length, numGates = nl.gates.length;
  const padded = (numGates + 7) & ~7;
  const outNames = [];
  for (let i = 0; i < 8; i++) outNames.push(`mem_addr[${i}]`);
  for (let i = 0; i < 16; i++) outNames.push(`mem_out[${i}]`);
  outNames.push('mem_we');
  const blob = Buffer.alloc(4 + 50 + numFFs * 2 + padded * 4);
  blob.writeUInt16BE(numFFs, 0);
  blob.writeUInt16BE(numGates, 2);
  outNames.forEach((n, i) => {
    const net = nl.outputs[n];
    if (net === undefined) throw new Error(`missing output ${n}`);
    blob.writeUInt16BE(net, 4 + i * 2);
  });
  nl.ffs.forEach((f, i) => blob.writeUInt16BE(f.d, 54 + i * 2));
  nl.gates.forEach(([a, b], k) => {
    blob.writeUInt16BE(a, 230 + k * 4);
    blob.writeUInt16BE(b, 230 + k * 4 + 2);
  });
  return blob;
}

export function dataContractCreationCode(blob) {
  const len = blob.length;
  const prefix = Buffer.from([0x61, len >> 8, len & 0xff, 0x80, 0x60, 0x0c, 0x60, 0x00, 0x39, 0x60, 0x00, 0xf3]);
  return Buffer.concat([prefix, blob]);
}
