// 底部抽屉的档位策略(片8 / ADR 0041)。
//
// **抽屉高度恒定,档位用位移表达。** 旧的 vendored 件是改高度(`style={{ height: "60vh" }}` →
// `"92vh"`)—— 那是普通内联 style,不在 `animate` 里,motion 不参与、浏览器也不补间,所以换档
// 必然瞬间跳。位移交给 motion 之后,跟手、按速度落档、动画中途反向拖都是白拿的。
//
// 这个文件只放**策略**:档位怎么换算成位移、投影落在哪一档。动画、惯性、越界回弹全是 motion 的事。

// 顶格之上再留一线,别让抽屉顶边贴着状态栏。
const TOP_GAP_REM = 0.5;

/**
 * 顶格高度 = 视口小高度 − 顶部安全区 − 那一线。
 *
 * **`env(safe-area-inset-top)` 这一项是「灵动岛压不到」的全部依据** —— 两档是它的 60% 与 100%,
 * 所以顶档天然停在安全区下面,不需要 92% 这种凑出来的分数(旧件就是那样,顶边离屏顶只剩约 8vh)。
 * 用 `svh` 而不是 `vh`:地址栏收放时不跳。
 *
 * 放在这里(而不是组件里)是为了能被断言:像素高度是运行时量出来的,jsdom 里没有 CSS,
 * 唯一能钉住「有没有扣安全区」的地方就是这个字符串。
 */
export const SHEET_MAX_HEIGHT = `calc(100svh - env(safe-area-inset-top) - ${TOP_GAP_REM}rem)`;

/** 两档:顶格高度的 60% 与 100%。灵动岛压不到由「顶格高度已经扣掉安全区」保证,不靠魔法数字。 */
const SHEET_SNAP_FRACTIONS = [0.6, 1] as const;

/**
 * 档位 → 位移(px,越大越靠下)。
 *
 * 返回值升序:`0` 是顶格(整块露出 `maxHeight`),中间是各半档,**最后一项是 dismiss** ——
 * 「完全移出」也是一个合法档位,于是下甩到关闭与换档是同一条连续动画,不是两段拼起来的。
 */
export function snapOffsets(
  maxHeight: number,
  fractions: readonly number[] = SHEET_SNAP_FRACTIONS,
): number[] {
  const stops = fractions.map((f) => Math.round(maxHeight * (1 - f)));
  // 去重 + 升序:fraction 给到 1 时 stop 是 0,与顶格重合。
  return [...new Set([...stops, maxHeight])].sort((a, b) => a - b);
}

/**
 * 松手落哪一档:**只看这一下拖了多远、多快**,不看松手时停在哪。
 *
 * 上一版是「让 motion 按惯性算出投影落点,我们取离它最近的档位」。真机上那样很难用 ——
 * 实测两档间距 338px,慢拖时投影≈松手点,于是**得拖过 169px(半个间距)才肯换档**,
 * 拖 120px 松手会弹回去,读起来像「往上滑不认」。
 *
 * 改成原生那套判据:朝着拖动方向看**相邻**那一档,
 *   · 拖过间距的 `COMMIT_FRACTION`,或者
 *   · 甩得比 `FLICK_VELOCITY` 快
 * 就换过去;否则回原档。于是「轻轻带一下就换档」和「拖一点点会回弹」同时成立,而且**换档距离
 * 与间距成比例**,不随视口高度漂。
 *
 * 这条与 ADR 0041 里「`dragMomentum` 保持开着、惯性交给 motion」**相反,是被真机推翻的**:
 * 惯性投影既定不了换档距离(恒等于半个间距),又给 dismiss 拖出一条软塌塌的长尾(松手后还要
 * 骑着惯性滑五百多像素,观感是「以奇怪的速度滑走」)。vaul 自己也不用惯性 —— 它用一条固定曲线
 * `cubic-bezier(0.32, 0.72, 0, 1)`,而这仓的 `EASE_DRAWER` 就是那条曲线。
 */
// 拖过相邻两档间距的这个比例就换档(慢拖也认)。
const COMMIT_FRACTION = 0.2;
// 甩得比这个快就换档,不看拖了多远(px/s)。
const FLICK_VELOCITY = 500;

export function chooseSnap({
  from,
  offsets,
  offset,
  velocity,
}: {
  /** 起手时停在哪一档(位移)。 */
  from: number;
  /** 全部合法档位,升序,最后一项是 dismiss。 */
  offsets: readonly number[];
  /** 这一下拖了多少(正 = 往下)。 */
  offset: number;
  /** 松手瞬时速度(px/s,正 = 往下)。 */
  velocity: number;
}): number {
  if (offsets.length === 0) return from;
  // 方向以速度为准;慢到几乎没速度时才看位移 —— 手指停住再松,那一下该按「拖到哪」算。
  const direction = Math.abs(velocity) >= FLICK_VELOCITY ? Math.sign(velocity) : Math.sign(offset);
  if (direction === 0) return from;

  const neighbour =
    direction > 0
      ? offsets.find((o) => o > from) // 往下 → 下一档(最后一档是 dismiss)
      : [...offsets].reverse().find((o) => o < from); // 往上 → 上一档
  if (neighbour == null) return from; // 已经在这一头的极限

  const gap = Math.abs(neighbour - from);
  const committed =
    Math.abs(offset) >= gap * COMMIT_FRACTION || Math.abs(velocity) >= FLICK_VELOCITY;
  return committed ? neighbour : from;
}
