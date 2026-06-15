import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { LcmConfig } from "./db/config.js";
import {
  checkSessionMemorySchemaCompatibility,
  type SessionMemoryOverlaySkipReason,
} from "./session-memory.js";

const SESSION_MEMORY_SCHEMA_VERSION = 1;
const SESSION_MEMORY_MIGRATION_ID = "session_memory_v0_1_initial";
const SESSION_MEMORY_MIGRATION_DESCRIPTION = "Create session-memory v0.1 schema";

export type SessionMemorySchemaCommand = {
  action: "plan" | "check" | "apply";
  dbPath?: string;
  execute: boolean;
  confirm?: string;
  allowRealDb: boolean;
};

type DbState =
  | { kind: "absent"; sidecarsPresent: boolean }
  | { kind: "compatible"; userVersion: number; schemaVersion: number }
  | {
      kind: "incompatible";
      reason: SessionMemoryOverlaySkipReason | "read_error" | "orphan_sidecars";
      userVersion?: number;
      schemaVersion?: number;
    };

const SESSION_MEMORY_SCHEMA_SQL = `
CREATE TABLE schema_migrations (
  migration_id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL,
  applied_at TEXT NOT NULL,
  checksum TEXT NOT NULL,
  description TEXT NOT NULL
);

CREATE TABLE sessions (
  session_id TEXT PRIMARY KEY,
  conversation_id INTEGER NULL,
  session_key TEXT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'closed', 'archived')),
  title TEXT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  metadata_json TEXT NULL
);

CREATE TABLE segments (
  segment_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(session_id),
  seq INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'checkpointed', 'settled', 'abandoned')),
  start_ref_json TEXT NULL,
  end_ref_json TEXT NULL,
  token_estimate INTEGER NULL,
  entry_count INTEGER NOT NULL DEFAULT 0,
  opened_at TEXT NOT NULL,
  closed_at TEXT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE entries (
  entry_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(session_id),
  segment_id TEXT NOT NULL REFERENCES segments(segment_id),
  kind TEXT NOT NULL CHECK (kind IN ('fact', 'decision', 'open_question', 'next_action', 'constraint', 'evidence', 'risk')),
  status TEXT NOT NULL CHECK (status IN ('active', 'carried', 'settled', 'stale', 'superseded', 'rejected')),
  confidence REAL NOT NULL CHECK (confidence >= 0.0 AND confidence <= 1.0),
  priority INTEGER NOT NULL DEFAULT 0,
  title TEXT NULL,
  body TEXT NOT NULL,
  source_refs_json TEXT NULL,
  origin_entry_id TEXT NULL REFERENCES entries(entry_id),
  superseded_by_entry_id TEXT NULL REFERENCES entries(entry_id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  settled_at TEXT NULL
);

CREATE TABLE checkpoints (
  checkpoint_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(session_id),
  from_segment_id TEXT NOT NULL REFERENCES segments(segment_id),
  to_segment_id TEXT NULL REFERENCES segments(segment_id),
  reason TEXT NOT NULL CHECK (reason IN ('lossless_compaction', 'threshold', 'handoff', 'user_request', 'phase_closed', 'manual', 'other')),
  trigger_snapshot_json TEXT NOT NULL,
  summary TEXT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE carry_forward (
  carry_id TEXT PRIMARY KEY,
  checkpoint_id TEXT NOT NULL REFERENCES checkpoints(checkpoint_id),
  from_entry_id TEXT NOT NULL REFERENCES entries(entry_id),
  to_entry_id TEXT NULL REFERENCES entries(entry_id),
  priority INTEGER NOT NULL DEFAULT 0,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE links (
  link_id TEXT PRIMARY KEY,
  src_type TEXT NOT NULL,
  src_id TEXT NOT NULL,
  relation TEXT NOT NULL CHECK (relation IN ('derived_from', 'supports', 'contradicts', 'supersedes', 'carried_to', 'landed_as', 'candidate_for', 'related_to')),
  dst_type TEXT NOT NULL,
  dst_id TEXT NOT NULL,
  confidence REAL NULL CHECK (confidence IS NULL OR (confidence >= 0.0 AND confidence <= 1.0)),
  source_refs_json TEXT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX sessions_status_updated_at_idx ON sessions (status, updated_at);
CREATE INDEX segments_session_status_seq_idx ON segments (session_id, status, seq);
CREATE INDEX entries_session_status_priority_updated_at_idx ON entries (session_id, status, priority, updated_at);
CREATE INDEX entries_segment_status_kind_idx ON entries (segment_id, status, kind);
CREATE INDEX links_src_relation_idx ON links (src_type, src_id, relation);
CREATE INDEX links_dst_relation_idx ON links (dst_type, dst_id, relation);

CREATE UNIQUE INDEX segments_session_seq_unique_idx ON segments (session_id, seq);
CREATE UNIQUE INDEX links_unique_edge_idx ON links (src_type, src_id, relation, dst_type, dst_id);

CREATE INDEX entries_kind_status_updated_at_idx ON entries (kind, status, updated_at);
CREATE INDEX entries_origin_entry_id_idx ON entries (origin_entry_id);
CREATE INDEX entries_superseded_by_entry_id_idx ON entries (superseded_by_entry_id);
CREATE INDEX checkpoints_session_created_at_idx ON checkpoints (session_id, created_at);
CREATE INDEX checkpoints_from_segment_id_idx ON checkpoints (from_segment_id);
CREATE INDEX carry_forward_checkpoint_priority_idx ON carry_forward (checkpoint_id, priority);
CREATE INDEX carry_forward_from_entry_id_idx ON carry_forward (from_entry_id);
CREATE INDEX carry_forward_to_entry_id_idx ON carry_forward (to_entry_id);
CREATE INDEX links_relation_created_at_idx ON links (relation, created_at);
`;

function statLine(label: string, value: string): string {
  return `${label}: ${value}`;
}

function migrationChecksum(): string {
  return createHash("sha256").update(SESSION_MEMORY_SCHEMA_SQL.trim()).digest("hex");
}

function confirmationToken(dbPath: string): string {
  return `sm:${createHash("sha256")
    .update(`${SESSION_MEMORY_MIGRATION_ID}\n${resolve(dbPath)}\n${SESSION_MEMORY_SCHEMA_VERSION}`)
    .digest("hex")
    .slice(0, 12)}`;
}

function targetDbPath(config: LcmConfig, command: SessionMemorySchemaCommand): string {
  return command.dbPath?.trim() || config.sessionMemoryOverlay.dbPath;
}

function sidecarPaths(dbPath: string): string[] {
  return [`${dbPath}-wal`, `${dbPath}-shm`];
}

function inspectDbState(dbPath: string): DbState {
  const dbExists = existsSync(dbPath);
  const sidecarsPresent = sidecarPaths(dbPath).some((path) => existsSync(path));
  if (!dbExists) {
    return { kind: "absent", sidecarsPresent };
  }
  if (sidecarsPresent && !dbExists) {
    return { kind: "incompatible", reason: "orphan_sidecars" };
  }

  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const compatibility = checkSessionMemorySchemaCompatibility(db);
    const userVersionRow = db.prepare("PRAGMA user_version").get() as { user_version?: unknown } | undefined;
    const userVersion = Number(userVersionRow?.user_version ?? 0);
    let schemaVersion = 0;
    try {
      const migrationRow = db
        .prepare("SELECT schema_version FROM schema_migrations ORDER BY applied_at DESC LIMIT 1")
        .get() as { schema_version?: unknown } | undefined;
      schemaVersion = Number(migrationRow?.schema_version ?? 0);
    } catch {
      schemaVersion = 0;
    }
    return compatibility.ok
      ? { kind: "compatible", userVersion, schemaVersion }
      : { kind: "incompatible", reason: compatibility.reason, userVersion, schemaVersion };
  } catch {
    return { kind: "incompatible", reason: "read_error" };
  } finally {
    try {
      db?.close();
    } catch {
      // Best-effort cleanup for a read-only inspection.
    }
  }
}

function dbStateLabel(state: DbState): string {
  if (state.kind === "absent") {
    return state.sidecarsPresent ? "orphan_sidecars" : "absent";
  }
  if (state.kind === "compatible") {
    return "compatible";
  }
  return state.reason;
}

function backupRequired(state: DbState): boolean {
  return state.kind === "incompatible";
}

function isTempPath(dbPath: string): boolean {
  const tempRoot = resolve(tmpdir());
  const target = resolve(dbPath);
  return target === tempRoot || target.startsWith(`${tempRoot}${sep}`);
}

function buildMaintenanceDryRunText(config: LcmConfig, command: SessionMemorySchemaCommand): string {
  const dbPath = targetDbPath(config, command);
  const state = inspectDbState(dbPath);
  return [
    "Session Memory Schema Maintenance",
    statLine("status", "dry_run"),
    statLine("target db", dbPath),
    statLine("overlay enabled", config.sessionMemoryOverlay.enabled ? "yes" : "no"),
    statLine("kill switch", config.sessionMemoryOverlay.killSwitchEnabled ? "yes" : "no"),
    statLine("db state", dbStateLabel(state)),
    statLine("backup required", backupRequired(state) ? "yes" : "no"),
    statLine("target version", String(SESSION_MEMORY_SCHEMA_VERSION)),
    "planned steps:",
    "- create schema_migrations",
    "- create sessions / segments / entries / checkpoints / carry_forward / links",
    "- create runtime-minimum indexes",
    "- create full migration-target indexes",
    "- set PRAGMA user_version = 1",
    "- insert schema_migrations row",
    "- run read-only compatibility check",
    statLine("execute confirmation", confirmationToken(dbPath)),
  ].join("\n");
}

function buildCheckText(config: LcmConfig, command: SessionMemorySchemaCommand): string {
  const dbPath = targetDbPath(config, command);
  const state = inspectDbState(dbPath);
  const lines = [
    "Session Memory Schema Check",
    statLine("target db", dbPath),
  ];
  if (state.kind === "compatible") {
    lines.push(statLine("status", "compatible"));
    lines.push(statLine("user_version", String(state.userVersion)));
    lines.push(statLine("schema_version", String(state.schemaVersion)));
  } else {
    lines.push(statLine("status", "skipped"));
    lines.push(statLine("reason", dbStateLabel(state)));
  }
  return lines.join("\n");
}

function createSessionMemorySchema(dbPath: string): void {
  mkdirSync(dirname(dbPath), { recursive: true });
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(dbPath);
    const checksum = migrationChecksum();
    db.exec("PRAGMA foreign_keys = ON");
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(SESSION_MEMORY_SCHEMA_SQL);
      db.prepare(
        `INSERT INTO schema_migrations (migration_id, schema_version, applied_at, checksum, description)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(
        SESSION_MEMORY_MIGRATION_ID,
        SESSION_MEMORY_SCHEMA_VERSION,
        new Date().toISOString(),
        checksum,
        SESSION_MEMORY_MIGRATION_DESCRIPTION,
      );
      db.exec(`PRAGMA user_version = ${SESSION_MEMORY_SCHEMA_VERSION}`);
      db.exec("COMMIT");
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // Preserve the original migration failure.
      }
      throw error;
    }
  } finally {
    try {
      db?.close();
    } catch {
      // Best-effort cleanup after migration.
    }
  }
}

function buildApplyExecuteText(config: LcmConfig, command: SessionMemorySchemaCommand): string {
  const dbPath = targetDbPath(config, command);
  const expectedConfirmation = confirmationToken(dbPath);
  if (command.confirm !== expectedConfirmation) {
    return [
      "Session Memory Schema Maintenance",
      statLine("status", "refused"),
      statLine("target db", dbPath),
      statLine("reason", "confirmation token mismatch"),
      statLine("execute confirmation", expectedConfirmation),
    ].join("\n");
  }
  if (config.sessionMemoryOverlay.enabled) {
    return [
      "Session Memory Schema Maintenance",
      statLine("status", "refused"),
      statLine("target db", dbPath),
      statLine("reason", "session-memory overlay is enabled"),
    ].join("\n");
  }
  const isExplicitTempTarget = Boolean(command.dbPath) && isTempPath(dbPath);
  if (!isExplicitTempTarget && !command.allowRealDb) {
    return [
      "Session Memory Schema Maintenance",
      statLine("status", "refused"),
      statLine("target db", dbPath),
      statLine("reason", "execute requires an explicit temp DB path or --allow-real-db"),
    ].join("\n");
  }
  if (command.allowRealDb && command.dbPath && !isTempPath(dbPath)) {
    return [
      "Session Memory Schema Maintenance",
      statLine("status", "refused"),
      statLine("target db", dbPath),
      statLine("reason", "--allow-real-db uses the resolved session-memory DB path; omit --db"),
    ].join("\n");
  }

  const state = inspectDbState(dbPath);
  if (state.kind === "absent" && state.sidecarsPresent) {
    return [
      "Session Memory Schema Maintenance",
      statLine("status", "refused"),
      statLine("target db", dbPath),
      statLine("reason", "orphan_sidecars"),
    ].join("\n");
  }
  if (state.kind === "compatible") {
    return [
      "Session Memory Schema Maintenance",
      statLine("status", "compatible"),
      statLine("target db", dbPath),
      statLine("post-check", "compatible"),
    ].join("\n");
  }
  if (state.kind === "incompatible") {
    return [
      "Session Memory Schema Maintenance",
      statLine("status", "refused"),
      statLine("target db", dbPath),
      statLine("reason", "backup_required"),
      statLine("db state", state.reason),
    ].join("\n");
  }

  try {
    createSessionMemorySchema(dbPath);
  } catch (error) {
    return [
      "Session Memory Schema Maintenance",
      statLine("status", "failed"),
      statLine("target db", dbPath),
      statLine("reason", error instanceof Error ? error.message : "schema migration failed"),
    ].join("\n");
  }

  const postState = inspectDbState(dbPath);
  return [
    "Session Memory Schema Maintenance",
    statLine("status", postState.kind === "compatible" ? "created" : "failed"),
    statLine("target db", dbPath),
    statLine("post-check", postState.kind === "compatible" ? "compatible" : dbStateLabel(postState)),
  ].join("\n");
}

export function buildSessionMemorySchemaMaintenanceText(params: {
  config: LcmConfig;
  command: SessionMemorySchemaCommand;
}): string {
  if (params.command.action === "check") {
    return buildCheckText(params.config, params.command);
  }
  if (params.command.action === "plan" || !params.command.execute) {
    return buildMaintenanceDryRunText(params.config, params.command);
  }
  return buildApplyExecuteText(params.config, params.command);
}
