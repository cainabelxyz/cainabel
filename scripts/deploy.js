// Deploy CAIN & ABEL to Robinhood Chain (or its testnet).
//
//   PRIVATE_KEY=0x... node scripts/deploy.js [--testnet] [--with-test-token]
//
// Order of operations:
//   1. gate table  (the CA-8 netlist as a data contract)
//   2. Field       (needs the gate table + the $CABEL token address)
//   3. writes both addresses into web/config.js
//
// The $CABEL token itself launches on pons (via the CABEL Launcher) — pass its
// address as CABEL_TOKEN=0x... . For a testnet rehearsal, --with-test-token
// deploys the plain CainToken ERC20 instead, so the whole loop can be walked
// at a fortieth of the price before T-0.
//
// Emission parameters are IMMUTABLE once deployed — set them deliberately:
//   EMISSION_PER_ROUND  $CABEL paid to the keeper per round   (default 10)
//   POT_PER_ROUND       $CABEL accrued to the offering        (default 5)

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { JsonRpcProvider, Wallet, ContractFactory, parseUnits } from 'ethers';
import { buildBlob, dataContractCreationCode } from './blob.js';

const require = createRequire(import.meta.url);
const solc = require('solc');

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const TESTNET = process.argv.includes('--testnet');
const WITH_TEST_TOKEN = process.argv.includes('--with-test-token');
const RPC = process.env.RPC_URL
  ?? (TESTNET ? 'https://rpc.testnet.chain.robinhood.com' : 'https://rpc.mainnet.chain.robinhood.com');

const pk = process.env.PRIVATE_KEY;
if (!pk) {
  console.error('PRIVATE_KEY is required. Nothing was sent anywhere.');
  process.exit(1);
}

const EMISSION = parseUnits(process.env.EMISSION_PER_ROUND ?? '10', 18);
const POT = parseUnits(process.env.POT_PER_ROUND ?? '5', 18);

const provider = new JsonRpcProvider(RPC);
const wallet = new Wallet(pk, provider);
const net = await provider.getNetwork();
console.log(`deployer ${wallet.address}`);
console.log(`chain    ${net.chainId} via ${RPC}`);
console.log(`balance  ${(await provider.getBalance(wallet.address))} wei`);
console.log(`emission ${EMISSION} /round · offering ${POT} /round (immutable — check twice)`);

// ---- compile ----
const sources = {};
for (const f of ['CainToken.sol', 'Field.sol']) {
  sources[f] = { content: readFileSync(join(root, 'contracts', f), 'utf8') };
}
const compiled = JSON.parse(solc.compile(JSON.stringify({
  language: 'Solidity',
  sources,
  settings: {
    optimizer: { enabled: true, runs: 500 },
    evmVersion: 'paris',
    outputSelection: { '*': { '*': ['evm.bytecode.object', 'abi'] } },
  },
})));
const errs = (compiled.errors || []).filter((e) => e.severity === 'error');
if (errs.length) { errs.forEach((e) => console.error(e.formattedMessage)); process.exit(1); }

// ---- 1. the silicon ----
const netlist = JSON.parse(readFileSync(join(root, 'web', 'netlist.json'), 'utf8'));
const blob = buildBlob(netlist);
console.log(`\n[1/3] deploying the gate table (${blob.length} bytes, ${netlist.gates.length} gates)…`);
const dataTx = await wallet.sendTransaction({ data: '0x' + dataContractCreationCode(blob).toString('hex') });
const dataRcpt = await dataTx.wait();
const netlistAddr = dataRcpt.contractAddress;
console.log(`      gate table at ${netlistAddr} · ${dataRcpt.gasUsed} gas`);

// ---- 2. the token address ----
let tokenAddr = process.env.CABEL_TOKEN;
if (WITH_TEST_TOKEN) {
  console.log('[2/3] deploying the test CainToken (testnet rehearsal only)…');
  const t = compiled.contracts['CainToken.sol'].CainToken;
  const f = new ContractFactory(t.abi, t.evm.bytecode.object, wallet);
  const c = await f.deploy();
  await c.waitForDeployment();
  tokenAddr = await c.getAddress();
  console.log(`      CainToken at ${tokenAddr}`);
} else if (!tokenAddr) {
  console.error('\nCABEL_TOKEN is required (the pons launch address), or pass --with-test-token.');
  console.error('The gate table above IS deployed and can be reused: set NETLIST=' + netlistAddr);
  process.exit(1);
}

// ---- 3. the field ----
console.log('[3/3] deploying the Field…');
const F = compiled.contracts['Field.sol'].Field;
const ff = new ContractFactory(F.abi, F.evm.bytecode.object, wallet);
const field = await ff.deploy(netlistAddr, tokenAddr, EMISSION, POT);
await field.waitForDeployment();
const fieldAddr = await field.getAddress();
console.log(`      Field at ${fieldAddr}`);

// ---- config.js ----
const cfgPath = join(root, 'web', 'config.js');
let cfg = readFileSync(cfgPath, 'utf8');
cfg = cfg.replace(/netlist: '[^']*'/, `netlist: '${netlistAddr}'`);
cfg = cfg.replace(/token: '[^']*'/, `token: '${tokenAddr}'`);
cfg = cfg.replace(/CA: '[^']*'/, `CA: '${tokenAddr}'`);
cfg = cfg.replace(/field: '[^']*'/, `field: '${fieldAddr}'`);
writeFileSync(cfgPath, cfg);
console.log('\nweb/config.js updated. Remaining by hand:');
console.log(`  1. fund the reserve:   CABEL.transfer(${fieldAddr}, reserve)`);
console.log('  2. create match #1 from the workbench (or cast/ethers)');
console.log('  3. upload web/ to Hostinger');
console.log('\nABI written to scripts/field-abi.json');
writeFileSync(join(here, 'field-abi.json'), JSON.stringify(F.abi, null, 2));
