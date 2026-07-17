import { cn } from "@folio/ui";
import { WalletIcon } from "lucide-react";

// 账户名统一展示:前置 WalletIcon 微图标(与侧栏「Accounts」导航同图标)——全站「带钱包图标的 = 账户」,
// 与平台名(logo 头像 + 公认名)区分。asset-sheet 来源行与 perp 场馆子头共用(H5 评审统一)。
export function AccountName({ name, className }: { name: string; className?: string }) {
  return (
    <span className={cn("flex min-w-0 items-center gap-1", className)}>
      <WalletIcon className="size-3 shrink-0 text-muted-foreground" />
      <span className="truncate">{name}</span>
    </span>
  );
}
