import type { Tag } from "@folio/db";
import { MorphingModal, toast, useMediaQuery } from "@folio/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { useTranslations } from "use-intl";
import { invalidateFor } from "@/lib/queries/refresh";
import { attachTag, createTag, deleteTag, detachTag, renameTag } from "@/lib/server/tags";
import { Portal } from "./portal";
import { TagInput } from "./tag-input";

// Tag created but not attached: onError must also roll back the optimistic attach in that case.
class AttachAfterCreateError extends Error {
  constructor(
    readonly tagId: string,
    options?: ErrorOptions,
  ) {
    super("attach after create failed", options);
    this.name = "AttachAfterCreateError";
  }
}

// Needs a Portal to escape the drawer's transform containing block. attach/detach use a local
// optimistic overlay (click takes effect immediately); create/rename/delete round-trip.
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
  portfolioTags: Tag[];
  attachedTagIds: string[];
  tagAccountCounts: Record<string, number>; // tagId -> accounts carrying it (delete-confirm copy)
  open: boolean;
  onClose: () => void;
}) {
  const t = useTranslations("Tags");
  const queryClient = useQueryClient();
  // Resolves after the refetch of mounted queries, so the overlay reconciliation below holds.
  const refresh = () => invalidateFor(queryClient, "tag.write");
  const isDesktop = useMediaQuery("(min-width: 640px)");
  // Toggle overlay: tagId -> desired attached value.
  const [optim, setOptim] = useState<Map<string, boolean>>(new Map());
  // Optimistic chips for new tags (names only, no real id yet); the real row takes over once stored.
  const [placeholders, setPlaceholders] = useState<string[]>([]);
  // Optimistic hide for deleting tags; restored on failure.
  const [removing, setRemoving] = useState<Set<string>>(new Set());

  // All three optimistic states are local overlays: mutate local, fire the server fn, refresh(),
  // and drop the overlay only once real data catches up (dropping earlier flickers). Not
  // `setQueryData`: this component receives an assembled projection, and an overlay only describes
  // what this slot should look like.

  // Drop a toggle overlay once attachedTagIds matches it; dropping in onSuccess would race the
  // loader and flash the old state.
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

  // Overlay state cleanup only. Convergence itself is derived by name in `items` below, since this
  // effect runs after paint and would flash a duplicate chip for one frame.
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
      .filter((tg) => !removing.has(tg.id))
      .map((tg) => ({
        id: tg.id,
        name: tg.name,
        attached: attached.has(tg.id),
        accountCount: tagAccountCounts[tg.id] ?? (attached.has(tg.id) ? 1 : 0),
        pending: false,
      }));
    // Placeholders go last, matching stored order. A real row filters out its same-named
    // placeholder in the same render, so there is never a two-chip frame.
    const have = new Set(rows.map((r) => r.name.toLowerCase()));
    return rows.concat(
      placeholders
        .filter((name) => !have.has(name.toLowerCase()))
        .map((name) => ({
          id: `pending:${name}`,
          name,
          attached: true,
          accountCount: 1,
          pending: true, // no real id yet: not clickable (see TagInput)
        })),
    );
  }, [portfolioTags, attachedTagIds, tagAccountCounts, optim, placeholders, removing]);

  const fail = () => toast.error(t("actionFailed"));

  // The overlay stays local (not `setQueryData`); mutations only give onMutate / onError / onSuccess
  // each a place. None of them disable any slot while pending: click-to-apply must not wait.

  const toggleMut = useMutation({
    mutationFn: ({ tagId, next }: { tagId: string; next: boolean }) =>
      next ? attachTag({ data: { accountId, tagId } }) : detachTag({ data: { accountId, tagId } }),
    // onMutate runs synchronously before the first await, so this setState batches with the click.
    onMutate: ({ tagId, next }) => {
      setOptim((m) => new Map(m).set(tagId, next));
    },
    onSuccess: refresh, // the reconcile effect drops the overlay; clearing here would flicker
    onError: (_e, { tagId }) => {
      setOptim((m) => {
        const n = new Map(m);
        n.delete(tagId);
        return n;
      });
      fail();
    },
  });

  const createMut = useMutation({
    mutationFn: async (name: string) => {
      const tg = await createTag({ data: { portfolioId, name } });
      // Optimistic attach as soon as the real id exists, so the chip doesn't flash unselected when
      // the placeholder goes. It can't live in onMutate: the id doesn't exist yet there.
      setOptim((m) => new Map(m).set(tg.id, true));
      // Wrapped so onError can tell "created but not attached".
      try {
        await attachTag({ data: { accountId, tagId: tg.id } });
      } catch (cause) {
        throw new AttachAfterCreateError(tg.id, { cause });
      }
      return tg;
    },
    onMutate: (name) => {
      setPlaceholders((n) => [...n, name]);
    },
    onSuccess: refresh,
    onError: async (error, name) => {
      // A created-but-unattached tag should still show in the list (the user can attach it by hand);
      // refreshing is harmless if createTag itself failed. The placeholder is dropped here: when
      // create failed no real row ever arrives for the reconcile effect.
      setPlaceholders((n) => {
        const i = n.indexOf(name);
        return i < 0 ? n : [...n.slice(0, i), ...n.slice(i + 1)];
      });
      // The optimistic attach must go too: attachedTagIds never reaches true, so the chip would
      // stay "attached" and block the manual-attach fallback.
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
      setRemoving((s) => new Set(s).add(tagId));
    },
    onSuccess: refresh, // the reconcile effect drops the overlay once the real row is gone
    onError: (_e, tagId) => {
      setRemoving((s) => {
        const n = new Set(s);
        n.delete(tagId);
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
