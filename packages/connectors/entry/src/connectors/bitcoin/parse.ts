import {
  isScriptType,
  makeDeriver,
  recommendedScript,
  type ScriptType,
} from "@folio/bitcoin-derive";
import type { XpubToken } from "@folio/blockbook-client";
import type { Note, NoteRow, Spot } from "@folio/connectors-basic";
import { tokenRef } from "@folio/oracle-ref";
import { EXT_PUBKEY_RE, SATS_PER_BTC } from "./constants";

interface BtcAddress {
  address: string;
  path: string; // m/purpose'/0'/0'/chain/index
  chain: "receive" | "change";
  balanceSats: number;
  pendingSats: number;
}
interface BtcReceive {
  lastUsed: { index: number; address: string } | null;
  next: { index: number; address: string }[];
}

const BTC_TOKEN_REF = tokenRef.native("bitcoin");

export const toSats = (s: string | undefined): number => {
  const n = Number(s ?? "0");
  return Number.isFinite(n) ? n : 0;
};

// zpub/ypub prefixes fix the script type; a bare xpub uses the chosen one or the recommended default.
export function effectiveScript(ext: string, scriptType: string | undefined): ScriptType {
  if (ext.startsWith("zpub") || ext.startsWith("ypub")) return recommendedScript(ext);
  return isScriptType(scriptType) ? scriptType : recommendedScript(ext);
}

// m/84'/0'/0'/0/5 → { chain: 0 (external), index: 5 }
function parsePath(path: string): { chain: number; index: number } | null {
  const parts = path.split("/");
  const index = Number(parts[parts.length - 1]);
  const chain = Number(parts[parts.length - 2]);
  if (!Number.isInteger(index) || !Number.isInteger(chain)) return null;
  return { chain, index };
}

// Confirmed amount only, value 0 (priced at market later). Pending-only still yields a row with
// amount 0 so the unconfirmed note has something to hang on.
export function toBtcBalances(confirmedSats: number, pendingSats: number): Spot[] {
  if (confirmedSats <= 0 && pendingSats === 0) return [];
  return [
    {
      symbol: "BTC",
      amount: confirmedSats / SATS_PER_BTC,
      value: 0,
      kind: "spot",
      tokenRef: BTC_TOKEN_REF,
    },
  ];
}

// Non-zero addresses plus receive guidance: lastUsed = highest used external index; next = the
// two after it, derived locally so no address lookup leaves the device.
export function buildXpubMeta(
  ext: string,
  script: ScriptType,
  tokens: readonly XpubToken[],
): { addresses: BtcAddress[]; receive: BtcReceive } {
  const addresses: BtcAddress[] = [];
  let lastExternal: { index: number; address: string } | null = null;

  for (const t of tokens) {
    const parsed = parsePath(t.path);
    if (!parsed) continue;
    const balanceSats = toSats(t.balance);
    if (balanceSats > 0) {
      addresses.push({
        address: t.name,
        path: t.path,
        chain: parsed.chain === 0 ? "receive" : "change",
        balanceSats,
        pendingSats: 0, // Blockbook has no per-address pending; account pending is top-level
      });
    }
    // tokens=used, so every returned address has been used.
    if (parsed.chain === 0 && (!lastExternal || parsed.index > lastExternal.index)) {
      lastExternal = { index: parsed.index, address: t.name };
    }
  }

  const derive = makeDeriver(ext, script);
  const base = lastExternal ? lastExternal.index + 1 : 0;
  const next = [base, base + 1].map((index) => ({ index, address: derive(0, index) }));

  return { addresses, receive: { lastUsed: lastExternal, next } };
}

const mempoolAddr = (address: string): string => `https://mempool.space/address/${address}`;

export function buildBtcNote(
  pendingSats: number,
  xpub?: { addresses: BtcAddress[]; receive: BtcReceive },
): Note[] {
  const sections: Note[] = [];

  if (pendingSats !== 0) {
    sections.push({
      title: "Unconfirmed",
      icon: "warning",
      content: [{ label: "Pending", value: pendingSats / SATS_PER_BTC, unit: "BTC" }],
    });
  }

  if (xpub) {
    const { addresses, receive } = xpub;

    const receiveRows: NoteRow[] = [];
    if (receive.lastUsed) {
      receiveRows.push({
        label: `Last used #${receive.lastUsed.index}`,
        value: receive.lastUsed.address,
        href: mempoolAddr(receive.lastUsed.address),
      });
    }
    for (const n of receive.next) {
      receiveRows.push({
        label: `Next #${n.index}`,
        value: n.address,
        href: mempoolAddr(n.address),
      });
    }
    if (receiveRows.length > 0) {
      sections.push({ title: "Receive addresses", icon: "info", content: receiveRows });
    }

    const distRow = (a: BtcAddress): NoteRow => ({
      label: a.address,
      value: a.balanceSats / SATS_PER_BTC,
      unit: "BTC",
      href: mempoolAddr(a.address),
    });
    const receiveDist = addresses.filter((a) => a.chain === "receive").map(distRow);
    const changeDist = addresses.filter((a) => a.chain === "change").map(distRow);
    if (receiveDist.length > 0) {
      sections.push({ title: "Receive distribution", icon: "info", content: receiveDist });
    }
    if (changeDist.length > 0) {
      sections.push({ title: "Change distribution", icon: "info", content: changeDist });
    }
  }

  return sections;
}

export const isExtendedPubkey = (id: string): boolean => EXT_PUBKEY_RE.test(id);
