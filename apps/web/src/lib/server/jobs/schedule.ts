import { Effect } from "effect";
import { AFTER_SYNC_DELAY_SECONDS } from "./constants";
import { type Enqueued, enqueue } from "./queue";

// Freshness is gated in the consumer, not the cron: checking caches here would cost cron CPU per
// user, while an extra no-op message is cheap. Frequency follows how fast data changes, not TTL:
// hourly with sync for prices / fx / platforms / defi-logos, daily for catalogue and prune-notes.

/** Snapshot readers are delayed until after the user's `sync-account`. */
export const hourlyUserJobs = (userId: string): Enqueued[] => [
  { job: { kind: "prices", userId } },
  { job: { kind: "daily-prices", userId } },
  { job: { kind: "fx", userId } },
  { job: { kind: "platforms", userId }, delaySeconds: AFTER_SYNC_DELAY_SECONDS },
  { job: { kind: "defi-logos", userId }, delaySeconds: AFTER_SYNC_DELAY_SECONDS },
];

const dailyUserJobs = (userId: string): Enqueued[] => [
  { job: { kind: "prune-notes", userId } },
  { job: { kind: "catalogue", userId } },
];

/** No upstream, no DB: per-user messages give per-user failure isolation. */
export const fanOutDaily = (userIds: readonly string[]): Effect.Effect<{ jobs: number }> => {
  const batch = userIds.flatMap(dailyUserJobs);
  return Effect.as(enqueue(batch), { jobs: batch.length });
};
