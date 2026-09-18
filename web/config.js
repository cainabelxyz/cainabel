// SINGLE SOURCE OF TRUTH — swap the CA by editing this one file and
// uploading it. It is loaded with a Date.now() cache-buster, so it is always
// fresh: no ?v bump, no cache purge needed for a CA swap.
window.CFG = {
  // the $CABEL contract address. '' shows SOON on the site; the BUY link
  // works either way (it points at Argus).
  CA: '0xf742BC0821EaC50f3c474E22F46Bf63CB8bb8c10',
  BUY: 'https://argus.world/token/',

  launchAtUTC: '2026-09-18T17:30:00Z',

  chain: {
    name: 'Arc',
    id: 5042,
    rpc: 'https://rpc.mainnet.arc.io',
    explorer: 'https://arcexplorer.org',
    // Arc pays gas in USDC; natively it carries 18 decimals
    currency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
  },
  testnet: {
    name: 'Arc Testnet',
    id: 5042002,
    rpc: 'https://rpc.testnet.arc.network',
  },

  // deployed addresses — scripts/deploy.js fills these in
  addresses: {
    netlist: '',
    token: '0xf742BC0821EaC50f3c474E22F46Bf63CB8bb8c10',
    field: '',
  },

  token: {
    name: 'CAINABEL',
    symbol: 'CABEL',
  },

  links: {
    x: 'https://x.com/cainabelxyz',
    telegram: 'https://t.me/cainabelxyz',
    github: 'https://github.com/cainabelxyz/cainabel',
  },
};
