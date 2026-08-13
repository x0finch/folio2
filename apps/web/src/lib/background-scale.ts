// 背景缩放的算法(片9 / ADR 0041)。纯函数,单独一个文件 —— 这样能测。

// 顶格时两侧各往里收多少(px)。**固定 px 换算成比例,而不是直接给一个固定比例**:
// 同一个 `scale(0.94)` 在小屏上收进去十几像素、在大屏上收进去三十多,观感对不上;
// 固定 px 才是「两边各让出一条同样宽的缝」。
const INSET_PX = 16;
// 缩下去之后露出来的那圈圆角,和抽屉顶部的圆角同一档(rounded-t-3xl = 1.5rem)。
const RADIUS_PX = 24;

/**
 * 进度(0 = 收起,1 = 顶格)→ 该给外壳的缩放与圆角。
 *
 * 缩放按视口宽度换算:两侧各收 `INSET_PX` 意味着宽度少 `2 × INSET_PX`。
 * 视口宽度拿不到(0)时退化成不缩放 —— 不返回 NaN 或大于 1 的值。
 */
export function backgroundScaleStyle(
  progress: number,
  viewportWidth: number,
): { scale: number; radiusPx: number } {
  // NaN 也要挡:`Math.min/max` 遇 NaN 仍是 NaN,一路传到 `scale(NaN)` 会被浏览器整条丢掉 ——
  // 那是「看起来没生效、又不报错」的失败,最难查。
  if (!Number.isFinite(progress) || viewportWidth <= 0) return { scale: 1, radiusPx: 0 };
  const clamped = Math.min(1, Math.max(0, progress));
  const minScale = Math.max(0, (viewportWidth - INSET_PX * 2) / viewportWidth);
  return {
    scale: 1 - clamped * (1 - minScale),
    radiusPx: clamped * RADIUS_PX,
  };
}
