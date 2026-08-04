import type { Tag } from "@folio/db";
import { MorphingModal, toast, useMediaQuery } from "@folio/ui";
import { useRouter } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useTranslations } from "use-intl";
import { attachTag, createTag, deleteTag, detachTag, renameTag } from "../lib/server/tags";
import { tagColor } from "../lib/tag-color";
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

  const items = useMemo(() => {
    const attached = new Set(attachedTagIds);
    for (const [id, want] of optim) {
      if (want) attached.add(id);
      else attached.delete(id);
    }
    return portfolioTags.map((tg) => ({
      id: tg.id,
      name: tg.name,
      color: tagColor(tg.id),
      attached: attached.has(tg.id),
      accountCount: tagAccountCounts[tg.id] ?? (attached.has(tg.id) ? 1 : 0),
    }));
  }, [portfolioTags, attachedTagIds, tagAccountCounts, optim]);

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
    try {
      const tg = await createTag({ data: { portfolioId, name } });
      await attachTag({ data: { accountId, tagId: tg.id } });
      await router.invalidate();
    } catch {
      // createTag 成功但 attachTag 失败会留下「已建未挂」的 Tag —— 仍刷新让它出现在列表里
      // (用户可手动挂上),不至于既看不到又只得到一句报错。createTag 本身失败时刷新无害。
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
    deleteTag({ data: { tagId } })
      .then(() => router.invalidate())
      .catch(fail);
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
