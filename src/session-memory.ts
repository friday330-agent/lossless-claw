import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { estimateTokens } from "./estimate-tokens.js";
import { resolveOpenclawStateDir } from "./db/config.js";

const DEFAULT_STALE_AFTER_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_TOKENS = 800;
const DEFAULT_OVERLAY_DB_PATH = join(resolveOpenclawStateDir(), "session-memory.db");
const DEFAULT_OVERLAY_LCM_DB_PATH = join(resolveOpenclawStateDir(), "lcm.db");
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
const REQUIRED_OVERLAY_TABLE_COLUMNS = {
  schema_migrations: ["migration_id", "schema_version", "applied_at", "checksum", "description"],
  sessions: ["session_id", "conversation_id", "session_key", "status", "started_at", "updated_at"],
  segments: ["segment_id", "session_id", "seq", "status", "opened_at", "updated_at"],
  entries: [
    "entry_id",
    "session_id",
    "segment_id",
    "kind",
    "status",
    "confidence",
    "priority",
    "body",
    "source_refs_json",
    "origin_entry_id",
    "superseded_by_entry_id",
    "updated_at",
  ],
  checkpoints: [
    "checkpoint_id",
    "session_id",
    "from_segment_id",
    "to_segment_id",
    "reason",
    "trigger_snapshot_json",
    "created_at",
  ],
  carry_forward: ["carry_id", "checkpoint_id", "from_entry_id", "to_entry_id", "priority", "reason", "created_at"],
  links: ["link_id", "src_type", "src_id", "relation", "dst_type", "dst_id", "confidence", "source_refs_json", "created_at"],
};
const REQUIRED_OVERLAY_INDEXES = [
  { tableName: "sessions", columns: ["status", "updated_at"] },
  { tableName: "segments", columns: ["session_id", "status", "seq"] },
  { tableName: "entries", columns: ["session_id", "status", "priority", "updated_at"] },
  { tableName: "entries", columns: ["segment_id", "status", "kind"] },
  { tableName: "links", columns: ["src_type", "src_id", "relation"] },
  { tableName: "links", columns: ["dst_type", "dst_id", "relation"] },
];
const REQUIRED_OVERLAY_UNIQUE_CONSTRAINTS = [
  { tableName: "segments", columns: ["session_id", "seq"] },
  { tableName: "links", columns: ["src_type", "src_id", "relation", "dst_type", "dst_id"] },
];
const REQUIRED_LCM_TABLE_COLUMNS = {
  conversations: ["conversation_id", "session_id", "session_key"],
  messages: ["message_id", "conversation_id", "seq"],
  summaries: ["summary_id", "conversation_id"],
  context_items: ["conversation_id", "ordinal"],
  summary_messages: ["summary_id", "message_id"],
  focus_briefs: ["brief_id", "conversation_id", "session_key"],
  focus_brief_sources: ["brief_id", "summary_id"],
};

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
  | "kill_switch"
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
  killSwitchEnabled: boolean;
  dbPath: string;
  lcmDbPath: string;
  maxTokens: number;
  staleAfterMs: number;
  renderVersion: string;
  truncationEnabled: boolean;
};

export const DEFAULT_SESSION_MEMORY_OVERLAY_CONFIG: SessionMemoryOverlayConfig = {
  enabled: false,
  killSwitchEnabled: false,
  dbPath: DEFAULT_OVERLAY_DB_PATH,
  lcmDbPath: DEFAULT_OVERLAY_LCM_DB_PATH,
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

export type SessionMemoryOverlayOrdering = "after_focus_before_fresh_tail";

export type SessionMemoryOverlayRenderResult =
  | {
      ok: true;
      source: "session_memory_overlay";
      content: string;
      tokenCount: number;
      entryCount: number;
      segmentId: string;
      sourceRefsCount: number;
      ordering: SessionMemoryOverlayOrdering;
      projectionKey: string;
    }
  | {
      ok: false;
      source: "session_memory_overlay";
      reason: SessionMemoryOverlaySkipReason;
    };

export type SessionMemoryOverlayTelemetry = {
  surface: "session_memory";
  state: "inserted" | "skipped";
  insertedCount: number;
  skippedCount: number;
  skippedReason?: SessionMemoryOverlaySkipReason;
  renderedTokens: number;
  entryCount: number;
  segmentId?: string;
  sourceRefsCount: number;
  projectionKey?: string;
};

export async function resolveSessionMemoryOverlay(params: {
  config?: Partial<SessionMemoryOverlayConfig>;
  request: SessionMemoryOverlayRequest;
  lookup?: SessionMemoryOverlayLookup;
}): Promise<SessionMemoryOverlayLookupResult> {
  const config = {
    ...DEFAULT_SESSION_MEMORY_OVERLAY_CONFIG,
    ...params.config,
  };
  if (config.killSwitchEnabled) {
    return {
      ok: false,
      source: "session_memory_overlay",
      reason: "kill_switch",
    };
  }
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

export function renderSessionMemoryOverlay(
  lookupResult: SessionMemoryOverlayLookupResult,
  config: SessionMemoryOverlayConfig = DEFAULT_SESSION_MEMORY_OVERLAY_CONFIG,
): SessionMemoryOverlayRenderResult {
  if (!lookupResult.ok) {
    return lookupResult;
  }
  if (lookupResult.entries.length === 0) {
    return {
      ok: false,
      source: "session_memory_overlay",
      reason: "no_active_entries",
    };
  }

  try {
    let content = "";
    let tokenCount = 0;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      content = buildSessionMemoryOverlayContent(lookupResult, config, tokenCount);
      const nextTokenCount = estimateTokens(content);
      if (nextTokenCount === tokenCount) {
        break;
      }
      tokenCount = nextTokenCount;
    }

    if (tokenCount > config.maxTokens) {
      return {
        ok: false,
        source: "session_memory_overlay",
        reason: "over_budget",
      };
    }

    return {
      ok: true,
      source: "session_memory_overlay",
      content,
      tokenCount,
      entryCount: lookupResult.entries.length,
      segmentId: lookupResult.segmentId,
      sourceRefsCount: countSessionMemorySourceRefs(lookupResult.entries),
      ordering: "after_focus_before_fresh_tail",
      projectionKey: buildSessionMemoryOverlayProjectionKey(lookupResult, config),
    };
  } catch {
    return {
      ok: false,
      source: "session_memory_overlay",
      reason: "render_error",
    };
  }
}

export function buildSessionMemoryOverlayTelemetry(
  result: SessionMemoryOverlayRenderResult,
): SessionMemoryOverlayTelemetry {
  if (!result.ok) {
    return {
      surface: "session_memory",
      state: "skipped",
      insertedCount: 0,
      skippedCount: 1,
      skippedReason: result.reason,
      renderedTokens: 0,
      entryCount: 0,
      segmentId: undefined,
      sourceRefsCount: 0,
      projectionKey: undefined,
    };
  }

  return {
    surface: "session_memory",
    state: "inserted",
    insertedCount: 1,
    skippedCount: 0,
    skippedReason: undefined,
    renderedTokens: result.tokenCount,
    entryCount: result.entryCount,
    segmentId: result.segmentId,
    sourceRefsCount: result.sourceRefsCount,
    projectionKey: result.projectionKey,
  };
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
    return readActiveSessionMemoryEntries(db, request, config);
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

  for (const [tableName, columns] of Object.entries(REQUIRED_OVERLAY_TABLE_COLUMNS)) {
    if (!hasRequiredColumns(db, tableName, columns)) {
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

  for (const indexSpec of REQUIRED_OVERLAY_INDEXES) {
    if (!hasIndexWithColumns(db, indexSpec.tableName, indexSpec.columns)) {
      return {
        ok: false,
        source: "session_memory_overlay",
        reason: "schema_index_missing",
      };
    }
  }

  for (const constraintSpec of REQUIRED_OVERLAY_UNIQUE_CONSTRAINTS) {
    if (!hasIndexWithColumns(db, constraintSpec.tableName, constraintSpec.columns, { unique: true })) {
      return {
        ok: false,
        source: "session_memory_overlay",
        reason: "schema_constraint_missing",
      };
    }
  }

  return { ok: true };
}

function hasRequiredColumns(db: DatabaseSync, tableName: string, columns: string[]): boolean {
  const tableColumns = new Set(
    db.prepare(`PRAGMA table_info(${quoteSqliteIdentifier(tableName)})`).all().map((row) => {
      return String((row as { name: unknown }).name);
    }),
  );
  return columns.every((column) => tableColumns.has(column));
}

function hasIndexWithColumns(
  db: DatabaseSync,
  tableName: string,
  columns: string[],
  options?: { unique?: boolean },
): boolean {
  const indexes = db.prepare(`PRAGMA index_list(${quoteSqliteIdentifier(tableName)})`).all() as Array<{
    name: unknown;
    unique: unknown;
  }>;
  for (const index of indexes) {
    if (options?.unique && Number(index.unique) !== 1) {
      continue;
    }
    const indexName = String(index.name);
    const indexColumns = db.prepare(`PRAGMA index_info(${quoteSqliteIdentifier(indexName)})`).all() as Array<{
      seqno: unknown;
      name: unknown;
    }>;
    const orderedColumns = indexColumns
      .sort((left, right) => Number(left.seqno) - Number(right.seqno))
      .map((column) => String(column.name));
    if (columns.length === orderedColumns.length && columns.every((column, index) => column === orderedColumns[index])) {
      return true;
    }
  }
  return false;
}

function quoteSqliteIdentifier(identifier: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)) {
    throw new Error(`Invalid SQLite identifier: ${identifier}`);
  }
  return `"${identifier}"`;
}

function readActiveSessionMemoryEntries(
  db: DatabaseSync,
  request: SessionMemoryOverlayRequest,
  config: SessionMemoryOverlayConfig,
): SessionMemoryOverlayLookupResult {
  const rows = db
    .prepare(
      `SELECT
         s.session_id AS session_id,
         s.updated_at AS session_updated_at,
         sg.segment_id AS segment_id,
         sg.updated_at AS segment_updated_at,
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
    session_updated_at: unknown;
    segment_id: unknown;
    segment_updated_at: unknown;
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
  const projectionUpdatedAt = resolveFreshestSessionMemoryProjectionTimestamp(rows);
  if (projectionUpdatedAt === null) {
    return {
      ok: false,
      source: "session_memory_overlay",
      reason: "malformed_rows",
    };
  }
  if (Date.now() - projectionUpdatedAt > config.staleAfterMs) {
    return {
      ok: false,
      source: "session_memory_overlay",
      reason: "stale_projection",
    };
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
    const body = String(row.body);
    if (containsRawTranscript(body)) {
      return {
        ok: false,
        source: "session_memory_overlay",
        reason: "raw_transcript_detected",
      };
    }
    entries.push({
      entryId: String(row.entry_id),
      segmentId: String(row.segment_id),
      kind,
      priority: Number(row.priority ?? 0),
      body,
      updatedAt: String(row.updated_at),
      sourceRefs,
    });
  }

  const provenance = validateLcmSourceRefs(entries, config);
  if (!provenance.ok) {
    return provenance;
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

function resolveFreshestSessionMemoryProjectionTimestamp(
  rows: Array<{
    session_updated_at?: unknown;
    segment_updated_at?: unknown;
    updated_at?: unknown;
  }>,
): number | null {
  let freshest = -Infinity;
  for (const row of rows) {
    const timestamps = [
      parseSessionMemoryTimestamp(row.session_updated_at),
      parseSessionMemoryTimestamp(row.segment_updated_at),
      parseSessionMemoryTimestamp(row.updated_at),
    ];
    for (const timestamp of timestamps) {
      if (timestamp === null) {
        return null;
      }
      freshest = Math.max(freshest, timestamp);
    }
  }
  return Number.isFinite(freshest) ? freshest : null;
}

function parseSessionMemoryTimestamp(value: unknown): number | null {
  if (typeof value !== "string" || value.trim() === "") {
    return null;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function validateLcmSourceRefs(
  entries: SessionMemoryOverlayEntry[],
  config: SessionMemoryOverlayConfig,
): SessionMemorySchemaCompatibilityResult {
  const refs = entries.flatMap((entry) => entry.sourceRefs).filter(isLcmBackedSourceRef);
  if (refs.length === 0) {
    return { ok: true };
  }
  if (!existsSync(config.lcmDbPath)) {
    return {
      ok: false,
      source: "session_memory_overlay",
      reason: "lcm_schema_incompatible",
    };
  }

  let lcmDb: DatabaseSync | undefined;
  try {
    lcmDb = new DatabaseSync(config.lcmDbPath, { readOnly: true });
    if (!hasRequiredLcmSchema(lcmDb)) {
      return {
        ok: false,
        source: "session_memory_overlay",
        reason: "lcm_schema_incompatible",
      };
    }
    for (const ref of refs) {
      if (!sourceRefExists(lcmDb, ref)) {
        return {
          ok: false,
          source: "session_memory_overlay",
          reason: "source_ref_missing",
        };
      }
    }
    return { ok: true };
  } catch {
    return {
      ok: false,
      source: "session_memory_overlay",
      reason: "lcm_schema_incompatible",
    };
  } finally {
    try {
      lcmDb?.close();
    } catch {
      // Best-effort cleanup only; callers already get a fail-closed result.
    }
  }
}

type LcmBackedSourceRef = Extract<
  SessionMemorySourceRef,
  { type: "lcm_summary" } | { type: "lcm_message_range" } | { type: "focus_brief" }
>;

function isLcmBackedSourceRef(ref: SessionMemorySourceRef): ref is LcmBackedSourceRef {
  return ref.type === "lcm_summary" || ref.type === "lcm_message_range" || ref.type === "focus_brief";
}

function hasRequiredLcmSchema(db: DatabaseSync): boolean {
  for (const [tableName, columns] of Object.entries(REQUIRED_LCM_TABLE_COLUMNS)) {
    const tableColumns = new Set(
      db.prepare(`PRAGMA table_info(${quoteSqliteIdentifier(tableName)})`).all().map((row) => {
        return String((row as { name: unknown }).name);
      }),
    );
    for (const column of columns) {
      if (!tableColumns.has(column)) {
        return false;
      }
    }
  }
  return true;
}

function sourceRefExists(db: DatabaseSync, ref: LcmBackedSourceRef): boolean {
  if (ref.type === "lcm_summary") {
    return (
      db.prepare("SELECT 1 FROM summaries WHERE summary_id = ? LIMIT 1").get(ref.summaryId) !== undefined
    );
  }
  if (ref.type === "focus_brief") {
    return db.prepare("SELECT 1 FROM focus_briefs WHERE brief_id = ? LIMIT 1").get(ref.briefId) !== undefined;
  }
  if (
    ref.sessionKey &&
    db
      .prepare("SELECT 1 FROM conversations WHERE conversation_id = ? AND session_key = ? LIMIT 1")
      .get(ref.conversationId, ref.sessionKey) === undefined
  ) {
    return false;
  }
  const startExists =
    db
      .prepare("SELECT 1 FROM messages WHERE conversation_id = ? AND seq = ? LIMIT 1")
      .get(ref.conversationId, ref.startSeq) !== undefined;
  const endExists =
    db
      .prepare("SELECT 1 FROM messages WHERE conversation_id = ? AND seq = ? LIMIT 1")
      .get(ref.conversationId, ref.endSeq) !== undefined;
  return startExists && endExists;
}

function containsRawTranscript(body: string): boolean {
  const roleLineCount = body
    .split(/\r?\n/)
    .filter((line) => /^(system|user|assistant|tool)\s*:/i.test(line.trim())).length;
  return roleLineCount >= 2;
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

function buildSessionMemoryOverlayProjectionKey(
  lookupResult: Extract<SessionMemoryOverlayLookupResult, { ok: true }>,
  config: SessionMemoryOverlayConfig,
): string {
  const entries = lookupResult.entries.slice().sort(compareSessionMemoryEntriesForRender).map((entry) => {
    return {
      entryId: entry.entryId,
      segmentId: entry.segmentId,
      kind: entry.kind,
      updatedAt: entry.updatedAt,
      version: entry.version ?? null,
      bodyHash: entry.bodyHash ?? hashSessionMemoryValue(entry.body),
      sourceRefsHash: hashSessionMemoryValue(entry.sourceRefs.map(renderSessionMemorySourceRef).join("|")),
    };
  });
  const payload = {
    projectionFormat: "session_memory_overlay_projection_v1",
    renderVersion: config.renderVersion,
    maxTokens: config.maxTokens,
    truncationEnabled: config.truncationEnabled,
    sessionId: lookupResult.sessionId,
    segmentId: lookupResult.segmentId,
    lookupProjectionKey: lookupResult.projectionKey,
    entries,
  };
  return `${config.renderVersion}:${hashSessionMemoryValue(JSON.stringify(payload))}`;
}

function countSessionMemorySourceRefs(entries: SessionMemoryOverlayEntry[]): number {
  return entries.reduce((count, entry) => count + entry.sourceRefs.length, 0);
}

function buildSessionMemoryOverlayContent(
  lookupResult: Extract<SessionMemoryOverlayLookupResult, { ok: true }>,
  config: SessionMemoryOverlayConfig,
  tokenCount: number,
): string {
  const sections: string[] = [];
  for (const group of SESSION_MEMORY_RENDER_GROUPS) {
    const entries = lookupResult.entries
      .filter((entry) => entry.kind === group.kind)
      .sort(compareSessionMemoryEntriesForRender);
    if (entries.length === 0) {
      continue;
    }
    sections.push(`${group.label}:\n${entries.map((entry) => `- ${escapeSessionMemoryText(entry.body)}`).join("\n")}`);
  }

  const sourceRefs = lookupResult.entries
    .slice()
    .sort(compareSessionMemoryEntriesForRender)
    .map((entry) => {
      return `- entry_id=${escapeSessionMemoryText(entry.entryId)} refs=[${entry.sourceRefs
        .map(renderSessionMemorySourceRef)
        .join(", ")}]`;
    });
  if (sourceRefs.length > 0) {
    sections.push(`Source refs:\n${sourceRefs.join("\n")}`);
  }

  const body = sections.join("\n\n");
  return [
    `<session_memory source="session_memory" version="${escapeSessionMemoryAttribute(
      config.renderVersion,
    )}" session_id="${escapeSessionMemoryAttribute(lookupResult.sessionId)}" segment_id="${escapeSessionMemoryAttribute(
      lookupResult.segmentId,
    )}" entries="${lookupResult.entries.length}" tokens="${tokenCount}">`,
    body,
    "</session_memory>",
  ].join("\n");
}

const SESSION_MEMORY_RENDER_GROUPS: Array<{ kind: SessionMemoryOverlayEntryKind; label: string }> = [
  { kind: "constraint", label: "Constraints" },
  { kind: "decision", label: "Decisions" },
  { kind: "next_action", label: "Next actions" },
  { kind: "open_question", label: "Open questions" },
  { kind: "fact", label: "Facts" },
  { kind: "risk", label: "Risks" },
  { kind: "evidence", label: "Evidence" },
];

function compareSessionMemoryEntriesForRender(
  left: SessionMemoryOverlayEntry,
  right: SessionMemoryOverlayEntry,
): number {
  return (
    right.priority - left.priority ||
    Date.parse(right.updatedAt) - Date.parse(left.updatedAt) ||
    left.entryId.localeCompare(right.entryId)
  );
}

function renderSessionMemorySourceRef(ref: SessionMemorySourceRef): string {
  if (ref.type === "lcm_summary") {
    return `lcm_summary:${escapeSessionMemoryText(ref.summaryId)}`;
  }
  if (ref.type === "lcm_message_range") {
    const sessionKey = ref.sessionKey ? `:${escapeSessionMemoryText(ref.sessionKey)}` : "";
    return `lcm_message_range:${ref.conversationId}:${ref.startSeq}-${ref.endSeq}${sessionKey}`;
  }
  if (ref.type === "focus_brief") {
    return `focus_brief:${escapeSessionMemoryText(ref.briefId)}`;
  }
  if (ref.type === "workspace_file") {
    const line = typeof ref.line === "number" ? `:${ref.line}` : "";
    return `workspace_file:${escapeSessionMemoryText(ref.path)}${line}`;
  }
  if (ref.type === "checkpoint") {
    return `checkpoint:${escapeSessionMemoryText(ref.checkpointId)}`;
  }
  return `sidecar_sample:${escapeSessionMemoryText(ref.path)}`;
}

function escapeSessionMemoryAttribute(value: string): string {
  return escapeSessionMemoryText(value).replace(/"/g, "&quot;");
}

function escapeSessionMemoryText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function hashSessionMemoryValue(value: string): string {
  return createHash("sha256").update(value).digest("hex");
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
