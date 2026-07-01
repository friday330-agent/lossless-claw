import { createHash } from "node:crypto";
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
const SEMANTIC_LOGICAL_KINDS = new Set([
  "overlay_verification",
  "overlay_content_gap",
  "reviewed_decision",
  "segment_bridge",
  "ingestion_rule",
  "implementation_trace",
  "dialogue_logic_trace",
  "writer_temp_proof",
  "schema_question",
]);
const SEMANTIC_REVIEW_STATES = new Set(["candidate", "accepted", "accepted_with_conditions", "rejected"]);
const SEMANTIC_EVIDENCE_LEVELS = new Set([
  "conversation_source_backed",
  "committed_plan",
  "committed_plan_plus_reverse_review",
  "native_slash_plus_db_check",
  "local_db_read",
  "temp_db_proof",
  "source_backed_required",
  "w550_report_friday_reviewed",
  "derived_from_reviewed_mapping",
]);
const SEMANTIC_ENTRY_COLUMNS = [
  "logical_kind",
  "project_id",
  "workline_id",
  "details_json",
  "evidence_level",
  "review_state",
];

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

export type SessionMemoryCarryForwardReplacementEntry = {
  sourceEntryId: string;
  entryId?: string;
  title?: string;
  body: string;
  confidence: number;
  priority?: number;
  sourceRefs?: SessionMemorySourceRef[];
};

export type SessionMemorySemanticEntryAppend = {
  entryId: string;
  kind: SessionMemoryOverlayEntryKind | string;
  logicalKind: string;
  projectId: string;
  worklineId: string;
  details: Record<string, unknown>;
  evidenceLevel: string;
  reviewState: string;
  confidence: number;
  priority?: number;
  title?: string;
  body: string;
  sourceRefs?: SessionMemorySourceRef[];
  originEntryId?: string;
  supersededByEntryId?: string;
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

export type SessionMemorySemanticAppendResult =
  | {
      ok: true;
      status: "written";
      conversationId: number;
      sessionId: string;
      segmentId: string;
      entryId: string;
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
        | "no_active_segment"
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

export type SessionMemoryCarryForwardResult =
  | {
      ok: true;
      status: "written";
      fromConversationId: number;
      toConversationId: number;
      sessionId: string;
      segmentId: string;
      entryCount: number;
      linkCount: number;
      carriedEntryIds: Array<{ fromEntryId: string; toEntryId: string }>;
      skippedEntryIds: Array<{ entryId: string; reason: CarryForwardSkipReason }>;
      replacementEntryIds: Array<{ fromEntryId: string; toEntryId: string }>;
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
        | "malformed_rows"
        | "raw_transcript_detected"
        | "lcm_schema_incompatible"
        | "source_ref_missing"
        | "no_active_entries"
        | "no_carryable_entries"
        | "target_already_has_entries"
        | "write_failed";
      detail?: string;
      schemaReason?: SessionMemoryOverlaySkipReason;
    };

export type SessionMemoryRefreshResult =
  | {
      ok: true;
      status: "written";
      conversationId: number;
      sessionId: string;
      segmentId: string;
      entryCount: number;
      linkCount: number;
      skippedEntryIds: Array<{ entryId: string; reason: CarryForwardSkipReason }>;
      replacementEntryIds: Array<{ fromEntryId: string; toEntryId: string }>;
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
        | "malformed_rows"
        | "raw_transcript_detected"
        | "lcm_schema_incompatible"
        | "source_ref_missing"
        | "no_active_entries"
        | "no_refreshable_entries"
        | "write_failed";
      detail?: string;
      schemaReason?: SessionMemoryOverlaySkipReason;
    };

type CarryForwardSkipReason = "current_state_fact_requires_refresh" | "next_action_requires_refresh";
type CarryForwardSourceStatus = "stale" | "settled" | "superseded";

type CarryForwardSourceEntry = {
  entryId: string;
  sessionId: string;
  segmentId: string;
  kind: SessionMemoryOverlayEntryKind;
  confidence: number;
  priority: number;
  title?: string;
  body: string;
  sourceRefs: SessionMemorySourceRef[];
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

export function appendReviewedSessionMemoryEntry(params: {
  dbPath: string;
  lcmDbPath: string;
  conversationId: number;
  sessionKey?: string;
  segmentId?: string;
  entry: SessionMemorySemanticEntryAppend;
  allowRealDb?: boolean;
  now?: Date;
}): SessionMemorySemanticAppendResult {
  if (!params.allowRealDb && !isTempPath(params.dbPath)) {
    return { ok: false, status: "refused", reason: "real_db_refused" };
  }
  if (!existsSync(params.dbPath)) {
    return { ok: false, status: "refused", reason: "db_absent" };
  }
  if (!Number.isInteger(params.conversationId)) {
    return semanticAppendInvalidPacket("conversationId is required");
  }
  const preflight = validateSemanticAppendEntry(params.entry);
  if (!preflight.ok) {
    return preflight.result;
  }

  let db: DatabaseSync | undefined;
  const updatedAt = (params.now ?? new Date()).toISOString();
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
    if (!hasColumns(db, "entries", SEMANTIC_ENTRY_COLUMNS)) {
      return {
        ok: false,
        status: "refused",
        reason: "schema_incompatible",
        detail: "entries semantic columns are required",
        schemaReason: "schema_missing",
      };
    }

    const refs = params.entry.sourceRefs ?? [];
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
      return semanticAppendFromWriteFailure(checkpointValidation.result);
    }

    const target = readActiveAppendTarget(db, {
      conversationId: params.conversationId,
      sessionKey: params.sessionKey,
      segmentId: params.segmentId,
    });
    if (!target.ok) {
      return target.result;
    }

    try {
      db.exec("BEGIN IMMEDIATE");
      insertSemanticAppendEntry(db, {
        entry: params.entry,
        sessionId: target.sessionId,
        segmentId: target.segmentId,
        updatedAt,
      });
      db
        .prepare("UPDATE segments SET entry_count = entry_count + 1, updated_at = ? WHERE segment_id = ?")
        .run(updatedAt, target.segmentId);
      db.prepare("UPDATE sessions SET updated_at = ? WHERE session_id = ?").run(updatedAt, target.sessionId);
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
        detail: error instanceof Error ? error.message : "session-memory semantic append failed",
      };
    }

    return {
      ok: true,
      status: "written",
      conversationId: params.conversationId,
      sessionId: target.sessionId,
      segmentId: target.segmentId,
      entryId: params.entry.entryId,
      updatedAt,
    };
  } catch (error) {
    return {
      ok: false,
      status: "failed",
      reason: "write_failed",
      detail: error instanceof Error ? error.message : "session-memory semantic append failed",
    };
  } finally {
    try {
      db?.close();
    } catch {
      // Best-effort cleanup after a bounded maintenance write.
    }
  }
}

export function carryForwardSessionMemoryEntries(params: {
  dbPath: string;
  lcmDbPath: string;
  fromConversationId: number;
  fromSessionKey?: string;
  to: {
    sessionId: string;
    conversationId: number;
    sessionKey?: string;
    title?: string;
    segmentId?: string;
  };
  allowRealDb?: boolean;
  maxEntries?: number;
  replacementEntries?: SessionMemoryCarryForwardReplacementEntry[];
  now?: Date;
}): SessionMemoryCarryForwardResult {
  if (!params.allowRealDb && !isTempPath(params.dbPath)) {
    return { ok: false, status: "refused", reason: "real_db_refused" };
  }
  if (!existsSync(params.dbPath)) {
    return { ok: false, status: "refused", reason: "db_absent" };
  }
  if (!Number.isInteger(params.fromConversationId) || !Number.isInteger(params.to.conversationId)) {
    return {
      ok: false,
      status: "refused",
      reason: "invalid_packet",
      detail: "fromConversationId and to.conversationId are required integers",
    };
  }
  if (params.fromConversationId === params.to.conversationId) {
    return {
      ok: false,
      status: "refused",
      reason: "invalid_packet",
      detail: "carry-forward target conversation must differ from source conversation",
    };
  }
  if (!isNonEmptyString(params.to.sessionId)) {
    return {
      ok: false,
      status: "refused",
      reason: "invalid_packet",
      detail: "to.sessionId is required",
    };
  }

  const maxEntries =
    typeof params.maxEntries === "number" && Number.isFinite(params.maxEntries)
      ? Math.floor(params.maxEntries)
      : 12;
  if (maxEntries < 1) {
    return {
      ok: false,
      status: "refused",
      reason: "invalid_packet",
      detail: "maxEntries must be >= 1",
    };
  }

  let db: DatabaseSync | undefined;
  const updatedAt = (params.now ?? new Date()).toISOString();
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
    const read = readCarryForwardSourceEntries(db, {
      conversationId: params.fromConversationId,
      sessionKey: params.fromSessionKey,
      maxEntries,
    });
    if (!read.ok) {
      return read.result;
    }
    const sourceEntries = read.entries;
    const carryForwardSelection = selectCarryForwardEntries(sourceEntries);
    const replacements = validateCarryForwardReplacementEntries({
      replacements: params.replacementEntries ?? [],
      skipped: carryForwardSelection.skipped,
      sourceEntries,
      toConversationId: params.to.conversationId,
    });
    if (!replacements.ok) {
      return replacements.result;
    }
    if (carryForwardSelection.entries.length === 0 && replacements.entries.length === 0) {
      return {
        ok: false,
        status: "refused",
        reason: "no_carryable_entries",
        detail: "all active source entries require refresh before carry-forward",
      };
    }
    const targetConflict = findExistingCarryForwardTargetEntries(db, {
      toConversationId: params.to.conversationId,
      sourceEntryIds: [
        ...carryForwardSelection.entries.map((entry) => entry.entryId),
        ...replacements.entries.map((entry) => entry.sourceEntryId),
      ],
    });
    if (targetConflict) {
      return {
        ok: false,
        status: "refused",
        reason: "target_already_has_entries",
        detail: `target conversation already has carried/replacement entry ${targetConflict.entryId} from source ${targetConflict.originEntryId}`,
      };
    }

    const packet = buildCarryForwardPacket({
      fromConversationId: params.fromConversationId,
      to: params.to,
      entries: carryForwardSelection.entries,
      replacements: replacements.entries,
    });
    const preflight = validateSeedPacketShape(packet);
    if (!preflight.ok) {
      return preflight.result;
    }
    const refs = collectSourceRefs(packet);
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

    try {
      db.exec("BEGIN IMMEDIATE");
      insertSession(db, packet, updatedAt);
      insertSegment(db, packet, updatedAt);
      for (const entry of packet.entries) {
        insertEntry(db, packet, entry, updatedAt);
      }
      for (const link of packet.links ?? []) {
        insertLink(db, link, updatedAt);
      }
      markSkippedCarryForwardSourceEntries(
        db,
        carryForwardSelection.skipped,
        sourceEntries,
        replacements.entries,
        updatedAt,
      );
      db
        .prepare("UPDATE segments SET entry_count = ?, updated_at = ? WHERE segment_id = ?")
        .run(packet.entries.length, updatedAt, packet.segment.segmentId);
      db.prepare("UPDATE sessions SET updated_at = ? WHERE session_id = ?").run(updatedAt, packet.session.sessionId);
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
        detail: error instanceof Error ? error.message : "session-memory carry-forward write failed",
      };
    }

    return {
      ok: true,
      status: "written",
      fromConversationId: params.fromConversationId,
      toConversationId: params.to.conversationId,
      sessionId: packet.session.sessionId,
      segmentId: packet.segment.segmentId,
      entryCount: packet.entries.length,
      linkCount: packet.links?.length ?? 0,
      carriedEntryIds: carryForwardSelection.entries.map((entry) => ({
        fromEntryId: entry.entryId,
        toEntryId: buildCarryForwardEntryId(params.to.conversationId, entry.entryId),
      })),
      skippedEntryIds: carryForwardSelection.skipped,
      replacementEntryIds: replacements.entries.map((entry) => ({
        fromEntryId: entry.sourceEntryId,
        toEntryId: entry.entryId,
      })),
      updatedAt,
    };
  } catch (error) {
    return {
      ok: false,
      status: "failed",
      reason: "write_failed",
      detail: error instanceof Error ? error.message : "session-memory carry-forward failed",
    };
  } finally {
    try {
      db?.close();
    } catch {
      // Best-effort cleanup after a bounded maintenance write.
    }
  }
}

export function refreshSessionMemoryEntries(params: {
  dbPath: string;
  lcmDbPath: string;
  conversationId: number;
  sessionKey?: string;
  allowRealDb?: boolean;
  maxEntries?: number;
  replacementEntries?: SessionMemoryCarryForwardReplacementEntry[];
  now?: Date;
}): SessionMemoryRefreshResult {
  if (!params.allowRealDb && !isTempPath(params.dbPath)) {
    return { ok: false, status: "refused", reason: "real_db_refused" };
  }
  if (!existsSync(params.dbPath)) {
    return { ok: false, status: "refused", reason: "db_absent" };
  }
  if (!Number.isInteger(params.conversationId)) {
    return {
      ok: false,
      status: "refused",
      reason: "invalid_packet",
      detail: "conversationId is required",
    };
  }

  const maxEntries =
    typeof params.maxEntries === "number" && Number.isFinite(params.maxEntries)
      ? Math.floor(params.maxEntries)
      : 12;
  if (maxEntries < 1) {
    return {
      ok: false,
      status: "refused",
      reason: "invalid_packet",
      detail: "maxEntries must be >= 1",
    };
  }

  let db: DatabaseSync | undefined;
  const updatedAt = (params.now ?? new Date()).toISOString();
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

    const read = readCarryForwardSourceEntries(db, {
      conversationId: params.conversationId,
      sessionKey: params.sessionKey,
      maxEntries,
    });
    if (!read.ok) {
      return refreshFromCarryForwardFailure(read.result);
    }
    const sourceEntries = read.entries;
    const sessionIds = new Set(sourceEntries.map((entry) => entry.sessionId));
    if (sessionIds.size !== 1) {
      return {
        ok: false,
        status: "refused",
        reason: "malformed_rows",
        detail: "refresh requires active source entries from exactly one session",
      };
    }

    const selection = selectCarryForwardEntries(sourceEntries);
    const replacements = validateCarryForwardReplacementEntries({
      replacements: params.replacementEntries ?? [],
      skipped: selection.skipped,
      sourceEntries,
      toConversationId: params.conversationId,
    });
    if (!replacements.ok) {
      return refreshFromCarryForwardFailure(replacements.result);
    }
    if (selection.skipped.length === 0 && replacements.entries.length === 0) {
      return {
        ok: false,
        status: "refused",
        reason: "no_refreshable_entries",
        detail: "no current-state facts or next actions require refresh",
      };
    }

    const refs = replacements.entries.flatMap((entry) => entry.sourceRefs);
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
      return refreshFromWriteFailure(checkpointValidation.result);
    }

    const sessionId = sourceEntries[0]?.sessionId;
    if (!sessionId) {
      return { ok: false, status: "refused", reason: "malformed_rows" };
    }
    const segmentId = `refresh:${params.conversationId}:segment:${hashShort(`${sessionId}:${updatedAt}`)}`;

    try {
      db.exec("BEGIN IMMEDIATE");
      insertRefreshSegment(db, {
        segmentId,
        sessionId,
        seq: nextSegmentSeq(db, sessionId),
        entryCount: replacements.entries.length,
        updatedAt,
      });
      for (const entry of replacements.entries) {
        insertRefreshReplacementEntry(db, {
          entry,
          sessionId,
          segmentId,
          updatedAt,
        });
        insertLink(
          db,
          {
            linkId: `refresh:${params.conversationId}:link:${hashShort(entry.sourceEntryId)}`,
            srcType: "entry",
            srcId: entry.entryId,
            relation: "supersedes",
            dstType: "entry",
            dstId: entry.sourceEntryId,
            confidence: entry.confidence,
          },
          updatedAt,
        );
      }
      markSkippedCarryForwardSourceEntries(db, selection.skipped, sourceEntries, replacements.entries, updatedAt);
      db.prepare("UPDATE sessions SET updated_at = ? WHERE session_id = ?").run(updatedAt, sessionId);
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
        detail: error instanceof Error ? error.message : "session-memory refresh write failed",
      };
    }

    return {
      ok: true,
      status: "written",
      conversationId: params.conversationId,
      sessionId,
      segmentId,
      entryCount: replacements.entries.length,
      linkCount: replacements.entries.length,
      skippedEntryIds: selection.skipped,
      replacementEntryIds: replacements.entries.map((entry) => ({
        fromEntryId: entry.sourceEntryId,
        toEntryId: entry.entryId,
      })),
      updatedAt,
    };
  } catch (error) {
    return {
      ok: false,
      status: "failed",
      reason: "write_failed",
      detail: error instanceof Error ? error.message : "session-memory refresh failed",
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

function validateSemanticAppendEntry(entry: SessionMemorySemanticEntryAppend):
  | { ok: true }
  | { ok: false; result: Extract<SessionMemorySemanticAppendResult, { ok: false }> } {
  if (!isNonEmptyString(entry?.entryId)) {
    return semanticAppendInvalidPacket("entry.entryId is required");
  }
  if (!ENTRY_KINDS.has(entry.kind as SessionMemoryOverlayEntryKind)) {
    return semanticAppendInvalidPacket(`invalid entry kind ${entry.kind}`);
  }
  if (!SEMANTIC_LOGICAL_KINDS.has(entry.logicalKind)) {
    return semanticAppendInvalidPacket(`invalid logicalKind ${entry.logicalKind}`);
  }
  if (!isNonEmptyString(entry.projectId)) {
    return semanticAppendInvalidPacket("entry.projectId is required");
  }
  if (!isNonEmptyString(entry.worklineId)) {
    return semanticAppendInvalidPacket("entry.worklineId is required");
  }
  if (!SEMANTIC_EVIDENCE_LEVELS.has(entry.evidenceLevel)) {
    return semanticAppendInvalidPacket(`invalid evidenceLevel ${entry.evidenceLevel}`);
  }
  if (!SEMANTIC_REVIEW_STATES.has(entry.reviewState)) {
    return semanticAppendInvalidPacket(`invalid reviewState ${entry.reviewState}`);
  }
  if (!Number.isFinite(entry.confidence) || entry.confidence < 0 || entry.confidence > 1) {
    return semanticAppendInvalidPacket("entry.confidence must be between 0 and 1");
  }
  if (entry.priority !== undefined && !Number.isInteger(entry.priority)) {
    return semanticAppendInvalidPacket("entry.priority must be an integer");
  }
  if (!isNonEmptyString(entry.body)) {
    return semanticAppendInvalidPacket("entry.body is required");
  }
  if (entry.body.length > MAX_ENTRY_BODY_CHARS) {
    return semanticAppendInvalidPacket(`entry.body exceeds ${MAX_ENTRY_BODY_CHARS} chars`);
  }
  if (isRawTranscriptShapedSessionMemoryBody(entry.body)) {
    return { ok: false, result: { ok: false, status: "refused", reason: "raw_transcript_detected" } };
  }
  if (!entry.details || typeof entry.details !== "object" || Array.isArray(entry.details)) {
    return semanticAppendInvalidPacket("entry.details must be an object");
  }
  const detailsJson = serializeOptionalJson(entry.details);
  if (!detailsJson.ok || detailsJson.value === null) {
    return semanticAppendInvalidPacket(`entry.details ${detailsJson.ok ? "is required" : detailsJson.reason}`);
  }
  const refs = validateSourceRefs(entry.sourceRefs ?? []);
  if (!refs.ok) {
    return semanticAppendInvalidPacket(refs.reason);
  }
  return { ok: true };
}

function readActiveAppendTarget(
  db: DatabaseSync,
  params: { conversationId: number; sessionKey?: string; segmentId?: string },
):
  | { ok: true; sessionId: string; segmentId: string }
  | { ok: false; result: Extract<SessionMemorySemanticAppendResult, { ok: false }> } {
  const row = db
    .prepare(
      `SELECT s.session_id AS session_id, sg.segment_id AS segment_id
       FROM sessions s
       JOIN segments sg ON sg.session_id = s.session_id
       WHERE s.conversation_id = ?
         AND s.status = 'active'
         AND sg.status = 'active'
         AND (? IS NULL OR s.session_key IS NULL OR s.session_key = ?)
         AND (? IS NULL OR sg.segment_id = ?)
       ORDER BY sg.seq DESC, sg.updated_at DESC, sg.segment_id ASC
       LIMIT 1`,
    )
    .get(
      params.conversationId,
      params.sessionKey ?? null,
      params.sessionKey ?? null,
      params.segmentId ?? null,
      params.segmentId ?? null,
    ) as { session_id?: unknown; segment_id?: unknown } | undefined;
  const sessionId = String(row?.session_id ?? "");
  const segmentId = String(row?.segment_id ?? "");
  if (!isNonEmptyString(sessionId) || !isNonEmptyString(segmentId)) {
    return { ok: false, result: { ok: false, status: "refused", reason: "no_active_segment" } };
  }
  return { ok: true, sessionId, segmentId };
}

function readCarryForwardSourceEntries(
  db: DatabaseSync,
  params: {
    conversationId: number;
    sessionKey?: string;
    maxEntries: number;
  },
):
  | { ok: true; entries: CarryForwardSourceEntry[] }
  | { ok: false; result: Extract<SessionMemoryCarryForwardResult, { ok: false }> } {
  const rows = db
    .prepare(
      `SELECT
         e.entry_id AS entry_id,
         e.session_id AS session_id,
         e.segment_id AS segment_id,
         e.kind AS kind,
         e.confidence AS confidence,
         e.priority AS priority,
         e.title AS title,
         e.body AS body,
         e.source_refs_json AS source_refs_json
       FROM sessions s
       JOIN segments sg ON sg.session_id = s.session_id
       JOIN entries e ON e.segment_id = sg.segment_id
       WHERE s.conversation_id = ?
         AND s.status = 'active'
         AND sg.status = 'active'
         AND e.status = 'active'
         AND (? IS NULL OR s.session_key IS NULL OR s.session_key = ?)
       ORDER BY e.priority DESC, e.updated_at DESC, e.entry_id ASC
       LIMIT ?`,
    )
    .all(params.conversationId, params.sessionKey ?? null, params.sessionKey ?? null, params.maxEntries) as Array<{
    entry_id: unknown;
    session_id: unknown;
    segment_id: unknown;
    kind: unknown;
    confidence: unknown;
    priority: unknown;
    title: unknown;
    body: unknown;
    source_refs_json: unknown;
  }>;

  if (rows.length === 0) {
    return { ok: false, result: { ok: false, status: "refused", reason: "no_active_entries" } };
  }

  const entries: CarryForwardSourceEntry[] = [];
  for (const row of rows) {
    const entryId = String(row.entry_id ?? "");
    const sessionId = String(row.session_id ?? "");
    const segmentId = String(row.segment_id ?? "");
    const kind = String(row.kind ?? "");
    const body = String(row.body ?? "");
    if (
      !isNonEmptyString(entryId) ||
      !isNonEmptyString(sessionId) ||
      !isNonEmptyString(segmentId) ||
      !ENTRY_KINDS.has(kind as SessionMemoryOverlayEntryKind)
    ) {
      return { ok: false, result: { ok: false, status: "refused", reason: "malformed_rows" } };
    }
    if (isRawTranscriptShapedSessionMemoryBody(body)) {
      return { ok: false, result: { ok: false, status: "refused", reason: "raw_transcript_detected" } };
    }
    const sourceRefs = parseStoredSourceRefs(row.source_refs_json);
    if (!sourceRefs) {
      return { ok: false, result: { ok: false, status: "refused", reason: "malformed_rows" } };
    }
    entries.push({
      entryId,
      sessionId,
      segmentId,
      kind: kind as SessionMemoryOverlayEntryKind,
      confidence: Number(row.confidence ?? 0),
      priority: Number(row.priority ?? 0),
      title: typeof row.title === "string" && row.title.trim() ? row.title : undefined,
      body,
      sourceRefs,
    });
  }
  return { ok: true, entries };
}

function selectCarryForwardEntries(entries: CarryForwardSourceEntry[]): {
  entries: CarryForwardSourceEntry[];
  skipped: Array<{ entryId: string; reason: CarryForwardSkipReason }>;
} {
  const selected: CarryForwardSourceEntry[] = [];
  const skipped: Array<{ entryId: string; reason: CarryForwardSkipReason }> = [];
  for (const entry of entries) {
    const skipReason = getCarryForwardSkipReason(entry);
    if (skipReason) {
      skipped.push({ entryId: entry.entryId, reason: skipReason });
    } else {
      selected.push(entry);
    }
  }
  return { entries: selected, skipped };
}

function findExistingCarryForwardTargetEntries(
  db: DatabaseSync,
  params: {
    toConversationId: number;
    sourceEntryIds: string[];
  },
): { entryId: string; originEntryId: string } | null {
  const sourceEntryIds = [...new Set(params.sourceEntryIds.filter(isNonEmptyString))];
  if (sourceEntryIds.length === 0) {
    return null;
  }
  const placeholders = sourceEntryIds.map(() => "?").join(", ");
  const row = db
    .prepare(
      `SELECT e.entry_id AS entry_id, e.origin_entry_id AS origin_entry_id
       FROM sessions s
       JOIN entries e ON e.session_id = s.session_id
       WHERE s.conversation_id = ?
         AND e.origin_entry_id IN (${placeholders})
       ORDER BY e.updated_at DESC, e.entry_id ASC
       LIMIT 1`,
    )
    .get(params.toConversationId, ...sourceEntryIds) as { entry_id?: unknown; origin_entry_id?: unknown } | undefined;
  if (!row || !isNonEmptyString(row.entry_id) || !isNonEmptyString(row.origin_entry_id)) {
    return null;
  }
  return { entryId: row.entry_id, originEntryId: row.origin_entry_id };
}

function getCarryForwardSkipReason(entry: CarryForwardSourceEntry): CarryForwardSkipReason | null {
  if (entry.kind === "next_action") {
    return "next_action_requires_refresh";
  }
  if (entry.kind === "fact" && isCurrentStateFactBody(entry.body)) {
    return "current_state_fact_requires_refresh";
  }
  return null;
}

function getSkippedSourceStatus(reason: CarryForwardSkipReason): CarryForwardSourceStatus {
  if (reason === "current_state_fact_requires_refresh") {
    return "stale";
  }
  return "settled";
}

type NormalizedCarryForwardReplacementEntry = Required<
  Pick<SessionMemoryCarryForwardReplacementEntry, "sourceEntryId" | "entryId" | "body" | "confidence" | "sourceRefs">
> &
  Pick<SessionMemoryCarryForwardReplacementEntry, "title" | "priority">;

function validateCarryForwardReplacementEntries(params: {
  replacements: SessionMemoryCarryForwardReplacementEntry[];
  skipped: Array<{ entryId: string; reason: CarryForwardSkipReason }>;
  sourceEntries: CarryForwardSourceEntry[];
  toConversationId: number;
}):
  | { ok: true; entries: NormalizedCarryForwardReplacementEntry[] }
  | { ok: false; result: Extract<SessionMemoryCarryForwardResult, { ok: false }> } {
  const skippedByEntryId = new Map(params.skipped.map((entry) => [entry.entryId, entry.reason]));
  const sourceByEntryId = new Map(params.sourceEntries.map((entry) => [entry.entryId, entry]));
  const normalized: NormalizedCarryForwardReplacementEntry[] = [];
  const sourceIds = new Set<string>();
  const replacementIds = new Set<string>();

  for (const replacement of params.replacements) {
    if (!isNonEmptyString(replacement.sourceEntryId)) {
      return carryForwardInvalidPacket("replacement.sourceEntryId is required");
    }
    if (sourceIds.has(replacement.sourceEntryId)) {
      return carryForwardInvalidPacket(`duplicate replacement sourceEntryId ${replacement.sourceEntryId}`);
    }
    sourceIds.add(replacement.sourceEntryId);

    const reason = skippedByEntryId.get(replacement.sourceEntryId);
    if (!reason) {
      return carryForwardInvalidPacket(`replacement source entry ${replacement.sourceEntryId} was not skipped`);
    }
    if (reason !== "current_state_fact_requires_refresh") {
      return carryForwardInvalidPacket(`replacement source entry ${replacement.sourceEntryId} is not a stale fact`);
    }
    const source = sourceByEntryId.get(replacement.sourceEntryId);
    if (!source || source.kind !== "fact") {
      return carryForwardInvalidPacket(`replacement source entry ${replacement.sourceEntryId} is not a fact`);
    }
    if (!isNonEmptyString(replacement.body)) {
      return carryForwardInvalidPacket("replacement.body is required");
    }
    if (replacement.body.length > MAX_ENTRY_BODY_CHARS) {
      return carryForwardInvalidPacket(`replacement.body exceeds ${MAX_ENTRY_BODY_CHARS} chars`);
    }
    if (isRawTranscriptShapedSessionMemoryBody(replacement.body)) {
      return { ok: false, result: { ok: false, status: "refused", reason: "raw_transcript_detected" } };
    }
    if (!Number.isFinite(replacement.confidence) || replacement.confidence < 0 || replacement.confidence > 1) {
      return carryForwardInvalidPacket("replacement.confidence must be between 0 and 1");
    }
    if (replacement.priority !== undefined && !Number.isInteger(replacement.priority)) {
      return carryForwardInvalidPacket("replacement.priority must be an integer");
    }
    const refs = validateSourceRefs(replacement.sourceRefs ?? []);
    if (!refs.ok) {
      return carryForwardInvalidPacket(refs.reason);
    }
    const entryId =
      replacement.entryId ?? buildCarryForwardReplacementEntryId(params.toConversationId, replacement.sourceEntryId);
    if (!isNonEmptyString(entryId)) {
      return carryForwardInvalidPacket("replacement.entryId must be a non-empty string when provided");
    }
    if (replacementIds.has(entryId)) {
      return carryForwardInvalidPacket(`duplicate replacement entry id ${entryId}`);
    }
    replacementIds.add(entryId);

    normalized.push({
      sourceEntryId: replacement.sourceEntryId,
      entryId,
      title: replacement.title,
      body: replacement.body,
      confidence: replacement.confidence,
      priority: replacement.priority,
      sourceRefs: replacement.sourceRefs ?? [],
    });
  }

  return { ok: true, entries: normalized };
}

function markSkippedCarryForwardSourceEntries(
  db: DatabaseSync,
  skipped: Array<{ entryId: string; reason: CarryForwardSkipReason }>,
  sourceEntries: CarryForwardSourceEntry[],
  replacements: NormalizedCarryForwardReplacementEntry[],
  updatedAt: string,
): void {
  if (skipped.length === 0) {
    return;
  }
  const sourceByEntryId = new Map(sourceEntries.map((entry) => [entry.entryId, entry]));
  const replacementBySourceId = new Map(replacements.map((entry) => [entry.sourceEntryId, entry]));
  const touchedSessionIds = new Set<string>();
  const touchedSegmentIds = new Set<string>();
  const update = db.prepare(
    `UPDATE entries
     SET status = ?, updated_at = ?, settled_at = ?, superseded_by_entry_id = ?
     WHERE entry_id = ?
       AND status = 'active'`,
  );
  for (const skippedEntry of skipped) {
    const source = sourceByEntryId.get(skippedEntry.entryId);
    if (!source) {
      throw new Error(`Missing skipped source entry ${skippedEntry.entryId}`);
    }
    const replacement = replacementBySourceId.get(skippedEntry.entryId);
    const status: CarryForwardSourceStatus = replacement ? "superseded" : getSkippedSourceStatus(skippedEntry.reason);
    const result = update.run(status, updatedAt, updatedAt, replacement?.entryId ?? null, skippedEntry.entryId);
    if (result.changes !== 1) {
      throw new Error(`Expected one active source entry update for ${skippedEntry.entryId}`);
    }
    touchedSessionIds.add(source.sessionId);
    touchedSegmentIds.add(source.segmentId);
  }
  updateRowsByIds(db, "segments", "segment_id", Array.from(touchedSegmentIds), updatedAt);
  updateRowsByIds(db, "sessions", "session_id", Array.from(touchedSessionIds), updatedAt);
}

function isCurrentStateFactBody(body: string): boolean {
  const normalized = body.toLowerCase();
  if (/\bconversation\s+\d+\b/.test(normalized)) {
    return true;
  }
  if (/\bcurrently\b/.test(normalized) && /\b(db|database|seed|session|conversation|active|rows?)\b/.test(normalized)) {
    return true;
  }
  if (/\bcurrent\b/.test(normalized) && /\b(conversation|session|seed|workline)\b/.test(normalized)) {
    return true;
  }
  if (/\bactive reviewed seed rows?\b/.test(normalized) || /\bactive seed rows?\b/.test(normalized)) {
    return true;
  }
  return false;
}

function buildCarryForwardPacket(params: {
  fromConversationId: number;
  to: {
    sessionId: string;
    conversationId: number;
    sessionKey?: string;
    title?: string;
    segmentId?: string;
  };
  entries: CarryForwardSourceEntry[];
  replacements: NormalizedCarryForwardReplacementEntry[];
}): SessionMemorySeedPacket {
  const segmentId = params.to.segmentId ?? `carry:${params.to.conversationId}:segment:${hashShort(params.to.sessionId)}`;
  const entryIdBySource = new Map<string, string>();
  for (const entry of params.entries) {
    entryIdBySource.set(entry.entryId, buildCarryForwardEntryId(params.to.conversationId, entry.entryId));
  }

  return {
    session: {
      sessionId: params.to.sessionId,
      conversationId: params.to.conversationId,
      sessionKey: params.to.sessionKey,
      title: params.to.title ?? "Carried-forward session memory seed",
      metadata: {
        carryForward: {
          fromConversationId: params.fromConversationId,
          toConversationId: params.to.conversationId,
          policy: "new_defaults_to_continue_previous_workline",
        },
      },
    },
    segment: {
      segmentId,
      seq: 1,
    },
    entries: [
      ...params.entries.map((entry) => ({
        entryId: entryIdBySource.get(entry.entryId) ?? buildCarryForwardEntryId(params.to.conversationId, entry.entryId),
        kind: entry.kind,
        confidence: entry.confidence,
        priority: entry.priority,
        title: entry.title,
        body: entry.body,
        sourceRefs: entry.sourceRefs,
        originEntryId: entry.entryId,
      })),
      ...params.replacements.map((entry) => ({
        entryId: entry.entryId,
        kind: "fact",
        confidence: entry.confidence,
        priority: entry.priority,
        title: entry.title,
        body: entry.body,
        sourceRefs: entry.sourceRefs,
        originEntryId: entry.sourceEntryId,
      })),
    ],
    links: [
      ...params.entries.map((entry) => ({
        linkId: `carry:${params.to.conversationId}:link:${hashShort(entry.entryId)}`,
        srcType: "entry",
        srcId: entry.entryId,
        relation: "carried_to",
        dstType: "entry",
        dstId: entryIdBySource.get(entry.entryId) ?? buildCarryForwardEntryId(params.to.conversationId, entry.entryId),
        confidence: 1,
      })),
      ...params.replacements.map((entry) => ({
        linkId: `refresh:${params.to.conversationId}:link:${hashShort(entry.sourceEntryId)}`,
        srcType: "entry",
        srcId: entry.entryId,
        relation: "supersedes",
        dstType: "entry",
        dstId: entry.sourceEntryId,
        confidence: entry.confidence,
      })),
    ],
  };
}

function invalidPacket(detail: string): { ok: false; result: Extract<SessionMemoryWriteResult, { ok: false }> } {
  return { ok: false, result: { ok: false, status: "refused", reason: "invalid_packet", detail } };
}

function semanticAppendInvalidPacket(
  detail: string,
): { ok: false; result: Extract<SessionMemorySemanticAppendResult, { ok: false }> } {
  return { ok: false, result: { ok: false, status: "refused", reason: "invalid_packet", detail } };
}

function carryForwardInvalidPacket(
  detail: string,
): { ok: false; result: Extract<SessionMemoryCarryForwardResult, { ok: false }> } {
  return { ok: false, result: { ok: false, status: "refused", reason: "invalid_packet", detail } };
}

function semanticAppendFromWriteFailure(
  result: Extract<SessionMemoryWriteResult, { ok: false }>,
): Extract<SessionMemorySemanticAppendResult, { ok: false }> {
  const reason =
    result.reason === "real_db_refused" ||
    result.reason === "db_absent" ||
    result.reason === "schema_incompatible" ||
    result.reason === "invalid_packet" ||
    result.reason === "raw_transcript_detected" ||
    result.reason === "lcm_schema_incompatible" ||
    result.reason === "source_ref_missing" ||
    result.reason === "write_failed"
      ? result.reason
      : "write_failed";
  return {
    ok: false,
    status: result.status,
    reason,
    detail: result.detail,
    schemaReason: result.schemaReason,
  };
}

function refreshFromCarryForwardFailure(
  result: Extract<SessionMemoryCarryForwardResult, { ok: false }>,
): Extract<SessionMemoryRefreshResult, { ok: false }> {
  const reason =
    result.reason === "no_carryable_entries"
      ? "no_refreshable_entries"
      : result.reason === "real_db_refused" ||
          result.reason === "db_absent" ||
          result.reason === "schema_incompatible" ||
          result.reason === "invalid_packet" ||
          result.reason === "malformed_rows" ||
          result.reason === "raw_transcript_detected" ||
          result.reason === "lcm_schema_incompatible" ||
          result.reason === "source_ref_missing" ||
          result.reason === "no_active_entries" ||
          result.reason === "write_failed"
        ? result.reason
        : "write_failed";
  return {
    ok: false,
    status: result.status,
    reason,
    detail: result.detail,
    schemaReason: result.schemaReason,
  };
}

function refreshFromWriteFailure(
  result: Extract<SessionMemoryWriteResult, { ok: false }>,
): Extract<SessionMemoryRefreshResult, { ok: false }> {
  const reason =
    result.reason === "real_db_refused" ||
    result.reason === "db_absent" ||
    result.reason === "schema_incompatible" ||
    result.reason === "invalid_packet" ||
    result.reason === "raw_transcript_detected" ||
    result.reason === "lcm_schema_incompatible" ||
    result.reason === "source_ref_missing" ||
    result.reason === "write_failed"
      ? result.reason
      : "write_failed";
  return {
    ok: false,
    status: result.status,
    reason,
    detail: result.detail,
    schemaReason: result.schemaReason,
  };
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

function nextSegmentSeq(db: DatabaseSync, sessionId: string): number {
  const row = db.prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM segments WHERE session_id = ?").get(sessionId) as {
    seq: unknown;
  };
  const seq = Number(row.seq);
  if (!Number.isInteger(seq) || seq < 1) {
    throw new Error(`Invalid next segment seq for ${sessionId}`);
  }
  return seq;
}

function insertRefreshSegment(
  db: DatabaseSync,
  params: {
    segmentId: string;
    sessionId: string;
    seq: number;
    entryCount: number;
    updatedAt: string;
  },
): void {
  db
    .prepare(
      `INSERT INTO segments (
        segment_id, session_id, seq, status, start_ref_json, end_ref_json, token_estimate, entry_count,
        opened_at, closed_at, created_at, updated_at
      ) VALUES (?, ?, ?, 'active', NULL, NULL, NULL, ?, ?, NULL, ?, ?)`,
    )
    .run(params.segmentId, params.sessionId, params.seq, params.entryCount, params.updatedAt, params.updatedAt, params.updatedAt);
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

function insertRefreshReplacementEntry(
  db: DatabaseSync,
  params: {
    entry: NormalizedCarryForwardReplacementEntry;
    sessionId: string;
    segmentId: string;
    updatedAt: string;
  },
): void {
  db
    .prepare(
      `INSERT INTO entries (
        entry_id, session_id, segment_id, kind, status, confidence, priority, title, body, source_refs_json,
        origin_entry_id, superseded_by_entry_id, created_at, updated_at, settled_at
      ) VALUES (?, ?, ?, 'fact', 'active', ?, ?, ?, ?, ?, ?, NULL, ?, ?, NULL)`,
    )
    .run(
      params.entry.entryId,
      params.sessionId,
      params.segmentId,
      params.entry.confidence,
      params.entry.priority ?? 0,
      params.entry.title ?? null,
      params.entry.body,
      serializeSourceRefs(params.entry.sourceRefs),
      params.entry.sourceEntryId,
      params.updatedAt,
      params.updatedAt,
    );
}

function insertSemanticAppendEntry(
  db: DatabaseSync,
  params: {
    entry: SessionMemorySemanticEntryAppend;
    sessionId: string;
    segmentId: string;
    updatedAt: string;
  },
): void {
  db
    .prepare(
      `INSERT INTO entries (
        entry_id, session_id, segment_id, kind, status, confidence, priority, title, body, source_refs_json,
        origin_entry_id, superseded_by_entry_id, created_at, updated_at, settled_at,
        logical_kind, project_id, workline_id, details_json, evidence_level, review_state
      ) VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      params.entry.entryId,
      params.sessionId,
      params.segmentId,
      params.entry.kind,
      params.entry.confidence,
      params.entry.priority ?? 0,
      params.entry.title ?? null,
      params.entry.body,
      serializeSourceRefs(params.entry.sourceRefs ?? []),
      params.entry.originEntryId ?? null,
      params.entry.supersededByEntryId ?? null,
      params.updatedAt,
      params.updatedAt,
      params.entry.logicalKind,
      params.entry.projectId,
      params.entry.worklineId,
      serializeRequiredOptionalJson(params.entry.details),
      params.entry.evidenceLevel,
      params.entry.reviewState,
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

function hasColumns(db: DatabaseSync, tableName: string, columns: string[]): boolean {
  const tableColumns = new Set(
    db.prepare(`PRAGMA table_info(${tableName})`).all().map((row) => String((row as { name: unknown }).name)),
  );
  return columns.every((column) => tableColumns.has(column));
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

function parseStoredSourceRefs(raw: unknown): SessionMemorySourceRef[] | null {
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

function buildCarryForwardEntryId(toConversationId: number, sourceEntryId: string): string {
  return `carry:${toConversationId}:entry:${hashShort(sourceEntryId)}`;
}

function buildCarryForwardReplacementEntryId(toConversationId: number, sourceEntryId: string): string {
  return `refresh:${toConversationId}:entry:${hashShort(sourceEntryId)}`;
}

function hashShort(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function isTempPath(dbPath: string): boolean {
  const tempRoot = resolve(tmpdir());
  const target = resolve(dbPath);
  return target === tempRoot || target.startsWith(`${tempRoot}${sep}`);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
