import type { DatabaseSync } from "node:sqlite";
import { withDatabaseTransaction } from "../transaction-mutex.js";
import { parseUtcTimestampOrNull } from "./parse-utc-timestamp.js";

export type CacheState = "hot" | "cold" | "unknown";
export type ActivityBand = "low" | "medium" | "high";
export type AssemblySelectedSource =
  | "raw_only"
  | "dag_summary"
  | "working_summary"
  | "compaction_injection_summary";

export type AssemblyTelemetryCounters = {
  assemblyReadCount: number;
  assemblyRawOnlyCount: number;
  assemblyDagSummaryCount: number;
  assemblyWorkingSummaryCount: number;
  assemblyInjectionSummaryCount: number;
  assemblyFallbackCount: number;
  assemblyLastSelectedSource: AssemblySelectedSource | null;
  assemblyLastFallbackReason: string | null;
  assemblyLastReadAt: Date | null;
};

export type ConversationCompactionTelemetryRecord = {
  conversationId: number;
  lastObservedCacheRead: number | null;
  lastObservedCacheWrite: number | null;
  lastObservedPromptTokenCount: number | null;
  lastObservedCacheHitAt: Date | null;
  lastObservedCacheBreakAt: Date | null;
  cacheState: CacheState;
  consecutiveColdObservations: number;
  retention: string | null;
  lastLeafCompactionAt: Date | null;
  turnsSinceLeafCompaction: number;
  tokensAccumulatedSinceLeafCompaction: number;
  lastActivityBand: ActivityBand;
  lastApiCallAt: Date | null;
  lastCacheTouchAt: Date | null;
  provider: string | null;
  model: string | null;
  updatedAt: Date;
};

export type UpsertConversationCompactionTelemetryInput = {
  conversationId: number;
  lastObservedCacheRead?: number | null;
  lastObservedCacheWrite?: number | null;
  lastObservedPromptTokenCount?: number | null;
  lastObservedCacheHitAt?: Date | null;
  lastObservedCacheBreakAt?: Date | null;
  cacheState: CacheState;
  consecutiveColdObservations?: number;
  retention?: string | null;
  lastLeafCompactionAt?: Date | null;
  turnsSinceLeafCompaction?: number;
  tokensAccumulatedSinceLeafCompaction?: number;
  lastActivityBand?: ActivityBand;
  lastApiCallAt?: Date | null;
  lastCacheTouchAt?: Date | null;
  provider?: string | null;
  model?: string | null;
};

type ConversationCompactionTelemetryRow = {
  conversation_id: number;
  last_observed_cache_read: number | null;
  last_observed_cache_write: number | null;
  last_observed_prompt_token_count: number | null;
  last_observed_cache_hit_at: string | null;
  last_observed_cache_break_at: string | null;
  cache_state: CacheState;
  consecutive_cold_observations: number | null;
  retention: string | null;
  last_leaf_compaction_at: string | null;
  turns_since_leaf_compaction: number | null;
  tokens_accumulated_since_leaf_compaction: number | null;
  last_activity_band: ActivityBand | null;
  last_api_call_at: string | null;
  last_cache_touch_at: string | null;
  provider: string | null;
  model: string | null;
  updated_at: string;
};

function toConversationCompactionTelemetryRecord(
  row: ConversationCompactionTelemetryRow,
): ConversationCompactionTelemetryRecord {
  return {
    conversationId: row.conversation_id,
    lastObservedCacheRead: row.last_observed_cache_read,
    lastObservedCacheWrite: row.last_observed_cache_write,
    lastObservedPromptTokenCount: row.last_observed_prompt_token_count,
    lastObservedCacheHitAt: parseUtcTimestampOrNull(row.last_observed_cache_hit_at),
    lastObservedCacheBreakAt: parseUtcTimestampOrNull(row.last_observed_cache_break_at),
    cacheState: row.cache_state,
    consecutiveColdObservations: row.consecutive_cold_observations ?? 0,
    retention: row.retention,
    lastLeafCompactionAt: parseUtcTimestampOrNull(row.last_leaf_compaction_at),
    turnsSinceLeafCompaction: row.turns_since_leaf_compaction ?? 0,
    tokensAccumulatedSinceLeafCompaction: row.tokens_accumulated_since_leaf_compaction ?? 0,
    lastActivityBand: row.last_activity_band ?? "low",
    lastApiCallAt: parseUtcTimestampOrNull(row.last_api_call_at),
    lastCacheTouchAt: parseUtcTimestampOrNull(row.last_cache_touch_at),
    provider: row.provider,
    model: row.model,
    updatedAt: parseUtcTimestampOrNull(row.updated_at) ?? new Date(0),
  };
}

export function emptyAssemblyTelemetryCounters(): AssemblyTelemetryCounters {
  return {
    assemblyReadCount: 0,
    assemblyRawOnlyCount: 0,
    assemblyDagSummaryCount: 0,
    assemblyWorkingSummaryCount: 0,
    assemblyInjectionSummaryCount: 0,
    assemblyFallbackCount: 0,
    assemblyLastSelectedSource: null,
    assemblyLastFallbackReason: null,
    assemblyLastReadAt: null,
  };
}

/**
 * In-memory assembly source counters for the currently running plugin process.
 *
 * These counters intentionally do not write database schema: assembly already
 * logs source metadata, while this helper gives tests and runtime status code a
 * cheap per-process aggregation surface.
 */
export class AssemblyTelemetryStore {
  private readonly records = new Map<number, AssemblyTelemetryCounters>();

  recordObservation(input: {
    conversationId: number;
    selectedSource: AssemblySelectedSource;
    fallbackReason?: string | null;
  }): AssemblyTelemetryCounters {
    const existing = this.records.get(input.conversationId) ?? emptyAssemblyTelemetryCounters();
    const fallbackReason = input.fallbackReason?.trim() || null;
    const updated: AssemblyTelemetryCounters = {
      assemblyReadCount: existing.assemblyReadCount + 1,
      assemblyRawOnlyCount:
        existing.assemblyRawOnlyCount + (input.selectedSource === "raw_only" ? 1 : 0),
      assemblyDagSummaryCount:
        existing.assemblyDagSummaryCount + (input.selectedSource === "dag_summary" ? 1 : 0),
      assemblyWorkingSummaryCount:
        existing.assemblyWorkingSummaryCount + (input.selectedSource === "working_summary" ? 1 : 0),
      assemblyInjectionSummaryCount:
        existing.assemblyInjectionSummaryCount
        + (input.selectedSource === "compaction_injection_summary" ? 1 : 0),
      assemblyFallbackCount: existing.assemblyFallbackCount + (fallbackReason ? 1 : 0),
      assemblyLastSelectedSource: input.selectedSource,
      assemblyLastFallbackReason: fallbackReason,
      assemblyLastReadAt: new Date(),
    };
    this.records.set(input.conversationId, updated);
    return updated;
  }

  get(conversationId: number): AssemblyTelemetryCounters | null {
    return this.records.get(conversationId) ?? null;
  }
}

/**
 * Persist and query per-conversation prompt-cache telemetry used by
 * cache-aware incremental compaction.
 */
export class CompactionTelemetryStore {
  constructor(private readonly db: DatabaseSync) {}

  /** Execute multiple telemetry writes atomically. */
  withTransaction<T>(fn: () => Promise<T>): Promise<T> {
    return withDatabaseTransaction(this.db, "BEGIN", fn);
  }

  /** Load the latest persisted telemetry for a conversation. */
  async getConversationCompactionTelemetry(
    conversationId: number,
  ): Promise<ConversationCompactionTelemetryRecord | null> {
    const row = this.db
      .prepare(
        `SELECT
           conversation_id,
           last_observed_cache_read,
           last_observed_cache_write,
           last_observed_prompt_token_count,
           last_observed_cache_hit_at,
           last_observed_cache_break_at,
           cache_state,
           consecutive_cold_observations,
           retention,
           last_leaf_compaction_at,
           turns_since_leaf_compaction,
           tokens_accumulated_since_leaf_compaction,
           last_activity_band,
           last_api_call_at,
           last_cache_touch_at,
           provider,
           model,
           updated_at
         FROM conversation_compaction_telemetry
         WHERE conversation_id = ?`,
      )
      .get(conversationId) as ConversationCompactionTelemetryRow | undefined;
    return row ? toConversationCompactionTelemetryRecord(row) : null;
  }

  /** Upsert the current cache telemetry snapshot for a conversation. */
  async upsertConversationCompactionTelemetry(
    input: UpsertConversationCompactionTelemetryInput,
  ): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO conversation_compaction_telemetry (
           conversation_id,
           last_observed_cache_read,
           last_observed_cache_write,
           last_observed_prompt_token_count,
           last_observed_cache_hit_at,
           last_observed_cache_break_at,
           cache_state,
           consecutive_cold_observations,
           retention,
           last_leaf_compaction_at,
           turns_since_leaf_compaction,
           tokens_accumulated_since_leaf_compaction,
           last_activity_band,
           last_api_call_at,
           last_cache_touch_at,
           provider,
           model,
           updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
         ON CONFLICT(conversation_id) DO UPDATE SET
           last_observed_cache_read = excluded.last_observed_cache_read,
           last_observed_cache_write = excluded.last_observed_cache_write,
           last_observed_prompt_token_count = excluded.last_observed_prompt_token_count,
           last_observed_cache_hit_at = excluded.last_observed_cache_hit_at,
           last_observed_cache_break_at = excluded.last_observed_cache_break_at,
           cache_state = excluded.cache_state,
           consecutive_cold_observations = excluded.consecutive_cold_observations,
           retention = excluded.retention,
           last_leaf_compaction_at = excluded.last_leaf_compaction_at,
           turns_since_leaf_compaction = excluded.turns_since_leaf_compaction,
           tokens_accumulated_since_leaf_compaction = excluded.tokens_accumulated_since_leaf_compaction,
           last_activity_band = excluded.last_activity_band,
           last_api_call_at = excluded.last_api_call_at,
           last_cache_touch_at = excluded.last_cache_touch_at,
           provider = excluded.provider,
           model = excluded.model,
           updated_at = datetime('now')`,
      )
      .run(
        input.conversationId,
        input.lastObservedCacheRead ?? null,
        input.lastObservedCacheWrite ?? null,
        input.lastObservedPromptTokenCount ?? null,
        input.lastObservedCacheHitAt?.toISOString() ?? null,
        input.lastObservedCacheBreakAt?.toISOString() ?? null,
        input.cacheState,
        input.consecutiveColdObservations ?? 0,
        input.retention ?? null,
        input.lastLeafCompactionAt?.toISOString() ?? null,
        input.turnsSinceLeafCompaction ?? 0,
        input.tokensAccumulatedSinceLeafCompaction ?? 0,
        input.lastActivityBand ?? "low",
        input.lastApiCallAt?.toISOString() ?? null,
        input.lastCacheTouchAt?.toISOString() ?? null,
        input.provider ?? null,
        input.model ?? null,
      );
  }
}
