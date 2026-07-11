import { z } from "zod";

// 【DetailSection —— provider 专属、账户级、仅供展示的「分组列表」】(DetailBlock 重设计)
// detail 不再挂 Balance,而是账户级:provider.fetchBalances 返回 { balances, detail? };
// 落账户快照层(snapshots.detail 列),前端 <BalanceDetail sections> 用 bouncy-accordion 渲染,
// 每 section = 一个手风琴 item。无共享逻辑读它 —— 纯展示。
// 一种 row、一种 section:无 `type` 判别、无 `format` 枚举。icon 为 5 个中性状态名 → lucide 命名图标。
// label/title 为英文字面串(结构保留,将来可 i18n);value 结构化(数即数),locale 格式化由前端注入的
// formatNumber 做。schema 是事实源,类型一律 z.infer(勿反向注解)。

// 中性状态图标名(缺省 / 未知 → "info")。前端映射到 lucide 命名图标。
export const DetailIcon = z.enum(["info", "success", "warning", "error", "help"]);

// 分组内的一行:label(标签)+ 可选 value(数字金额 或 文本/地址)+ 可选 unit(数字单位符号)
// + 可选 href(外链,如地址 → mempool)。裸联合,接受。
export const DetailRow = z.object({
  label: z.string(),
  value: z.union([z.string(), z.number()]).optional(),
  unit: z.string().optional(),
  href: z.string().optional(),
});

// 一个分组 = 手风琴的一个 item。title = item 标题;icon 中性状态名;
// content 为纯文本段(string)或行列表(DetailRow[])。裸联合,接受。
export const DetailSection = z.object({
  title: z.string(),
  icon: DetailIcon.optional(),
  content: z.union([z.string(), z.array(DetailRow)]),
});

export type DetailIcon = z.infer<typeof DetailIcon>;
export type DetailRow = z.infer<typeof DetailRow>;
export type DetailSection = z.infer<typeof DetailSection>;
