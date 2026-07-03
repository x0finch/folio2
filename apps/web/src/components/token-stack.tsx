import { Avatar, AvatarFallback, AvatarGroup, AvatarGroupCount, AvatarImage } from "@folio/ui";
import type { OverviewBalance } from "../lib/account-view";

// 单个代币头像:shadcn Avatar 二次包装 —— 有 logo 显 logo,加载失败/缺失由 AvatarFallback 回退首字母。
export function TokenAvatar({
  symbol,
  logo,
  size = "sm",
}: {
  symbol: string;
  logo?: string;
  size?: "sm" | "default" | "lg";
}) {
  return (
    <Avatar size={size} className="bg-background">
      {/* 代币 logo 多为透明 PNG:底色 bg-background 填满圆,叠压时不透出后面的头像。 */}
      {logo && <AvatarImage src={logo} alt={symbol} className="bg-background" />}
      <AvatarFallback className="text-[10px]">{symbol.slice(0, 1).toUpperCase()}</AvatarFallback>
    </Avatar>
  );
}

// 账户持有代币的层叠头像:按 symbol 去重、按合计美元价值降序;最多 max 个,其余折成 "+N"。
// 层叠由 shadcn AvatarGroup 承担(-space-x-2 + ring),溢出计数用 AvatarGroupCount。
export function TokenStack({ balances, max = 10 }: { balances: OverviewBalance[]; max?: number }) {
  const byToken = new Map<string, { symbol: string; logo?: string; value: number }>();
  for (const b of balances) {
    const key = b.symbol.toUpperCase();
    const cur = byToken.get(key);
    if (cur) cur.value += b.usdValue;
    else byToken.set(key, { symbol: b.symbol, logo: b.logo, value: b.usdValue });
  }
  const tokens = [...byToken.values()].sort((a, b) => b.value - a.value);
  if (tokens.length === 0) return null;

  const shown = tokens.slice(0, max);
  const rest = tokens.length - shown.length;
  return (
    <AvatarGroup>
      {shown.map((t) => (
        <TokenAvatar key={t.symbol} symbol={t.symbol} logo={t.logo} />
      ))}
      {rest > 0 && <AvatarGroupCount className="text-[10px]">+{rest}</AvatarGroupCount>}
    </AvatarGroup>
  );
}
