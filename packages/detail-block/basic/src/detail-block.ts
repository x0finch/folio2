import { z } from "zod";

// 【DetailBlock —— provider 专属展示明细的结构化块】(ADR 0010,词汇表 v1)
// detail 是 Balance 上「仅供展示、无共享逻辑读」的一袋块(`detail?: DetailBlock[]`,落 BalanceBase)。
// 每块自带「画法(判别式 `type`)+ 结构化数据」,随数据一起走 —— 无独立 spec、无 registry、无路径绑定。
//   · `type` 是画法原语(stat/keyValue/addressList),**不是**业务身份(前端永不判断 BTC/CEX)。
//   · 值结构化(数字即数字,不预格式化成串);格式由块的 `format` 声明、**前端做** → 跟随显示币种/locale。
//   · 标签用 **i18n key 字符串**(不写死文案)→ 前端解析,跟随中英双语。
// 本包 React-free:provider(server)import 拼块受编译期形状检查,前端(@folio/detail-block)import 渲染。
// schema 是事实源,类型一律 `z.infer`(勿反向注解)。

// 展示格式枚举:声明结构化值该被前端渲染成哪种显示串(跟随显示币种 / locale)。
//   sats/btc:比特币金额(sats = 以聪计,btc = 以 BTC 计);usd:法币金额(跟随显示币种换算);
//   percent:百分比;date:时间戳;address:链上地址(前端可中缩)。
export const DetailFormat = z.enum(["sats", "btc", "usd", "percent", "date", "address"]);

// stat:带标签的单个数值(如账户净未确认额)。label 是 i18n key;value 结构化;format 声明画法。
export const StatBlock = z.object({
  type: z.literal("stat"),
  label: z.string(), // i18n key
  value: z.number(),
  format: DetailFormat,
});

// keyValue 的一项:label(i18n key)+ 结构化 value。数字项带 format(声明画法);
// 与语言/币种无关的字符串项(地址、协议名等)可省 format,前端原样呈现(address 除外,可中缩)。
export const KeyValueItem = z.object({
  label: z.string(), // i18n key
  value: z.union([z.number(), z.string()]),
  format: DetailFormat.optional(),
});

// keyValue:键值对列表(如 CEX 的 locked / available)。可选块级 label(i18n key,作分区标题)。
export const KeyValueBlock = z.object({
  type: z.literal("keyValue"),
  label: z.string().optional(), // i18n key
  items: z.array(KeyValueItem),
});

// addressList 的一项:地址 + 可选派生信息(xpub 派生地址表 / 收款指引)。
export const AddressItem = z.object({
  address: z.string(),
  path: z.string().optional(), // 派生路径 m/…
  index: z.number().optional(), // 派生 index
  balanceSats: z.number().optional(),
  pendingSats: z.number().optional(),
});

// addressList:地址列表(自带复制 / 二维码,交互烘进原语)。qr 开则每项渲染二维码。
export const AddressListBlock = z.object({
  type: z.literal("addressList"),
  label: z.string().optional(), // i18n key
  items: z.array(AddressItem),
  qr: z.boolean().optional(),
});

// 词汇表 v1(封闭):stat / keyValue / addressList。table / note 按真实需求后加(ADR 0010)。
export const DetailBlock = z.discriminatedUnion("type", [
  StatBlock,
  KeyValueBlock,
  AddressListBlock,
]);

export type DetailFormat = z.infer<typeof DetailFormat>;
export type DetailBlock = z.infer<typeof DetailBlock>;
export type DetailBlockType = DetailBlock["type"];
export type StatBlock = z.infer<typeof StatBlock>;
export type KeyValueBlock = z.infer<typeof KeyValueBlock>;
export type KeyValueItem = z.infer<typeof KeyValueItem>;
export type AddressListBlock = z.infer<typeof AddressListBlock>;
export type AddressItem = z.infer<typeof AddressItem>;
