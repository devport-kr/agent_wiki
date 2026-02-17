import { TrackedRepositoryStore } from "./registry";

interface BootstrapResult {
  promoted: number;
  active_count: number;
}

export function ensureInitialTrackedSet(
  store: TrackedRepositoryStore,
  targetActiveCount = 50,
): BootstrapResult {
  const activeRecords = store.listByStatus("active");
  if (activeRecords.length >= targetActiveCount) {
    return {
      promoted: 0,
      active_count: activeRecords.length,
    };
  }

  const pending = store
    .listByStatus("pending")
    .sort((left, right) => {
      const delta = right.quality_score - left.quality_score;
      if (delta !== 0) {
        return delta;
      }

      return left.full_name.localeCompare(right.full_name);
    });

  const needed = targetActiveCount - activeRecords.length;
  const toPromote = pending.slice(0, needed);

  for (const record of toPromote) {
    store.markActive(record.full_name);
  }

  return {
    promoted: toPromote.length,
    active_count: activeRecords.length + toPromote.length,
  };
}

export function filterRecordsByStatus(
  store: TrackedRepositoryStore,
  status: "active" | "pending" | "paused" | "blacklisted",
): ReturnType<TrackedRepositoryStore["listByStatus"]> {
  return store.listByStatus(status);
}

export type { BootstrapResult };
