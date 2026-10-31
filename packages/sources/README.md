# @folio/sources

Every data source Folio reads is a plugin here: one folder, one `defineSource()` call. Plugins
fetch and normalize; they never touch the database, pricing or each other. The sync engine
runs them inside a Durable Object alarm with a subrequest budget.

## The contract

```ts
defineSource({
  id: 'example', // stored with every connection: never rename
  kind: 'wallet', // 'wallet' | 'exchange' | 'perp' | 'manual'
  label: 'Example',
  description: 'One line for the source picker',
  // The form and the stored config. `field()` and `secret()` attach the form metadata;
  // secret fields are encrypted at rest and never returned by the API.
  config: z.object({
    address: field({ title: 'Address', placeholder: '0x…' }),
    apiSecret: secret({ title: 'API secret' }),
  }),
  maxRequests: (config) => 3, // most subrequests one fetch may need
  defaultLabel: (config) => short(config.address),
  validate: async (ctx) => {}, // optional: runs when a connection is saved
  fetchPositions: async (ctx) => [], // returns Position[]
})
```

`ctx` holds the parsed `config` (secrets decrypted), a budgeted `fetch`, a `log` and `now`.
Use `fetchJson(ctx.fetch, url, zodSchema)` for JSON APIs: it validates the answer and maps
HTTP errors to `SourceError` codes (`unauthorized`, `rate_limited`, `upstream`...). Throw
`SourceError('invalid_config', …)` for a config the upstream rejects.

A `Position` names its asset (`coingecko:<id>` or `<chain>:<address>`), an amount as a decimal
string, and a kind (`spot`, `staked`, `lending`, `borrowed`, `reward`, `perp`). Return
`priceUsd` when the venue prices the asset, `valueUsd` when it knows the value better than
amount × price (perp equity), and `perp` details for perp positions.

## Adding a source

1. Create `src/<id>/index.ts` and export the source built with `defineSource()`.
2. Describe the config with `field()` / `secret()`; add `.regex()`/`.refine()` checks for
   addresses so mistakes are caught before any request.
3. Implement `fetchPositions` with `fetchJson` and zod schemas for every upstream answer.
4. Keep `maxRequests` honest: the engine defers a source when less budget is left.
5. Record real upstream answers (redacted) as fixtures in `test/fixtures/<id>/`.
6. Write `test/<id>.test.ts` with `contextFor()` and `fixtureFetch()` from `src/testing.ts`:
   golden positions, error mapping, and that no secret reaches `ctx.log`.
7. List the source in `src/registry.ts`.
8. Add a short section about the upstream (limits, key needed or not) to this README.

The registry test fails if a source has no `test/<id>.test.ts`.

## Sources

- `manual` — holdings entered by hand; no requests.
