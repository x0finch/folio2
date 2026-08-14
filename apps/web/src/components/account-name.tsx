import { cn } from "@folio/ui";

// 账户名统一展示:前置 `@`(#351 ③)——全站「一个符号 = 一种身份」:tag `#名`、account `@名`、
// connector `logo + 类型名`。`@` 是纯展示前缀、永不入库,紧贴名字(同 `#tag`),与平台名(logo 头像 +
// 公认名)区分。token-sheet 来源行与 perp 场馆子头共用(H5 评审统一)。
export function AccountName({ name, className }: { name: string; className?: string }) {
  return (
    // select-text:账户名是内容(长按复制是全站唯一的复制途径),不随所在的行/卡片一起不可选。
    <span className={cn("flex min-w-0 select-text items-center", className)}>
      <span className="truncate">@{name}</span>
    </span>
  );
}
