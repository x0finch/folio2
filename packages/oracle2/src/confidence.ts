import { RESOLUTION_DOMINANCE, RESOLUTION_TOP_RANK } from "./constants";
import type { SymbolCandidate } from "./stores";

// 按市值排名消歧,**门控不变**(与今天的 pickByConfidence 逐条对齐):
// top-N 之内 / 只有一个候选 / 碾压次席 → 有把握;否则没把握 → 调用方降级(各自独立成行,不链 CGK)。
// 没把握时宁可两行也不能并错 —— 并错了会把假 USDC 的金额算进真 USDC。
export function pickBySymbol(candidates: readonly SymbolCandidate[]): string | undefined {
  if (candidates.length === 0) return undefined;

  const rank = (c: SymbolCandidate): number => c.marketCapRank ?? Number.POSITIVE_INFINITY;
  const sorted = [...candidates].sort((a, b) => rank(a) - rank(b));
  const best = sorted[0];
  if (sorted.length === 1) return best.coinId;

  const bestRank = rank(best);
  const runnerRank = rank(sorted[1]);

  if (bestRank <= RESOLUTION_TOP_RANK) return best.coinId;
  // 最佳有 rank、其余都没有 → 无歧义
  if (!Number.isFinite(runnerRank) && Number.isFinite(bestRank)) return best.coinId;
  if (
    Number.isFinite(runnerRank) &&
    bestRank > 0 &&
    runnerRank / bestRank >= RESOLUTION_DOMINANCE
  ) {
    return best.coinId;
  }
  return undefined;
}
