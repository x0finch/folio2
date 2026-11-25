// The current upstream's naming identity: `id` plus its curated table. A separate port, not a face of `TokenUpstream`: mint needs these two
// and "no network on the write path" is a type fact, so depending on the whole `TokenUpstream` would wire the read path's network face in.
// `overrides`: symbol to this upstream's coin id (majors + known collisions), wins over market-cap rank; it holds one vendor's ids, so the adapter supplies it.
export interface Namer {
  readonly id: string;
  readonly overrides: Readonly<Record<string, string>>;
}
