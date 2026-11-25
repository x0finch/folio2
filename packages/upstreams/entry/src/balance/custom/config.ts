import { Result, Schema } from "effect";
import {
  ADDRESS_PLACEHOLDER,
  FORBIDDEN_HEADER_PREFIXES,
  FORBIDDEN_HEADERS,
  MAX_DOT_PATH_LENGTH,
  MAX_HOST_LENGTH,
  MAX_NAME_LENGTH,
  MAX_PATH_LENGTH,
  MAX_QUERY_PARAMS,
  MAX_QUERY_VALUE_LENGTH,
  PAGE_PLACEHOLDER,
  PRIVATE_SUFFIXES,
} from "./constants";

const IPV4 = /^\d+(?:\.\d+){3}$/;
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
// An all-digit last label is what makes `127.1` or `0x7f.1` resolve as an address.
const TLD = /^(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;

/** Why a host may not be called, or undefined. `ownHost` is the deployment's own hostname. */
export function hostProblem(host: string, ownHost?: string): string | undefined {
  if (host.includes(":") || host.includes("[") || IPV4.test(host)) {
    return "IP literals are not allowed";
  }
  if (host.length > MAX_HOST_LENGTH) return "host is too long";
  const labels = host.split(".");
  if (labels.length < 2) return "single-label hosts are not allowed";
  if (!labels.every((label) => LABEL.test(label))) {
    return "host must be a lowercase hostname, without scheme, port or path";
  }
  if (!TLD.test(labels[labels.length - 1] ?? "")) return "host must end in a top-level domain";
  if (PRIVATE_SUFFIXES.some((suffix) => host.endsWith(`.${suffix}`))) {
    return "private network names are not allowed";
  }
  if (ownHost && (host === ownHost || host.endsWith(`.${ownHost}`))) {
    return "this deployment's own domain is not allowed";
  }
  return undefined;
}

/** The hostname of the deployment's origin, or undefined when it isn't a URL. */
export const hostOfOrigin = (origin: string | undefined): string | undefined =>
  origin && URL.canParse(origin) ? new URL(origin).hostname.toLowerCase() : undefined;

const Host = Schema.String.check(Schema.makeFilter((host: string) => hostProblem(host)));

// Path characters only: `?` and `#` are out; queries go in `query`, `auth` and `pagination`.
const PATH_CHARS = /^\/[A-Za-z0-9\-._~!$&'()*+,;=:@%/{}]*$/;
const PLACEHOLDER = /\{[^}]*\}/g;

function pathProblem(path: string): string | undefined {
  if (path.length > MAX_PATH_LENGTH) return "path is too long";
  if (!PATH_CHARS.test(path)) return "path must start with / and hold no query, fragment or spaces";
  if (path.startsWith("//")) return "path must not start with //";
  // URL parsing turns `%2e` into a dot segment and some servers decode `%2f` into a separator.
  if (/%2[ef]/i.test(path)) return "path must not encode dots or slashes";
  if (path.split("/").some((segment) => segment === "." || segment === "..")) {
    return "path must not contain . or .. segments";
  }
  const placeholders = path.match(PLACEHOLDER) ?? [];
  const known = [ADDRESS_PLACEHOLDER, PAGE_PLACEHOLDER];
  if (placeholders.some((p) => !known.includes(p))) {
    return `path placeholders are ${known.join(" and ")} only`;
  }
  if (path.replace(PLACEHOLDER, "").match(/[{}]/)) return "path has an unclosed placeholder";
  return undefined;
}

const PathTemplate = Schema.String.check(Schema.makeFilter((path: string) => pathProblem(path)));

// Segments of word characters; a numeric segment indexes an array.
const DOT_PATH = /^[A-Za-z0-9_$-]+(?:\.[A-Za-z0-9_$-]+)*$/;
const DotPath = Schema.String.check(
  Schema.makeFilter(
    (path: string) =>
      (path.length <= MAX_DOT_PATH_LENGTH && DOT_PATH.test(path)) ||
      "expected a dot path like data.items",
  ),
);

const QUERY_NAME = /^[A-Za-z0-9_.\-[\]]+$/;
const QueryName = Schema.String.check(
  Schema.makeFilter(
    (name: string) =>
      (name.length <= MAX_NAME_LENGTH && QUERY_NAME.test(name)) || "invalid query parameter name",
  ),
);

// Plain text plus `{address}`; the value is URL-encoded when sent.
const QUERY_VALUE = /^[A-Za-z0-9\-._~:,{}]*$/;
const QueryValue = Schema.String.check(
  Schema.makeFilter(
    (value: string) =>
      (value.length <= MAX_QUERY_VALUE_LENGTH &&
        QUERY_VALUE.test(value) &&
        (value.match(PLACEHOLDER) ?? []).every((p) => p === ADDRESS_PLACEHOLDER)) ||
      `query values are plain text and ${ADDRESS_PLACEHOLDER} only`,
  ),
);
const FixedQuery = Schema.Record(QueryName, QueryValue).check(
  Schema.makeFilter(
    (query: Readonly<Record<string, string>>) =>
      Object.keys(query).length <= MAX_QUERY_PARAMS ||
      `at most ${MAX_QUERY_PARAMS} query parameters`,
  ),
);

const HEADER_NAME = /^[A-Za-z][A-Za-z0-9-]*$/;
function headerProblem(name: string): string | undefined {
  if (name.length > MAX_NAME_LENGTH || !HEADER_NAME.test(name)) return "invalid header name";
  const lower = name.toLowerCase();
  if (FORBIDDEN_HEADERS.has(lower) || FORBIDDEN_HEADER_PREFIXES.some((p) => lower.startsWith(p))) {
    return `the key can't be sent in ${name}`;
  }
  return undefined;
}
const HeaderName = Schema.String.check(Schema.makeFilter((name: string) => headerProblem(name)));

const Auth = Schema.Union([
  Schema.Literals(["none", "bearer"]),
  Schema.Struct({ header: HeaderName }),
  Schema.Struct({ query: QueryName }),
]);

// `page`: a page number in `{page}` or in `param`; stops at the first empty page.
// `cursor`: the value at `next` in each response goes back in `param`; stops when it is missing.
const Pagination = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("page"),
    param: Schema.optional(QueryName),
    start: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1 }))),
  }),
  Schema.Struct({ type: Schema.Literal("cursor"), param: QueryName, next: DotPath }),
]);

// Dot paths into each row. With `decimals`, `amount` is a raw integer in the smallest unit.
const Fields = Schema.Struct({
  symbol: DotPath,
  amount: DotPath,
  decimals: Schema.optional(DotPath),
  chain: Schema.optional(DotPath),
  contract: Schema.optional(DotPath),
  name: Schema.optional(DotPath),
  price: Schema.optional(DotPath),
});

const BaseConfig = Schema.Struct({
  host: Host,
  path: PathTemplate,
  // Fixed query parameters, e.g. `{ "chain": "eth" }`.
  query: Schema.optional(FixedQuery),
  auth: Schema.optional(Auth),
  pagination: Schema.optional(Pagination),
  // Dot path to the row array; absent when the body is the array.
  rows: Schema.optional(DotPath),
  fields: Fields,
});

function crossProblems(config: typeof BaseConfig.Type): Schema.FilterIssue[] {
  const issues: Schema.FilterIssue[] = [];
  const { pagination, auth, fields } = config;
  const inPath = config.path.includes(PAGE_PLACEHOLDER);
  if (pagination?.type === "page" && inPath === (pagination.param !== undefined)) {
    issues.push({
      path: ["pagination"],
      issue: `page goes in either ${PAGE_PLACEHOLDER} or param`,
    });
  }
  if (pagination?.type !== "page" && inPath) {
    issues.push({ path: ["path"], issue: `${PAGE_PLACEHOLDER} needs page pagination` });
  }
  if (typeof auth === "object" && "query" in auth && auth.query === pagination?.param) {
    issues.push({ path: ["auth"], issue: "the key and the page share a query parameter" });
  }
  const fixed = Object.keys(config.query ?? {});
  const authQuery = typeof auth === "object" && "query" in auth ? auth.query : undefined;
  for (const name of [authQuery, pagination?.param]) {
    if (name !== undefined && fixed.includes(name)) {
      issues.push({ path: ["query", name], issue: "already set by auth or pagination" });
    }
  }
  if (fields.contract !== undefined && fields.chain === undefined) {
    issues.push({ path: ["fields", "contract"], issue: "contract needs chain" });
  }
  return issues;
}

export const CustomConfig = BaseConfig.check(Schema.makeFilter(crossProblems));
export type CustomConfig = typeof CustomConfig.Type;
export type CustomAuth = NonNullable<CustomConfig["auth"]>;

// Typos in a hand-written config fail instead of being dropped.
const STRICT = { onExcessProperty: "error" } as const;
const decodeJson = Schema.decodeUnknownResult(Schema.fromJsonString(CustomConfig), STRICT);

/** Decodes a stored config string; the failure is a message for the account form. */
export const decodeCustomConfig = (
  raw: unknown,
):
  | { readonly ok: true; readonly config: CustomConfig }
  | { readonly ok: false; readonly message: string } => {
  const result = decodeJson(raw);
  return Result.isSuccess(result)
    ? { ok: true, config: result.success }
    : { ok: false, message: result.failure.message.replace(/\n\s*/g, " ") };
};
