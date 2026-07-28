import { TOP_TOKENS_LIMIT } from "@folio/oracle2";
import { cn, Input } from "@folio/ui";
import { useQuery } from "@tanstack/react-query";
import { ChevronDownIcon, CircleAlertIcon, Loader2Icon, SearchXIcon, XIcon } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import { useTranslations } from "use-intl";
import { matchSegments } from "../lib/highlight";
import { useDebouncedValue } from "../lib/hooks/use-debounced-value";
import { listTokenCatalogue, listTokens } from "../lib/server/tokens";
import type { TokenOption } from "../lib/token-option";
import { mergeSearchResults, needsRemoteSearch, searchCatalogue } from "../lib/token-search";

// manual 选币的内联 Combobox(A4,替代 TokenPicker 的全屏 CommandPalette 浮层):点触发器**就地下推**展开
// 搜索框 + 结果列表(在文档流内、把下方字段推下去,不叠第二层遮罩)。接口与 TokenPicker 对齐(value/onChange/
// onManual),故可直接替入 ManualFields。命中子串高亮走 matchSegments(design token,禁硬编码色)。
// 开合平滑:结果层 Framer 动 height:auto+opacity,承载它的 MorphingModal 面板内容驱动、自然 reflow 跟随。
// 键盘:↑↓ 移高亮、Enter 选中/转手动、Esc 收起;点组件外亦收起(均保留当前值,不改选)。
//
// **搜索先在本地目录里做。** 组件一挂载(= 记账/加账户模态框打开)就预取整份目录(市值前 1000,
// 约 35KB),默认列取它的前 N 条,敲字则就地筛(见 lib/token-search.ts)—— 零往返、无防抖、
// 一个字符就出结果。只有本地凑不够(用户在找长尾币)才防抖打一次上游 /search,回来合并进本地那几条。
// 搜不到可转手动录入。

// 同 beUI 的 EASE_OUT 动效 token 曲线(@folio/ui 未导出 lib/ease → 本地镜像同一 cubic-bezier)。
const EASE_OUT = [0.16, 1, 0.3, 1] as const;

// 上游搜索的节流:停顿 250ms 才发,且需 ≥2 字符。本地筛不受这两条约束(它不出网)。
const SEARCH_DEBOUNCE_MS = 250;
const MIN_SEARCH_LEN = 2;
// 目录多久算旧。它本身是市值前 1000 的快照,分钟级的变化对选币毫无意义。
const CATALOGUE_STALE_MS = 10 * 60 * 1000;

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
  const search = query.trim();
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // 目录:**挂载即预取**(不等下拉展开)—— 组件出现的时刻就是模态框打开的时刻,用户还要点一下
  // 才会展开选币,那段时间足够这 35KB 落地。
  const catalogueQuery = useQuery({
    queryKey: ["token-catalogue"],
    queryFn: () => listTokenCatalogue(),
    staleTime: CATALOGUE_STALE_MS,
  });
  const catalogue = useMemo(() => catalogueQuery.data ?? [], [catalogueQuery.data]);

  // 本地筛:随每次按键即时重算,不出网。
  const local = useMemo(() => searchCatalogue(catalogue, search), [catalogue, search]);

  // 上游只在「目录已落地 + 敲完了(防抖落定)+ 够长 + 本地凑不够」时才问一次。
  //   · `settled` 让 local 与发出去的词恒是同一个 —— 否则会拿上一个词的本地命中数决定这一个词。
  //   · 等目录落地是因为它没到时 local 恒为空 —— 那会把「手快的用户」全都推去打上游。
  //     只等到它**有结论**为止(成功或失败),失败时照样能搜,不然目录一挂搜索就整个瘫了。
  const debounced = useDebouncedValue(search, SEARCH_DEBOUNCE_MS);
  const settled = debounced === search;
  const wantRemote =
    settled &&
    !catalogueQuery.isLoading &&
    search.length >= MIN_SEARCH_LEN &&
    needsRemoteSearch(local);
  const remoteQuery = useQuery({
    queryKey: ["token-search", search],
    queryFn: () => listTokens({ data: { query: search } }),
    enabled: open && wantRemote,
    staleTime: 60_000,
  });

  // 空输入 → 目录前 N 条(默认列);有输入 → 本地在前,上游补的接在后面。
  const tokens = useMemo(
    () =>
      search
        ? mergeSearchResults(local, remoteQuery.data ?? [])
        : catalogue.slice(0, TOP_TOKENS_LIMIT),
    [search, local, remoteQuery.data, catalogue],
  );
  // 转圈只在「手上一条都没有、还在等」时出现:本地有命中就直接显示,上游那趟在后台补。
  const isLoading =
    tokens.length === 0 && (catalogueQuery.isLoading || (wantRemote && remoteQuery.isPending));
  const isError =
    tokens.length === 0 && (catalogueQuery.isError || (wantRemote && remoteQuery.isError));

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
  //
  // **按下标取,不扫 `[data-active="true"]`。** 后者拿的是 DOM 顺序里的第一个,而 DOM 里
  // 混进过僵尸行(重复 key 导致 React 卸载了却没摘掉的节点),它们身上的标记停在死掉那一刻 ——
  // 扫到僵尸就把列表滚回了顶部。根因(目录里的重复币)已在上游修掉,但依赖 DOM 顺序本身就脆。
  // (顺带:改成按下标之后 effect 真的读了 `active`,依赖数组自洽,原先那条 lint 豁免不再需要。)
  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-index="${active}"]`)
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
              {isError ? (
                <div className="flex flex-col items-center gap-2 px-3 py-6 text-center text-destructive text-sm">
                  <CircleAlertIcon className="size-5" />
                  {t("searchFailed")}
                </div>
              ) : tokens.length > 0 ? (
                tokens.map((token, i) => (
                  <button
                    key={token.ticket}
                    type="button"
                    data-index={i}
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
              ) : isLoading ? (
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
