import type { Tag } from "@folio/db";
import { MorphingModal, toast, useMediaQuery } from "@folio/ui";
import { useRouter } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useTranslations } from "use-intl";
import { attachTag, createTag, deleteTag, detachTag, renameTag } from "../lib/server/tags";
import { Portal } from "./portal";
import { TagInput } from "./tag-input";

// 「打标签」弹窗(ADR 0034):MorphingModal + Portal(同删除确认那套,必须 Portal 出抽屉的 transform 包含块)。
// 交付「点即生效」:attach/detach 用本地 optimistic overlay 即时反馈,后台发 server fn + router.invalidate 同步
// 账户行徽章;create/rename/delete 走 server + invalidate(低频,round-trip 可接受)。纯展示交互在 TagInput。
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
  const router = useRouter();
  const isDesktop = useMediaQuery("(min-width: 640px)");
  // toggle 的乐观 overlay:tagId → 期望的 attached 值。即时反馈,后台 server fn + invalidate 落库。
  const [optim, setOptim] = useState<Map<string, boolean>>(new Map());
  // 新建的乐观占位:回车即先摆一个「已选中」的 chip,不等 create + attach + invalidate 两趟往返。
  // 只存名字 —— 此刻还没有真 id。落库后由真行接管(见下面的对账 effect)。
  const [pending, setPending] = useState<string[]>([]);
  // 删除的乐观隐藏:确认即从列表撤下,不等 delete + invalidate。失败则放回去。
  const [removing, setRemoving] = useState<Set<string>>(new Set());

  // 本组件的数据来自**路由 loader**(listTags),不在 React Query 缓存里 → 没有 setQueryData 可改、
  // 也没有 cache snapshot 可回滚。三处乐观(挂载 / 新建 / 删除)都是同一形状的本地 overlay:
  // 先改本地 → 发 server fn → router.invalidate() → 等 loader 数据追上再撤 overlay(撤早了会闪)。

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
    setPending((names) => {
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
      pending
        .filter((name) => !have.has(name.toLowerCase()))
        .map((name) => ({
          id: `pending:${name}`,
          name,
          attached: true,
          accountCount: 1,
          pending: true, // 还没有真 id → 这一格先不接受点击(见 TagInput)
        })),
    );
  }, [portfolioTags, attachedTagIds, tagAccountCounts, optim, pending, removing]);

  const fail = () => toast.error(t("actionFailed"));

  const onToggle = (tagId: string, next: boolean) => {
    setOptim((m) => new Map(m).set(tagId, next)); // 即时反馈
    const call = next
      ? attachTag({ data: { accountId, tagId } })
      : detachTag({ data: { accountId, tagId } });
    call
      .then(() => router.invalidate()) // 撤 overlay 交给上面的对账 effect,别在这清(避免闪烁)
      .catch(() => {
        setOptim((m) => {
          const n = new Map(m);
          n.delete(tagId); // 失败 → 立即回退乐观
          return n;
        });
        fail();
      });
  };

  const onCreate = async (name: string) => {
    setPending((n) => [...n, name]); // 即时反馈:先摆上已选中的 chip
    // 拿到真 id 才写得进 optim,但失败时得撤 —— 记在这儿,catch 里按它回滚。
    let createdId: string | null = null;
    try {
      const tg = await createTag({ data: { portfolioId, name } });
      createdId = tg.id;
      // 真 id 到手即写乐观挂载 —— 占位撤下时由它接力,避免 attachedTagIds 晚一拍导致 chip 闪成未选中。
      setOptim((m) => new Map(m).set(tg.id, true));
      await attachTag({ data: { accountId, tagId: tg.id } });
      await router.invalidate();
    } catch {
      // createTag 成功但 attachTag 失败会留下「已建未挂」的 Tag —— 仍刷新让它出现在列表里
      // (用户可手动挂上),不至于既看不到又只得到一句报错。createTag 本身失败时刷新无害。
      // 占位在此显式撤掉:create 本身失败时真行永远不出现,对账 effect 等不到。
      setPending((n) => {
        const i = n.indexOf(name);
        return i < 0 ? n : [...n.slice(0, i), ...n.slice(i + 1)];
      });
      // **乐观挂载也得撤**:attach 失败时 attachedTagIds 永远不会追上 true,对账 effect 撤不掉它,
      // chip 会一直显示「已打上」—— 那正好挡住上面那条「用户可手动挂上」的退路。
      const failedId = createdId; // 闭包里收窄:TS 不信 let 在回调执行时仍非空
      if (failedId) {
        setOptim((m) => {
          const n = new Map(m);
          n.delete(failedId);
          return n;
        });
      }
      await router.invalidate();
      fail();
    }
  };

  const onRename = (tagId: string, name: string) => {
    renameTag({ data: { tagId, name } })
      .then(() => router.invalidate())
      .catch(fail);
  };

  const onDelete = (tagId: string) => {
    setRemoving((s) => new Set(s).add(tagId)); // 即时消失
    deleteTag({ data: { tagId } })
      .then(() => router.invalidate()) // 撤 overlay 交给对账 effect(真行没了才撤,避免闪回)
      .catch(() => {
        setRemoving((s) => {
          const n = new Set(s);
          n.delete(tagId); // 失败 → 立刻放回列表
          return n;
        });
        fail();
      });
  };

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
          onToggle={onToggle}
          onCreate={onCreate}
          onRename={onRename}
          onDelete={onDelete}
        />
      </MorphingModal>
    </Portal>
  );
}
