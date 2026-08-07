import { maybe } from "@folio/client-core";
import { Schema } from "effect";

// Trezor Blockbook v2 响应(仅取用到的字段)。金额一律 satoshi 字符串。
//
// 字段一个没动 —— 换的是「谁说了算」:以前是 `interface` + 一次 `as`(声明而已,运行时没人查),
// 现在是 schema,类型从它推出来,上游改了形状当场就是 `UpstreamParseError`。

// xpub 的一个派生地址(details=tokenBalances 时带 balance;tokens=used → 仅已用地址)。
export const XpubToken = Schema.Struct({
  name: Schema.String, // 地址
  path: Schema.String, // 派生路径 m/purpose'/0'/0'/chain/index
  transfers: Schema.Number,
  balance: Schema.String, // 已确认(satoshi 串)
  totalReceived: maybe(Schema.String),
  totalSent: maybe(Schema.String),
});
export type XpubToken = typeof XpubToken.Type;

// GET /api/v2/xpub/{token}?details=tokenBalances&tokens=used —— 服务端派生 + 汇总。
export const XpubResponse = Schema.Struct({
  address: Schema.String, // 回显的 xpub/descriptor
  balance: Schema.String, // 账户已确认总额(satoshi 串,Blockbook 已汇总)
  unconfirmedBalance: Schema.String, // 账户净未确认(satoshi 串)
  // **这两个是可选的,不是必填** —— 老那份 `interface` 把它们写成必填,而录制的真实响应里
  // 压根没有 `unconfirmedTxs`。校验一上来这条谎话当场就现形了(golden fixture 直接红)。
  unconfirmedTxs: maybe(Schema.Number),
  txs: maybe(Schema.Number),
  usedTokens: maybe(Schema.Number),
  tokens: maybe(Schema.Array(XpubToken)), // 已用派生地址(带余额)
});
export type XpubResponse = typeof XpubResponse.Type;

// GET /api/v2/address/{addr}
export const AddressResponse = Schema.Struct({
  address: Schema.String,
  balance: Schema.String,
  unconfirmedBalance: Schema.String,
  unconfirmedTxs: maybe(Schema.Number),
  txs: maybe(Schema.Number),
});
export type AddressResponse = typeof AddressResponse.Type;
