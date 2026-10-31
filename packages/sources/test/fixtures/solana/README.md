Recorded on 2026-10-31 with curl for `86xCnPeV69n6t3DnyGvkKobf9FdN2H9oiVDdaMpo2MMY`:

- `balance.json`: `getBalance` on `https://api.mainnet-beta.solana.com`, full answer.
- `token-accounts.json`, `token-2022-accounts.json`: `getTokenAccountsByOwner` (jsonParsed) for
  the Token and Token-2022 programs. The wallet holds about 1,100 token accounts (mostly
  airdrops), so the `value` arrays are trimmed to 8 and 5 real accounts picked to cover the
  cases: priced, dust, unpriced, zero balance, NFT (0 decimals) and a Token-2022 UI-multiplier
  amount (MCDx).
- `jupiter-search.json`: `GET https://lite-api.jup.ag/tokens/v2/search?query=<mints>` for
  exactly the fungible, non-zero mints of the trimmed accounts, full answer.
