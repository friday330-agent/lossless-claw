import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  checkSessionMemorySchemaCompatibility,
  isRawTranscriptShapedSessionMemoryBody,
  type SessionMemoryOverlayEntryKind,
  type SessionMemoryOverlaySkipReason,
  type SessionMemorySourceRef,
  validateSessionMemorySourceRefs,
} from "./session-memory.js";

const MAX_ENTRY_BODY_CHARS = 1200;
const MAX_JSON_CHARS = 4000;

const ENTRY_KINDS = new Set<SessionMemoryOverlayEntryKind>([
  "fact",
  "decision",
  "open_question",
  "next_action",
  "constraint",
  "evidence",
  "risk",
]);
const ENTRY_STATUSES = new Set(["active"]);
const LINK_RELATIONS = new Set([
  "derived_from",
  "supports",
  "contradicts",
  "supersedes",
  "carried_to",
  "landed_as",
  "candidate_for",
  "related_to",
]);
const LINK_OBJECT_TYPES = new Set([
  "session",
  "segment",
  "entry",
  "checkpoint",
  "workspace_file",
  "lcm_summary",
  "focus_brief",
  "sidecar_sample",
]);

export type SessionMemorySeedPacket = {
  session: {
    sessionId: string;
    conversationId?: number;
    sessionKey?: string;
    title?: string;
    metadata?: Record<string, unknown>;
  };
  segment: {
    segmentId: string;
    seq: number;
    startRef?: unknown;
    endRef?: unknown;
    tokenEstimate?: number;
  };
  entries: Array<{
    entryId: string;
    kind: SessionMemoryOverlayEntryKind | string;
    status?: "active" | string;
    confidence: number;
    priority?: number;
    title?: string;
    body: string;
    sourceRefs?: SessionMemorySourceRef[];
    originEntryId?: string;
    supersededByEntryId?: string;
  }>;
  links?: Array<{
    linkId: string;
    srcType: string;
    srcId: string;
    relation: string;
    dstType: string;
    dstId: string;
    confidence?: number;
    sourceRefs?: SessionMemorySourceRef[];
  }>;
};

export type SessionMemoryWriteResult =
  | {
      ok: true;
      status: "written";
      sessionId: string;
      segmentId: string;
      entryCount: number;
      linkCount: number;
      updatedAt: string;
    }
  | {
      ok: false;
      status: "refused" | "failed";
      reason:
        | "real_db_refused"
        | "db_absent"
        | "schema_incompatible"
        | "invalid_packet"
        | "raw_transcript_detected"
        | "lcm_schema_incompatible"
        | "source_ref_missing"
        | "write_failed";
      detail?: string;
      schemaReason?: SessionMemoryOverlaySkipReason;
    };

export type SessionMemoryRejectEntriesResult =
  | {
      ok: true;
      status: "rejected";
      entryCount: number;
      sessionCount: number;
      segmentCount: number;
      updatedAt: string;
    }
  | {
      ok: false;
      status: "refused" | "failed";
      reason: "real_db_refused" | "db_absent" | "schema_incompatible" | "invalid_packet" | "write_failed";
      detail?: string;
      schemaReason?: SessionMemoryOverlaySkipReason;
    };

export function writeSessionMemorySeedPacket(params: {
  dbPath: string;
  lcmDbPath: string;
  packet: SessionMemorySeedPacket;
  allowRealDb?: boolean;
  now?: Date;
}): SessionMemoryWriteResult {
  if (!params.allowRealDb && !isTempPath(params.dbPath)) {
    return { ok: false, status: "refused", reason: "real_db_refused" };
  }
  if (!existsSync(params.dbPath)) {
    return { ok: false, status: "refused", reason: "db_absent" };
  }

  const preflight = validateSeedPacketShape(params.packet);
  if (!preflight.ok) {
    return preflight.result;
  }

  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(params.dbPath);
    db.exec("PRAGMA foreign_keys = ON");
    const compatibility = checkSessionMemorySchemaCompatibility(db);
    if (!compatibility.ok) {
      return {
        ok: false,
        status: "refused",
        reason: "schema_incompatible",
        schemaReason: compatibility.reason,
      };
    }

    const refs = collectSourceRefs(params.packet);
    const lcmValidation = validateSessionMemorySourceRefs(refs, { lcmDbPath: params.lcmDbPath });
    if (!lcmValidation.ok) {
      return {
        ok: false,
        status: "refused",
        reason: lcmValidation.reason === "source_ref_missing" ? "source_ref_missing" : "lcm_schema_incompatible",
        schemaReason: lcmValidation.reason,
      };
    }
    const checkpointValidation = validateCheckpointRefs(db, refs);
    if (!checkpointValidation.ok) {
      return checkpointValidation.result;
    }

    const updatedAt = (params.now ?? new Date()).toISOString();
    try {
      db.exec("BEGIN IMMEDIATE");
      insertSession(db, params.packet, updatedAt);
      insertSegment(db, params.packet, updatedAt);
      for (const entry of params.packet.entries) {
        insertEntry(db, params.packet, entry, updatedAt);
      }
      for (const link of params.packet.links ?? []) {
        insertLink(db, link, updatedAt);
      }
      db
        .prepare("UPDATE segments SET entry_count = ?, updated_at = ? WHERE segment_id = ?")
        .run(params.packet.entries.length, updatedAt, params.packet.segment.segmentId);
      db.prepare("UPDATE sessions SET updated_at = ? WHERE session_id = ?").run(updatedAt, params.packet.session.sessionId);
      db.exec("COMMIT");
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // Preserve the original write failure.
      }
      return {
        ok: false,
        status: "failed",
        reason: "write_failed",
        detail: error instanceof Error ? error.message : "session-memory seed write failed",
      };
    }

    return {
      ok: true,
      status: "written",
      sessionId: params.packet.session.sessionId,
      segmentId: params.packet.segment.segmentId,
      entryCount: params.packet.entries.length,
      linkCount: params.packet.links?.length ?? 0,
      updatedAt,
    };
  } catch (error) {
    return {
      ok: false,
      status: "failed",
      reason: "write_failed",
      detail: error instanceof Error ? error.message : "session-memory writer failed",
    };
  } finally {
    try {
      db?.close();
    } catch {
      // Best-effort cleanup after a bounded maintenance write.
    }
  }
}

export function rejectSessionMemoryEntries(params: {
  dbPath: string;
  entryIds: string[];
  allowRealDb?: boolean;
  now?: Date;
}): SessionMemoryRejectEntriesResult {
  if (!params.allowRealDb && !isTempPath(params.dbPath)) {
    return { ok: false, status: "refused", reason: "real_db_refused" };
  }
  if (!existsSync(params.dbPath)) {
    return { ok: false, status: "refused", reason: "db_absent" };
  }
  const entryIds = Array.from(new Set(params.entryIds));
  if (entryIds.length === 0 || entryIds.some((entryId) => !isNonEmptyString(entryId))) {
    return { ok: false, status: "refused", reason: "invalid_packet", detail: "entryIds must be non-empty strings" };
  }

  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(params.dbPath);
    db.exec("PRAGMA foreign_keys = ON");
    const compatibility = checkSessionMemorySchemaCompatibility(db);
    if (!compatibility.ok) {
      return {
        ok: false,
        status: "refused",
        reason: "schema_incompatible",
        schemaReason: compatibility.reason,
      };
    }

    const placeholders = entryIds.map(() => "?").join(", ");
    const activeEntryCount = (
      db
        .prepare(
          `SELECT COUNT(*) AS count
           FROM entries
           WHERE entry_id IN (${placeholders})
             AND status = 'active'`,
        )
        .get(...entryIds) as { count: unknown }
    ).count;
    if (Number(activeEntryCount) !== entryIds.length) {
      return {
        ok: false,
        status: "refused",
        reason: "invalid_packet",
        detail: "all entryIds must refer to active entries",
      };
    }
    const rows = db
      .prepare(
        `SELECT DISTINCT session_id, segment_id
         FROM entries
         WHERE entry_id IN (${placeholders})
           AND status = 'active'`,
      )
      .all(...entryIds) as Array<{ session_id: unknown; segment_id: unknown }>;

    const sessionIds = Array.from(new Set(rows.map((row) => String(row.session_id))));
    const segmentIds = Array.from(new Set(rows.map((row) => String(row.segment_id))));
    const updatedAt = (params.now ?? new Date()).toISOString();
    try {
      db.exec("BEGIN IMMEDIATE");
      db
        .prepare(
          `UPDATE entries
           SET status = 'rejected', updated_at = ?, settled_at = ?
           WHERE entry_id IN (${placeholders})
             AND status = 'active'`,
        )
        .run(updatedAt, updatedAt, ...entryIds);
      updateRowsByIds(db, "segments", "segment_id", segmentIds, updatedAt);
      updateRowsByIds(db, "sessions", "session_id", sessionIds, updatedAt);
      db.exec("COMMIT");
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // Preserve the original write failure.
      }
      return {
        ok: false,
        status: "failed",
        reason: "write_failed",
        detail: error instanceof Error ? error.message : "session-memory reject entries failed",
      };
    }

    return {
      ok: true,
      status: "rejected",
      entryCount: entryIds.length,
      sessionCount: sessionIds.length,
      segmentCount: segmentIds.length,
      updatedAt,
    };
  } catch (error) {
    return {
      ok: false,
      status: "failed",
      reason: "write_failed",
      detail: error instanceof Error ? error.message : "session-memory reject entries failed",
    };
  } finally {
    try {
      db?.close();
    } catch {
      // Best-effort cleanup after a bounded maintenance write.
    }
  }
}

function validateSeedPacketShape(packet: SessionMemorySeedPacket):
  | { ok: true }
  | { ok: false; result: Extract<SessionMemoryWriteResult, { ok: false }> } {
  if (!isNonEmptyString(packet.session?.sessionId)) {
    return invalidPacket("session.sessionId is required");
  }
  if (!Number.isInteger(packet.session.conversationId)) {
    return invalidPacket("session.conversationId is required");
  }
  if (!isNonEmptyString(packet.segment?.segmentId)) {
    return invalidPacket("segment.segmentId is required");
  }
  if (!Number.isInteger(packet.segment.seq) || packet.segment.seq < 1) {
    return invalidPacket("segment.seq must be an integer >= 1");
  }
  const metadataJson = serializeOptionalJson(packet.session.metadata);
  const startRefJson = serializeOptionalJson(packet.segment.startRef);
  const endRefJson = serializeOptionalJson(packet.segment.endRef);
  if (!metadataJson.ok) {
    return invalidPacket(`session.metadata ${metadataJson.reason}`);
  }
  if (!startRefJson.ok) {
    return invalidPacket(`segment.startRef ${startRefJson.reason}`);
  }
  if (!endRefJson.ok) {
    return invalidPacket(`segment.endRef ${endRefJson.reason}`);
  }
  if (!Array.isArray(packet.entries) || packet.entries.length === 0) {
    return invalidPacket("entries must contain at least one entry");
  }
  const entryIds = new Set<string>();
  for (const entry of packet.entries) {
    if (!isNonEmptyString(entry.entryId)) {
      return invalidPacket("entry.entryId is required");
    }
    if (entryIds.has(entry.entryId)) {
      return invalidPacket(`duplicate entry id ${entry.entryId}`);
    }
    entryIds.add(entry.entryId);
    if (!ENTRY_KINDS.has(entry.kind as SessionMemoryOverlayEntryKind)) {
      return invalidPacket(`invalid entry kind ${entry.kind}`);
    }
    if (!ENTRY_STATUSES.has(entry.status ?? "active")) {
      return invalidPacket(`invalid entry status ${entry.status}`);
    }
    if (!Number.isFinite(entry.confidence) || entry.confidence < 0 || entry.confidence > 1) {
      return invalidPacket("entry.confidence must be between 0 and 1");
    }
    if (entry.priority !== undefined && !Number.isInteger(entry.priority)) {
      return invalidPacket("entry.priority must be an integer");
    }
    if (!isNonEmptyString(entry.body)) {
      return invalidPacket("entry.body is required");
    }
    if (entry.body.length > MAX_ENTRY_BODY_CHARS) {
      return invalidPacket(`entry.body exceeds ${MAX_ENTRY_BODY_CHARS} chars`);
    }
    if (isRawTranscriptShapedSessionMemoryBody(entry.body)) {
      return { ok: false, result: { ok: false, status: "refused", reason: "raw_transcript_detected" } };
    }
    const refs = validateSourceRefs(entry.sourceRefs ?? []);
    if (!refs.ok) {
      return invalidPacket(refs.reason);
    }
  }

  const edges = new Set<string>();
  for (const link of packet.links ?? []) {
    if (!isNonEmptyString(link.linkId)) {
      return invalidPacket("link.linkId is required");
    }
    if (!LINK_OBJECT_TYPES.has(link.srcType) || !LINK_OBJECT_TYPES.has(link.dstType)) {
      return invalidPacket("link srcType/dstType is invalid");
    }
    if (!isNonEmptyString(link.srcId) || !isNonEmptyString(link.dstId)) {
      return invalidPacket("link srcId/dstId is required");
    }
    if (!LINK_RELATIONS.has(link.relation)) {
      return invalidPacket(`invalid link relation ${link.relation}`);
    }
    if (link.confidence !== undefined && (!Number.isFinite(link.confidence) || link.confidence < 0 || link.confidence > 1)) {
      return invalidPacket("link.confidence must be between 0 and 1");
    }
    const refs = validateSourceRefs(link.sourceRefs ?? []);
    if (!refs.ok) {
      return invalidPacket(refs.reason);
    }
    const edgeKey = [link.srcType, link.srcId, link.relation, link.dstType, link.dstId].join("\0");
    if (edges.has(edgeKey)) {
      return invalidPacket("duplicate link edge");
    }
    edges.add(edgeKey);
  }

  return { ok: true };
}

function invalidPacket(detail: string): { ok: false; result: Extract<SessionMemoryWriteResult, { ok: false }> } {
  return { ok: false, result: { ok: false, status: "refused", reason: "invalid_packet", detail } };
}

function validateSourceRefs(refs: SessionMemorySourceRef[]): { ok: true } | { ok: false; reason: string } {
  if (!Array.isArray(refs)) {
    return { ok: false, reason: "sourceRefs must be an array" };
  }
  for (const ref of refs) {
    if (!ref || typeof ref !== "object") {
      return { ok: false, reason: "sourceRef must be an object" };
    }
    if (ref.type === "lcm_summary") {
      if (!isNonEmptyString(ref.summaryId)) {
        return { ok: false, reason: "lcm_summary.summaryId is required" };
      }
    } else if (ref.type === "lcm_message_range") {
      if (!Number.isInteger(ref.conversationId) || !Number.isInteger(ref.startSeq) || !Number.isInteger(ref.endSeq)) {
        return { ok: false, reason: "lcm_message_range numeric fields are required" };
      }
      if (ref.startSeq > ref.endSeq) {
        return { ok: false, reason: "lcm_message_range startSeq must be <= endSeq" };
      }
    } else if (ref.type === "focus_brief") {
      if (!isNonEmptyString(ref.briefId)) {
        return { ok: false, reason: "focus_brief.briefId is required" };
      }
    } else if (ref.type === "workspace_file") {
      if (!isNonEmptyString(ref.path)) {
        return { ok: false, reason: "workspace_file.path is required" };
      }
    } else if (ref.type === "checkpoint") {
      if (!isNonEmptyString(ref.checkpointId)) {
        return { ok: false, reason: "checkpoint.checkpointId is required" };
      }
    } else if (ref.type === "sidecar_sample") {
      if (!isNonEmptyString(ref.path)) {
        return { ok: false, reason: "sidecar_sample.path is required" };
      }
    } else {
      return { ok: false, reason: "unknown sourceRef type" };
    }
  }
  return { ok: true };
}

function collectSourceRefs(packet: SessionMemorySeedPacket): SessionMemorySourceRef[] {
  return [
    ...packet.entries.flatMap((entry) => entry.sourceRefs ?? []),
    ...(packet.links ?? []).flatMap((link) => link.sourceRefs ?? []),
  ];
}

function validateCheckpointRefs(
  db: DatabaseSync,
  refs: SessionMemorySourceRef[],
): { ok: true } | { ok: false; result: Extract<SessionMemoryWriteResult, { ok: false }> } {
  for (const ref of refs) {
    if (
      ref.type === "checkpoint" &&
      db.prepare("SELECT 1 FROM checkpoints WHERE checkpoint_id = ? LIMIT 1").get(ref.checkpointId) === undefined
    ) {
      return { ok: false, result: { ok: false, status: "refused", reason: "source_ref_missing" } };
    }
  }
  return { ok: true };
}

function insertSession(db: DatabaseSync, packet: SessionMemorySeedPacket, updatedAt: string): void {
  const metadataJson = serializeRequiredOptionalJson(packet.session.metadata);
  db
    .prepare(
      `INSERT INTO sessions (
        session_id, conversation_id, session_key, status, title, started_at, ended_at, created_at, updated_at, metadata_json
      ) VALUES (?, ?, ?, 'active', ?, ?, NULL, ?, ?, ?)`,
    )
    .run(
      packet.session.sessionId,
      packet.session.conversationId ?? null,
      packet.session.sessionKey ?? null,
      packet.session.title ?? null,
      updatedAt,
      updatedAt,
      updatedAt,
      metadataJson,
    );
}

function insertSegment(db: DatabaseSync, packet: SessionMemorySeedPacket, updatedAt: string): void {
  const startRefJson = serializeRequiredOptionalJson(packet.segment.startRef);
  const endRefJson = serializeRequiredOptionalJson(packet.segment.endRef);
  db
    .prepare(
      `INSERT INTO segments (
        segment_id, session_id, seq, status, start_ref_json, end_ref_json, token_estimate, entry_count,
        opened_at, closed_at, created_at, updated_at
      ) VALUES (?, ?, ?, 'active', ?, ?, ?, 0, ?, NULL, ?, ?)`,
    )
    .run(
      packet.segment.segmentId,
      packet.session.sessionId,
      packet.segment.seq,
      startRefJson,
      endRefJson,
      packet.segment.tokenEstimate ?? null,
      updatedAt,
      updatedAt,
      updatedAt,
    );
}

function insertEntry(
  db: DatabaseSync,
  packet: SessionMemorySeedPacket,
  entry: SessionMemorySeedPacket["entries"][number],
  updatedAt: string,
): void {
  db
    .prepare(
      `INSERT INTO entries (
        entry_id, session_id, segment_id, kind, status, confidence, priority, title, body, source_refs_json,
        origin_entry_id, superseded_by_entry_id, created_at, updated_at, settled_at
      ) VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    )
    .run(
      entry.entryId,
      packet.session.sessionId,
      packet.segment.segmentId,
      entry.kind,
      entry.confidence,
      entry.priority ?? 0,
      entry.title ?? null,
      entry.body,
      serializeSourceRefs(entry.sourceRefs ?? []),
      entry.originEntryId ?? null,
      entry.supersededByEntryId ?? null,
      updatedAt,
      updatedAt,
    );
}

function insertLink(db: DatabaseSync, link: NonNullable<SessionMemorySeedPacket["links"]>[number], updatedAt: string): void {
  db
    .prepare(
      `INSERT INTO links (
        link_id, src_type, src_id, relation, dst_type, dst_id, confidence, source_refs_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      link.linkId,
      link.srcType,
      link.srcId,
      link.relation,
      link.dstType,
      link.dstId,
      link.confidence ?? null,
      serializeSourceRefs(link.sourceRefs ?? []),
      updatedAt,
    );
}

function updateRowsByIds(
  db: DatabaseSync,
  tableName: "sessions" | "segments",
  idColumn: "session_id" | "segment_id",
  ids: string[],
  updatedAt: string,
): void {
  if (ids.length === 0) {
    return;
  }
  const placeholders = ids.map(() => "?").join(", ");
  db.prepare(`UPDATE ${tableName} SET updated_at = ? WHERE ${idColumn} IN (${placeholders})`).run(updatedAt, ...ids);
}

function serializeSourceRefs(refs: SessionMemorySourceRef[]): string {
  return JSON.stringify(
    refs.map((ref) => {
      if (ref.type === "lcm_summary") {
        return { type: ref.type, summary_id: ref.summaryId };
      }
      if (ref.type === "lcm_message_range") {
        return {
          type: ref.type,
          conversation_id: ref.conversationId,
          session_key: ref.sessionKey,
          start_seq: ref.startSeq,
          end_seq: ref.endSeq,
        };
      }
      if (ref.type === "focus_brief") {
        return { type: ref.type, brief_id: ref.briefId };
      }
      if (ref.type === "workspace_file") {
        return { type: ref.type, path: ref.path, line: ref.line };
      }
      if (ref.type === "checkpoint") {
        return { type: ref.type, checkpoint_id: ref.checkpointId };
      }
      return { type: ref.type, path: ref.path };
    }),
  );
}

function serializeOptionalJson(value: unknown): { ok: true; value: string | null } | { ok: false; reason: string } {
  if (value === undefined || value === null) {
    return { ok: true, value: null };
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    return { ok: false, reason: "must be JSON-serializable" };
  }
  if (serialized.length > MAX_JSON_CHARS) {
    return { ok: false, reason: `exceeds ${MAX_JSON_CHARS} chars` };
  }
  if (isRawTranscriptShapedSessionMemoryBody(serialized)) {
    return { ok: false, reason: "must not contain raw transcript-shaped text" };
  }
  return { ok: true, value: serialized };
}

function serializeRequiredOptionalJson(value: unknown): string | null {
  const serialized = serializeOptionalJson(value);
  if (!serialized.ok) {
    throw new Error(`Invalid JSON payload: ${serialized.reason}`);
  }
  return serialized.value;
}

function isTempPath(dbPath: string): boolean {
  const tempRoot = resolve(tmpdir());
  const target = resolve(dbPath);
  return target === tempRoot || target.startsWith(`${tempRoot}${sep}`);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
