import type { Tag } from "@folio/db";
import { MorphingModal, toast, useMediaQuery } from "@folio/ui";
import { useRouter } from "@tanstack/react-router";
import { useMemo, useState } from "react";
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
  // toggle 的乐观 overlay:tagId → 期望的 attached 值。props 追上后由 items 派生自然覆盖(下次 invalidate)。
  const [optim, setOptim] = useState<Map<string, boolean>>(new Map());

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
      .then(() => router.invalidate())
      .catch(() => {
        setOptim((m) => {
          const n = new Map(m);
          n.delete(tagId); // 回退乐观
          return n;
        });
        fail();
      });
  };

  const onCreate = (name: string) => {
    createTag({ data: { portfolioId, name } })
      .then((tg) => attachTag({ data: { accountId, tagId: tg.id } }))
      .then(() => router.invalidate())
      .catch(fail);
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
