export const SATS_PER_BTC = 100_000_000;

// Mainnet shape check only (prefix / charset / length); checksums are verified on encoding.
export const BTC_ADDRESS_RE = /^(bc1[a-z0-9]{11,87}|[13][a-km-zA-HJ-NP-Z1-9]{25,39})$/;
export const EXT_PUBKEY_RE = /^(xpub|ypub|zpub)/;
// Rules out EVM 0x addresses and junk.
export const EXT_PUBKEY_FULL_RE = /^(xpub|ypub|zpub)[1-9A-HJ-NP-Za-km-z]{100,115}$/;
