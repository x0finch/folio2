import { RESOLUTION_DOMINANCE, RESOLUTION_TOP_RANK } from "./constants";
import type {
  AssetRef,
  Confidence,
  Resolution,
  TokenCandidate,
  TokenIndex,
  TokenRef,
} from "./types";

// 符号归一 —— 建索引 / lookupBySymbol / OVERRIDES 三处用同一口径,避免 `USDC`/`usdc` 漏配。
export function normalizeSymbol(s: string): string {
  return s.trim().toUpperCase();
}

function contractKey(platform: string, contract: string): string {
  return `${platform}:${contract.toLowerCase()}`;
}

// (链,合约) → 规范 ref。链经 platforms 映射到平台(小写),合约小写;任一缺失/未映射 → null。
export function lookupByContract(
  index: TokenIndex,
  chain: string,
  contract: string,
): TokenRef | null {
  const platform = index.platforms.get(chain.toLowerCase());
  if (!platform) return null;
  return index.byContract.get(contractKey(platform, contract)) ?? null;
}

// symbol → 候选(已带 rank)。空 symbol / 未收录 → []。
export function lookupBySymbol(index: TokenIndex, symbol: string): TokenCandidate[] {
  return index.bySymbol.get(normalizeSymbol(symbol)) ?? [];
}

export interface ConfidenceOpts {
  topRank?: number;
  dominance?: number;
}

// 按 marketCapRank 升序消歧。top-N / 单候选 / 碾压次席 → high;否则 low(调用方降级,不写进数据)。空 → null。
export function pickByConfidence(
  candidates: TokenCandidate[],
  opts?: ConfidenceOpts,
): { ref: TokenRef; confidence: Confidence } | null {
  if (candidates.length === 0) return null;
  const topRank = opts?.topRank ?? RESOLUTION_TOP_RANK;
  const dominance = opts?.dominance ?? RESOLUTION_DOMINANCE;

  const sorted = [...candidates].sort(
    (a, b) =>
      (a.marketCapRank ?? Number.POSITIVE_INFINITY) - (b.marketCapRank ?? Number.POSITIVE_INFINITY),
  );
  const best = sorted[0];
  if (sorted.length === 1) return { ref: best.ref, confidence: "high" };

  const bestRank = best.marketCapRank ?? Number.POSITIVE_INFINITY;
  const runnerRank = sorted[1].marketCapRank ?? Number.POSITIVE_INFINITY;

  let confidence: Confidence = "low";
  if (bestRank <= topRank) {
    confidence = "high";
  } else if (!Number.isFinite(runnerRank) && Number.isFinite(bestRank)) {
    confidence = "high"; // 最佳有 rank,其余都没有 → 无歧义
  } else if (Number.isFinite(runnerRank) && bestRank > 0 && runnerRank / bestRank >= dominance) {
    confidence = "high";
  }
  return { ref: best.ref, confidence };
}

// 内核瀑布(纯):explicit > contract > override > symbol(门控) > none。
export function chooseResolution(
  asset: AssetRef,
  inputs: { contractHit?: TokenRef | null; candidates?: TokenCandidate[]; override?: TokenRef },
): Resolution {
  if (asset.ref) return { ref: asset.ref, confidence: "high", via: "explicit" };
  if (inputs.contractHit) return { ref: inputs.contractHit, confidence: "high", via: "contract" };
  if (inputs.override) return { ref: inputs.override, confidence: "high", via: "override" };

  const picked =
    inputs.candidates && inputs.candidates.length > 0 ? pickByConfidence(inputs.candidates) : null;
  if (picked) return { ref: picked.ref, confidence: picked.confidence, via: "symbol" };

  return { ref: null, confidence: "low", via: "none" };
}

// 公开入口(纯):查索引 + 覆盖表,拼装后交内核瀑布。调用方(P7.4)只调这一个。
export function resolve(
  index: TokenIndex,
  asset: AssetRef,
  overrides?: Readonly<Record<string, TokenRef>>,
): Resolution {
  if (asset.ref) return { ref: asset.ref, confidence: "high", via: "explicit" };

  const contractHit =
    asset.contract && asset.chain ? lookupByContract(index, asset.chain, asset.contract) : null;
  const candidates = lookupBySymbol(index, asset.symbol);
  const override = overrides?.[normalizeSymbol(asset.symbol)];

  return chooseResolution(asset, { contractHit, candidates, override });
}
