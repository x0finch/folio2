import type { TokenInfo } from "@folio/tokens";
import { CommandPalette } from "@folio/ui";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { ChevronDownIcon, CircleAlertIcon, SearchXIcon, XIcon } from "lucide-react";
import { useDeferredValue, useState } from "react";
import { useTranslations } from "use-intl";
import { matchSegments } from "../lib/highlight";
import { searchTokens, topTokens } from "../lib/server/tokens";

// 命中子串背景高亮(design token,禁硬编码色)。
function Highlighted({ text, query }: { text: string; query: string }) {
  return (
    <>
      {matchSegments(text, query).map((seg, i) =>
        seg.match ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: positional segments, static per render
          <span key={i} className="rounded-sm bg-accent text-accent-foreground">
            {seg.text}
          </span>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: positional segments, static per render
          <span key={i}>{seg.text}</span>
        ),
      )}
    </>
  );
}

// 一行代币展示:logo + symbol + name(选中触发器与列表行共用)。
function TokenRow({ token, query }: { token: TokenInfo; query?: string }) {
  return (
    <>
      {token.logo ? (
        <img src={token.logo} alt="" className="h-5 w-5 shrink-0 rounded-full" />
      ) : (
        <span className="h-5 w-5 shrink-0 rounded-full bg-muted" />
      )}
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

// manual 选币(beui #07):点触发器打开全屏 ⌘K 面板;默认列 topTokens,输入远程搜 searchTokens,
// 命中高亮,选中回调 onChange(父组件据此自动填价);搜不到可 onManual 手动录入。
export function TokenPicker({
  value,
  onChange,
  onManual,
}: {
  value: TokenInfo | null;
  onChange: (token: TokenInfo | null) => void;
  onManual: (query: string) => void;
}) {
  const t = useTranslations("Accounts");
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const search = useDeferredValue(query.trim());

  const tokensQuery = useQuery({
    queryKey: ["tokens", search],
    queryFn: () => (search ? searchTokens({ data: { query: search } }) : topTokens({ data: {} })),
    enabled: open,
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  });
  const tokens = tokensQuery.data ?? [];

  const pick = (token: TokenInfo) => {
    onChange(token);
    setOpen(false);
    setQuery("");
  };

  return (
    <>
      {/* 触发器:选中则显示代币行 + 清除叉;否则占位提示。点击打开全屏面板。 */}
      <button
        type="button"
        onClick={() => {
          setQuery("");
          setOpen(true);
        }}
        className="flex h-11 w-full items-center gap-2 rounded-full border border-border bg-background px-3.5 text-sm outline-none transition-colors hover:border-foreground/40 focus-visible:ring-2 focus-visible:ring-ring/40"
      >
        {value ? (
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <TokenRow token={value} />
          </div>
        ) : (
          <span className="flex-1 text-left text-muted-foreground">
            {t("searchTokenPlaceholder")}
          </span>
        )}
        {value ? (
          <XIcon
            className="size-4 shrink-0 text-muted-foreground hover:text-foreground"
            onClick={(e) => {
              e.stopPropagation();
              onChange(null);
            }}
          />
        ) : (
          <ChevronDownIcon className="size-4 shrink-0 text-muted-foreground" />
        )}
      </button>

      <CommandPalette
        open={open}
        onOpenChange={setOpen}
        query={query}
        onQueryChange={setQuery}
        placeholder={t("searchTokenPlaceholder")}
        loading={tokensQuery.isLoading}
      >
        {tokensQuery.isError ? (
          <div className="flex flex-col items-center gap-2 px-3 py-8 text-center text-sm text-destructive">
            <CircleAlertIcon className="size-5" />
            {t("searchFailed")}
          </div>
        ) : tokens.length > 0 ? (
          tokens.map((token) => (
            <button
              key={`${token.ref.source}:${token.ref.identifier}`}
              type="button"
              onClick={() => pick(token)}
              className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm text-foreground transition-colors hover:bg-muted"
            >
              <TokenRow token={token} query={search} />
            </button>
          ))
        ) : (
          <div className="flex flex-col items-center gap-2 px-3 py-8 text-center text-sm text-muted-foreground">
            <SearchXIcon className="size-5" />
            {t("noResults")}
            {search ? (
              <button
                type="button"
                onClick={() => {
                  onManual(search);
                  setOpen(false);
                }}
                className="font-medium text-foreground underline underline-offset-2"
              >
                {t("customEntry", { query: search })}
              </button>
            ) : null}
          </div>
        )}
      </CommandPalette>
    </>
  );
}
