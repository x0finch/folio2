// Contract tokens below this USD value are dropped (native coins exempt); rabby has no server-side
// trash filter. Measured on one address: $1 halves the rows (907 → 444) losing $104 (0.01%).
export const DUST_USD = 1;

export const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
