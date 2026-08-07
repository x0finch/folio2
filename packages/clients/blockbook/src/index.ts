// @folio/blockbook-client —— Trezor Blockbook v2 的请求层。
//
// 只跟上游说话,**不带任何 folio 语义** —— satoshi 串转数字、UTXO 汇总、`tokenRef` 命名
// 全在适配层(ADR 0036)。
//
// 这家上游的特点:**没有凭据**(公共节点),而**限流的应对是换下一个节点、不是排队等** ——
// 所以本包没有速率闸,轮询循环就是它的「重试」。
export {
  BlockbookClient,
  type BlockbookClientApi,
  type BlockbookConfig,
  make,
  type XpubQuery,
} from "./client";
export { BLOCKBOOK_BASES, USER_AGENT } from "./constants";
export type { AddressResponse, XpubResponse, XpubToken } from "./types";
