import type { TokenInfo } from "@folio/tokens";
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from "@folio/ui";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { CircleAlertIcon, LoaderCircleIcon, SearchXIcon, XIcon } from "lucide-react";
import { useDeferredValue, useRef, useState } from "react";
import { useTranslations } from "use-intl";
import { matchSegments } from "../lib/highlight";
import { searchTokens, topTokens } from "../lib/server/tokens";

// 下拉的三种非列表态:统一居中的小块,图标 + 文案。搜索态/错误态横排,空态纵排 + 行动按钮。
function StatusBlock({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div
      className={`flex flex-col items-center justify-center gap-2 px-3 py-6 text-center text-sm ${className ?? ""}`}
    >
      {children}
    </div>
  );
}

function TokenListLoading() {
  const t = useTranslations("Accounts");
  return (
    <StatusBlock className="text-muted-foreground">
      <LoaderCircleIcon className="size-5 animate-spin" />
      {t("searching")}
    </StatusBlock>
  );
}

function TokenListError() {
  const t = useTranslations("Accounts");
  return (
    <StatusBlock className="text-destructive">
      <CircleAlertIcon className="size-5" />
      {t("searchFailed")}
    </StatusBlock>
  );
}

function TokenListEmpty({ query, onManual }: { query: string; onManual: (query: string) => void }) {
  const t = useTranslations("Accounts");
  return (
    <StatusBlock className="text-muted-foreground">
      <SearchXIcon className="size-5" />
      {t("noResults")}
      {query ? (
        <button
          type="button"
          onClick={() => onManual(query)}
          className="font-medium text-foreground underline underline-offset-2"
        >
          {t("customEntry", { query })}
        </button>
      ) : null}
    </StatusBlock>
  );
}

// 命中子串背景高亮:matchSegments 给数据,这里只做渲染(design token,禁硬编码色 / 任意值)。
function Highlighted({ text, query }: { text: string; query: string }) {
  return (
    <>
      {matchSegments(text, query).map((seg, i) =>
        seg.match ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: segments are positional, list is static per render
          <span key={i} className="rounded-sm bg-accent text-accent-foreground">
            {seg.text}
          </span>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: segments are positional, list is static per render
          <span key={i}>{seg.text}</span>
        ),
      )}
    </>
  );
}

// 一行代币展示:logo + symbol + name。选中态(覆盖层)与下拉选项共用 → 选中后展示 = 选项。
function TokenRow({ token, query }: { token: TokenInfo; query?: string }) {
  return (
    <>
      {token.logo && <img src={token.logo} alt="" className="h-5 w-5 shrink-0 rounded-full" />}
      <span className="shrink-0 font-medium">
        {query ? (
          <Highlighted text={token.symbol.toUpperCase()} query={query} />
        ) : (
          token.symbol.toUpperCase()
        )}
      </span>
      <span className="truncate text-muted-foreground">
        {query ? <Highlighted text={token.name} query={query} /> : token.name}
      </span>
    </>
  );
}

// manual 选币(P7.4.5):Base UI Combobox 输入框式。输入框常驻;选中后在同位叠富展示(TokenRow,与选项同款)
// + 右侧叉叉;点富展示重新展开搜索。数据走 useQuery(空词=topTokens,有词=searchTokens),无 useEffect。
export function TokenCombobox({
  value,
  onChange,
  onManual,
}: {
  value: TokenInfo | null;
  onChange: (token: TokenInfo | null) => void;
  onManual: (query: string) => void;
}) {
  const t = useTranslations("Accounts");
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  // 防抖式:延迟值作为查询键,快速输入时少发请求(无需 useEffect + setTimeout)。
  const search = useDeferredValue(query.trim());
  const tokensQuery = useQuery({
    queryKey: ["tokens", search],
    queryFn: () => (search ? searchTokens({ data: { query: search } }) : topTokens({ data: {} })),
    enabled: open, // 只在下拉打开时取
    placeholderData: keepPreviousData, // 切词时保留上次结果,不闪空
    staleTime: 60_000,
  });
  const tokens = tokensQuery.data ?? [];

  const focusInput = (clear = false) => {
    const input = boxRef.current?.querySelector("input");
    requestAnimationFrame(() => {
      if (!input) return;
      if (clear) input.value = ""; // 兜底清空(不只依赖受控 state)
      input.focus();
      if (!clear) input.select(); // 预填 symbol 时全选,便于一键替换
    });
  };

  // 点叉叉 → 清除选中,清空搜索词,展开下拉重新选。
  const clearSelection = (e: React.MouseEvent) => {
    e.stopPropagation();
    onChange(null);
    setQuery("");
    setOpen(true);
    focusInput(true);
  };

  const isSelectedAndClosed = value !== null && !open;

  // 选中态覆盖层:整体 pointer-events-none —— 点击「穿透」到底下的输入框,由 Combobox 自身的 openOnInputClick
  //(与空态同一条打开路径,稳定不闪)展开下拉;富展示纯视觉。只有右侧叉叉恢复 pointer-events 供清除。
  const selectedOverlay = isSelectedAndClosed ? (
    <div className="pointer-events-none absolute inset-0 flex items-center gap-2 rounded-md border border-input bg-background pr-2 pl-3 text-sm">
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <TokenRow token={value} />
      </div>
      <button
        type="button"
        aria-label={t("clearToken")}
        onClick={clearSelection}
        className="pointer-events-auto shrink-0 rounded-sm p-0.5 text-muted-foreground hover:text-foreground focus-visible:outline-none"
      >
        <XIcon className="size-4" />
      </button>
    </div>
  ) : null;

  const dropdownBody = tokensQuery.isError ? (
    <TokenListError />
  ) : tokensQuery.isLoading ? (
    <TokenListLoading />
  ) : (
    <>
      <ComboboxList>
        {(token: TokenInfo) => (
          <ComboboxItem key={`${token.ref.source}:${token.ref.identifier}`} value={token}>
            <TokenRow token={token} query={search} />
          </ComboboxItem>
        )}
      </ComboboxList>
      <ComboboxEmpty>
        <TokenListEmpty query={search} onManual={onManual} />
      </ComboboxEmpty>
    </>
  );

  return (
    <Combobox
      items={tokens}
      value={value}
      onValueChange={(token: TokenInfo | null) => onChange(token)}
      open={open}
      onOpenChange={setOpen}
      inputValue={query}
      onInputValueChange={setQuery}
      filter={null}
      openOnInputClick
      // 选中后不把 symbol 回填进搜索框(输入框被富展示覆盖,不需要显示;返回 ""):否则 query 变成 symbol,
      // 再次点开会以该 symbol 为关键词搜索,而非回到无输入的 top-N 默认列表。
      itemToStringLabel={() => ""}
      isItemEqualToValue={(a: TokenInfo, b: TokenInfo) => a?.ref.identifier === b?.ref.identifier}
    >
      {/* 输入框常驻;选中且下拉关闭时,在同位叠富展示覆盖层(点它重新展开)。 */}
      <div ref={boxRef} className="relative">
        <ComboboxInput
          className="w-full"
          placeholder={t("searchTokenPlaceholder")}
          onFocus={(e) => e.currentTarget.select()} // 重开选中项时全选,便于一键替换
        />
        {selectedOverlay}
      </div>
      <ComboboxContent>{dropdownBody}</ComboboxContent>
    </Combobox>
  );
}
