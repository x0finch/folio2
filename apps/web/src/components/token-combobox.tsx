import { TOP_TOKENS_LIMIT } from "@folio/oracle-basic";
import { cn, Input, LogoAvatar } from "@folio/ui";
import { useQuery } from "@tanstack/react-query";
import { ChevronDownIcon, CircleAlertIcon, Loader2Icon, SearchXIcon, XIcon } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import { useTranslations } from "use-intl";
import { formatNumber } from "../lib/core/format-number";
import { useDebouncedValue } from "../lib/hooks/use-debounced-value";
import { fiatOptionsQuery, tokenCatalogueQuery, tokenSearchQuery } from "../lib/queries/tokens";
import { refreshTokenPrices } from "../lib/server/tokens";
import type { TokenOption } from "../lib/server/tokens/model";
import {
  buildTokenSections,
  type LivePrice,
  matchSegments,
  needsRemoteSearch,
  searchCatalogue,
  staleTickets,
  type TokenSectionKey,
} from "./token-search";

// manual 选币的内联 Combobox(A4,替代 TokenPicker 的全屏 CommandPalette 浮层):点触发器**就地下推**展开
// 搜索框 + 结果列表(在文档流内、把下方字段推下去,不叠第二层遮罩)。接口与 TokenPicker 对齐(value/onChange/
// onManual),故可直接替入 ManualFields。命中子串高亮走 matchSegments(design token,禁硬编码色)。
// 开合平滑:结果层 Framer 动 height:auto+opacity,承载它的 MorphingModal 面板内容驱动、自然 reflow 跟随。
// 键盘:↑↓ 移高亮、Enter 选中/转手动、Esc 收起;点组件外亦收起(均保留当前值,不改选)。
//
// **搜索先在本地目录里做。** 组件一挂载(= 记账/加账户模态框打开)就预取整份目录(市值前 1000,
// 约 35KB),默认列取它的前 N 条,敲字则就地筛(见 ./token-search.ts)—— 零往返、无防抖、
// 一个字符就出结果。只有本地凑不够(用户在找长尾币)才防抖打一次上游 /search,回来合并进本地那几条。
// 搜不到可转手动录入。

// 同 beUI 的 EASE_OUT 动效 token 曲线(@folio/ui 未导出 lib/ease → 本地镜像同一 cubic-bezier)。
const EASE_OUT = [0.16, 1, 0.3, 1] as const;

// 分组标题的 i18n key(#269):纯层只给 section 语义 key,文案在这里映射。
const SECTION_LABEL: Record<TokenSectionKey, "sectionOwned" | "sectionFiat" | "sectionCatalogue"> =
  {
    owned: "sectionOwned",
    fiat: "sectionFiat",
    catalogue: "sectionCatalogue",
  };

// 上游搜索的节流:停顿 250ms 才发,且需 ≥2 字符。本地筛不受这两条约束(它不出网)。
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

// 收起态触发器里的选中币:单行 logo + 代号 + 名字(下拉那种两行式在这一行放不下,也不需要)。
function TokenTriggerLabel({ token }: { token: TokenOption }) {
  return (
    <>
      <LogoAvatar src={token.logo} fallback={token.symbol} size="sm" />
      <span className="shrink-0 font-medium">{token.symbol.toUpperCase()}</span>
      <span className="truncate text-muted-foreground">{token.name}</span>
    </>
  );
}

// 市值排名:name 右侧的低调灰字 `#N`(不加框)。**缺 rank → 调用方不渲染它**(有没有它本身就是消歧)。
function RankTag({ rank }: { rank: number }) {
  return <span className="shrink-0 text-muted-foreground text-xs tabular-nums">#{rank}</span>;
}

// 下拉的一项:仿主页代币行的两行式。左 logo + 名字(粗)/ `#rank` 徽标 / 代号(灰);
// 右 现价 + 24h 涨跌%(涨绿跌红平不显示,走 text-pos/neg token)。价缺 → `—`。
// price/change 由父层按「刷来的 live 价优先、否则票自带的默认列价」算好传进来。
function TokenListRow({
  token,
  query,
  price,
  change24h,
}: {
  token: TokenOption;
  query?: string;
  price?: number;
  change24h?: number;
}) {
  return (
    <div className="flex w-full items-center gap-2.5">
      <LogoAvatar src={token.logo} fallback={token.symbol} size="sm" />
      <div className="min-w-0 flex-1">
        {/* min-w-0 让名字可收缩截断,徽标 shrink-0 不被挤出、不被右侧价列盖住。 */}
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="min-w-0 truncate font-medium">
            {query ? <Highlighted text={token.name} query={query} /> : token.name}
          </span>
          {token.rank != null && <RankTag rank={token.rank} />}
        </div>
        <span className="block truncate text-muted-foreground text-xs">
          {query ? (
            <Highlighted text={token.symbol.toUpperCase()} query={query} />
          ) : (
            token.symbol.toUpperCase()
          )}
        </span>
      </div>
      <div className="shrink-0 text-right">
        <div className="text-sm tabular-nums">
          {price != null ? formatNumber(price, { unit: "$" }) : "—"}
        </div>
        {/* 涨绿跌红平灰;缺涨跌(搜索来的无价行)→ 整行留空,不显示 0。 */}
        {change24h != null && (
          <div
            className={cn(
              "text-xs tabular-nums",
              change24h > 0 ? "text-pos" : change24h < 0 ? "text-neg" : "text-muted-foreground",
            )}
          >
            {change24h > 0 ? "+" : change24h < 0 ? "-" : ""}
            {Math.abs(change24h).toFixed(2)}%
          </div>
        )}
      </div>
    </div>
  );
}

export function TokenCombobox({
  value,
  onChange,
  onManual,
  owned = [],
}: {
  value: TokenOption | null;
  onChange: (token: TokenOption | null) => void;
  onManual: (query: string) => void;
  // 「已有代币」组的数据。**只在 manual 账户侧边栏**由父层传入(该侧边栏账户当前已有的币);
  // 其它出现处(新建账户模态)不传 → 缺省空 → 无该组(#269 语义修正)。
  owned?: readonly TokenOption[];
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
  const catalogueQuery = useQuery(tokenCatalogueQuery());
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
  const remoteQuery = useQuery({ ...tokenSearchQuery(search), enabled: open && wantRemote });

  // 法币组(#272):SUPPORTED_CURRENCIES 的 10 法币。**票在服务端造**(与目录/已有一致,前端只拿不透明串,
  // 不构造 tokenRef/票 —— 见 token-option.ts),名字按请求 locale 已本地化。静态数据,挂载即预取。
  const fiatQuery = useQuery(fiatOptionsQuery());
  const fiat = useMemo(() => fiatQuery.data ?? [], [fiatQuery.data]);

  // 分组(#269):已有代币 → Tokens(目录)→ 法币(Cash)。各组内部按 search 过滤,目录再并进
  // 上游补的那几条。空组不出现。
  const sections = useMemo(
    () =>
      buildTokenSections({
        owned,
        fiat,
        catalogue,
        query: search,
        catalogueTopN: TOP_TOKENS_LIMIT,
        remote: remoteQuery.data ?? [],
      }),
    [owned, fiat, catalogue, search, remoteQuery.data],
  );

  // 键盘导航 / 刷价 / 空态判断都按**扁平化后的可见项**走(active 是它的下标)。
  const flatItems = useMemo(() => sections.flatMap((s) => s.items), [sections]);
  // 渲染用:给每行预先算好扁平下标(data-index),避免在 JSX 里塞计数副作用。
  // `uid` 带段序号 —— 搜索排序会让同一类型出现在多个 section(相邻切段),裸 key 会撞。
  const rendered = useMemo(() => {
    let index = 0;
    return sections.map((s, si) => ({
      uid: `${s.key}:${si}`,
      key: s.key,
      rows: s.items.map((token) => ({ token, index: index++ })),
    }));
  }, [sections]);

  // 展示时的 SWR 刷价(#226):对当前这批行里价过期(1h)/ 缺失的,批量走一次 /simple/price 回填。
  // `live` = 刷来的价(盖过票自带的默认列价);`requested` = 每次打开只补一次的闸(见 staleTickets)。
  //
  // **这里是 CODING.md「取数走 useQuery 不走 useEffect」的例外**(该条末句留的口子:事件处理器
  // 表达不了的真副作用)。三条语义合起来 useQuery 的「按 key 取、换 key 换数据」模型装不下:
  //   1. **累积回填** —— 结果要并进一张跨搜索词存活的 map(边打字边补,补过的不因换词丢);
  //      useQuery 的 data 是按 key 的,换一批可见行就把上一批的价丢了。
  //   2. **单请求批量** —— 一整批 stale 票合成一次 /simple/price(useQueries 会拆成 N 个请求)。
  //   3. **每次打开补一次** —— 由 requested 闸表达,不是 staleTime 能覆盖的。
  // live / requested **跨下拉开合保留**(不随收起清空),整个记账模态会话共用一份:重开下拉时
  // 已经刷新过、还新鲜(<1h)的价直接复用 → staleTickets 返回空 → 零请求。清空会让每次重开都整份
  // 重刷 /simple/price,白烧 CGK 额度、跟 /search 抢(用户看到的就是 8848 那种「Search failed」)。
  // 模态关闭时组件卸载,这份缓存自然随之释放。
  const [live, setLive] = useState<Map<string, LivePrice>>(() => new Map());
  const requested = useRef<Set<string>>(new Set());

  useEffect(() => {
    // 只在搜索词**落定后**刷(与 /search 同一个防抖闸):否则每个中间按键都发一次 /simple/price,
    // 白烧 CGK 额度还跟 /search 抢,免费档下更容易把 /search 挤到限流(搜不存在的币时尤其明显 ——
    // 本地必然落空、强制打远端)。落定后这批行才稳定,一次批量刷即可。
    // (同样**有意不走 `useMutation`**:它是 effect 驱动的后台批量刷价,没有用户发起的动作,
    //  而且取消语义绑在 effect 的 cleanup 上(`cancelled` 闭包标志)—— mutation 表达不了这个。)
    if (!open || !settled || flatItems.length === 0) return;
    const stale = staleTickets(flatItems, live, requested.current, Date.now());
    if (stale.length === 0) return;
    for (const tk of stale) requested.current.add(tk); // 先占闸,重渲染不重发
    let cancelled = false;
    refreshTokenPrices({ data: { tickets: stale } })
      .then((rows) => {
        if (cancelled || rows.length === 0) return;
        setLive((prev) => {
          const next = new Map(prev);
          for (const r of rows) {
            next.set(r.ticket, {
              price: r.unitPrice,
              change24h: r.change24h ?? undefined,
              asOf: r.asOf,
            });
          }
          return next;
        });
      })
      .catch(() => {
        // 刷价失败不阻断:那几行显示无价。requested 已占 → 本次打开不再重试。
      });
    return () => {
      cancelled = true;
    };
  }, [open, settled, flatItems, live]);
  // 转圈只在「手上一条都没有、还在等」时出现:本地有命中就直接显示,上游那趟在后台补。
  // 「已有代币」由父层直接传 prop(不出网)→ 不参与 loading/error 门。
  const isLoading =
    flatItems.length === 0 && (catalogueQuery.isLoading || (wantRemote && remoteQuery.isPending));
  const isError =
    flatItems.length === 0 && (catalogueQuery.isError || (wantRemote && remoteQuery.isError));

  const pick = (token: TokenOption) => {
    // 把下拉里**已经显示的那个价**随选中带出去(live 刷来的优先,否则票自带的)——
    // 让表单直接用它回填单价,不必再单独取一次(见 account-fields 的 onPick)。
    const lp = live.get(token.ticket);
    onChange({
      ...token,
      price: lp?.price ?? token.price,
      change24h: lp?.change24h ?? token.change24h,
    });
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
    // 输入法组合中(中文/日文等)的按键归输入法:此时 Enter 是「上屏候选词」、↑↓ 是「选候选」、
    // Esc 是「取消组合」——一个都不能被这里当成选币/移高亮/收起。敲完 coin 按 Enter 确认拼音那一下,
    // 事件的 isComposing 为真,直接放行给输入法。
    if (e.nativeEvent.isComposing) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(flatItems.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (flatItems[active]) pick(flatItems[active]);
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
              <TokenTriggerLabel token={value} />
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
              ) : flatItems.length > 0 ? (
                // 分组渲染:每段一个低调组标题 + 若干行。**data-index 走扁平下标**(键盘高亮跨段
                // 连续);React key 用带段序号的 uid —— 搜索时同类型可能多段、且两来源不去重,裸 key 会撞。
                rendered.map((section) => (
                  <div key={section.uid}>
                    <div className="px-2.5 pt-2 pb-1 font-medium text-muted-foreground text-xs">
                      {t(SECTION_LABEL[section.key])}
                    </div>
                    {section.rows.map(({ token, index }) => {
                      // 生效价:刷来的 live 优先,否则票自带的默认列价(搜索来的行两者皆无 → 显示 —)。
                      const lp = live.get(token.ticket);
                      return (
                        <button
                          key={`${section.uid}:${token.ticket}`}
                          type="button"
                          data-index={index}
                          data-active={index === active}
                          onPointerMove={() => setActive(index)}
                          onClick={() => pick(token)}
                          className={cn(
                            "flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm transition-colors",
                            index === active && "bg-muted",
                          )}
                        >
                          <TokenListRow
                            token={token}
                            query={search}
                            price={lp?.price ?? token.price}
                            change24h={lp?.change24h ?? token.change24h}
                          />
                        </button>
                      );
                    })}
                  </div>
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
