import type { TokenInfo } from "@folio/tokens";
import { Input } from "@folio/ui";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { ChevronDownIcon, CircleAlertIcon, Loader2Icon, SearchXIcon, XIcon } from "lucide-react";
import { useDeferredValue, useState } from "react";
import { useTranslations } from "use-intl";
import { matchSegments } from "../lib/highlight";
import { searchTokens, topTokens } from "../lib/server/tokens";

// manual 选币的内联 Combobox(A4,替代 TokenPicker 的全屏 CommandPalette 浮层):点触发器**就地下推**展开
// 搜索框 + 结果列表(在文档流内、把下方字段推下去,不叠第二层遮罩)。接口与 TokenPicker 对齐(value/onChange/
// onManual),故可直接替入 ManualFields。命中子串高亮走 matchSegments(design token,禁硬编码色)。
// 默认列 topTokens,输入远程搜 searchTokens(仅展开时启用,竞态由 query key 天然处理),搜不到可转手动录入。

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

// 一行代币:logo + symbol + name(触发器与结果行共用)。
function TokenRow({ token, query }: { token: TokenInfo; query?: string }) {
  return (
    <>
      {token.logo ? (
        <img src={token.logo} alt="" className="size-5 shrink-0 rounded-full" />
      ) : (
        <span className="size-5 shrink-0 rounded-full bg-muted" />
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

  // 展开:就地下推 —— 搜索框 + 结果列表在文档流内,顶开下方字段(不绝对定位、不叠遮罩、不裁切)。
  if (open) {
    return (
      <div className="flex flex-col gap-1.5">
        {/* combobox 由用户点击展开 → 聚焦搜索框(Input 为自定义组件,不触发原生 autofocus a11y 规则)。 */}
        <Input
          autoFocus
          value={query}
          onChange={(v) => setQuery(v)}
          placeholder={t("searchTokenPlaceholder")}
        />
        <div className="max-h-52 overflow-y-auto rounded-xl border border-border bg-card p-1">
          {tokensQuery.isError ? (
            <div className="flex flex-col items-center gap-2 px-3 py-6 text-center text-destructive text-sm">
              <CircleAlertIcon className="size-5" />
              {t("searchFailed")}
            </div>
          ) : tokens.length > 0 ? (
            tokens.map((token) => (
              <button
                key={`${token.ref.source}:${token.ref.identifier}`}
                type="button"
                onClick={() => pick(token)}
                className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm transition-colors hover:bg-muted"
              >
                <TokenRow token={token} query={search} />
              </button>
            ))
          ) : tokensQuery.isLoading ? (
            <div className="flex items-center justify-center px-3 py-6 text-muted-foreground">
              <Loader2Icon className="size-5 animate-spin" aria-label={t("searching")} />
            </div>
          ) : (
            <div className="flex flex-col items-center gap-2 px-3 py-6 text-center text-muted-foreground text-sm">
              <SearchXIcon className="size-5" />
              {t("noResults")}
              {search && (
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
              )}
            </div>
          )}
        </div>
      </div>
    );
  }

  // 收起:触发器 —— 选中则显示代币行 + 清除叉,否则占位。点击展开。
  return (
    <button
      type="button"
      onClick={() => {
        setQuery("");
        setOpen(true);
      }}
      className="flex h-11 w-full items-center gap-2 rounded-full border border-border bg-background px-3.5 text-sm outline-none transition-colors hover:border-foreground/40 focus-visible:ring-2 focus-visible:ring-ring/40"
    >
      {value ? (
        <span className="flex min-w-0 flex-1 items-center gap-2">
          <TokenRow token={value} />
        </span>
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
  );
}
