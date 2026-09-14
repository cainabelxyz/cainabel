// SINGLE SOURCE OF TRUTH — swap the CA by editing this one file and
// uploading it. It is loaded with a Date.now() cache-buster, so it is always
// fresh: no ?v bump, no cache purge needed for a CA swap.
window.CFG = {
  // the $CABEL contract address. '' shows SOON on the site; the BUY link
  // works either way (it points at the pons launchpad page).
  CA: '',
  PONS: 'https://www.ponsfamily.com/launchpad/',

  launchAtUTC: '2026-09-16T16:00:00Z',

  chain: {
    name: 'Robinhood Chain',
    id: 4663,
    rpc: 'https://rpc.mainnet.chain.robinhood.com',
    explorer: 'https://robinhoodchain.blockscout.com',
  },
  testnet: {
    name: 'Robinhood Chain Testnet',
    id: 46630,
    rpc: '',
    explorer: '',
  },

  // deployed addresses — scripts/deploy.js fills these in
  addresses: {
    netlist: '',
    token: '',
    field: '',
  },

  token: {
    name: 'CAIN & ABEL',
    symbol: 'CABEL',
    supply: '1,000,000,000',
  },

  links: {
    x: 'https://x.com/cainabelxyz',
    telegram: 'https://t.me/cainabelxyz',
    github: 'https://github.com/cainabelxyz/cainabel',
  },
};
