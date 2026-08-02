import { z } from "zod";

// 【Note —— provider 专属、仅供展示的「分段」】(note 重设计,两级)
// 一个 Note = 一段:状态 icon + 标题 + content(行列表 或 纯文本)。纯展示,无共享逻辑读它。
// 两级挂载(见 balance.ts / connector.ts):
//   · account 级 `Note[]`(整钱包,BTC:未确认/收款/派生分布) → 前端持仓区手风琴,一段一个 item;
//     `fetchBalances` 顶层返回 + 落 snapshots.note(JSON)。
//   · balance 级单个 `Note`(这笔持仓,CEX:该币锁仓/冻结) → 前端行标题右侧小 icon + hover popover;
//     挂 Balance.note,落 snapshot_balances.note(JSON)。
// 一种 row、一种 section:无 `type` 判别、无 `format` 枚举。icon 为 5 个中性状态名 → 前端映射 lucide 命名图标。
// label/title 英文字面串(结构保留,将来可 i18n);value 结构化(数即数),locale 格式化由前端注入的
// formatNumber 做。schema 是事实源,类型一律 z.infer(勿反向注解)。
// 注:与 manual 账本的用户备注 `memo` 是两回事 —— 这里的 note 是 provider 生成的展示块。

// 中性状态图标名(缺省 / 未知 → "info")。前端映射到 lucide 命名图标。
export const NoteIcon = z.enum(["info", "success", "warning", "error", "help"]);

// 分段内的一行:label(标签)+ 可选 value(数字金额 或 文本/地址)+ 可选 unit(数字单位符号)
// + 可选 href(外链,如地址 → mempool)。裸联合,接受。
export const NoteRow = z.object({
  label: z.string(),
  value: z.union([z.string(), z.number()]).optional(),
  unit: z.string().optional(),
  href: z.string().optional(),
});

// 一个 Note = 一段。title = 段标题;icon 中性状态名(段首状态图标);
// content 为纯文本段(string)或行列表(NoteRow[])。裸联合,接受。
export const Note = z.object({
  title: z.string(),
  icon: NoteIcon.optional(),
  content: z.union([z.string(), z.array(NoteRow)]),
  // 抽屉按钱包分 tab 的**分组标记**(CEX 多钱包:funding / earn…)。**不渲染**(NoteView/NoteIndicator
  // 只吃 title/icon/content),仅供账户抽屉读它归 tab —— ADR 0030「钱包只活抽屉」的最轻落地:复用已
  // 贯通的 note 列(随 note JSON 落库/读回),免 core 表加列 + 迁移。
  group: z.string().optional(),
});

export type NoteIcon = z.infer<typeof NoteIcon>;
export type NoteRow = z.infer<typeof NoteRow>;
export type Note = z.infer<typeof Note>;
