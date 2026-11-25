import type { Spot } from "@folio/connectors-basic";
import { tokenRef } from "@folio/oracle-ref";
import { valueAt } from "./api";
import type { CustomConfig } from "./config";
import { ID, MAX_DECIMALS, MAX_REF_PART_LENGTH, MAX_SYMBOL_LENGTH } from "./constants";

export type Row = Spot;

const NUMERIC = /^-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?$/;
const RAW_INTEGER = /^\d+$/;
// A `/` would split the ref into three segments; whitespace never appears in a namer or address.
const NAMER = /^[A-Za-z0-9][A-Za-z0-9:_.-]*$/;
const ADDRESS = /^[A-Za-z0-9:_.-]+$/;

const numberOf = (value: unknown): number | undefined => {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string" || !NUMERIC.test(value.trim())) return undefined;
  return Number(value.trim());
};

const textOf = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;

// String arithmetic: a raw 18-decimal balance is past 2^53 and `Number(raw) / 10 ** 18` would round
// before scaling.
function scaleRaw(raw: unknown, decimals: unknown): number | undefined {
  const digits =
    typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 0
      ? String(raw)
      : typeof raw === "string" && RAW_INTEGER.test(raw.trim())
        ? raw.trim()
        : undefined;
  const places = numberOf(decimals);
  if (digits === undefined || places === undefined) return undefined;
  if (!Number.isInteger(places) || places < 0 || places > MAX_DECIMALS) return undefined;
  const padded = digits.padStart(places + 1, "0");
  const point = padded.length - places;
  return Number(`${padded.slice(0, point)}.${padded.slice(point) || "0"}`);
}

const refPart = (value: unknown, shape: RegExp): string | undefined => {
  const text = textOf(value);
  return text && text.length <= MAX_REF_PART_LENGTH && shape.test(text) ? text : undefined;
};

// Never `issued:`: nothing vouches for a user-defined source's names.
function refOf(row: unknown, config: CustomConfig, host: string, symbol: string): string {
  const { chain: chainPath, contract: contractPath } = config.fields;
  const chain = chainPath && refPart(valueAt(row, chainPath), NAMER);
  if (chain) {
    const rawContract = contractPath ? valueAt(row, contractPath) : undefined;
    if (textOf(rawContract) === undefined) return tokenRef.native(chain);
    const contract = refPart(rawContract, ADDRESS);
    if (contract) return tokenRef.contract(chain, contract);
  }
  return tokenRef.custom(ID, `${host}:${symbol}`);
}

// The account is marked to market: a coin the market prices is revalued at sync and on display;
// the source's own price only values a coin the market doesn't know.
export function parseRows(
  rows: readonly unknown[],
  config: CustomConfig,
): { balances: Row[]; readable: number } {
  const { fields, host } = config;
  const balances: Row[] = [];
  let readable = 0;
  for (const row of rows) {
    const symbol = textOf(valueAt(row, fields.symbol));
    if (!symbol || symbol.length > MAX_SYMBOL_LENGTH || symbol.includes("/")) continue;
    const rawAmount = valueAt(row, fields.amount);
    const amount =
      fields.decimals === undefined
        ? numberOf(rawAmount)
        : scaleRaw(rawAmount, valueAt(row, fields.decimals));
    if (amount === undefined) continue;
    readable++;
    // Spot holdings only: an empty or negative row is not something this account holds.
    if (amount <= 0) continue;
    const price = fields.price === undefined ? undefined : numberOf(valueAt(row, fields.price));
    const name = fields.name === undefined ? undefined : textOf(valueAt(row, fields.name));
    balances.push({
      kind: "spot",
      symbol,
      amount,
      ...(price !== undefined && price > 0 ? { price, value: amount * price } : { value: 0 }),
      tokenRef: refOf(row, config, host, symbol),
      ...(name ? { name } : {}),
    });
  }
  return { balances, readable };
}
