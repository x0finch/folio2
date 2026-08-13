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
 * 投影 → 最近的合法档位。
 *
 * `projected` 是 motion 按当前速度算出的「照这个速度会滑到哪」(它的衰减模型,比手拍一个常数
 * 靠谱)。我们只回答「离它最近的档位是哪个」,所以这是个纯 number → number,不用模拟手势就能测。
 *
 * 越界两头都夹住:往上过头 → 顶档(不越界);往下过头 → dismiss(猛甩关闭)。
 */
export function nearestSnap(projected: number, offsets: readonly number[]): number {
  if (offsets.length === 0) return 0;
  let best = offsets[0];
  let bestGap = Math.abs(projected - best);
  for (const offset of offsets) {
    const gap = Math.abs(projected - offset);
    if (gap < bestGap) {
      best = offset;
      bestGap = gap;
    }
  }
  return best;
}
