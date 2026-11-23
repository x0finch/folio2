import type { DbRequest } from "@folio/db";
import { Oracle } from "@folio/oracle";
import { fiatCodeOf, type TokenRef, tokenTicket } from "@folio/oracle-basic";
import { Clock, Effect, Option } from "effect";

// Routes a batch of tickets to prices: fiat via FX (USD = 1, spot rate, no 24h change), everything else via
// the token price source (`pricesByRefs`). `fiatCodeOf` decides: allow-listed fiat goes to FX, other `fiat/issued:XXX`
// falls back to the token source (just unpriced). Fiat is cache-only and never `fx.warm`s (hourly `fx` job warms
// it); a cold cache drops the fiat ticket and callers degrade to "no price". Only network-free work here: decode,
// route, map back to tickets.

export interface TickerPrice {
  unitPrice: number;
  change24h?: number;
  asOf: number;
}

export interface PricedTicket {
  ticket: string;
  unitPrice: number;
  change24h: number | null;
  asOf: number;
}

export interface PriceTicketsOptions {
  // Namers allowed (current token upstream + `fiat`); tickets from other namers are dropped.
  namers: readonly string[];
}

export const priceTickets = (
  tickets: readonly string[],
  options: PriceTicketsOptions,
): Effect.Effect<PricedTicket[], never, Oracle | DbRequest> =>
  Effect.gen(function* () {
    // Ticket -> ref (undecodable / foreign namer dropped), remembering ref -> ticket; duplicate refs collapse.
    const byRef = new Map<TokenRef, string>();
    for (const ticket of tickets) {
      const ref = tokenTicket.decode(ticket, options.namers);
      if (ref) byRef.set(ref, ticket);
    }
    if (byRef.size === 0) return [];

    const fiatByCode = new Map<string, string>(); // code -> ticket
    const cryptoRefs: TokenRef[] = [];
    for (const [ref, ticket] of byRef) {
      const code = fiatCodeOf(ref);
      if (code) fiatByCode.set(code, ticket);
      else cryptoRefs.push(ref);
    }

    const out: PricedTicket[] = [];

    if (cryptoRefs.length > 0) {
      const priced = yield* Effect.flatMap(Oracle, (o) => o.tokens.pricesByRefs(cryptoRefs));
      for (const [ref, price] of priced) {
        const ticket = byRef.get(ref);
        if (ticket) {
          out.push({
            ticket,
            unitPrice: price.unitPrice,
            change24h: price.change24h ?? null,
            asOf: price.asOf,
          });
        }
      }
    }

    if (fiatByCode.size > 0) {
      const { fx } = yield* Oracle;
      const asOf = yield* Clock.currentTimeMillis;
      for (const [code, ticket] of fiatByCode) {
        const rate = yield* fx.resolve(code);
        if (Option.isSome(rate)) {
          out.push({ ticket, unitPrice: rate.value, change24h: null, asOf });
        }
      }
    }

    return out;
  });
