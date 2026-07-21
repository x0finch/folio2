import { useCallback, useMemo, useState } from "react";
import type { OverviewBalance } from "../account-view";
import {
  type ActivityDraft,
  addHolding,
  commitBatch,
  deleteActivity,
  type HoldingInput,
  holdingValid,
  type ManualState,
  makeSeedHolding,
  mergedActivities,
  removeHolding,
  resolveActivityDrafts,
  type StoredActivity,
  updateActivity,
  updateHolding,
  validateBatch,
} from "../manual-store";

const newId = () => crypto.randomUUID();

// 把账户现有余额行播种成初始 holdings（每条现货 = 一个 token，seed 一条 set 活动）。
// 单价:优先 provider 自带 unitPrice,否则从市值/数量反推。
function seedFromBalances(balances: OverviewBalance[], now: number): ManualState {
  return balances.map((b) => {
    const unitPrice = b.unitPrice ?? (b.amount ? b.usdValue / b.amount : 0);
    return makeSeedHolding(
      newId(),
      newId(),
      {
        symbol: b.symbol,
        unitPrice,
        identifier: b.tokenKey ?? undefined,
        logo: b.logo,
        name: b.name,
        amount: b.amount,
      },
      now,
    );
  });
}

// F 片内存态:账户详情抽屉里 manual 多 token 的页面态。key={account.id} 重挂即重播种（切账户清态）。
export function useManualStore(balances: OverviewBalance[]) {
  const [state, setState] = useState<ManualState>(() => seedFromBalances(balances, Date.now()));

  const holdings = state;
  const merged = useMemo(() => mergedActivities(state), [state]);

  const create = useCallback((input: HoldingInput) => {
    setState((s) => addHolding(s, makeSeedHolding(newId(), newId(), input, Date.now())));
  }, []);

  const edit = useCallback((holdingId: string, input: HoldingInput) => {
    setState((s) => updateHolding(s, holdingId, input, { id: newId(), occurredAt: Date.now() }));
  }, []);

  const remove = useCallback((holdingId: string) => {
    setState((s) => removeHolding(s, holdingId));
  }, []);

  const removeActivity = useCallback((holdingId: string, activityId: string) => {
    setState((s) => deleteActivity(s, holdingId, activityId));
  }, []);

  // 编辑一笔既有活动:套用 patch 后校验该 holding 时间线(改 amount/kind/日期可能致超支),合法才写入。
  const editActivity = useCallback(
    (holdingId: string, activityId: string, patch: Partial<Omit<StoredActivity, "id">>) => {
      const next = updateActivity(state, holdingId, activityId, patch);
      const ok = holdingValid(next, holdingId);
      if (ok) setState(next);
      return { ok };
    },
    [state],
  );

  // 提交暂存批量（token 维度）:先为未持有 token 现建空 holding,再整批校验(reduce 超支 → 整批拒),合法才入库。
  const commit = useCallback(
    (drafts: ActivityDraft[]) => {
      const { state: resolved, holdingDrafts } = resolveActivityDrafts(state, drafts, () =>
        newId(),
      );
      const result = validateBatch(resolved, holdingDrafts);
      if (result.ok) {
        const base = Date.now();
        setState(commitBatch(resolved, holdingDrafts, (i) => `${base}-${i}`));
      }
      return result;
    },
    [state],
  );

  return {
    holdings,
    merged,
    create,
    edit,
    remove,
    removeActivity,
    editActivity,
    commit,
  } as const;
}

export type ManualStoreApi = ReturnType<typeof useManualStore>;
