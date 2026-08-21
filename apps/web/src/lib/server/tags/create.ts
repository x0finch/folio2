import { TagStore } from "@folio/db";
import { z } from "zod";
import { runStore } from "../oracle";

export const CreateTagInput = z.object({
  portfolioId: z.string().min(1),
  name: z.string().trim().min(1, "tag name is required"),
});

export function handleCreateTag({
  data,
  context,
}: {
  data: z.infer<typeof CreateTagInput>;
  context: { userId: string };
}) {
  return runStore(context.userId, TagStore, (s) =>
    s.create({ portfolioId: data.portfolioId, name: data.name }),
  );
}
