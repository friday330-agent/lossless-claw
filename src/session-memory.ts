import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { estimateTokens } from "./estimate-tokens.js";
import { resolveOpenclawStateDir } from "./db/config.js";

const DEFAULT_STALE_AFTER_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_TOKENS = 800;
const DEFAULT_OVERLAY_DB_PATH = join(resolveOpenclawStateDir(), "session-memory.db");
const DEFAULT_OVERLAY_RENDER_VERSION = "session_memory_overlay_v1";
const SUPPORTED_SESSION_MEMORY_SCHEMA_VERSION = 1;
const REQUIRED_OVERLAY_TABLES = [
  "schema_migrations",
  "sessions",
  "segments",
  "entries",
  "checkpoints",
  "carry_forward",
  "links",
];

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
  if (!existsSync(config.dbPath)) {
    return {
      ok: false,
      source: "session_memory_overlay",
      reason: "db_absent",
    };
  }

  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(config.dbPath, { readOnly: true });
    const compatibility = checkSessionMemorySchemaCompatibility(db);
    if (!compatibility.ok) {
      return compatibility;
    }
    return readActiveSessionMemoryEntries(db, request);
  } catch {
    return {
      ok: false,
      source: "session_memory_overlay",
      reason: "read_error",
    };
  } finally {
    try {
      db?.close();
    } catch {
      // Best-effort cleanup only; callers already get a fail-closed result.
    }
  }
}

type SessionMemorySchemaCompatibilityResult =
  | { ok: true }
  | {
      ok: false;
      source: "session_memory_overlay";
      reason: SessionMemoryOverlaySkipReason;
    };

function checkSessionMemorySchemaCompatibility(db: DatabaseSync): SessionMemorySchemaCompatibilityResult {
  const tableNames = new Set(
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => String((row as { name: unknown }).name)),
  );

  for (const tableName of REQUIRED_OVERLAY_TABLES) {
    if (!tableNames.has(tableName)) {
      return {
        ok: false,
        source: "session_memory_overlay",
        reason: "schema_missing",
      };
    }
  }

  const pragmaUserVersion = db.prepare("PRAGMA user_version").get() as { user_version?: unknown } | undefined;
  const userVersion = Number(pragmaUserVersion?.user_version ?? 0);
  if (userVersion < SUPPORTED_SESSION_MEMORY_SCHEMA_VERSION) {
    return {
      ok: false,
      source: "session_memory_overlay",
      reason: "schema_too_old",
    };
  }
  if (userVersion > SUPPORTED_SESSION_MEMORY_SCHEMA_VERSION) {
    return {
      ok: false,
      source: "session_memory_overlay",
      reason: "schema_too_new",
    };
  }

  const migration = db
    .prepare("SELECT schema_version FROM schema_migrations ORDER BY applied_at DESC LIMIT 1")
    .get() as { schema_version?: unknown } | undefined;
  const migrationVersion = Number(migration?.schema_version ?? 0);
  if (migrationVersion !== SUPPORTED_SESSION_MEMORY_SCHEMA_VERSION) {
    return {
      ok: false,
      source: "session_memory_overlay",
      reason: "schema_migration_required",
    };
  }

  return { ok: true };
}

function readActiveSessionMemoryEntries(
  db: DatabaseSync,
  request: SessionMemoryOverlayRequest,
): SessionMemoryOverlayLookupResult {
  const rows = db
    .prepare(
      `SELECT
         s.session_id AS session_id,
         sg.segment_id AS segment_id,
         e.entry_id AS entry_id,
         e.kind AS kind,
         e.priority AS priority,
         e.body AS body,
         e.updated_at AS updated_at,
         e.source_refs_json AS source_refs_json
       FROM sessions s
       JOIN segments sg ON sg.session_id = s.session_id
       JOIN entries e ON e.segment_id = sg.segment_id
       WHERE s.conversation_id = ?
         AND s.status = 'active'
         AND sg.status = 'active'
         AND e.status = 'active'
         AND (? IS NULL OR s.session_key IS NULL OR s.session_key = ?)
       ORDER BY e.priority DESC, e.updated_at DESC, e.entry_id ASC`,
    )
    .all(request.conversationId, request.sessionKey ?? null, request.sessionKey ?? null) as Array<{
    session_id: unknown;
    segment_id: unknown;
    entry_id: unknown;
    kind: unknown;
    priority: unknown;
    body: unknown;
    updated_at: unknown;
    source_refs_json: unknown;
  }>;

  if (rows.length === 0) {
    return readNoActiveEntriesResult();
  }

  const entries: SessionMemoryOverlayEntry[] = [];
  for (const row of rows) {
    const kind = String(row.kind);
    if (!isSessionMemoryOverlayEntryKind(kind)) {
      return {
        ok: false,
        source: "session_memory_overlay",
        reason: "malformed_rows",
      };
    }
    const sourceRefs = parseSourceRefs(row.source_refs_json);
    if (!sourceRefs) {
      return {
        ok: false,
        source: "session_memory_overlay",
        reason: "malformed_rows",
      };
    }
    entries.push({
      entryId: String(row.entry_id),
      segmentId: String(row.segment_id),
      kind,
      priority: Number(row.priority ?? 0),
      body: String(row.body),
      updatedAt: String(row.updated_at),
      sourceRefs,
    });
  }

  return {
    ok: true,
    source: "session_memory_overlay",
    sessionId: String(rows[0]?.session_id),
    segmentId: String(rows[0]?.segment_id),
    entries,
    projectionKey: buildSessionMemoryProjectionKey(entries),
  };
}

function readNoActiveEntriesResult(): SessionMemoryOverlayLookupResult {
  return {
    ok: false,
    source: "session_memory_overlay",
    reason: "no_active_entries",
  };
}

function isSessionMemoryOverlayEntryKind(value: string): value is SessionMemoryOverlayEntryKind {
  return (
    value === "fact" ||
    value === "decision" ||
    value === "open_question" ||
    value === "next_action" ||
    value === "constraint" ||
    value === "evidence" ||
    value === "risk"
  );
}

function parseSourceRefs(raw: unknown): SessionMemorySourceRef[] | null {
  if (raw === null || raw === undefined || raw === "") {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(raw));
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) {
    return null;
  }
  const refs: SessionMemorySourceRef[] = [];
  for (const ref of parsed) {
    if (!ref || typeof ref !== "object") {
      return null;
    }
    const candidate = ref as Record<string, unknown>;
    const type = String(candidate.type);
    if (type === "lcm_summary" && typeof candidate.summary_id === "string") {
      refs.push({ type, summaryId: candidate.summary_id });
    } else if (
      type === "lcm_message_range" &&
      typeof candidate.conversation_id === "number" &&
      typeof candidate.start_seq === "number" &&
      typeof candidate.end_seq === "number"
    ) {
      refs.push({
        type,
        conversationId: candidate.conversation_id,
        sessionKey: typeof candidate.session_key === "string" ? candidate.session_key : undefined,
        startSeq: candidate.start_seq,
        endSeq: candidate.end_seq,
      });
    } else if (type === "focus_brief" && typeof candidate.brief_id === "string") {
      refs.push({ type, briefId: candidate.brief_id });
    } else if (type === "workspace_file" && typeof candidate.path === "string") {
      refs.push({
        type,
        path: candidate.path,
        line: typeof candidate.line === "number" ? candidate.line : undefined,
      });
    } else if (type === "checkpoint" && typeof candidate.checkpoint_id === "string") {
      refs.push({ type, checkpointId: candidate.checkpoint_id });
    } else if (type === "sidecar_sample" && typeof candidate.path === "string") {
      refs.push({ type, path: candidate.path });
    } else {
      return null;
    }
  }
  return refs;
}

function buildSessionMemoryProjectionKey(entries: SessionMemoryOverlayEntry[]): string {
  return entries
    .map((entry) => [entry.entryId, entry.updatedAt, entry.bodyHash ?? "", entry.version ?? ""].join(":"))
    .join("|");
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
