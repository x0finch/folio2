import {
  BitcoinDeriveError,
  blockbookXpubParam,
  isScriptType,
  makeDeriver,
  recommendedScript,
  SCRIPT_TYPES,
  type ScriptType,
} from "@folio/bitcoin-derive";
import {
  type BlockbookClient,
  BlockbookError,
  createBlockbookClient,
  type XpubToken,
} from "@folio/blockbook-client";
import {
  type BalanceProvider,
  type CredField,
  isCredentialRejection,
  type Note,
  type NoteRow,
  ProviderError,
  type Spot,
} from "@folio/connectors-basic";
import { tokenRef } from "@folio/oracle-ref";
import { z } from "zod";
import { BTC_ADDRESS_RE, EXT_PUBKEY_FULL_RE, EXT_PUBKEY_RE, SATS_PER_BTC } from "./constants";

// BTC xpub 处理的本包局部形状(原 @folio/connectors-basic 的 UtxoAddress/UtxoReceive;
// utxo kind 并回 spot 后这些只服务本包的 Note 组装,不再是公共契约)。
interface BtcAddress {
  address: string;
  path: string; // 派生路径 m/purpose'/0'/0'/chain/index
  chain: "receive" | "change";
  balanceSats: number;
  pendingSats: number;
}
interface BtcReceive {
  lastUsed: { index: number; address: string } | null;
  next: { index: number; address: string }[];
}

// @folio/connectors-provider-blockbook —— 只读 Bitcoin(bitcoin connector)。地址 + xpub 两模式。
// 只做【整合】:取数走 @folio/blockbook-client(Trezor Blockbook,xpub 服务端派生、一次调用),
// token 造型/本地下址派生走 @folio/bitcoin-derive,本包串起值/Note 组装 + 契约映射。
// addressOrXpub(public)= BTC 地址或扩展公钥;裸 xpub 用 scriptType(public)选脚本类型(zpub/ypub 前缀已定,忽略)。
// 值不在此算:provider 只产已确认 BTC amount(value=0),交 app 的 revalue 盯市(token 层唯一价源)。
// 纯包:blockbook-client / bitcoin-derive 均无 cloudflare:workers / env,不碰 SECRETS_KEY(原则 #5)。

// BTC 身份键:bitcoin/native(仅作身份 + 平台归属 → "Bitcoin")。
export const BTC_TOKEN_REF = tokenRef.native("bitcoin");

const toSats = (s: string | undefined): number => {
  const n = Number(s ?? "0");
  return Number.isFinite(n) ? n : 0;
};

// 生效脚本类型:zpub/ypub 前缀权威(忽略 scriptType);裸 xpub 用所选、缺省按 recommendedScript(native)。
function effectiveScript(ext: string, scriptType: string | undefined): ScriptType {
  if (ext.startsWith("zpub") || ext.startsWith("ypub")) return recommendedScript(ext);
  return isScriptType(scriptType) ? scriptType : recommendedScript(ext);
}

// 派生路径尾段 → { chain, index }。形如 m/84'/0'/0'/0/5 → chain=0(外部)、index=5。
function parsePath(path: string): { chain: number; index: number } | null {
  const parts = path.split("/");
  const index = Number(parts[parts.length - 1]);
  const chain = Number(parts[parts.length - 2]);
  if (!Number.isInteger(index) || !Number.isInteger(chain)) return null;
  return { chain, index };
}

// 已确认净额 → amount(BTC);未确认/派生地址等展示细节走 account 级 Note[](buildBtcNote),不落 balance。
// 既无已确认又无未确认 → 空(无持仓);仅未确认仍产一行(amount=0 + Note 里 pending 段)。
// BTC 并回 spot(ADR 0010):吐 kind:"spot"、零 meta;value=0 交 revalue 盯市。
function toBtcBalances(confirmedSats: number, pendingSats: number): Spot[] {
  if (confirmedSats <= 0 && pendingSats === 0) return [];
  return [
    {
      symbol: "BTC",
      amount: confirmedSats / SATS_PER_BTC,
      value: 0, // 交给 revalue 盯市(amount × BTC 市价)
      kind: "spot",
      tokenRef: BTC_TOKEN_REF,
    },
  ];
}

// Blockbook xpub 响应 → 分布(仅非零)+ 收款指引(lastUsed 外部最大已用;next 本地派生其后两个)。
function buildXpubMeta(
  ext: string,
  script: ScriptType,
  tokens: XpubToken[],
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
        pendingSats: 0, // Blockbook 不给逐地址未确认;账户级 pending 走顶层
      });
    }
    // tokens=used → 返回的都是已用地址;取外部链(chain 0)最大下标作 lastUsed。
    if (parsed.chain === 0 && (!lastExternal || parsed.index > lastExternal.index)) {
      lastExternal = { index: parsed.index, address: t.name };
    }
  }

  // next:外部链 lastUsed 之后两个(本地派生,不出网 → 保隐私)。
  const derive = makeDeriver(ext, script);
  const base = lastExternal ? lastExternal.index + 1 : 0;
  const next = [base, base + 1].map((index) => ({ index, address: derive(0, index) }));

  return { addresses, receive: { lastUsed: lastExternal, next } };
}

// BTC 钱包展示 note(note 重设计,account 级 Note[]):从同一份取数造多段(仅供展示),整钱包一份,
// 顶层随 fetchBalances 返回(不挂 balance)。前端渲染成持仓区手风琴,一段一个 item。
//  · Unconfirmed:账户净未确认额一行(仅非零;icon warning)。
//  · Receive addresses:收款指引(最近用过 + 下一批未使用,地址行 + mempool 外链)。
//  · Receive/Change distribution:非零派生地址按链拆两 section(地址行 value+unit+href)。
const mempoolAddr = (address: string): string => `https://mempool.space/address/${address}`;

function buildBtcNote(
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

    // 收款指引:最近用过(如有)+ 下一批未使用地址。
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

    // 派生分布:仅非零地址,按 receive/change 链拆两 section。
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

const isExtendedPubkey = (id: string): boolean => EXT_PUBKEY_RE.test(id);

// 客户端/派生错误 → provider 契约(sync 据 ProviderError 重试)。
function toProviderError(err: unknown): ProviderError {
  if (err instanceof ProviderError) return err;
  if (err instanceof BlockbookError) {
    // **保留 retryable** —— 客户端会把「非 401/403/429 的 4xx」(如无效 xpub 的 400)标成
    // UPSTREAM_ERROR + retryable:false;不透传就会被 ProviderError 按 code 重算成 true,
    // 于是一个永久 400 被反复重试(validateAccount 与 fetchBalances 都受影响)。
    return new ProviderError(err.code, err.message, {
      retryable: err.retryable,
      retryAfterMs: err.retryAfterMs,
      cause: err,
    });
  }
  if (err instanceof BitcoinDeriveError) {
    return new ProviderError("INVALID_CREDENTIALS", err.message, { cause: err });
  }
  return new ProviderError("UPSTREAM_ERROR", "bitcoin provider failed", { cause: err });
}

async function fetchXpub(
  client: BlockbookClient,
  ext: string,
  scriptType: string | undefined,
): Promise<{ balances: Spot[]; note: Note[] }> {
  const script = effectiveScript(ext, scriptType);
  const res = await client.getXpub(blockbookXpubParam(ext, script)); // details=tokenBalances&tokens=used
  const pendingSats = toSats(res.unconfirmedBalance);
  const { addresses, receive } = buildXpubMeta(ext, script, res.tokens ?? []);
  const balances = toBtcBalances(toSats(res.balance), pendingSats);
  return { balances, note: buildBtcNote(pendingSats, { addresses, receive }) };
}

// —— 账户级 creds(AC):BTC 地址或扩展公钥,public(明文落库、可导出重建)——
// addressOrXpub:地址(1…/3…/bc1…)或 xpub/ypub/zpub;scriptType:仅裸 xpub 用(zpub/ypub 前缀已定、单地址无关),缺省由 recommendedScript 兜底。
// 账户 creds 声明随 provider(其天然消费者)落此;将来同 connector 多 provider 时提到 entry 共享。
export const bitcoinAccountCreds = [
  {
    key: "addressOrXpub",
    type: "public",
    label: "Bitcoin address or xpub",
    desc: "address (1…/3…/bc1…) or xpub/ypub/zpub",
    validator: z.string().refine((v) => BTC_ADDRESS_RE.test(v) || EXT_PUBKEY_FULL_RE.test(v), {
      message: "expected a BTC address or extended public key",
    }),
  },
  {
    key: "scriptType",
    type: "public",
    label: "Address type",
    validator: z.enum(SCRIPT_TYPES).optional(),
  },
] as const satisfies readonly CredField[];

// —— provider 级 creds(PC):空 —— Blockbook 公共实例免 key,开箱即用。
const providerCreds = [] as const satisfies readonly CredField[];

export const blockbookProvider: BalanceProvider<
  Spot,
  typeof bitcoinAccountCreds,
  typeof providerCreds
> = {
  id: "blockbook",
  label: "Blockbook",
  creds: providerCreds,

  async fetchBalances(ctx): Promise<{ balances: Spot[]; note?: Note[] }> {
    const id = ctx.account.creds.addressOrXpub;
    const client = createBlockbookClient();
    try {
      if (isExtendedPubkey(id)) return await fetchXpub(client, id, ctx.account.creds.scriptType);
      const res = await client.getAddress(id);
      const pendingSats = toSats(res.unconfirmedBalance);
      const balances = toBtcBalances(toSats(res.balance), pendingSats);
      return { balances, note: buildBtcNote(pendingSats) };
    } catch (err) {
      throw toProviderError(err);
    }
  },

  // 轻量探活:地址模式打地址端点;xpub 模式造 token 打 xpub 端点(顺带校验扩展公钥可解析)。
  // 凭据被拒 / xpub 解析不出来(INVALID_CREDENTIALS)→ false;够不到上游 → 抛 ProviderError
  // (经 toProviderError 归一,与 fetchBalances 同口径;契约见 connector.ts / errors.ts)。
  async validateAccount(ctx): Promise<boolean> {
    const id = ctx.account.creds.addressOrXpub;
    const client = createBlockbookClient();
    try {
      if (isExtendedPubkey(id)) {
        await client.getXpub(
          blockbookXpubParam(id, effectiveScript(id, ctx.account.creds.scriptType)),
          { details: "basic" },
        );
      } else {
        await client.getAddress(id);
      }
      return true;
    } catch (err) {
      const pe = toProviderError(err);
      if (isCredentialRejection(pe)) return false;
      throw pe;
    }
  },
};
