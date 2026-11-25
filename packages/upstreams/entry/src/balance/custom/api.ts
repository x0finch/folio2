import { type UpstreamError, type UpstreamNeeds, UpstreamParseError } from "@folio/upstream-basic";
import { Effect, Schema } from "effect";
import type { Call } from "../../runtime/define";
import type { RequestOptions } from "../../runtime/http";
import type { CustomAuth, CustomConfig } from "./config";
import { ADDRESS_PLACEHOLDER, ID, MAX_PAGES, type OWN_ORIGIN, PAGE_PLACEHOLDER } from "./constants";

// Own properties only: a path like `__proto__.x` must not walk into prototypes.
export function valueAt(body: unknown, path: string): unknown {
  let at: unknown = body;
  for (const segment of path.split(".")) {
    if (at === null || typeof at !== "object" || !Object.hasOwn(at, segment)) return undefined;
    at = (at as Record<string, unknown>)[segment];
  }
  return at;
}

interface Target {
  readonly config: CustomConfig;
  readonly apiKey?: string;
  readonly address?: string;
}

const keyPlacement = (auth: CustomAuth, key: string | undefined): RequestOptions => {
  if (auth === "none" || key === undefined) return {};
  if (auth === "bearer") return { headers: Effect.succeed({ authorization: `Bearer ${key}` }) };
  if ("header" in auth) return { headers: Effect.succeed({ [auth.header]: key }) };
  return { query: { [auth.query]: key } };
};

const pathFor = (config: CustomConfig, address: string | undefined, page: number): string =>
  config.path
    .replaceAll(ADDRESS_PLACEHOLDER, encodeURIComponent(address ?? ""))
    .replaceAll(PAGE_PLACEHOLDER, String(page));

const fixedQuery = (config: CustomConfig, address: string | undefined): Record<string, string> =>
  Object.fromEntries(
    Object.entries(config.query ?? {}).map(([name, value]) => [
      name,
      value.replaceAll(ADDRESS_PLACEHOLDER, address ?? ""),
    ]),
  );

const hasRows = (body: unknown, config: CustomConfig): boolean =>
  Array.isArray(config.rows === undefined ? body : valueAt(body, config.rows));

const rowsOf = (body: unknown, config: CustomConfig, where: string) => {
  const rows = config.rows === undefined ? body : valueAt(body, config.rows);
  return Array.isArray(rows)
    ? Effect.succeed(rows as readonly unknown[])
    : Effect.fail(new UpstreamParseError({ upstream: ID, where, cause: "rows is not an array" }));
};

const cursorOf = (body: unknown, path: string): string | undefined => {
  const next = valueAt(body, path);
  if (typeof next === "number" && Number.isFinite(next)) return String(next);
  return typeof next === "string" && next !== "" ? next : undefined;
};

// Why the walk stopped short of a clear last page: the page cap, or a page seen before.
export type Incomplete = "page-cap" | "repeated";

/** Every row across the pages read, and why the read may be incomplete. */
export const fetchRows = (
  call: Call<never, typeof OWN_ORIGIN>,
  { config, apiKey, address }: Target,
): Effect.Effect<{ rows: unknown[]; incomplete?: Incomplete }, UpstreamError, UpstreamNeeds> =>
  Effect.gen(function* () {
    const { pagination } = config;
    const auth = keyPlacement(config.auth ?? "none", apiKey);
    const rows: unknown[] = [];
    let page = pagination?.type === "page" ? (pagination.start ?? 1) : 0;
    let cursor: string | undefined;
    // A source that ignores the page parameter, or whose pages or cursors cycle, serves rows it
    // already sent; stop there rather than count holdings twice. Only a second page equal to the
    // first is a clean end (the parameter was ignored); a later repeat leaves the read uncertain.
    const seenCursors = new Set<string>();
    const seenPages = new Set<string>();
    for (let read = 0; read < MAX_PAGES; read++) {
      const path = pathFor(config, address, page);
      const query: Record<string, string | number | undefined> = {
        ...fixedQuery(config, address),
        ...auth.query,
      };
      if (pagination?.type === "page" && pagination.param) query[pagination.param] = page;
      if (pagination?.type === "cursor") query[pagination.param] = cursor;
      // Past the first page, a 404 or a body without rows is how many sources say "no more".
      const later = read > 0;
      const body = yield* call.request(path, Schema.Unknown, {
        ...auth,
        query,
        ...(later ? { notFoundAsNull: true as const } : {}),
      });
      if (later && (body === null || !hasRows(body, config))) return { rows };
      const pageRows = yield* rowsOf(body, config, path);
      const pageKey = JSON.stringify(pageRows);
      if (pageRows.length > 0 && seenPages.has(pageKey)) {
        return read > 1 ? { rows, incomplete: "repeated" } : { rows };
      }
      seenPages.add(pageKey);
      rows.push(...pageRows);

      if (pagination === undefined) return { rows };
      if (pagination.type === "page") {
        if (pageRows.length === 0) return { rows };
        page++;
      } else {
        const next = cursorOf(body, pagination.next);
        if (next === undefined || seenCursors.has(next) || next === cursor) {
          return { rows };
        }
        if (cursor !== undefined) seenCursors.add(cursor);
        cursor = next;
      }
    }
    return { rows, incomplete: "page-cap" };
  });
