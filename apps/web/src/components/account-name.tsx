import { cn } from "@folio/ui";

// 账户名统一展示:前置 `@`(#351 ③)——全站「一个符号 = 一种身份」:tag `#名`、account `@名`、
// connector `logo + 类型名`。`@` 是纯展示前缀、永不入库,紧贴名字(同 `#tag`),与平台名(logo 头像 +
// 公认名)区分。asset-sheet 来源行与 perp 场馆子头共用(H5 评审统一)。
export function AccountName({ name, className }: { name: string; className?: string }) {
  return (
    <span className={cn("flex min-w-0 items-center", className)}>
      <span className="truncate">@{name}</span>
    </span>
  );
}
