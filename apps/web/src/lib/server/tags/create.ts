import { TagStore } from "@folio/db";
import { runStore } from "../oracle";

export function handleCreateTag({
  data,
  context,
}: {
  data: { portfolioId: string; name: string };
  context: { userId: string };
}) {
  return runStore(context.userId, TagStore, (s) =>
    s.create({ portfolioId: data.portfolioId, name: data.name }),
  );
}
