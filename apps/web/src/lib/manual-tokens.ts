// manual 加账户表单首 token 标量 → 单元素 `tokens` JSON(manual 的 account.creds,ADR 0017)。
// 数字保持字符串(由 manualToken validator coerce);ticket 空则省略键(视为可选)。
// 纯逻辑、无 React/server 依赖 → 可单测,且不把 server-only 模块拉进组件测试。
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
