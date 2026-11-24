// Hyperliquid API constants. Only what the request layer needs: the address regex (`accountCreds` validation) belongs to the adapter.

// Who this is: goes into every error's `upstream` field.
export const UPSTREAM = "hyperliquid";

export const HYPERLIQUID_API_BASE = "https://api.hyperliquid.xyz";
// All read-only queries go through one info endpoint (POST + JSON body naming the type).
export const INFO_PATH = "/info";
// Perp account state (margin summary + positions), body: { type, user }.
export const CLEARINGHOUSE_TYPE = "clearinghouseState";

// No rate gate: the test is whether several calls compete for one quota, not whether the upstream rate-limits.
// REST quota is per egress IP at 1200 weight/min, and info requests like `clearinghouseState` weigh 2 (~600/min). One request per
// account and sync concurrency at most 6 gives a peak of 6, so a gate would never block anything (a full bucket forever): decoration, not protection.
// Source: https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/rate-limits-and-user-limits
// Redo this arithmetic if calls start going per coin or per position.
