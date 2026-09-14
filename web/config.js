// Chain + contract configuration. Filled in at deploy time by
// scripts/deploy.js — everything the site reads on-chain goes through this
// file and a public RPC, so there is no server anywhere.
export const CONFIG = {
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

  // deployed addresses — empty until scripts/deploy.js fills them in
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
    github: 'https://github.com/',              // update with the public repo
    trade: '',                                  // pons pair URL once live
  },
};
