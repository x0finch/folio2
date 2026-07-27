import { cn, Input } from "@folio/ui";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { ChevronDownIcon, CircleAlertIcon, Loader2Icon, SearchXIcon, XIcon } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import { useTranslations } from "use-intl";
import { matchSegments } from "../lib/highlight";
import { useDebouncedValue } from "../lib/hooks/use-debounced-value";
import { listTokens, listTopTokens } from "../lib/server/tokens";
import type { TokenOption } from "../lib/token-option";

// manual 选币的内联 Combobox(A4,替代 TokenPicker 的全屏 CommandPalette 浮层):点触发器**就地下推**展开
// 搜索框 + 结果列表(在文档流内、把下方字段推下去,不叠第二层遮罩)。接口与 TokenPicker 对齐(value/onChange/
// onManual),故可直接替入 ManualFields。命中子串高亮走 matchSegments(design token,禁硬编码色)。
// 默认列 topTokens,输入远程搜 searchTokens(仅展开时启用,竞态由 query key 天然处理),搜不到可转手动录入。
// 开合平滑:结果层 Framer 动 height:auto+opacity,承载它的 MorphingModal 面板内容驱动、自然 reflow 跟随。
// 键盘:↑↓ 移高亮、Enter 选中/转手动、Esc 收起;点组件外亦收起(均保留当前值,不改选)。

// 同 beUI 的 EASE_OUT 动效 token 曲线(@folio/ui 未导出 lib/ease → 本地镜像同一 cubic-bezier)。
const EASE_OUT = [0.16, 1, 0.3, 1] as const;

// 搜索节流:停顿 250ms 才发,且需 ≥2 字符(否则退回 topTokens 默认列,不打 CGK /search)。
const SEARCH_DEBOUNCE_MS = 250;
const MIN_SEARCH_LEN = 2;

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
function TokenRow({ token, query }: { token: TokenOption; query?: string }) {
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
  value: TokenOption | null;
  onChange: (token: TokenOption | null) => void;
  onManual: (query: string) => void;
}) {
  const t = useTranslations("Accounts");
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  // 防抖 + 最小长度:CGK /search 慢且限流(见 server/tokens),故停顿 250ms 后才搜,且 <2 字符不搜(退回
  // topTokens 默认列,读本地 store 快)—— 把逐键的上游请求压成「停顿后一次」。
  const debounced = useDebouncedValue(query.trim(), SEARCH_DEBOUNCE_MS);
  const search = debounced.length >= MIN_SEARCH_LEN ? debounced : "";
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const tokensQuery = useQuery({
    queryKey: ["tokens", search],
    queryFn: () => (search ? listTokens({ data: { query: search } }) : listTopTokens({ data: {} })),
    enabled: open,
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  });
  const tokens = tokensQuery.data ?? [];

  const pick = (token: TokenOption) => {
    onChange(token);
    setOpen(false);
    setQuery("");
  };

  // 结果集变化 → 高亮归位首行(避免 active 越界指向不存在的行)。
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset active whenever the visible result set changes
  useEffect(() => {
    setActive(0);
  }, [search, open]);

  // 展开时:点击组件外 → 收起(保留当前值,不改选)。
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open]);

  // 键盘高亮行滚入可视区(列表内滚动,不惊动外层)。active 作触发器,不在 body 直接读。
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-run to scroll the newly-active row into view
  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>('[data-active="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!open) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(tokens.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (tokens[active]) pick(tokens[active]);
      else if (search) {
        onManual(search);
        setOpen(false);
      }
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation(); // 只收起 combobox,不冒泡去关整个 modal
      setOpen(false);
    }
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: keydown is delegated from the inner input/buttons; combobox role lives on the field
    <div ref={rootRef} onKeyDown={onKeyDown} className="flex flex-col gap-1.5">
      {open ? (
        // combobox 由用户点击展开 → 聚焦搜索框(Input 为自定义组件,不触发原生 autofocus a11y 规则)。
        <Input
          autoFocus
          value={query}
          onChange={(v) => setQuery(v)}
          placeholder={t("searchTokenPlaceholder")}
        />
      ) : (
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
            <span className="min-w-0 flex-1 truncate text-left text-muted-foreground">
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
      )}

      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.18, ease: EASE_OUT }}
            className="overflow-hidden"
          >
            <div
              ref={listRef}
              className="max-h-52 overflow-y-auto rounded-xl border border-border bg-card p-1"
            >
              {tokensQuery.isError ? (
                <div className="flex flex-col items-center gap-2 px-3 py-6 text-center text-destructive text-sm">
                  <CircleAlertIcon className="size-5" />
                  {t("searchFailed")}
                </div>
              ) : tokens.length > 0 ? (
                tokens.map((token, i) => (
                  <button
                    key={token.ticket}
                    type="button"
                    data-active={i === active}
                    onPointerMove={() => setActive(i)}
                    onClick={() => pick(token)}
                    className={cn(
                      "flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm transition-colors",
                      i === active && "bg-muted",
                    )}
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
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
