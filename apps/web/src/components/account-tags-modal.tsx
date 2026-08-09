import type { Tag } from "@folio/db";
import { MorphingModal, toast, useMediaQuery } from "@folio/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { useTranslations } from "use-intl";
import { invalidateFor } from "../lib/queries/refresh";
import { attachTag, createTag, deleteTag, detachTag, renameTag } from "../lib/server/tags";
import { Portal } from "./portal";
import { TagInput } from "./tag-input";

// 「Tag 建出来了,但没挂到账户上」——`createMut` 里 create 与 attach 两步的中间态。
// 单独立一个错误类型,是因为 onError 对这两种失败的善后不一样:后者还要撤掉那笔乐观挂载。
class AttachAfterCreateError extends Error {
  constructor(
    readonly tagId: string,
    options?: ErrorOptions,
  ) {
    super("attach after create failed", options);
    this.name = "AttachAfterCreateError";
  }
}

// 「打标签」弹窗(ADR 0034):MorphingModal + Portal(同删除确认那套,必须 Portal 出抽屉的 transform 包含块)。
// 交付「点即生效」:attach/detach 用本地 optimistic overlay 即时反馈,后台发 server fn + 定向刷新同步
// 账户行徽章;create/rename/delete 走 server + 定向刷新(低频,round-trip 可接受)。纯展示交互在 TagInput。
export function AccountTagsModal({
  accountId,
  accountLabel,
  portfolioId,
  portfolioTags,
  attachedTagIds,
  tagAccountCounts,
  open,
  onClose,
}: {
  accountId: string;
  accountLabel: string;
  portfolioId: string;
  portfolioTags: Tag[]; // 账户所在 Portfolio 的全部 Tag
  attachedTagIds: string[]; // 本账户已打的 Tag id
  tagAccountCounts: Record<string, number>; // tagId → 打了它的账户数(删除确认文案)
  open: boolean;
  onClose: () => void;
}) {
  const t = useTranslations("Tags");
  const queryClient = useQueryClient();
  // 定向刷新。**它 resolve 的时刻仍然晚于「真实数据到位」** —— `invalidateQueries` 等的是
  // 挂载中那些查询重拉完,所以下面那套「等真值追上乐观值再撤 overlay」的对账原样成立。
  const refresh = () => invalidateFor(queryClient, "tag.write");
  const isDesktop = useMediaQuery("(min-width: 640px)");
  // toggle 的乐观 overlay:tagId → 期望的 attached 值。即时反馈,后台 server fn + invalidate 落库。
  const [optim, setOptim] = useState<Map<string, boolean>>(new Map());
  // 新建的乐观占位:回车即先摆一个「已选中」的 chip,不等 create + attach + invalidate 两趟往返。
  // 只存名字 —— 此刻还没有真 id。落库后由真行接管(见下面的对账 effect)。
  // (叫 placeholders 不叫 pending:这个文件里现在有四条 mutation,各自带一个 `isPending`,
  //  再有个同名的本地 state 会让人读错。item 上那个 `pending` 字段是给 TagInput 的,含义不同,保持原样。)
  const [placeholders, setPlaceholders] = useState<string[]>([]);
  // 删除的乐观隐藏:确认即从列表撤下,不等 delete + invalidate。失败则放回去。
  const [removing, setRemoving] = useState<Set<string>>(new Set());

  // 三处乐观(挂载 / 新建 / 删除)都是同一形状的**本地 overlay**:先改本地 → 发 server fn →
  // refresh() → 等真实数据追上再撤 overlay(撤早了会闪)。
  //
  // **迁进 react-query 之后没有改成 `setQueryData` 直改缓存**,虽然现在技术上做得到了。理由:
  // 本组件收到的是**已经拼装过的投影**(`portfolioTags` / `attachedTagIds` 由账户页拼好传下来),
  // 直改缓存要反向去改两条原始查询、再指望拼装结果如愿变化;而本地 overlay 只描述「这一格现在
  // 应该长什么样」,与拼装无关。乐观更新的形状是被「点即生效不能闪」这条需求逼出来的,不是
  // 因为当时没有缓存可改 —— 换成缓存写法并不会更简单,只会把闪烁的可能面铺得更宽。

  // 对账式修剪:等 invalidate 后 attachedTagIds 追上乐观值,才把那条 overlay 撤下(此刻撤 = 无视觉变化)。
  // 不在 onToggle 成功回调里立刻撤 —— 那会与 loader 数据传播抢跑,先露出旧态再翻回来 = 闪一下。
  useEffect(() => {
    setOptim((m) => {
      if (m.size === 0) return m;
      const attached = new Set(attachedTagIds);
      const n = new Map(m);
      let changed = false;
      for (const [id, want] of n) {
        if (attached.has(id) === want) {
          n.delete(id);
          changed = true;
        }
      }
      return changed ? n : m;
    });
  }, [attachedTagIds]);

  // 新建/删除 overlay 的**状态清理**(纯为不让它无限长)。收敛不靠这个 effect —— 它在绘制之后才跑,
  // 真行进入渲染、占位还没撤的那一帧会被画出来 = 同名 chip 闪现两个(实测抓到)。真正的收敛在下面
  // items 里按名字现算,渲染永远只有一个。
  useEffect(() => {
    const have = new Set(portfolioTags.map((tg) => tg.name.toLowerCase()));
    setPlaceholders((names) => {
      if (names.length === 0) return names;
      const next = names.filter((n) => !have.has(n.toLowerCase()));
      return next.length === names.length ? names : next;
    });
    const ids = new Set(portfolioTags.map((tg) => tg.id));
    setRemoving((s) => {
      if (s.size === 0) return s;
      const next = new Set([...s].filter((id) => ids.has(id)));
      return next.size === s.size ? s : next;
    });
  }, [portfolioTags]);

  const items = useMemo(() => {
    const attached = new Set(attachedTagIds);
    for (const [id, want] of optim) {
      if (want) attached.add(id);
      else attached.delete(id);
    }
    const rows = portfolioTags
      .filter((tg) => !removing.has(tg.id)) // 删除中的行立刻消失
      .map((tg) => ({
        id: tg.id,
        name: tg.name,
        attached: attached.has(tg.id),
        accountCount: tagAccountCounts[tg.id] ?? (attached.has(tg.id) ? 1 : 0),
        pending: false,
      }));
    // 占位排在末尾 = 刚敲完的那个紧跟在已有 chip 后面,位置与落库后一致(列表按建表顺序)。
    // **真行一进 rows 就地滤掉同名占位** —— 同一次渲染内完成交接,不留「两个同名 chip」的中间帧。
    const have = new Set(rows.map((r) => r.name.toLowerCase()));
    return rows.concat(
      placeholders
        .filter((name) => !have.has(name.toLowerCase()))
        .map((name) => ({
          id: `pending:${name}`,
          name,
          attached: true,
          accountCount: 1,
          pending: true, // 还没有真 id → 这一格先不接受点击(见 TagInput)
        })),
    );
  }, [portfolioTags, attachedTagIds, tagAccountCounts, optim, placeholders, removing]);

  const fail = () => toast.error(t("actionFailed"));

  // 四条写全部走 mutation,但**乐观仍然是本地 overlay,不是 `setQueryData`** —— 理由见上面那段。
  // mutation 在这里换来的是:乐观放进 `onMutate`、回滚放进 `onError`、刷新放进 `onSuccess`,
  // 三件事各有各的位置,而不是散在一串 `.then().catch()` 里靠读顺序拼出来。
  //
  // **这几条不接 `isPending`,也不禁用任何一格。** 整个交互的前提就是「点即生效」——
  // 在飞时禁用会把它变成「点了要等一下」,那正是这套 overlay 存在的理由的反面。

  const toggleMut = useMutation({
    mutationFn: ({ tagId, next }: { tagId: string; next: boolean }) =>
      next ? attachTag({ data: { accountId, tagId } }) : detachTag({ data: { accountId, tagId } }),
    // onMutate 是同步调用的(execute() 在第一个 await 之前就把它叫掉了),所以这一笔 setState
    // 与点击在同一个 React 批次里 —— 与原来直接在 handler 里 setOptim 是同一帧,不会多出一帧旧态。
    onMutate: ({ tagId, next }) => {
      setOptim((m) => new Map(m).set(tagId, next));
    },
    onSuccess: refresh, // 撤 overlay 交给上面的对账 effect,别在这清(避免闪烁)
    onError: (_e, { tagId }) => {
      setOptim((m) => {
        const n = new Map(m);
        n.delete(tagId); // 失败 → 立即回退乐观
        return n;
      });
      fail();
    },
  });

  const createMut = useMutation({
    mutationFn: async (name: string) => {
      const tg = await createTag({ data: { portfolioId, name } });
      // 真 id 到手即写乐观挂载 —— 占位撤下时由它接力,避免 attachedTagIds 晚一拍导致 chip 闪成未选中。
      // 这一笔 setState 留在 mutationFn 里(而不是 onMutate):它要的 id 在**发起那一刻还不存在**。
      setOptim((m) => new Map(m).set(tg.id, true));
      // 包一层,让 onError 知道「Tag 已经建出来了、只是没挂上」—— 这两种失败的善后不一样。
      try {
        await attachTag({ data: { accountId, tagId: tg.id } });
      } catch (cause) {
        throw new AttachAfterCreateError(tg.id, { cause });
      }
      return tg;
    },
    onMutate: (name) => {
      setPlaceholders((n) => [...n, name]); // 即时反馈:先摆上已选中的 chip
    },
    onSuccess: refresh,
    onError: async (error, name) => {
      // createTag 成功但 attachTag 失败会留下「已建未挂」的 Tag —— 仍刷新让它出现在列表里
      // (用户可手动挂上),不至于既看不到又只得到一句报错。createTag 本身失败时刷新无害。
      // 占位在此显式撤掉:create 本身失败时真行永远不出现,对账 effect 等不到。
      setPlaceholders((n) => {
        const i = n.indexOf(name);
        return i < 0 ? n : [...n.slice(0, i), ...n.slice(i + 1)];
      });
      // **乐观挂载也得撤**:attach 失败时 attachedTagIds 永远不会追上 true,对账 effect 撤不掉它,
      // chip 会一直显示「已打上」—— 那正好挡住上面那条「用户可手动挂上」的退路。
      if (error instanceof AttachAfterCreateError) {
        setOptim((m) => {
          const n = new Map(m);
          n.delete(error.tagId);
          return n;
        });
      }
      await refresh();
      fail();
    },
  });

  const renameMut = useMutation({
    mutationFn: ({ tagId, name }: { tagId: string; name: string }) =>
      renameTag({ data: { tagId, name } }),
    onSuccess: refresh,
    onError: fail,
  });

  const deleteMut = useMutation({
    mutationFn: (tagId: string) => deleteTag({ data: { tagId } }),
    onMutate: (tagId) => {
      setRemoving((s) => new Set(s).add(tagId)); // 即时消失
    },
    onSuccess: refresh, // 撤 overlay 交给对账 effect(真行没了才撤,避免闪回)
    onError: (_e, tagId) => {
      setRemoving((s) => {
        const n = new Set(s);
        n.delete(tagId); // 失败 → 立刻放回列表
        return n;
      });
      fail();
    },
  });

  return (
    <Portal>
      <MorphingModal
        viewId={open ? "tags" : null}
        onClose={onClose}
        placement={isDesktop ? "center" : "bottom"}
        className="w-[min(100%,26rem)]"
      >
        <TagInput
          subtitle={accountLabel}
          items={items}
          onToggle={(tagId, next) => toggleMut.mutate({ tagId, next })}
          onCreate={(name) => createMut.mutate(name)}
          onRename={(tagId, name) => renameMut.mutate({ tagId, name })}
          onDelete={(tagId) => deleteMut.mutate(tagId)}
        />
      </MorphingModal>
    </Portal>
  );
}
