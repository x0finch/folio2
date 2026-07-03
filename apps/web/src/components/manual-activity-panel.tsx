import type { ManualActivity } from "@folio/db";
import {
  Button,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@folio/ui";
import { useRouter } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useTranslations } from "use-intl";
import {
  addManualActivity,
  deleteManualActivity,
  listManualActivity,
} from "../lib/server/manual-activity";

// manual 账户的活动面板(P7.4.1):列出 add/reduce/set 活动 + 录入/删除。自取数据(client fetch)。
// 改动后 router.invalidate() 刷新总览/账户(数量已物化进 creds.amount)。用于账户详情侧栏。
export function ManualActivityPanel({ accountId }: { accountId: string }) {
  const t = useTranslations("Activity");
  const router = useRouter();
  const [items, setItems] = useState<ManualActivity[]>([]);
  const [kind, setKind] = useState<"add" | "reduce" | "set">("add");
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = async () => {
    setItems(await listManualActivity({ data: { accountId } }));
  };
  useEffect(() => {
    let alive = true;
    listManualActivity({ data: { accountId } })
      .then((rows) => alive && setItems(rows))
      .catch((e) => alive && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      alive = false;
    };
  }, [accountId]);

  async function onAdd(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await addManualActivity({
        data: { accountId, kind, amount: Number(amount), note: note || undefined },
      });
      setAmount("");
      setNote("");
      await reload();
      await router.invalidate(); // 数量变 → 刷新总览/账户
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function onDelete(id: string) {
    await deleteManualActivity({ data: { accountId, id } });
    await reload();
    await router.invalidate();
  }

  return (
    <div className="flex flex-col gap-2 border-t pt-3">
      <p className="text-xs font-medium text-muted-foreground">{t("title")}</p>
      {items.length > 0 && (
        <ul className="flex flex-col gap-1 text-sm">
          {items.map((it) => (
            <li key={it.id} className="flex items-center justify-between gap-2">
              <span>
                <span className="capitalize">{t(it.kind)}</span> {it.amount}
                {it.note ? <span className="text-muted-foreground"> · {it.note}</span> : null}
              </span>
              <button
                type="button"
                onClick={() => onDelete(it.id)}
                className="text-xs text-muted-foreground hover:text-destructive"
              >
                {t("delete")}
              </button>
            </li>
          ))}
        </ul>
      )}
      <form onSubmit={onAdd} className="flex flex-wrap items-end gap-2">
        <Select value={kind} onValueChange={(v) => setKind(v as "add" | "reduce" | "set")}>
          <SelectTrigger className="w-28">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="add">{t("add")}</SelectItem>
            <SelectItem value="reduce">{t("reduce")}</SelectItem>
            <SelectItem value="set">{t("set")}</SelectItem>
          </SelectContent>
        </Select>
        <Input
          type="number"
          step="any"
          required
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          placeholder={t("amountPlaceholder")}
          className="w-32"
        />
        <Input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder={t("notePlaceholder")}
          className="w-40"
        />
        <Button type="submit" size="sm" disabled={busy}>
          {t("record")}
        </Button>
      </form>
      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
}
