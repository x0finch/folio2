// manual 加账户表单首 token 标量 → 单元素 creds.tokens JSON(ADR 0017)。
// 与消费它的 <ManualFields> 同目录、单列一个文件:account-fields.tsx 引了 server function,
// 内联进去会把这段纯逻辑的单测拖进 server-only 依赖链(见 vitest.config.ts 的 logic/dom 分项)。
export function manualTokensJson(fields: {
  symbol: string;
  unitPrice: string;
  amount: string;
  ticket?: string;
}): string {
  const entry: Record<string, string> = {
    symbol: fields.symbol,
    unitPrice: fields.unitPrice,
    amount: fields.amount,
  };
  if (fields.ticket) entry.ticket = fields.ticket;
  return JSON.stringify([entry]);
}
