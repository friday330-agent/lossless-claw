import { existsSync } from "node:fs";
import { join } from "node:path";
import { estimateTokens } from "./estimate-tokens.js";
import { resolveOpenclawStateDir } from "./db/config.js";

const DEFAULT_STALE_AFTER_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_TOKENS = 800;
const DEFAULT_OVERLAY_DB_PATH = join(resolveOpenclawStateDir(), "session-memory.db");
const DEFAULT_OVERLAY_RENDER_VERSION = "session_memory_overlay_v1";

const REQUIRED_FIELDS = [
  ["current topic", "currentTopic"],
  ["user goal", "userGoal"],
  ["must-remember current conclusions", "mustRememberCurrentConclusions"],
  ["current stop point", "currentStopPoint"],
  ["current risk", "currentRisk"],
  ["next step", "nextStep"],
] as const;

type SessionMemoryFieldKey = (typeof REQUIRED_FIELDS)[number][1];
type SessionMemoryFieldLabel = (typeof REQUIRED_FIELDS)[number][0];

export type SessionMemoryCandidate = {
  source: "session_memory_candidate";
  freshness: "fresh";
  budget: "within_budget";
  sourcePath: string;
  modifiedAt: Date;
  tokenCount: number;
  fields: Record<SessionMemoryFieldKey, string>;
};

export type ParseSessionMemorySidecarResult =
  | {
      ok: true;
      candidate: SessionMemoryCandidate;
    }
  | {
      ok: false;
      source: "session_memory_candidate";
      reason: "stale_session_memory" | "malformed_session_memory" | "over_budget";
    };

export type SessionMemoryOverlaySkipReason =
  | "disabled"
  | "db_absent"
  | "read_error"
  | "schema_missing"
  | "schema_too_old"
  | "schema_too_new"
  | "schema_migration_required"
  | "schema_index_missing"
  | "schema_constraint_missing"
  | "lcm_schema_incompatible"
  | "source_ref_missing"
  | "stale_projection"
  | "malformed_rows"
  | "wrong_session"
  | "no_active_entries"
  | "raw_transcript_detected"
  | "over_budget"
  | "render_error"
  | "migration_in_progress"
  | "backup_required"
  | "backup_failed";

export type SessionMemoryOverlayConfig = {
  enabled: boolean;
  dbPath: string;
  maxTokens: number;
  staleAfterMs: number;
  renderVersion: string;
  truncationEnabled: boolean;
};

export const DEFAULT_SESSION_MEMORY_OVERLAY_CONFIG: SessionMemoryOverlayConfig = {
  enabled: false,
  dbPath: DEFAULT_OVERLAY_DB_PATH,
  maxTokens: DEFAULT_MAX_TOKENS,
  staleAfterMs: DEFAULT_STALE_AFTER_MS,
  renderVersion: DEFAULT_OVERLAY_RENDER_VERSION,
  truncationEnabled: false,
};

export type SessionMemoryOverlayRequest = {
  conversationId: number;
  sessionId?: string;
  sessionKey?: string;
};

export type SessionMemorySourceRef =
  | { type: "lcm_summary"; summaryId: string }
  | {
      type: "lcm_message_range";
      conversationId: number;
      sessionKey?: string;
      startSeq: number;
      endSeq: number;
    }
  | { type: "focus_brief"; briefId: string }
  | { type: "workspace_file"; path: string; line?: number }
  | { type: "checkpoint"; checkpointId: string }
  | { type: "sidecar_sample"; path: string };

export type SessionMemoryOverlayEntryKind =
  | "fact"
  | "decision"
  | "open_question"
  | "next_action"
  | "constraint"
  | "evidence"
  | "risk";

export type SessionMemoryOverlayEntry = {
  entryId: string;
  segmentId: string;
  kind: SessionMemoryOverlayEntryKind;
  priority: number;
  body: string;
  updatedAt: string;
  sourceRefs: SessionMemorySourceRef[];
  bodyHash?: string;
  version?: number;
};

export type SessionMemoryOverlayLookupResult =
  | {
      ok: true;
      source: "session_memory_overlay";
      sessionId: string;
      segmentId: string;
      entries: SessionMemoryOverlayEntry[];
      projectionKey: string;
    }
  | {
      ok: false;
      source: "session_memory_overlay";
      reason: SessionMemoryOverlaySkipReason;
    };

export type SessionMemoryOverlayLookup = (
  request: SessionMemoryOverlayRequest,
  config: SessionMemoryOverlayConfig,
) => Promise<SessionMemoryOverlayLookupResult>;

export async function resolveSessionMemoryOverlay(params: {
  config?: Partial<SessionMemoryOverlayConfig>;
  request: SessionMemoryOverlayRequest;
  lookup?: SessionMemoryOverlayLookup;
}): Promise<SessionMemoryOverlayLookupResult> {
  const config = {
    ...DEFAULT_SESSION_MEMORY_OVERLAY_CONFIG,
    ...params.config,
  };
  if (!config.enabled) {
    return {
      ok: false,
      source: "session_memory_overlay",
      reason: "disabled",
    };
  }
  const lookup = params.lookup ?? lookupSessionMemoryOverlay;
  try {
    return await lookup(params.request, config);
  } catch {
    return {
      ok: false,
      source: "session_memory_overlay",
      reason: "read_error",
    };
  }
}

export async function lookupSessionMemoryOverlay(
  request: SessionMemoryOverlayRequest,
  config: SessionMemoryOverlayConfig,
): Promise<SessionMemoryOverlayLookupResult> {
  void request;
  if (!existsSync(config.dbPath)) {
    return {
      ok: false,
      source: "session_memory_overlay",
      reason: "db_absent",
    };
  }
  return {
    ok: false,
    source: "session_memory_overlay",
    reason: "schema_missing",
  };
}

export function parseSessionMemorySidecar(params: {
  content: string;
  sourcePath: string;
  modifiedAt: Date;
  now?: Date;
  staleAfterMs?: number;
  maxTokens?: number;
}): ParseSessionMemorySidecarResult {
  const now = params.now ?? new Date();
  const staleAfterMs = params.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  if (now.getTime() - params.modifiedAt.getTime() > staleAfterMs) {
    return { ok: false, source: "session_memory_candidate", reason: "stale_session_memory" };
  }

  const fields = parseFields(params.content);
  if (!fields) {
    return { ok: false, source: "session_memory_candidate", reason: "malformed_session_memory" };
  }

  const tokenCount = estimateTokens(params.content);
  if (tokenCount > (params.maxTokens ?? DEFAULT_MAX_TOKENS)) {
    return { ok: false, source: "session_memory_candidate", reason: "over_budget" };
  }

  return {
    ok: true,
    candidate: {
      source: "session_memory_candidate",
      freshness: "fresh",
      budget: "within_budget",
      sourcePath: params.sourcePath,
      modifiedAt: params.modifiedAt,
      tokenCount,
      fields,
    },
  };
}

function parseFields(content: string): Record<SessionMemoryFieldKey, string> | null {
  const output = {} as Record<SessionMemoryFieldKey, string>;
  const seen = new Set<string>();
  const expected = new Map<SessionMemoryFieldLabel, SessionMemoryFieldKey>(REQUIRED_FIELDS);
  const lines = content.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length !== REQUIRED_FIELDS.length) {
    return null;
  }

  for (const line of lines) {
    const separator = line.indexOf(":");
    if (separator <= 0) {
      return null;
    }
    const label = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    const key = expected.get(label as SessionMemoryFieldLabel);
    if (!key || seen.has(label) || value.length === 0) {
      return null;
    }
    output[key] = value;
    seen.add(label);
  }

  if (seen.size !== REQUIRED_FIELDS.length) {
    return null;
  }
  return output;
}
