import { BitcoinDeriveError, blockbookXpubParam, SCRIPT_TYPES } from "@folio/bitcoin-derive";
import { type BlockbookClientApi, make as makeBlockbookClient } from "@folio/blockbook-client";
import type { UpstreamError } from "@folio/client-core";
import {
  type BalanceProvider,
  ConnectorAuthError,
  type ConnectorError,
  ConnectorFailure,
  type CredField,
  type Note,
  type ProviderNeeds,
  type Spot,
} from "@folio/connectors-basic";
import { Effect } from "effect";
import { z } from "zod";
import { fromUpstreamError } from "../../upstream";
import { BTC_ADDRESS_RE, EXT_PUBKEY_FULL_RE } from "./constants";
import {
  buildBtcNote,
  buildXpubMeta,
  effectiveScript,
  isExtendedPubkey,
  toBtcBalances,
  toSats,
} from "./parse";

// —— 账户级 creds(AC):地址或扩展公钥 + 可选的脚本类型,都是 public(明文落库、可导出重建)——
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

// **构造是纯的**(这家上游没有闸 —— 它的「重试」是换下一个公共节点,轮询在 client 里)。
const client: BlockbookClientApi = makeBlockbookClient();

// 请求层错误 → connector 错误。**比 `asConnector` 多一条本上游的判据**:
//
// **服务端永久拒(4xx)不可重试。** 无效 xpub 之类的 400 换四个节点还是四个 400,重试是白赔往返。
// client 那层只说「够不到上游」(它没有「这是不是你的错」这个概念),而可不可重试是**消费者的**
// 问题 —— 所以判据落在这里。老那版靠 client 手动标一个 `retryable: false` 布尔表达同一件事;
// 换成 tagged error 之后那个布尔没了,这条判据就得显式写出来(测试抓到过它一度丢了)。
const asBitcoin = <A, R>(
  effect: Effect.Effect<A, UpstreamError, R>,
): Effect.Effect<A, ConnectorError, R> =>
  Effect.mapError(effect, (error) =>
    error._tag === "UpstreamUnavailableError" &&
    error.status !== undefined &&
    error.status >= 400 &&
    error.status < 500
      ? new ConnectorFailure({ message: error.message, cause: error })
      : fromUpstreamError(error),
  );

// 扩展公钥解析不出来 → 「凭据问题」。这是**本地**失败(压根没出网),所以不经 `asConnector` ——
// 那个函数翻译的是请求层的失败。
const derivationIsCredentials = <A, R>(
  effect: Effect.Effect<A, ConnectorError, R>,
): Effect.Effect<A, ConnectorError, R> =>
  Effect.catchAllDefect(effect, (defect) =>
    defect instanceof BitcoinDeriveError
      ? Effect.fail(new ConnectorAuthError({ message: defect.message, cause: defect }))
      : Effect.die(defect),
  );

// xpub 模式:一发拿回整簇地址的汇总 + 各地址明细(details=tokenBalances&tokens=used)。
const fromXpub = (
  ext: string,
  scriptType: string | undefined,
): Effect.Effect<{ balances: Spot[]; note: Note[] }, ConnectorError, ProviderNeeds> =>
  Effect.suspend(() => {
    const script = effectiveScript(ext, scriptType);
    return asBitcoin(client.xpub(blockbookXpubParam(ext, script))).pipe(
      Effect.map((res) => {
        const pendingSats = toSats(res.unconfirmedBalance);
        const { addresses, receive } = buildXpubMeta(ext, script, res.tokens ?? []);
        return {
          balances: toBtcBalances(toSats(res.balance), pendingSats),
          note: buildBtcNote(pendingSats, { addresses, receive }),
        };
      }),
    );
  });

const fromAddress = (
  address: string,
): Effect.Effect<{ balances: Spot[]; note: Note[] }, ConnectorError, ProviderNeeds> =>
  asBitcoin(client.address(address)).pipe(
    Effect.map((res) => {
      const pendingSats = toSats(res.unconfirmedBalance);
      return {
        balances: toBtcBalances(toSats(res.balance), pendingSats),
        note: buildBtcNote(pendingSats),
      };
    }),
  );

export const blockbookProvider: BalanceProvider<
  Spot,
  typeof bitcoinAccountCreds,
  typeof providerCreds
> = {
  id: "blockbook",
  label: "Blockbook",
  creds: providerCreds,

  fetchBalances: (ctx) => {
    const id = ctx.account.creds.addressOrXpub;
    return derivationIsCredentials(
      isExtendedPubkey(id) ? fromXpub(id, ctx.account.creds.scriptType) : fromAddress(id),
    );
  },

  // 轻量探活:地址模式打地址端点;xpub 模式造 token 打 xpub 端点(顺带校验扩展公钥可解析)。
  //
  // 凭据被拒 / xpub 解析不出来 → 成功返回 `false`;够不到上游 → 留在错误通道。
  // **`details: "basic"`** —— 探活不需要各地址明细,少拉一大坨。
  validateAccount: (ctx) => {
    const id = ctx.account.creds.addressOrXpub;
    const probe = Effect.suspend(() =>
      isExtendedPubkey(id)
        ? asBitcoin(
            client.xpub(blockbookXpubParam(id, effectiveScript(id, ctx.account.creds.scriptType)), {
              details: "basic",
            }),
          )
        : asBitcoin(client.address(id)),
    );
    return derivationIsCredentials(probe).pipe(
      Effect.as(true),
      Effect.catchTag("ConnectorAuthError", () => Effect.succeed(false)),
    );
  },
};
