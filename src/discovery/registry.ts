import { promises as fs } from "node:fs";
import path from "node:path";

import {
  RepoCandidate,
  registryRecordSchema,
  type RegistryRecord,
  type RegistrySnapshot,
  registrySnapshotSchema,
  type TrackingStatus,
} from "./types";

const ALLOWED_TRANSITIONS: Record<
  TrackingStatus,
  ReadonlyArray<TrackingStatus>
> = {
  pending: ["active", "paused", "blacklisted"],
  active: ["active", "paused", "blacklisted"],
  paused: ["active", "blacklisted", "paused"],
  blacklisted: ["blacklisted"],
};

interface StoreOptions {
  snapshotPath?: string;
  now?: () => string;
}

interface UpsertResult {
  inserted: number;
  updated: number;
  errors: number;
  records: RegistryRecord[];
}

export class TrackedRepositoryStore {
  private records = new Map<string, RegistryRecord>();
  private now = () => new Date().toISOString();

  private constructor(
    private options: StoreOptions = {},
  ) {
    this.now = options.now || this.now;
  }

  static async create(options: StoreOptions = {}): Promise<TrackedRepositoryStore> {
    const store = new TrackedRepositoryStore(options);
    if (options.snapshotPath) {
      await store.loadFromPath(options.snapshotPath);
    }
    return store;
  }

  private async loadFromPath(snapshotPath: string): Promise<void> {
    const absolute = path.resolve(snapshotPath);
    let raw: string;

    try {
      raw = await fs.readFile(absolute, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return;
      }

      throw error;
    }

    const parsed = registrySnapshotSchema.parse(JSON.parse(raw));
    this.records = new Map(parsed.records.map((record) => [record.full_name, record]));
  }

  private nowIso(): string {
    return this.now();
  }

  get allRecords(): RegistryRecord[] {
    return [...this.records.values()].sort((left, right) =>
      left.full_name.localeCompare(right.full_name)
    );
  }

  getRecord(fullName: string): RegistryRecord | undefined {
    return this.records.get(fullName);
  }

  listByStatus(status: TrackingStatus): RegistryRecord[] {
    return this.allRecords.filter((record) => record.status === status);
  }

  snapshot(queryProfileId: string): RegistrySnapshot {
    return registrySnapshotSchema.parse({
      schema_version: 1,
      generated_at: this.nowIso(),
      query_profile_id: queryProfileId,
      records: this.allRecords,
    });
  }

  async persist(snapshotPath: string, queryProfileId: string): Promise<RegistrySnapshot> {
    const absolute = path.resolve(snapshotPath);
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    const snapshot = this.snapshot(queryProfileId);
    await fs.writeFile(absolute, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
    return snapshot;
  }

  upsertTrackedRepositories(
    candidates: RepoCandidate[],
  ): UpsertResult {
    let inserted = 0;
    let updated = 0;
    let errors = 0;

    for (const candidate of candidates) {
      try {
        const exists = this.records.get(candidate.full_name);
        const now = this.nowIso();

        if (exists) {
          const next: RegistryRecord = {
            ...exists,
            id: candidate.id,
            default_branch: candidate.default_branch,
            stars: candidate.stars,
            pushed_at: candidate.pushed_at,
            updated_at: candidate.updated_at,
            language: candidate.language,
            license: candidate.license,
            topics: candidate.topics,
            homepage: candidate.homepage,
            description: candidate.description,
            quality_score: candidate.quality_score,
            source_category: candidate.source_category,
            source_query_profile_id: candidate.source_query_profile_id,
            last_checked_at: now,
            last_error: null,
          };

          this.records.set(candidate.full_name, {
            ...next,
            priority: exists.priority ?? 0,
          });
          updated += 1;
          continue;
        }

        const record = registryRecordSchema.parse({
          ...candidate,
          status: "pending",
          last_checked_at: now,
          last_transition_at: now,
          last_error: null,
          priority: 0,
        });

        this.records.set(candidate.full_name, record);
        inserted += 1;
      } catch (error) {
        errors += 1;
      }
    }

    return {
      inserted,
      updated,
      errors,
      records: this.allRecords,
    };
  }

  transitionRecordStatus(
    fullName: string,
    nextStatus: TrackingStatus,
  ): RegistryRecord {
    const current = this.records.get(fullName);
    if (!current) {
      throw new Error(`No tracked repo with full_name ${fullName}`);
    }

    const allowed = ALLOWED_TRANSITIONS[current.status].includes(nextStatus);
    if (!allowed) {
      throw new Error(`Invalid transition: ${current.status} -> ${nextStatus}`);
    }

    if (current.status !== nextStatus) {
      const now = this.nowIso();
      current.status = nextStatus;
      current.last_transition_at = now;
    }

    current.last_checked_at = this.nowIso();
    current.last_error = null;
    this.records.set(current.full_name, current);

    return current;
  }

  markActive(fullName: string): RegistryRecord {
    return this.transitionRecordStatus(fullName, "active");
  }

  markPaused(fullName: string): RegistryRecord {
    return this.transitionRecordStatus(fullName, "paused");
  }

  markBlacklisted(fullName: string): RegistryRecord {
    return this.transitionRecordStatus(fullName, "blacklisted");
  }
}

export type { UpsertResult };
