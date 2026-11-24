import { z } from "zod";

// No future timestamps: a future buy would bend the net-worth curve upward with value that doesn't
// exist yet. A few minutes of slack absorb client clock skew.
const FUTURE_SKEW_MS = 5 * 60 * 1000;

// Handler input only, not imports: old backups may predate this rule and must still restore.
export const OccurredAt = z
  .number()
  .int()
  .refine((ms) => ms <= Date.now() + FUTURE_SKEW_MS, {
    message: "occurredAt must not be in the future",
  });
