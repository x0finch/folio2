import { type AccountType, typeLabel } from "../lib/account-types";

// 账户类型徽章:统一的 muted 小标(仅 shadcn 设计 token,不用任意色值)。列表行与详情头共用。
export function AccountTypeBadge({ type }: { type: AccountType }) {
  return (
    <span className="rounded-sm bg-muted px-1.5 py-0.5 text-xs font-medium text-muted-foreground">
      {typeLabel(type)}
    </span>
  );
}
