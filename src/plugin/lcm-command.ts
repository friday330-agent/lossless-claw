import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import packageJson from "../../package.json" with { type: "json" };
import { formatTimestamp } from "../compaction.js";
import type { LcmConfig } from "../db/config.js";
import type {
  RotateSessionStorageWithBackupResult,
  SessionMemoryOverlaySessionStatus,
} from "../engine.js";
import { runDelegatedFocusBrief, runDelegatedRefocusBrief } from "../focus-briefs.js";
import type { LcmSummarizeFn } from "../summarize.js";
import type { LcmDependencies } from "../types.js";
import type {
  CompactResult,
  OpenClawPluginCommandDefinition,
  PluginCommandContext,
} from "../openclaw-bridge.js";
import { applyScopedDoctorRepair } from "./lcm-doctor-apply.js";
import { createLcmDatabaseBackup } from "./lcm-db-backup.js";
import { describeLogError } from "../lcm-log.js";
import {
  applyDoctorCleaners,
  getDoctorCleanerApplyUnavailableReason,
  getDoctorCleanerFilterIds,
  scanDoctorCleaners,
  type DoctorCleanerId,
} from "./lcm-doctor-cleaners.js";
import {
  detectDoctorMarker,
  getDoctorSummaryStats,
  type DoctorSummaryStats,
} from "./lcm-doctor-shared.js";
import {
  CompactionMaintenanceStore,
  type ConversationCompactionMaintenanceRecord,
} from "../store/compaction-maintenance-store.js";
import { CompactionTelemetryStore } from "../store/compaction-telemetry-store.js";
import { FocusBriefStore, hashFocusSourceContext } from "../store/focus-brief-store.js";
import { assemblySourceTelemetry } from "../assembly-source-telemetry.js";
import {
  buildSessionMemorySchemaMaintenanceText,
  type SessionMemorySchemaCommand,
} from "../session-memory-maintenance.js";
import type { SessionMemoryOverlayMode, SessionMemoryOverlayRenderProfile } from "../session-memory.js";
import {
  appendReviewedSessionMemoryEntry,
  carryForwardSessionMemoryEntries,
  type SessionMemoryCarryForwardReplacementEntry,
  type SessionMemorySemanticEntryAppend,
} from "../session-memory-writer.js";

const VISIBLE_COMMAND = "/lossless";
const HIDDEN_ALIAS = "/lcm";
const ROTATE_DATABASE_LOCK_TIMEOUT_MS = 30_000;

type LcmStatusStats = {
  conversationCount: number;
  summaryCount: number;
  storedSummaryTokens: number;
  summarizedSourceTokens: number;
  leafSummaryCount: number;
  condensedSummaryCount: number;
};

type LcmConversationStatusStats = {
  conversationId: number;
  sessionId: string;
  sessionKey: string | null;
  messageCount: number;
  summaryCount: number;
  storedSummaryTokens: number;
  summarizedSourceTokens: number;
  contextTokenCount: number;
  compressedTokenCount: number;
  leafSummaryCount: number;
  condensedSummaryCount: number;
};

type CurrentConversationResolution =
  | {
      kind: "resolved";
      source: "session_key" | "session_key_via_session_id" | "session_id";
      stats: LcmConversationStatusStats;
    }
  | {
      kind: "unavailable";
      reason: string;
    };

type ParsedLcmCommand =
  | { kind: "status" }
  | { kind: "backup" }
  | { kind: "rotate" }
  | { kind: "focus_status" }
  | { kind: "focus_generate"; prompt: string }
  | { kind: "refocus" }
  | { kind: "unfocus" }
  | { kind: "doctor"; apply: boolean }
  | { kind: "doctor_cleaners"; apply: boolean; filterId?: DoctorCleanerId; vacuum: boolean }
  | { kind: "session_memory_mode"; action: "status" | "clear" | SessionMemoryOverlayMode }
  | { kind: "session_memory_profile"; action: "clear" | SessionMemoryOverlayRenderProfile }
  | { kind: "session_memory_schema"; command: SessionMemorySchemaCommand }
  | { kind: "session_memory_carry_forward"; command: SessionMemoryCarryForwardCommand }
  | { kind: "session_memory_append_reviewed"; command: SessionMemoryAppendReviewedCommand }
  | { kind: "session_memory_capture_candidates"; command: SessionMemoryCaptureCandidatesCommand }
  | { kind: "help"; error?: string };

type SessionMemoryCarryForwardCommand = {
  sourceMode: "explicit" | "same_session_key";
  fromConversationId?: number;
  fromSessionKey?: string;
  toConversationId?: number;
  dbPath?: string;
  execute: boolean;
  confirm?: string;
  allowRealDb: boolean;
  maxEntries?: number;
  replacementsPath?: string;
};

type SessionMemoryAppendReviewedCommand = {
  entryPath: string;
  dbPath?: string;
  segmentId?: string;
  toConversationId?: number;
  execute: boolean;
  confirm?: string;
  allowRealDb: boolean;
};

type SessionMemoryCaptureCandidatesCommand = {
  conversationId?: number;
  limit: number;
};

type SessionMemoryCaptureCandidate = {
  kind:
    | "workline_shift"
    | "constraint_boundary"
    | "decision"
    | "design_focus"
    | "research_direction"
    | "open_question"
    | "task_request"
    | "next_action"
    | "verified_result"
    | "completed_state"
    | "correction"
    | "system_boundary";
  source: "user_decision" | "friday_review" | "command_result" | "lcm_summary";
  sourceKind: "message" | "summary";
  sourceRef: string;
  role: string;
  createdAt: string;
  claim: string;
  evidenceSignals?: string[];
  why: string;
  confidence: "high" | "medium";
  riskIfWrong: string;
  suggestedDestination: string;
};

type SessionMemoryCaptureReviewBucket =
  | "promotable"
  | "open_question"
  | "resolved_question"
  | "evidence_only"
  | "duplicate"
  | "local_flow"
  | "stale_superseded";

type ReviewedSessionMemoryCaptureCandidate = SessionMemoryCaptureCandidate & {
  reviewBucket: SessionMemoryCaptureReviewBucket;
  reviewNote: string;
};

type SessionMemoryCurrentStateProbe = {
  latestCompleted: string[];
  nextAction: string[];
  newestEvidence: string[];
};

type SessionMemoryCurrentStateProbeCandidate = {
  text: string;
  createdAt: string;
  sourceKind?: "message" | "summary";
  score: number;
};

type SessionMemoryReplacementPacketLoadResult =
  | {
      ok: true;
      path?: string;
      entries: SessionMemoryCarryForwardReplacementEntry[];
      digest: string;
    }
  | {
      ok: false;
      error: string;
    };

type SessionMemoryAppendPacketLoadResult =
  | {
      ok: true;
      path: string;
      entry: SessionMemorySemanticEntryAppend;
      digest: string;
    }
  | {
      ok: false;
      error: string;
    };

type RotateCommandEngine = {
  rotateSessionStorageWithBackup(params: {
    sessionId?: string;
    sessionKey?: string;
    sessionFile: string;
    lockTimeoutMs: number;
  }): Promise<RotateSessionStorageWithBackupResult>;
};

type FocusCompactionCommandEngine = {
  compact(params: {
    sessionId: string;
    sessionKey?: string;
    sessionFile: string;
    tokenBudget?: number;
    currentTokenCount?: number;
    compactionTarget?: "budget" | "threshold";
    runtimeContext?: Record<string, unknown>;
    force?: boolean;
  }): Promise<CompactResult>;
};

type RuntimeCommandEngine = RotateCommandEngine & Partial<FocusCompactionCommandEngine>;

type SessionMemoryOverlayCommandEngine = {
  getSessionMemoryOverlayMode(params: {
    sessionId?: string;
    sessionKey?: string;
  }): SessionMemoryOverlaySessionStatus;
  setSessionMemoryOverlayMode(params: {
    sessionId?: string;
    sessionKey?: string;
    mode: SessionMemoryOverlayMode;
  }): SessionMemoryOverlaySessionStatus;
  clearSessionMemoryOverlayMode(params: {
    sessionId?: string;
    sessionKey?: string;
  }): SessionMemoryOverlaySessionStatus;
  setSessionMemoryOverlayRenderProfile(params: {
    sessionId?: string;
    sessionKey?: string;
    renderProfile: SessionMemoryOverlayRenderProfile;
  }): SessionMemoryOverlaySessionStatus;
  clearSessionMemoryOverlayRenderProfile(params: {
    sessionId?: string;
    sessionKey?: string;
  }): SessionMemoryOverlaySessionStatus;
};

type LcmCommandEngine = RuntimeCommandEngine & Partial<SessionMemoryOverlayCommandEngine>;

const DOCTOR_CLEANER_IDS = new Set<DoctorCleanerId>(getDoctorCleanerFilterIds());

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readCommandRuntimeContext(ctx: PluginCommandContext): Record<string, unknown> | undefined {
  return asRecord(asRecord(ctx)?.runtimeContext);
}

function formatBoolean(value: boolean): string {
  return value ? "yes" : "no";
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return "unknown";
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const precision = value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(precision)} ${units[unitIndex]}`;
}

function formatCommand(command: string): string {
  return `\`${command}\``;
}

function buildHeaderLines(): string[] {
  return [
    `**🦀 Lossless Claw v${packageJson.version}**`,
    `Help: ${formatCommand(`${VISIBLE_COMMAND} help`)} · Alias: ${formatCommand(HIDDEN_ALIAS)}`,
  ];
}

function buildSection(title: string, lines: string[]): string {
  return [`**${title}**`, ...lines.map((line) => `  ${line}`)].join("\n");
}

function buildStatLine(label: string, value: string): string {
  return `${label}: ${value}`;
}

function formatFailureReason(error: unknown): string {
  const message = describeLogError(error).trim();
  return message || "Unknown error";
}

function formatCompressionRatio(contextTokens: number, compressedTokens: number): string {
  if (
    !Number.isFinite(contextTokens) ||
    contextTokens <= 0 ||
    !Number.isFinite(compressedTokens) ||
    compressedTokens <= 0
  ) {
    return "n/a";
  }
  const ratio = Math.max(1, Math.round(compressedTokens / contextTokens));
  return `1:${formatNumber(ratio)}`;
}

function truncateMiddle(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  if (maxChars <= 3) {
    return value.slice(0, maxChars);
  }
  const head = Math.ceil((maxChars - 1) / 2);
  const tail = Math.floor((maxChars - 1) / 2);
  return `${value.slice(0, head)}…${value.slice(value.length - tail)}`;
}

function splitArgs(rawArgs: string | undefined): string[] {
  return (rawArgs ?? "")
    .trim()
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean);
}

function isTempPath(path: string): boolean {
  const tempRoot = resolve(tmpdir());
  const target = resolve(path);
  return target === tempRoot || target.startsWith(`${tempRoot}${sep}`);
}

function sessionMemoryCarryForwardConfirmationToken(params: {
  dbPath: string;
  fromConversationId: number;
  toConversationId: number;
  sessionId: string;
  sessionKey?: string | null;
  replacementsDigest?: string;
}): string {
  return `smcf:${createHash("sha256")
    .update([
      "session_memory_carry_forward_v1",
      resolve(params.dbPath),
      String(params.fromConversationId),
      String(params.toConversationId),
      params.sessionId,
      params.sessionKey ?? "",
      params.replacementsDigest ?? "",
    ].join("\n"))
    .digest("hex")
    .slice(0, 12)}`;
}

function parseConversationId(value: string | undefined, optionName: string):
  | { ok: true; conversationId: number }
  | { ok: false; error: string } {
  if (!value) {
    return { ok: false, error: `\`${optionName}\` requires a conversation id.` };
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    return { ok: false, error: `\`${optionName}\` must be a positive integer conversation id.` };
  }
  return { ok: true, conversationId: parsed };
}

function resolveSameSessionKeyReattachSource(params: {
  lcmDb: DatabaseSync;
  sessionMemoryDbPath: string;
  currentConversationId: number;
  currentSessionKey?: string | null;
  requestedSessionKey?: string;
}):
  | {
      ok: true;
      conversationId: number;
      sessionKey: string;
      candidateCount: number;
      activeEntryCount: number;
    }
  | {
      ok: false;
      reason: string;
      detail?: string;
      sessionKey?: string;
      candidateCount?: number;
    } {
  const sessionKey = normalizeIdentity(params.requestedSessionKey ?? params.currentSessionKey ?? undefined);
  if (!sessionKey) {
    return {
      ok: false,
      reason: "missing_session_key",
      detail: "same-sessionKey reattach requires a source session key or current session key",
    };
  }

  const candidates = params.lcmDb
    .prepare(
      `SELECT conversation_id
       FROM conversations
       WHERE session_key = ?
         AND conversation_id <> ?
       ORDER BY active ASC, created_at DESC, conversation_id DESC`,
    )
    .all(sessionKey, params.currentConversationId) as Array<{ conversation_id: number }>;

  if (candidates.length === 0) {
    return {
      ok: false,
      reason: "no_same_session_key_candidates",
      sessionKey,
      candidateCount: 0,
    };
  }

  if (!existsSync(params.sessionMemoryDbPath)) {
    return {
      ok: false,
      reason: "session_memory_db_absent",
      sessionKey,
      candidateCount: candidates.length,
      detail: params.sessionMemoryDbPath,
    };
  }

  let db: DatabaseSync;
  try {
    db = new DatabaseSync(params.sessionMemoryDbPath, { readOnly: true });
  } catch (error) {
    return {
      ok: false,
      reason: "session_memory_db_read_error",
      sessionKey,
      candidateCount: candidates.length,
      detail: error instanceof Error ? error.message : String(error),
    };
  }

  try {
    const countActiveEntries = db.prepare(
      `SELECT COUNT(*) AS count
       FROM entries
       JOIN sessions ON sessions.session_id = entries.session_id
       WHERE sessions.conversation_id = ?
         AND entries.status = 'active'`,
    );
    for (const candidate of candidates) {
      const row = countActiveEntries.get(candidate.conversation_id) as { count: number };
      if (row.count > 0) {
        return {
          ok: true,
          conversationId: candidate.conversation_id,
          sessionKey,
          candidateCount: candidates.length,
          activeEntryCount: row.count,
        };
      }
    }
  } catch (error) {
    return {
      ok: false,
      reason: "session_memory_candidate_query_failed",
      sessionKey,
      candidateCount: candidates.length,
      detail: error instanceof Error ? error.message : String(error),
    };
  } finally {
    db.close();
  }

  return {
    ok: false,
    reason: "no_candidates_with_active_entries",
    sessionKey,
    candidateCount: candidates.length,
  };
}

function sessionMemoryAppendReviewedConfirmationToken(params: {
  dbPath: string;
  conversationId: number;
  sessionId: string;
  sessionKey?: string | null;
  segmentId?: string;
  entryDigest: string;
}): string {
  return `smar:${createHash("sha256")
    .update([
      "session_memory_append_reviewed_v1",
      resolve(params.dbPath),
      String(params.conversationId),
      params.sessionId,
      params.sessionKey ?? "",
      params.segmentId ?? "",
      params.entryDigest,
    ].join("\n"))
    .digest("hex")
    .slice(0, 12)}`;
}

function loadSessionMemoryReplacementPacket(path: string | undefined): SessionMemoryReplacementPacketLoadResult {
  if (!path) {
    return {
      ok: true,
      entries: [],
      digest: "none",
    };
  }
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    return {
      ok: false,
      error: `could not read replacements packet: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (raw.length > 64 * 1024) {
    return { ok: false, error: "replacements packet exceeds 65536 chars" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return {
      ok: false,
      error: `replacements packet is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const maybePacket = asRecord(parsed);
  const entries = Array.isArray(parsed)
    ? parsed
    : Array.isArray(maybePacket?.replacementEntries)
      ? maybePacket.replacementEntries
      : undefined;
  if (!entries) {
    return {
      ok: false,
      error: "replacements packet must be an array or an object with replacementEntries array",
    };
  }

  return {
    ok: true,
    path,
    entries: entries as SessionMemoryCarryForwardReplacementEntry[],
    digest: createHash("sha256").update(raw).digest("hex").slice(0, 16),
  };
}

function loadSessionMemoryAppendPacket(path: string | undefined): SessionMemoryAppendPacketLoadResult {
  if (!path) {
    return { ok: false, error: "`--entry` requires a JSON file path." };
  }
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    return {
      ok: false,
      error: `could not read entry packet: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (raw.length > 64 * 1024) {
    return { ok: false, error: "entry packet exceeds 65536 chars" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return {
      ok: false,
      error: `entry packet is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const maybePacket = asRecord(parsed);
  const entry = asRecord(maybePacket?.entry) ?? maybePacket;
  if (!entry) {
    return {
      ok: false,
      error: "entry packet must be an entry object or an object with an entry object",
    };
  }

  return {
    ok: true,
    path,
    entry: entry as SessionMemorySemanticEntryAppend,
    digest: createHash("sha256").update(raw).digest("hex").slice(0, 16),
  };
}

function parseDoctorCleanerApplyArgs(tokens: string[]):
  | { ok: true; filterId?: DoctorCleanerId; vacuum: boolean }
  | { ok: false; error: string } {
  let filterId: DoctorCleanerId | undefined;
  let vacuum = false;

  for (const token of tokens) {
    const normalized = token.toLowerCase();
    if (normalized === "vacuum") {
      vacuum = true;
      continue;
    }
    if (DOCTOR_CLEANER_IDS.has(normalized as DoctorCleanerId) && !filterId) {
      filterId = normalized as DoctorCleanerId;
      continue;
    }
    return {
      ok: false,
      error:
        `\`${VISIBLE_COMMAND} doctor clean apply\` accepts at most one filter id (\`${getDoctorCleanerFilterIds().join("`, `")}\`) plus optional \`vacuum\`.`,
    };
  }

  return { ok: true, filterId, vacuum };
}

function parseSessionMemorySchemaArgs(tokens: string[]):
  | { ok: true; command: SessionMemorySchemaCommand }
  | { ok: false; error: string } {
  if (tokens[0]?.toLowerCase() !== "schema") {
    return {
      ok: false,
      error: `\`${VISIBLE_COMMAND} session-memory\` currently supports \`schema plan|check|apply\`.`,
    };
  }
  const action = tokens[1]?.toLowerCase();
  if (action !== "plan" && action !== "check" && action !== "apply") {
    return {
      ok: false,
      error: `\`${VISIBLE_COMMAND} session-memory schema\` accepts \`plan\`, \`check\`, or \`apply\`.`,
    };
  }

  let dbPath: string | undefined;
  let execute = false;
  let confirm: string | undefined;
  let allowRealDb = false;
  const rest = tokens.slice(2);
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (token === "--db") {
      const value = rest[index + 1];
      if (!value) {
        return { ok: false, error: "`--db` requires a path." };
      }
      dbPath = value;
      index += 1;
      continue;
    }
    if (token === "--execute") {
      execute = true;
      continue;
    }
    if (token === "--dry-run") {
      execute = false;
      continue;
    }
    if (token === "--confirm") {
      const value = rest[index + 1];
      if (!value) {
        return { ok: false, error: "`--confirm` requires a token." };
      }
      confirm = value;
      index += 1;
      continue;
    }
    if (token === "--allow-real-db") {
      allowRealDb = true;
      continue;
    }
    return { ok: false, error: `Unknown session-memory schema option \`${token}\`.` };
  }

  if (action !== "apply" && (execute || confirm || allowRealDb)) {
    return {
      ok: false,
      error: "`--execute`, `--confirm`, and `--allow-real-db` are only valid for `session-memory schema apply`.",
    };
  }

  return {
    ok: true,
    command: {
      action,
      dbPath,
      execute: action === "apply" ? execute : false,
      confirm,
      allowRealDb,
    },
  };
}

function parseSessionMemoryCarryForwardArgs(tokens: string[]):
  | { ok: true; command: SessionMemoryCarryForwardCommand }
  | { ok: false; error: string } {
  let fromConversationId: number | undefined;
  let fromSessionKey: string | undefined;
  let dbPath: string | undefined;
  let execute = false;
  let confirm: string | undefined;
  let allowRealDb = false;
  let maxEntries: number | undefined;
  let replacementsPath: string | undefined;

  const rest = tokens.slice(1);
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (token === "--from") {
      const value = rest[index + 1];
      if (!value) {
        return { ok: false, error: "`--from` requires a conversation id." };
      }
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        return { ok: false, error: "`--from` must be a positive integer conversation id." };
      }
      fromConversationId = parsed;
      index += 1;
      continue;
    }
    if (token === "--from-session-key") {
      const value = rest[index + 1];
      if (!value) {
        return { ok: false, error: "`--from-session-key` requires a session key." };
      }
      fromSessionKey = value;
      index += 1;
      continue;
    }
    if (token === "--db") {
      const value = rest[index + 1];
      if (!value) {
        return { ok: false, error: "`--db` requires a path." };
      }
      dbPath = value;
      index += 1;
      continue;
    }
    if (token === "--max-entries") {
      const value = rest[index + 1];
      if (!value) {
        return { ok: false, error: "`--max-entries` requires a number." };
      }
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 1) {
        return { ok: false, error: "`--max-entries` must be a positive integer." };
      }
      maxEntries = parsed;
      index += 1;
      continue;
    }
    if (token === "--replacements") {
      const value = rest[index + 1];
      if (!value) {
        return { ok: false, error: "`--replacements` requires a JSON file path." };
      }
      replacementsPath = value;
      index += 1;
      continue;
    }
    if (token === "--execute") {
      execute = true;
      continue;
    }
    if (token === "--dry-run") {
      execute = false;
      continue;
    }
    if (token === "--confirm") {
      const value = rest[index + 1];
      if (!value) {
        return { ok: false, error: "`--confirm` requires a token." };
      }
      confirm = value;
      index += 1;
      continue;
    }
    if (token === "--allow-real-db") {
      allowRealDb = true;
      continue;
    }
    return { ok: false, error: `Unknown session-memory carry-forward option \`${token}\`.` };
  }

  if (!fromConversationId) {
    return { ok: false, error: "`/lossless session-memory carry-forward` requires `--from <conversation-id>`." };
  }

  return {
    ok: true,
    command: {
      sourceMode: "explicit",
      fromConversationId,
      fromSessionKey,
      dbPath,
      execute,
      confirm,
      allowRealDb,
      maxEntries,
      replacementsPath,
    },
  };
}

function parseSessionMemoryReattachArgs(tokens: string[]):
  | { ok: true; command: SessionMemoryCarryForwardCommand }
  | { ok: false; error: string } {
  let fromSessionKey: string | undefined;
  let toConversationId: number | undefined;
  let dbPath: string | undefined;
  let execute = false;
  let confirm: string | undefined;
  let allowRealDb = false;
  let maxEntries: number | undefined;
  let replacementsPath: string | undefined;

  const rest = tokens.slice(1);
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (token === "--from") {
      return {
        ok: false,
        error: "`/lossless session-memory reattach` resolves source by session key; use `carry-forward --from <conversation-id>` for explicit sources.",
      };
    }
    if (token === "--from-session-key") {
      const value = rest[index + 1];
      if (!value) {
        return { ok: false, error: "`--from-session-key` requires a session key." };
      }
      fromSessionKey = value;
      index += 1;
      continue;
    }
    if (token === "--to-conversation") {
      const parsed = parseConversationId(rest[index + 1], "--to-conversation");
      if (!parsed.ok) {
        return parsed;
      }
      toConversationId = parsed.conversationId;
      index += 1;
      continue;
    }
    if (token === "--db") {
      const value = rest[index + 1];
      if (!value) {
        return { ok: false, error: "`--db` requires a path." };
      }
      dbPath = value;
      index += 1;
      continue;
    }
    if (token === "--max-entries") {
      const value = rest[index + 1];
      if (!value) {
        return { ok: false, error: "`--max-entries` requires a number." };
      }
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 1) {
        return { ok: false, error: "`--max-entries` must be a positive integer." };
      }
      maxEntries = parsed;
      index += 1;
      continue;
    }
    if (token === "--replacements") {
      const value = rest[index + 1];
      if (!value) {
        return { ok: false, error: "`--replacements` requires a JSON file path." };
      }
      replacementsPath = value;
      index += 1;
      continue;
    }
    if (token === "--execute") {
      execute = true;
      continue;
    }
    if (token === "--dry-run") {
      execute = false;
      continue;
    }
    if (token === "--confirm") {
      const value = rest[index + 1];
      if (!value) {
        return { ok: false, error: "`--confirm` requires a token." };
      }
      confirm = value;
      index += 1;
      continue;
    }
    if (token === "--allow-real-db") {
      allowRealDb = true;
      continue;
    }
    return { ok: false, error: `Unknown session-memory reattach option \`${token}\`.` };
  }

  return {
    ok: true,
    command: {
      sourceMode: "same_session_key",
      fromSessionKey,
      toConversationId,
      dbPath,
      execute,
      confirm,
      allowRealDb,
      maxEntries,
      replacementsPath,
    },
  };
}

function parseSessionMemoryAppendReviewedArgs(tokens: string[]):
  | { ok: true; command: SessionMemoryAppendReviewedCommand }
  | { ok: false; error: string } {
  let entryPath: string | undefined;
  let dbPath: string | undefined;
  let segmentId: string | undefined;
  let toConversationId: number | undefined;
  let execute = false;
  let confirm: string | undefined;
  let allowRealDb = false;

  const rest = tokens.slice(1);
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (token === "--entry") {
      const value = rest[index + 1];
      if (!value) {
        return { ok: false, error: "`--entry` requires a JSON file path." };
      }
      entryPath = value;
      index += 1;
      continue;
    }
    if (token === "--db") {
      const value = rest[index + 1];
      if (!value) {
        return { ok: false, error: "`--db` requires a path." };
      }
      dbPath = value;
      index += 1;
      continue;
    }
    if (token === "--segment-id") {
      const value = rest[index + 1];
      if (!value) {
        return { ok: false, error: "`--segment-id` requires an id." };
      }
      segmentId = value;
      index += 1;
      continue;
    }
    if (token === "--to-conversation") {
      const parsed = parseConversationId(rest[index + 1], "--to-conversation");
      if (!parsed.ok) {
        return parsed;
      }
      toConversationId = parsed.conversationId;
      index += 1;
      continue;
    }
    if (token === "--execute") {
      execute = true;
      continue;
    }
    if (token === "--dry-run") {
      execute = false;
      continue;
    }
    if (token === "--confirm") {
      const value = rest[index + 1];
      if (!value) {
        return { ok: false, error: "`--confirm` requires a token." };
      }
      confirm = value;
      index += 1;
      continue;
    }
    if (token === "--allow-real-db") {
      allowRealDb = true;
      continue;
    }
    return { ok: false, error: `Unknown session-memory append-reviewed option \`${token}\`.` };
  }

  if (!entryPath) {
    return { ok: false, error: "`/lossless session-memory append-reviewed` requires `--entry <json>`." };
  }

  return {
    ok: true,
    command: {
      entryPath,
      dbPath,
      segmentId,
      toConversationId,
      execute,
      confirm,
      allowRealDb,
    },
  };
}

function parseSessionMemoryCaptureCandidatesArgs(tokens: string[]):
  | { ok: true; command: SessionMemoryCaptureCandidatesCommand }
  | { ok: false; error: string } {
  let conversationId: number | undefined;
  let limit = 24;

  const rest = tokens.slice(1);
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (token === "--conversation") {
      const parsed = parseConversationId(rest[index + 1], "--conversation");
      if (!parsed.ok) {
        return parsed;
      }
      conversationId = parsed.conversationId;
      index += 1;
      continue;
    }
    if (token === "--limit") {
      const value = rest[index + 1];
      if (!value) {
        return { ok: false, error: "`--limit` requires a number." };
      }
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) {
        return { ok: false, error: "`--limit` must be an integer from 1 to 100." };
      }
      limit = parsed;
      index += 1;
      continue;
    }
    return { ok: false, error: `Unknown session-memory capture-candidates option \`${token}\`.` };
  }

  return { ok: true, command: { conversationId, limit } };
}

function parseSessionMemoryArgs(tokens: string[]): ParsedLcmCommand {
  const action = tokens[0]?.toLowerCase();
  if (!action || action === "status") {
    return tokens.length <= 1
      ? { kind: "session_memory_mode", action: "status" }
      : { kind: "help", error: `\`${VISIBLE_COMMAND} session-memory status\` does not accept extra arguments.` };
  }
  if (action === "native" || action === "overlay-readonly" || action === "clear") {
    return tokens.length === 1
      ? { kind: "session_memory_mode", action }
      : { kind: "help", error: `\`${VISIBLE_COMMAND} session-memory ${action}\` does not accept extra arguments.` };
  }
  if (action === "profile") {
    const profileAction = tokens[1]?.toLowerCase();
    if (tokens.length !== 2 || (profileAction !== "grouped" && profileAction !== "compact" && profileAction !== "clear")) {
      return {
        kind: "help",
        error: `\`${VISIBLE_COMMAND} session-memory profile\` accepts \`grouped\`, \`compact\`, or \`clear\`.`,
      };
    }
    return { kind: "session_memory_profile", action: profileAction };
  }
  if (action === "schema") {
    const parsed = parseSessionMemorySchemaArgs(tokens);
    return parsed.ok
      ? { kind: "session_memory_schema", command: parsed.command }
      : { kind: "help", error: parsed.error };
  }
  if (action === "carry-forward") {
    const parsed = parseSessionMemoryCarryForwardArgs(tokens);
    return parsed.ok
      ? { kind: "session_memory_carry_forward", command: parsed.command }
      : { kind: "help", error: parsed.error };
  }
  if (action === "reattach") {
    const parsed = parseSessionMemoryReattachArgs(tokens);
    return parsed.ok
      ? { kind: "session_memory_carry_forward", command: parsed.command }
      : { kind: "help", error: parsed.error };
  }
  if (action === "append-reviewed") {
    const parsed = parseSessionMemoryAppendReviewedArgs(tokens);
    return parsed.ok
      ? { kind: "session_memory_append_reviewed", command: parsed.command }
      : { kind: "help", error: parsed.error };
  }
  if (action === "capture-candidates") {
    const parsed = parseSessionMemoryCaptureCandidatesArgs(tokens);
    return parsed.ok
      ? { kind: "session_memory_capture_candidates", command: parsed.command }
      : { kind: "help", error: parsed.error };
  }
  return {
    kind: "help",
    error: `\`${VISIBLE_COMMAND} session-memory\` supports \`status\`, \`native\`, \`overlay-readonly\`, \`clear\`, \`profile grouped|compact|clear\`, \`carry-forward\`, \`reattach\`, \`append-reviewed\`, \`capture-candidates\`, and \`schema plan|check|apply\`.`,
  };
}

function parseLcmCommand(rawArgs: string | undefined): ParsedLcmCommand {
  const raw = (rawArgs ?? "").trim();
  if (raw === "") {
    return { kind: "status" };
  }
  const focusMatch = raw.match(/^focus(?:\s+([\s\S]*))?$/i);
  if (focusMatch) {
    const prompt = focusMatch[1]?.trim() ?? "";
    return prompt ? { kind: "focus_generate", prompt } : { kind: "focus_status" };
  }
  if (/^refocus$/i.test(raw)) {
    return { kind: "refocus" };
  }
  if (/^unfocus$/i.test(raw)) {
    return { kind: "unfocus" };
  }

  const tokens = splitArgs(rawArgs);
  if (tokens.length === 0) {
    return { kind: "status" };
  }

  const [head, ...rest] = tokens;
  switch (head.toLowerCase()) {
    case "status":
      return rest.length === 0
        ? { kind: "status" }
        : { kind: "help", error: "`/lcm status` does not accept extra arguments." };
    case "backup":
      return rest.length === 0
        ? { kind: "backup" }
        : { kind: "help", error: "`/lcm backup` does not accept extra arguments." };
    case "rotate":
      return rest.length === 0
        ? { kind: "rotate" }
        : { kind: "help", error: "`/lcm rotate` does not accept extra arguments." };
    case "doctor":
      if (rest.length === 0) {
        return { kind: "doctor", apply: false };
      }
      if (rest.length === 1 && rest[0]?.toLowerCase() === "clean") {
        return { kind: "doctor_cleaners", apply: false, vacuum: false };
      }
      if (rest[0]?.toLowerCase() === "clean" && rest[1]?.toLowerCase() === "apply") {
        const parsedApply = parseDoctorCleanerApplyArgs(rest.slice(2));
        return parsedApply.ok
          ? {
              kind: "doctor_cleaners",
              apply: true,
              filterId: parsedApply.filterId,
              vacuum: parsedApply.vacuum,
            }
          : { kind: "help", error: parsedApply.error };
      }
      if (rest.length === 1 && rest[0]?.toLowerCase() === "apply") {
        return { kind: "doctor", apply: true };
      }
      return {
        kind: "help",
        error:
          `\`${VISIBLE_COMMAND} doctor\` accepts no arguments, \`clean\` for global high-confidence junk diagnostics, \`clean apply [filter-id] [vacuum]\` for cleanup, or \`apply\` for the scoped summary repair path.`,
      };
    case "session-memory": {
      return parseSessionMemoryArgs(rest);
    }
    case "help":
      return { kind: "help" };
    default:
      return {
        kind: "help",
        error: `Unknown subcommand \`${head}\`. Supported: status, focus, refocus, unfocus, backup, rotate, doctor, doctor clean, doctor apply, session-memory, session-memory schema, help.`,
      };
  }
}

function getLcmStatusStats(db: DatabaseSync): LcmStatusStats {
  const row = db
    .prepare(
      `SELECT
         COALESCE((SELECT COUNT(*) FROM conversations), 0) AS conversation_count,
         COALESCE(COUNT(*), 0) AS summary_count,
         COALESCE(SUM(token_count), 0) AS stored_summary_tokens,
         COALESCE(SUM(CASE WHEN kind = 'leaf' THEN source_message_token_count ELSE 0 END), 0) AS summarized_source_tokens,
         COALESCE(SUM(CASE WHEN kind = 'leaf' THEN 1 ELSE 0 END), 0) AS leaf_summary_count,
         COALESCE(SUM(CASE WHEN kind = 'condensed' THEN 1 ELSE 0 END), 0) AS condensed_summary_count
       FROM summaries`,
    )
    .get() as
    | {
        conversation_count: number;
        summary_count: number;
        stored_summary_tokens: number;
        summarized_source_tokens: number;
        leaf_summary_count: number;
        condensed_summary_count: number;
      }
    | undefined;

  return {
    conversationCount: row?.conversation_count ?? 0,
    summaryCount: row?.summary_count ?? 0,
    storedSummaryTokens: row?.stored_summary_tokens ?? 0,
    summarizedSourceTokens: row?.summarized_source_tokens ?? 0,
    leafSummaryCount: row?.leaf_summary_count ?? 0,
    condensedSummaryCount: row?.condensed_summary_count ?? 0,
  };
}

function getConversationStatusStats(
  db: DatabaseSync,
  conversationId: number,
): LcmConversationStatusStats | null {
  const row = db
    .prepare(
      `SELECT
         c.conversation_id,
         c.session_id,
         c.session_key,
         COALESCE((SELECT COUNT(*) FROM messages WHERE conversation_id = c.conversation_id), 0) AS message_count,
         COALESCE((SELECT COUNT(*) FROM summaries WHERE conversation_id = c.conversation_id), 0) AS summary_count,
         COALESCE((SELECT SUM(token_count) FROM summaries WHERE conversation_id = c.conversation_id), 0) AS stored_summary_tokens,
         COALESCE((SELECT SUM(CASE WHEN kind = 'leaf' THEN source_message_token_count ELSE 0 END) FROM summaries WHERE conversation_id = c.conversation_id), 0) AS summarized_source_tokens,
         COALESCE((
           SELECT SUM(token_count)
           FROM (
             SELECT m.token_count AS token_count
             FROM context_items ci
             JOIN messages m ON m.message_id = ci.message_id
             WHERE ci.conversation_id = c.conversation_id
               AND ci.item_type = 'message'
             UNION ALL
             SELECT s.token_count AS token_count
             FROM context_items ci
             JOIN summaries s ON s.summary_id = ci.summary_id
             WHERE ci.conversation_id = c.conversation_id
               AND ci.item_type = 'summary'
           ) context_token_rows
         ), 0) AS context_token_count,
         COALESCE((
           SELECT SUM(COALESCE(s.source_message_token_count, 0) + COALESCE(s.descendant_token_count, 0))
           FROM context_items ci
           JOIN summaries s ON s.summary_id = ci.summary_id
           WHERE ci.conversation_id = c.conversation_id
             AND ci.item_type = 'summary'
         ), 0) AS compressed_token_count,
         COALESCE((SELECT SUM(CASE WHEN kind = 'leaf' THEN 1 ELSE 0 END) FROM summaries WHERE conversation_id = c.conversation_id), 0) AS leaf_summary_count,
         COALESCE((SELECT SUM(CASE WHEN kind = 'condensed' THEN 1 ELSE 0 END) FROM summaries WHERE conversation_id = c.conversation_id), 0) AS condensed_summary_count
       FROM conversations c
       WHERE c.conversation_id = ?`,
    )
    .get(conversationId) as
    | {
        conversation_id: number;
        session_id: string;
        session_key: string | null;
        message_count: number;
        summary_count: number;
        stored_summary_tokens: number;
        summarized_source_tokens: number;
        context_token_count: number;
        compressed_token_count: number;
        leaf_summary_count: number;
        condensed_summary_count: number;
      }
    | undefined;

  if (!row) {
    return null;
  }

  return {
    conversationId: row.conversation_id,
    sessionId: row.session_id,
    sessionKey: row.session_key,
    messageCount: row.message_count,
    summaryCount: row.summary_count,
    storedSummaryTokens: row.stored_summary_tokens,
    summarizedSourceTokens: row.summarized_source_tokens,
    contextTokenCount: row.context_token_count,
    compressedTokenCount: row.compressed_token_count,
    leafSummaryCount: row.leaf_summary_count,
    condensedSummaryCount: row.condensed_summary_count,
  };
}

function normalizeIdentity(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function getConversationStatusBySessionKey(
  db: DatabaseSync,
  sessionKey: string,
): LcmConversationStatusStats | null {
  const row = db
    .prepare(
      `SELECT conversation_id
       FROM conversations
       WHERE session_key = ?
       ORDER BY active DESC, created_at DESC
       LIMIT 1`,
    )
    .get(sessionKey) as { conversation_id: number } | undefined;

  if (!row) {
    return null;
  }

  return getConversationStatusStats(db, row.conversation_id);
}

function getConversationStatusBySessionId(
  db: DatabaseSync,
  sessionId: string,
): LcmConversationStatusStats | null {
  const row = db
    .prepare(
      `SELECT conversation_id
       FROM conversations
       WHERE session_id = ?
       ORDER BY active DESC, created_at DESC
       LIMIT 1`,
    )
    .get(sessionId) as { conversation_id: number } | undefined;

  if (!row) {
    return null;
  }

  return getConversationStatusStats(db, row.conversation_id);
}

async function getConversationCompactionMaintenanceByConversationId(
  db: DatabaseSync,
  conversationId: number,
): Promise<ConversationCompactionMaintenanceRecord | null> {
  return await new CompactionMaintenanceStore(db).getConversationCompactionMaintenance(
    conversationId,
  );
}

async function getConversationCompactionTelemetryByConversationId(
  db: DatabaseSync,
  conversationId: number,
) {
  return await new CompactionTelemetryStore(db).getConversationCompactionTelemetry(conversationId);
}

async function resolveCurrentConversation(params: {
  ctx: PluginCommandContext;
  db: DatabaseSync;
}): Promise<CurrentConversationResolution> {
  const sessionKey = normalizeIdentity(params.ctx.sessionKey);
  const sessionId = normalizeIdentity(params.ctx.sessionId);

  if (sessionKey) {
    const bySessionKey = getConversationStatusBySessionKey(params.db, sessionKey);
    if (bySessionKey) {
      return { kind: "resolved", source: "session_key", stats: bySessionKey };
    }

    if (sessionId) {
      const bySessionId = getConversationStatusBySessionId(params.db, sessionId);
      if (bySessionId) {
        if (!bySessionId.sessionKey || bySessionId.sessionKey === sessionKey) {
          return {
            kind: "resolved",
            source: "session_key_via_session_id",
            stats: bySessionId,
          };
        }

        return {
          kind: "unavailable",
          reason: `Active session key ${formatCommand(sessionKey)} is not stored in LCM yet. Session id fallback found conversation #${formatNumber(bySessionId.conversationId)}, but it is bound to ${formatCommand(bySessionId.sessionKey)}, so Global stats are safer.`,
        };
      }
    }

    return {
      kind: "unavailable",
      reason: sessionId
        ? `No LCM conversation is stored yet for active session key ${formatCommand(sessionKey)} or active session id ${formatCommand(sessionId)}.`
        : `No LCM conversation is stored yet for active session key ${formatCommand(sessionKey)}.`,
    };
  }

  if (sessionId) {
    const bySessionId = getConversationStatusBySessionId(params.db, sessionId);
    if (bySessionId) {
      return { kind: "resolved", source: "session_id", stats: bySessionId };
    }

    return {
      kind: "unavailable",
      reason: `OpenClaw did not expose an active session key here. Tried active session id ${formatCommand(sessionId)}, but no stored LCM conversation matched it.`,
    };
  }

  return {
    kind: "unavailable",
    reason: "OpenClaw did not expose an active session key or session id here, so only GLOBAL stats are available.",
  };
}

async function resolveRuntimeSessionId(params: {
  ctx: PluginCommandContext;
  deps: LcmDependencies;
  current: Extract<CurrentConversationResolution, { kind: "resolved" }>;
}): Promise<string | undefined> {
  const directSessionId = normalizeIdentity(params.ctx.sessionId);
  if (directSessionId) {
    return directSessionId;
  }

  const sessionKey = normalizeIdentity(params.ctx.sessionKey);
  if (sessionKey) {
    const runtimeSessionId = normalizeIdentity(
      await params.deps.resolveSessionIdFromSessionKey(sessionKey),
    );
    if (runtimeSessionId) {
      return runtimeSessionId;
    }
  }

  return normalizeIdentity(params.current.stats.sessionId);
}

function resolveLifecycleCompactionTokenBudget(config: LcmConfig): number {
  return config.maxAssemblyTokenBudget && config.maxAssemblyTokenBudget > 0
    ? Math.floor(config.maxAssemblyTokenBudget)
    : 128_000;
}

// Run the cache-aware focus lifecycle sweep. Focus and unfocus both mutate the
// prompt prefix, so they explicitly take the manual full-sweep path and bypass
// threshold skips instead of leaving compaction to normal background policy.
async function runFocusLifecycleCompaction(params: {
  ctx: PluginCommandContext;
  deps?: LcmDependencies;
  getLcm?: () => Promise<LcmCommandEngine>;
  config: LcmConfig;
  current: Extract<CurrentConversationResolution, { kind: "resolved" }>;
  sessionKey?: string;
}): Promise<
  | { status: "ok"; sessionId: string; result: CompactResult }
  | { status: "unavailable" | "failed"; reason: string }
> {
  if (!params.deps || !params.getLcm) {
    return {
      status: "unavailable",
      reason: "Focus lifecycle compaction requires the runtime-backed LCM engine.",
    };
  }

  const sessionKey = params.sessionKey ?? normalizeIdentity(params.ctx.sessionKey);
  const sessionId = await resolveRuntimeSessionId({
    ctx: params.ctx,
    deps: params.deps,
    current: params.current,
  });
  if (!sessionId) {
    return {
      status: "unavailable",
      reason:
        "Lossless Claw resolved the active conversation, but OpenClaw did not expose or resolve a runtime session id for compaction.",
    };
  }

  const engine = await params.getLcm();
  if (typeof engine.compact !== "function") {
    return {
      status: "unavailable",
      reason: "The runtime-backed LCM engine does not expose compaction to commands.",
    };
  }

  let sessionFile = "";
  try {
    sessionFile =
      (await params.deps.resolveSessionTranscriptFile({
        sessionId,
        sessionKey,
      })) ?? "";
  } catch {
    sessionFile = "";
  }

  const tokenBudget = resolveLifecycleCompactionTokenBudget(params.config);
  try {
    const result = await engine.compact({
      sessionId,
      sessionKey,
      sessionFile,
      tokenBudget,
      currentTokenCount: params.current.stats.contextTokenCount,
      compactionTarget: "threshold",
      runtimeContext: {
        manualCompaction: true,
        tokenBudget,
        currentTokenCount: params.current.stats.contextTokenCount,
      },
      force: true,
    });
    return result.ok
      ? { status: "ok", sessionId, result }
      : {
          status: "failed",
          reason: result.reason ?? result.error ?? "focus lifecycle compaction failed",
        };
  } catch (error) {
    return { status: "failed", reason: formatFailureReason(error) };
  }
}

function resolvePluginEnabled(config: unknown): boolean {
  const root = asRecord(config);
  const plugins = asRecord(root?.plugins);
  const entries = asRecord(plugins?.entries);
  const entry = asRecord(entries?.["lossless-claw"]);
  if (typeof entry?.enabled === "boolean") {
    return entry.enabled;
  }
  return true;
}

function resolveContextEngineSlot(config: unknown): string {
  const root = asRecord(config);
  const plugins = asRecord(root?.plugins);
  const slots = asRecord(plugins?.slots);
  return typeof slots?.contextEngine === "string" ? slots.contextEngine.trim() : "";
}

function resolvePluginSelected(config: unknown): boolean {
  const slot = resolveContextEngineSlot(config);
  return slot === "" || slot === "lossless-claw";
}

function resolveDbSizeLabel(dbPath: string): string {
  if (typeof dbPath !== "string") return "unknown";
  const trimmed = dbPath.trim();
  if (!trimmed || trimmed === ":memory:" || trimmed.startsWith("file::memory:")) {
    return "in-memory";
  }
  try {
    return formatBytes(statSync(trimmed).size);
  } catch {
    return "missing";
  }
}

function buildHelpText(error?: string): string {
  const lines = [
    ...(error ? [`⚠️ ${error}`, ""] : []),
    ...buildHeaderLines(),
    "",
    buildSection("📘 Commands", [
      buildStatLine(formatCommand(VISIBLE_COMMAND), "Show compact status output."),
      buildStatLine(
        formatCommand(`${VISIBLE_COMMAND} status`),
        "Show plugin, Global, current-conversation, and compaction-maintenance status.",
      ),
      buildStatLine(
        formatCommand(`${VISIBLE_COMMAND} backup`),
        "Create a timestamped backup of the current LCM database.",
      ),
      buildStatLine(
        formatCommand(`${VISIBLE_COMMAND} rotate`),
        "Compact the current session transcript while preserving the same LCM conversation and live session identity.",
      ),
      buildStatLine(
        formatCommand(`${VISIBLE_COMMAND} focus <prompt>`),
        "Generate an active focus brief with a delegated recall sub-agent.",
      ),
      buildStatLine(
        formatCommand(`${VISIBLE_COMMAND} focus`),
        "Show the latest focus brief for the current conversation.",
      ),
      buildStatLine(
        formatCommand(`${VISIBLE_COMMAND} refocus`),
        "Refresh the active focus brief from post-focus summary deltas.",
      ),
      buildStatLine(
        formatCommand(`${VISIBLE_COMMAND} unfocus`),
        "Deactivate the active focus overlay without deleting focus history.",
      ),
      buildStatLine(formatCommand(`${VISIBLE_COMMAND} doctor`), "Scan for broken or truncated summaries."),
      buildStatLine(
        formatCommand(`${VISIBLE_COMMAND} doctor clean`),
        "Report global high-confidence junk candidates without deleting anything.",
      ),
      buildStatLine(
        formatCommand(`${VISIBLE_COMMAND} doctor clean apply`),
        "Delete approved high-confidence cleaner matches after creating a DB backup.",
      ),
      buildStatLine(formatCommand(`${VISIBLE_COMMAND} doctor apply`), "Repair broken summaries in the current conversation."),
      buildStatLine(
        formatCommand(`${VISIBLE_COMMAND} session-memory status|native|overlay-readonly|clear`),
        "Inspect or set the current session's volatile read-only session-memory overlay mode.",
      ),
      buildStatLine(
        formatCommand(`${VISIBLE_COMMAND} session-memory profile grouped|compact|clear`),
        "Set or clear the current session's volatile session-memory render profile override.",
      ),
      buildStatLine(
        formatCommand(`${VISIBLE_COMMAND} session-memory carry-forward --from <conversation-id> [--replacements <json>]`),
        "Dry-run or temp-DB execute reviewed seed carry-forward and explicit replacement facts.",
      ),
      buildStatLine(
        formatCommand(`${VISIBLE_COMMAND} session-memory reattach [--from-session-key <key>] [--to-conversation <id>]`),
        "Dry-run or temp-DB execute same-sessionKey fork reattach into the current or explicit target conversation.",
      ),
      buildStatLine(
        formatCommand(`${VISIBLE_COMMAND} session-memory append-reviewed --entry <json> [--to-conversation <id>]`),
        "Dry-run or temp-DB execute one reviewed semantic entry append.",
      ),
      buildStatLine(
        formatCommand(`${VISIBLE_COMMAND} session-memory capture-candidates [--conversation <id>] [--limit <n>]`),
        "Read recent LCM messages and report review-only session-memory capture candidates.",
      ),
      buildStatLine(
        formatCommand(`${VISIBLE_COMMAND} session-memory schema plan|check|apply`),
        "Plan or run gated session-memory schema maintenance.",
      ),
    ]),
    "",
    buildSection("🧭 Notes", [
      buildStatLine("subcommands", `Discover them with ${formatCommand(`${VISIBLE_COMMAND} help`)}.`),
      buildStatLine("alias", `${formatCommand(HIDDEN_ALIAS)} is accepted as a shorter alias.`),
      buildStatLine("current conversation", "Uses the active LCM session when the host exposes session identity."),
      buildStatLine("session-memory mode", "Session-local and in-memory only; it is not written to openclaw.json."),
      buildStatLine("session-memory profile", "Session-local and in-memory only; it is not written to openclaw.json."),
      buildStatLine("`/new`", "Prunes context for the current LCM conversation. It does not split storage."),
      buildStatLine("`/reset`", "Resets OpenClaw session flow. Use rotate when you only want transcript compaction."),
    ]),
  ];
  return lines.join("\n");
}

function buildDoctorCleanerExampleLine(params: {
  conversationId: number;
  sessionKey: string | null;
  messageCount: number;
  firstMessagePreview: string | null;
}): string {
  const sessionKey = params.sessionKey ? formatCommand(truncateMiddle(params.sessionKey, 44)) : "missing";
  const preview = params.firstMessagePreview ? ` · first: ${JSON.stringify(params.firstMessagePreview)}` : "";
  return `conv ${formatNumber(params.conversationId)} · session key ${sessionKey} · messages ${formatNumber(params.messageCount)}${preview}`;
}

async function buildStatusText(params: {
  ctx: PluginCommandContext;
  db: DatabaseSync;
  config: LcmConfig;
}): Promise<string> {
  const status = getLcmStatusStats(params.db);
  const doctor = getDoctorSummaryStats(params.db);
  const enabled = resolvePluginEnabled(params.ctx.config);
  const selected = resolvePluginSelected(params.ctx.config);
  const slot = resolveContextEngineSlot(params.ctx.config);
  const dbSize = resolveDbSizeLabel(params.config.databasePath);
  const current = await resolveCurrentConversation({
    ctx: params.ctx,
    db: params.db,
  });

  const lines = [
    ...buildHeaderLines(),
    "",
    buildSection("🧩 Plugin", [
      buildStatLine("enabled", formatBoolean(enabled)),
      buildStatLine("selected", `${formatBoolean(selected)}${slot ? ` (slot=${slot})` : " (slot=unset)"}`),
      buildStatLine("db path", params.config.databasePath),
      buildStatLine("db size", dbSize),
    ]),
    "",
    buildSection("🌐 Global", [
      buildStatLine("conversations", formatNumber(status.conversationCount)),
      buildStatLine(
        "summaries",
        `${formatNumber(status.summaryCount)} (${formatNumber(status.leafSummaryCount)} leaf, ${formatNumber(status.condensedSummaryCount)} condensed)`,
      ),
      buildStatLine("stored summary tokens", formatNumber(status.storedSummaryTokens)),
      buildStatLine("summarized source tokens", formatNumber(status.summarizedSourceTokens)),
    ]),
    "",
  ];

  if (current.kind === "resolved") {
    const conversationDoctor =
      doctor.byConversation.get(current.stats.conversationId) ?? {
        total: 0,
        old: 0,
        truncated: 0,
        fallback: 0,
      };
    const maintenance = await getConversationCompactionMaintenanceByConversationId(
      params.db,
      current.stats.conversationId,
    );
    const telemetry = await getConversationCompactionTelemetryByConversationId(
      params.db,
      current.stats.conversationId,
    );
    const sourceTelemetry = assemblySourceTelemetry.get(current.stats.conversationId);
    const focusLines = await buildFocusSummaryLines({
      store: new FocusBriefStore(params.db),
      conversationId: current.stats.conversationId,
      timezone: params.config.timezone,
    });
    const formatMaintenanceTime = (value: Date | null): string =>
      value ? formatTimestamp(value, params.config.timezone) : "never";
    lines.push(
      buildSection("📍 Current conversation", [
        buildStatLine("conversation id", formatNumber(current.stats.conversationId)),
        buildStatLine(
          "session key",
          current.stats.sessionKey ? formatCommand(truncateMiddle(current.stats.sessionKey, 44)) : "missing",
        ),
        buildStatLine("messages", formatNumber(current.stats.messageCount)),
        buildStatLine(
          "summaries",
          `${formatNumber(current.stats.summaryCount)} (${formatNumber(current.stats.leafSummaryCount)} leaf, ${formatNumber(current.stats.condensedSummaryCount)} condensed)`,
        ),
        buildStatLine("stored summary tokens", formatNumber(current.stats.storedSummaryTokens)),
        buildStatLine("summarized source tokens", formatNumber(current.stats.summarizedSourceTokens)),
        buildStatLine("tokens in context", formatNumber(current.stats.contextTokenCount)),
        buildStatLine(
          "compression ratio",
          formatCompressionRatio(current.stats.contextTokenCount, current.stats.compressedTokenCount),
        ),
        buildStatLine(
          "doctor",
          conversationDoctor.total > 0
            ? `${formatNumber(conversationDoctor.total)} issue(s) in this conversation`
            : "clean",
        ),
      ]),
    );
    lines.push("", buildSection("🎯 Focus", focusLines));
    lines.push(
      "",
      buildSection("📦 Assembly source", [
        buildStatLine("last selected", sourceTelemetry?.lastSelectedSource ?? "unknown"),
        buildStatLine("last reason", sourceTelemetry?.lastReason ?? "none"),
        buildStatLine(
          "counts",
          sourceTelemetry
            ? `raw_only=${formatNumber(sourceTelemetry.counters.raw_only)}, dag_summary=${formatNumber(sourceTelemetry.counters.dag_summary)}, focus_brief=${formatNumber(sourceTelemetry.counters.focus_brief)}`
            : "unobserved",
        ),
        buildStatLine(
          "skipped",
          sourceTelemetry ? formatAssemblySkippedReasons(sourceTelemetry.skippedReasons) : "none",
        ),
      ]),
    );
    lines.push(
      "",
      buildSection("🛠️ Maintenance", [
        buildStatLine(
          "state",
          maintenance?.pending
            ? "pending"
            : maintenance?.running
              ? "running"
              : "idle",
        ),
        buildStatLine("requested at", formatMaintenanceTime(maintenance?.requestedAt ?? null)),
        buildStatLine("reason", maintenance?.reason ?? "none"),
        buildStatLine("last started", formatMaintenanceTime(maintenance?.lastStartedAt ?? null)),
        buildStatLine("last finished", formatMaintenanceTime(maintenance?.lastFinishedAt ?? null)),
        buildStatLine("last failure", maintenance?.lastFailureSummary ?? "none"),
        buildStatLine(
          "requested token budget",
          maintenance?.tokenBudget != null ? formatNumber(maintenance.tokenBudget) : "unknown",
        ),
        buildStatLine(
          "observed token count",
          maintenance?.currentTokenCount != null ? formatNumber(maintenance.currentTokenCount) : "unknown",
        ),
        buildStatLine("last api call", formatMaintenanceTime(telemetry?.lastApiCallAt ?? null)),
        buildStatLine("last cache touch", formatMaintenanceTime(telemetry?.lastCacheTouchAt ?? null)),
        buildStatLine("cache retention", telemetry?.retention ?? "unknown"),
        buildStatLine("cache state", telemetry?.cacheState ?? "unknown"),
        buildStatLine("provider/model", [telemetry?.provider, telemetry?.model].filter(Boolean).join(" / ") || "unknown"),
      ]),
    );
  } else {
    lines.push(
      buildSection("📍 Current conversation", [
        buildStatLine("status", "unavailable"),
        buildStatLine("reason", current.reason),
        buildStatLine("fallback", "Showing Global stats only."),
      ]),
    );
  }

  return lines.join("\n");
}

function formatSessionMemoryModeStatus(status: SessionMemoryOverlaySessionStatus): string[] {
  return [
    buildStatLine("effective mode", status.effectiveMode),
    buildStatLine("override", status.overrideMode ?? "unset"),
    buildStatLine("kill switch", formatBoolean(status.killSwitchEnabled)),
    buildStatLine("render version", status.renderVersion),
    buildStatLine("render profile", status.renderProfile),
    buildStatLine("configured profile", status.configuredRenderProfile),
    buildStatLine("profile override", status.overrideRenderProfile ?? "unset"),
    buildStatLine("max tokens", formatNumber(status.maxTokens)),
    buildStatLine("db path", status.dbPath),
  ];
}

async function buildSessionMemoryModeText(params: {
  ctx: PluginCommandContext;
  db: DatabaseSync;
  getLcm?: () => Promise<LcmCommandEngine>;
  action: "status" | "clear" | SessionMemoryOverlayMode;
}): Promise<string> {
  const current = await resolveCurrentConversation({ ctx: params.ctx, db: params.db });
  const sessionId = normalizeIdentity(params.ctx.sessionId)
    ?? (current.kind === "resolved" ? normalizeIdentity(current.stats.sessionId) : undefined);
  const sessionKey = normalizeIdentity(params.ctx.sessionKey)
    ?? (current.kind === "resolved" ? normalizeIdentity(current.stats.sessionKey ?? undefined) : undefined);

  const lines = [
    ...buildHeaderLines(),
    "",
    "🧠 Session Memory",
    "",
  ];

  if (!sessionId && !sessionKey) {
    lines.push(
      buildSection("📍 Current session", [
        buildStatLine("status", "unavailable"),
        buildStatLine(
          "reason",
          current.kind === "unavailable"
            ? current.reason
            : "OpenClaw did not expose an active session id or session key.",
        ),
      ]),
    );
    return lines.join("\n");
  }

  lines.push(
    buildSection("📍 Current session", [
      buildStatLine("session id", sessionId ? formatCommand(truncateMiddle(sessionId, 44)) : "missing"),
      buildStatLine("session key", sessionKey ? formatCommand(truncateMiddle(sessionKey, 44)) : "missing"),
      buildStatLine("scope", "this runtime session only"),
      buildStatLine("persistence", "volatile; not written to openclaw.json"),
    ]),
    "",
  );

  if (!params.getLcm) {
    lines.push(
      buildSection("⚙️ Mode", [
        buildStatLine("status", "unavailable"),
        buildStatLine("reason", "The runtime-backed LCM engine is not available to commands."),
      ]),
    );
    return lines.join("\n");
  }

  const engine = await params.getLcm();
  if (
    typeof engine.getSessionMemoryOverlayMode !== "function" ||
    typeof engine.setSessionMemoryOverlayMode !== "function" ||
    typeof engine.clearSessionMemoryOverlayMode !== "function"
  ) {
    lines.push(
      buildSection("⚙️ Mode", [
        buildStatLine("status", "unavailable"),
        buildStatLine("reason", "The runtime-backed LCM engine does not expose session-memory mode controls."),
      ]),
    );
    return lines.join("\n");
  }

  const status = params.action === "clear"
    ? engine.clearSessionMemoryOverlayMode({ sessionId, sessionKey })
    : params.action === "status"
      ? engine.getSessionMemoryOverlayMode({ sessionId, sessionKey })
      : engine.setSessionMemoryOverlayMode({ sessionId, sessionKey, mode: params.action });
  const actionLabel = params.action === "status"
    ? "status"
    : params.action === "clear"
      ? "cleared"
      : "updated";
  lines.push(
    buildSection("⚙️ Mode", [
      buildStatLine("status", actionLabel),
      ...formatSessionMemoryModeStatus(status),
      buildStatLine(
        "contract",
        "Lossless consumes stable projection fields only; writer-owned schema quality can evolve independently.",
      ),
    ]),
  );
  if (status.killSwitchEnabled && params.action === "overlay-readonly") {
    lines.push(
      "",
      buildSection("⚠️ Kill switch", [
        buildStatLine("result", "overlay-readonly was recorded, but the env kill switch forces native mode"),
      ]),
    );
  }
  return lines.join("\n");
}

async function buildSessionMemoryProfileText(params: {
  ctx: PluginCommandContext;
  db: DatabaseSync;
  getLcm?: () => Promise<LcmCommandEngine>;
  action: "clear" | SessionMemoryOverlayRenderProfile;
}): Promise<string> {
  const current = await resolveCurrentConversation({ ctx: params.ctx, db: params.db });
  const sessionId = normalizeIdentity(params.ctx.sessionId)
    ?? (current.kind === "resolved" ? normalizeIdentity(current.stats.sessionId) : undefined);
  const sessionKey = normalizeIdentity(params.ctx.sessionKey)
    ?? (current.kind === "resolved" ? normalizeIdentity(current.stats.sessionKey ?? undefined) : undefined);

  const lines = [
    ...buildHeaderLines(),
    "",
    "🧠 Session Memory",
    "",
  ];

  if (!sessionId && !sessionKey) {
    lines.push(
      buildSection("📍 Current session", [
        buildStatLine("status", "unavailable"),
        buildStatLine(
          "reason",
          current.kind === "unavailable"
            ? current.reason
            : "OpenClaw did not expose an active session id or session key.",
        ),
      ]),
    );
    return lines.join("\n");
  }

  lines.push(
    buildSection("📍 Current session", [
      buildStatLine("session id", sessionId ? formatCommand(truncateMiddle(sessionId, 44)) : "missing"),
      buildStatLine("session key", sessionKey ? formatCommand(truncateMiddle(sessionKey, 44)) : "missing"),
      buildStatLine("scope", "this runtime session only"),
      buildStatLine("persistence", "volatile; not written to openclaw.json"),
    ]),
    "",
  );

  if (!params.getLcm) {
    lines.push(
      buildSection("🎛️ Render Profile", [
        buildStatLine("status", "unavailable"),
        buildStatLine("reason", "The runtime-backed LCM engine is not available to commands."),
      ]),
    );
    return lines.join("\n");
  }

  const engine = await params.getLcm();
  if (
    typeof engine.setSessionMemoryOverlayRenderProfile !== "function" ||
    typeof engine.clearSessionMemoryOverlayRenderProfile !== "function"
  ) {
    lines.push(
      buildSection("🎛️ Render Profile", [
        buildStatLine("status", "unavailable"),
        buildStatLine("reason", "The runtime-backed LCM engine does not expose session-memory profile controls."),
      ]),
    );
    return lines.join("\n");
  }

  const status = params.action === "clear"
    ? engine.clearSessionMemoryOverlayRenderProfile({ sessionId, sessionKey })
    : engine.setSessionMemoryOverlayRenderProfile({ sessionId, sessionKey, renderProfile: params.action });
  lines.push(
    buildSection("🎛️ Render Profile", [
      buildStatLine("status", params.action === "clear" ? "cleared" : "updated"),
      ...formatSessionMemoryModeStatus(status),
    ]),
  );
  return lines.join("\n");
}

async function buildSessionMemoryCarryForwardText(params: {
  ctx: PluginCommandContext;
  db: DatabaseSync;
  config: LcmConfig;
  command: SessionMemoryCarryForwardCommand;
}): Promise<string> {
  const current = await resolveCurrentConversation({
    ctx: params.ctx,
    db: params.db,
  });
  const dbPath = params.command.dbPath?.trim() || params.config.sessionMemoryOverlay.dbPath;
  const isReattach = params.command.sourceMode === "same_session_key";
  const lines = [
    ...buildHeaderLines(),
    "",
    isReattach ? "🧠 Session Memory Reattach" : "🧠 Session Memory Carry-Forward",
    "",
  ];

  if (current.kind === "unavailable") {
    lines.push(
      buildSection("📍 Target conversation", [
        buildStatLine("status", "unavailable"),
        buildStatLine("reason", current.reason),
      ]),
    );
    return lines.join("\n");
  }

  const targetStats = params.command.toConversationId != null
    ? getConversationStatusStats(params.db, params.command.toConversationId)
    : current.stats;

  if (!targetStats) {
    lines.push(
      buildSection("📍 Target conversation", [
        buildStatLine("status", "refused"),
        buildStatLine("reason", "target conversation not found"),
        buildStatLine("conversation id", formatNumber(params.command.toConversationId ?? 0)),
      ]),
    );
    return lines.join("\n");
  }

  let fromConversationId = params.command.fromConversationId;
  let resolvedSourceSessionKey = params.command.fromSessionKey;
  let sameSessionKeyCandidateCount: number | undefined;
  let sameSessionKeyActiveEntryCount: number | undefined;
  if (isReattach) {
    const source = resolveSameSessionKeyReattachSource({
      lcmDb: params.db,
      sessionMemoryDbPath: dbPath,
      currentConversationId: targetStats.conversationId,
      currentSessionKey: targetStats.sessionKey,
      requestedSessionKey: params.command.fromSessionKey,
    });
    if (!source.ok) {
      lines.push(
        buildSection("🧷 Source", [
          buildStatLine("source mode", "same-sessionKey reattach"),
          buildStatLine(
            "session key",
            source.sessionKey ? formatCommand(truncateMiddle(source.sessionKey, 44)) : "missing",
          ),
          ...(source.candidateCount != null
            ? [buildStatLine("same-sessionKey candidates", formatNumber(source.candidateCount))]
            : []),
          buildStatLine("status", "refused"),
          buildStatLine("reason", source.reason),
          ...(source.detail ? [buildStatLine("detail", source.detail)] : []),
        ]),
      );
      return lines.join("\n");
    }
    fromConversationId = source.conversationId;
    resolvedSourceSessionKey = source.sessionKey;
    sameSessionKeyCandidateCount = source.candidateCount;
    sameSessionKeyActiveEntryCount = source.activeEntryCount;
  }

  if (!fromConversationId) {
    lines.push(
      buildSection("🧷 Source", [
        buildStatLine("status", "refused"),
        buildStatLine("reason", "missing source conversation id"),
      ]),
    );
    return lines.join("\n");
  }

  const replacements = loadSessionMemoryReplacementPacket(params.command.replacementsPath);
  if (!replacements.ok) {
    lines.push(
      buildSection("🧩 Replacement packet", [
        buildStatLine("status", "invalid"),
        buildStatLine("reason", replacements.error),
      ]),
    );
    return lines.join("\n");
  }

  const confirmation = sessionMemoryCarryForwardConfirmationToken({
    dbPath,
    fromConversationId,
    toConversationId: targetStats.conversationId,
    sessionId: targetStats.sessionId,
    sessionKey: targetStats.sessionKey,
    replacementsDigest: replacements.digest,
  });
  const maxEntries = params.command.maxEntries ?? 12;

  lines.push(
    buildSection("📍 Target conversation", [
      buildStatLine("conversation id", formatNumber(targetStats.conversationId)),
      buildStatLine("target mode", params.command.toConversationId != null ? "explicit" : "current"),
      buildStatLine("session id", formatCommand(truncateMiddle(targetStats.sessionId, 44))),
      buildStatLine(
        "session key",
        targetStats.sessionKey ? formatCommand(truncateMiddle(targetStats.sessionKey, 44)) : "missing",
      ),
      ...(params.command.toConversationId != null
        ? [buildStatLine("current conversation id", formatNumber(current.stats.conversationId))]
        : []),
    ]),
    "",
    buildSection("🧷 Source", [
      buildStatLine("source mode", isReattach ? "same-sessionKey reattach" : "explicit conversation"),
      buildStatLine("conversation id", formatNumber(fromConversationId)),
      buildStatLine(
        "session key filter",
        resolvedSourceSessionKey ? formatCommand(truncateMiddle(resolvedSourceSessionKey, 44)) : "none",
      ),
      ...(sameSessionKeyCandidateCount != null
        ? [buildStatLine("same-sessionKey candidates", formatNumber(sameSessionKeyCandidateCount))]
        : []),
      ...(sameSessionKeyActiveEntryCount != null
        ? [buildStatLine("source active entries", formatNumber(sameSessionKeyActiveEntryCount))]
        : []),
      buildStatLine("max entries", formatNumber(maxEntries)),
    ]),
    "",
    buildSection("🧩 Replacement packet", [
      buildStatLine("path", replacements.path ?? "none"),
      buildStatLine("replacement entries", formatNumber(replacements.entries.length)),
      buildStatLine("digest", replacements.digest),
    ]),
    "",
    buildSection("💾 Write target", [
      buildStatLine("session-memory db", dbPath),
      buildStatLine("overlay enabled", params.config.sessionMemoryOverlay.enabled ? "yes" : "no"),
      buildStatLine("mode", params.command.execute ? "execute" : "dry_run"),
      buildStatLine("real DB execution", params.command.allowRealDb ? "allowed by explicit flag" : "blocked"),
      buildStatLine("execute confirmation", confirmation),
    ]),
  );

  if (!params.command.execute) {
    lines.push(
      "",
      buildSection("🛠️ Result", [
        buildStatLine("status", "dry_run"),
        buildStatLine(
          "next",
          `rerun with ${formatCommand("--execute")} ${formatCommand("--confirm")} ${confirmation}`,
        ),
      ]),
    );
    return lines.join("\n");
  }

  if (params.command.confirm !== confirmation) {
    lines.push(
      "",
      buildSection("🛠️ Result", [
        buildStatLine("status", "refused"),
        buildStatLine("reason", "confirmation token mismatch"),
      ]),
    );
    return lines.join("\n");
  }
  if (params.config.sessionMemoryOverlay.enabled) {
    lines.push(
      "",
      buildSection("🛠️ Result", [
        buildStatLine("status", "refused"),
        buildStatLine("reason", "session-memory overlay is enabled"),
      ]),
    );
    return lines.join("\n");
  }
  const isTempTarget = isTempPath(dbPath);
  if (!isTempTarget && !params.command.allowRealDb) {
    lines.push(
      "",
      buildSection("🛠️ Result", [
        buildStatLine("status", "refused"),
        buildStatLine("reason", "real DB carry-forward requires a separate approved backup gate"),
      ]),
    );
    return lines.join("\n");
  }
  if (!isTempTarget && params.command.allowRealDb && params.command.dbPath) {
    lines.push(
      "",
      buildSection("🛠️ Result", [
        buildStatLine("status", "refused"),
        buildStatLine("reason", "--allow-real-db uses the resolved session-memory DB path; omit --db"),
      ]),
    );
    return lines.join("\n");
  }

  const result = carryForwardSessionMemoryEntries({
    dbPath,
    lcmDbPath: params.config.databasePath,
    fromConversationId,
    fromSessionKey: resolvedSourceSessionKey,
    to: {
      sessionId: targetStats.sessionId,
      conversationId: targetStats.conversationId,
      sessionKey: targetStats.sessionKey ?? undefined,
    },
    maxEntries,
    replacementEntries: replacements.entries,
    allowRealDb: params.command.allowRealDb,
  });

  if (!result.ok) {
    lines.push(
      "",
      buildSection("🛠️ Result", [
        buildStatLine("status", result.status),
        buildStatLine("reason", result.reason),
        ...(result.detail ? [buildStatLine("detail", result.detail)] : []),
      ]),
    );
    return lines.join("\n");
  }

  lines.push(
    "",
    buildSection("🛠️ Result", [
      buildStatLine("status", result.status),
      buildStatLine("session id", formatCommand(truncateMiddle(result.sessionId, 44))),
      buildStatLine("segment id", formatCommand(truncateMiddle(result.segmentId, 44))),
      buildStatLine("entries carried", formatNumber(result.entryCount)),
      buildStatLine("entries skipped", formatNumber(result.skippedEntryIds.length)),
      buildStatLine("entries replaced", formatNumber(result.replacementEntryIds.length)),
      buildStatLine("links written", formatNumber(result.linkCount)),
      buildStatLine("updated at", result.updatedAt),
    ]),
  );
  return lines.join("\n");
}

async function buildSessionMemoryAppendReviewedText(params: {
  ctx: PluginCommandContext;
  db: DatabaseSync;
  config: LcmConfig;
  command: SessionMemoryAppendReviewedCommand;
}): Promise<string> {
  const current = await resolveCurrentConversation({
    ctx: params.ctx,
    db: params.db,
  });
  const dbPath = params.command.dbPath?.trim() || params.config.sessionMemoryOverlay.dbPath;
  const lines = [
    ...buildHeaderLines(),
    "",
    "🧠 Session Memory Reviewed Append",
    "",
  ];

  if (current.kind === "unavailable") {
    lines.push(
      buildSection("📍 Target conversation", [
        buildStatLine("status", "unavailable"),
        buildStatLine("reason", current.reason),
      ]),
    );
    return lines.join("\n");
  }
  const targetStats = params.command.toConversationId === undefined
    ? current.stats
    : getConversationStatusStats(params.db, params.command.toConversationId);
  if (!targetStats) {
    lines.push(
      buildSection("📍 Target conversation", [
        buildStatLine("status", "unavailable"),
        buildStatLine("target mode", "explicit"),
        buildStatLine("conversation id", formatNumber(params.command.toConversationId)),
        buildStatLine("reason", "conversation not found in LCM"),
      ]),
    );
    return lines.join("\n");
  }

  const packet = loadSessionMemoryAppendPacket(params.command.entryPath);
  if (!packet.ok) {
    lines.push(
      buildSection("🧩 Entry packet", [
        buildStatLine("status", "invalid"),
        buildStatLine("reason", packet.error),
      ]),
    );
    return lines.join("\n");
  }

  const confirmation = sessionMemoryAppendReviewedConfirmationToken({
    dbPath,
    conversationId: targetStats.conversationId,
    sessionId: targetStats.sessionId,
    sessionKey: targetStats.sessionKey,
    segmentId: params.command.segmentId,
    entryDigest: packet.digest,
  });

  lines.push(
    buildSection("📍 Target conversation", [
      buildStatLine("target mode", params.command.toConversationId === undefined ? "current" : "explicit"),
      buildStatLine("conversation id", formatNumber(targetStats.conversationId)),
      ...(params.command.toConversationId === undefined
        ? []
        : [buildStatLine("current conversation id", formatNumber(current.stats.conversationId))]),
      buildStatLine("session id", formatCommand(truncateMiddle(targetStats.sessionId, 44))),
      buildStatLine(
        "session key",
        targetStats.sessionKey ? formatCommand(truncateMiddle(targetStats.sessionKey, 44)) : "missing",
      ),
      buildStatLine("segment id", params.command.segmentId ? formatCommand(params.command.segmentId) : "active segment"),
    ]),
    "",
    buildSection("🧩 Entry packet", [
      buildStatLine("path", packet.path),
      buildStatLine("digest", packet.digest),
      buildStatLine("entry id", formatCommand(packet.entry.entryId ?? "missing")),
      buildStatLine("kind", String(packet.entry.kind ?? "missing")),
      buildStatLine("logical kind", String(packet.entry.logicalKind ?? "missing")),
      buildStatLine("project id", String(packet.entry.projectId ?? "missing")),
      buildStatLine("workline id", String(packet.entry.worklineId ?? "missing")),
      buildStatLine("review state", String(packet.entry.reviewState ?? "missing")),
      buildStatLine("evidence level", String(packet.entry.evidenceLevel ?? "missing")),
    ]),
    "",
    buildSection("💾 Write target", [
      buildStatLine("session-memory db", dbPath),
      buildStatLine("overlay enabled", params.config.sessionMemoryOverlay.enabled ? "yes" : "no"),
      buildStatLine("mode", params.command.execute ? "execute" : "dry_run"),
      buildStatLine("real DB execution", params.command.allowRealDb ? "allowed by explicit flag" : "blocked"),
      buildStatLine("execute confirmation", confirmation),
    ]),
  );

  if (!params.command.execute) {
    lines.push(
      "",
      buildSection("🛠️ Result", [
        buildStatLine("status", "dry_run"),
        buildStatLine(
          "next",
          `rerun with ${formatCommand("--execute")} ${formatCommand("--confirm")} ${confirmation}`,
        ),
      ]),
    );
    return lines.join("\n");
  }

  if (params.command.confirm !== confirmation) {
    lines.push(
      "",
      buildSection("🛠️ Result", [
        buildStatLine("status", "refused"),
        buildStatLine("reason", "confirmation token mismatch"),
      ]),
    );
    return lines.join("\n");
  }
  if (params.config.sessionMemoryOverlay.enabled) {
    lines.push(
      "",
      buildSection("🛠️ Result", [
        buildStatLine("status", "refused"),
        buildStatLine("reason", "session-memory overlay is enabled"),
      ]),
    );
    return lines.join("\n");
  }
  if (!isTempPath(dbPath) && !params.command.allowRealDb) {
    lines.push(
      "",
      buildSection("🛠️ Result", [
        buildStatLine("status", "refused"),
        buildStatLine("reason", "real DB append requires a separate approved backup gate"),
      ]),
    );
    return lines.join("\n");
  }
  if (params.command.allowRealDb && params.command.dbPath && !isTempPath(dbPath)) {
    lines.push(
      "",
      buildSection("🛠️ Result", [
        buildStatLine("status", "refused"),
        buildStatLine("reason", "--allow-real-db uses the resolved session-memory DB path; omit --db"),
      ]),
    );
    return lines.join("\n");
  }

  const result = appendReviewedSessionMemoryEntry({
    dbPath,
    lcmDbPath: params.config.databasePath,
    conversationId: targetStats.conversationId,
    sessionKey: targetStats.sessionKey ?? undefined,
    segmentId: params.command.segmentId,
    entry: packet.entry,
    allowRealDb: params.command.allowRealDb,
  });

  if (!result.ok) {
    lines.push(
      "",
      buildSection("🛠️ Result", [
        buildStatLine("status", result.status),
        buildStatLine("reason", result.reason),
        ...(result.detail ? [buildStatLine("detail", result.detail)] : []),
        ...(result.schemaReason ? [buildStatLine("schema reason", result.schemaReason)] : []),
      ]),
    );
    return lines.join("\n");
  }

  lines.push(
    "",
    buildSection("🛠️ Result", [
      buildStatLine("status", result.status),
      buildStatLine("session id", formatCommand(truncateMiddle(result.sessionId, 44))),
      buildStatLine("segment id", formatCommand(truncateMiddle(result.segmentId, 44))),
      buildStatLine("entry id", formatCommand(result.entryId)),
      buildStatLine("updated at", result.updatedAt),
    ]),
  );
  return lines.join("\n");
}

function includesAny(value: string, needles: string[]): boolean {
  return needles.some((needle) => value.includes(needle));
}

function looksLikeSessionMemoryCandidateReport(value: string): boolean {
  const normalized = value.toLowerCase();
  return (
    includesAny(normalized, ["lossless claw", "session memory candidate capture"]) &&
    includesAny(normalized, ["candidate summary", "candidate 1 -", "review result: candidate_only"]) &&
    includesAny(normalized, ["writes: none", "accepted memory: none"])
  );
}

function stripPastedSessionMemoryCandidateReport(value: string): string {
  if (!looksLikeSessionMemoryCandidateReport(value)) {
    return value;
  }
  const reportStartCandidates = [
    value.search(/\*\*[^*\n]*Lossless Claw/i),
    value.search(/🧠\s*Session Memory Candidate Capture/i),
  ].filter((index) => index >= 0);
  const reportStart = Math.min(...reportStartCandidates);
  if (!Number.isFinite(reportStart) || reportStart <= 0) {
    return "";
  }
  return value.slice(0, reportStart).trim();
}

function normalizeSessionMemoryCandidateClaim(value: string): string {
  return value
    .toLowerCase()
    .replace(/\b(user|assistant|confirmed|directed|requested)\b/g, "")
    .replace(/用户|助手/g, "")
    .replace(/[`*_~()[\]{}"'“”‘’]/g, "")
    .replace(/\s+/g, "")
    .trim();
}

function extractGateRefs(value: string): Array<{ gate: string; ordinal: number }> {
  const refs: Array<{ gate: string; ordinal: number }> = [];
  const pattern = /\bgate\s*(\d+)([a-z])\b/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(value)) !== null) {
    const number = Number.parseInt(match[1] ?? "", 10);
    const letter = (match[2] ?? "").toLowerCase();
    if (!Number.isFinite(number) || letter.length !== 1) {
      continue;
    }
    refs.push({
      gate: `gate${number}`,
      ordinal: number * 100 + letter.charCodeAt(0) - 96,
    });
  }
  return refs;
}

function looksLikeProcessContext(value: string): boolean {
  const normalized = value.toLowerCase();
  return (
    includesAny(normalized, ["startup.md", "current.md", "read startup", "re-read startup", "重读", "回读", "读 startup"]) ||
    (includesAny(normalized, ["ok 继续", "继续"]) && includesAny(normalized, ["startup", "current", "context", "上下文"]))
  );
}

function looksLikeCorrectionOrDowngrade(value: string): boolean {
  const normalized = value.toLowerCase();
  return (
    includesAny(normalized, ["纠正", "降回", "降级", "不要强行", "不能把", "不能升级", "先空着", "继续空着", "不再当", "不再作为"]) ||
    (includesAny(normalized, ["30s", "30 秒", "30秒", "3min", "3 分钟", "3分钟"]) &&
      includesAny(normalized, ["未确认", "不确认", "unsupported", "unconfirmed", "blank", "空着"]))
  );
}

function looksLikeSystemBoundaryCheck(value: string): boolean {
  const normalized = value.toLowerCase();
  return (
    includesAny(normalized, ["session-memory", "session memory", "active-memory", "active memory"]) &&
    includesAny(normalized, ["db", "数据库", "写入", "没写入", "没有写入", "没有接入", "边界", "真实状态", "健康", "integrity_check=ok"])
  );
}

function looksLikeLocalFlowApproval(value: string): boolean {
  const compact = value
    .toLowerCase()
    .replace(/[`*_~()[\]{}"'“”‘’。，、！？!?:：；;,.]/g, "")
    .replace(/\s+/g, "")
    .trim();
  if (!compact || compact.length > 24) {
    return false;
  }
  return (
    /^(ok|okay|好|好的|可以|可以吧|继续|继续吧|可以继续|可以继续吧|行|行吧|嗯|收到|go)$/.test(compact) ||
    /^(ok|okay|好|好的|可以|行|行吧)(先)?(开始|开始修|修|处理|继续|继续修)(他|它)?(吧)?$/.test(compact) ||
    /^(嗯|好|好的|可以|行|行吧)?(下一步)?(继续)?(优化|修|继续修)(吧)?$/.test(compact)
  );
}

function looksLikeTaskRequest(value: string): boolean {
  const normalized = value.toLowerCase();
  return (
    includesAny(normalized, ["总结", "canvas", "架构图", "检查", "查下", "看下", "修一下", "继续修", "帮我", "给我"]) &&
    includesAny(normalized, ["你", "我", "给", "帮", "检查", "修", "总结", "canvas", "架构图"])
  );
}

function looksLikeOpenQuestion(value: string): boolean {
  const normalized = value.toLowerCase();
  return (
    includesAny(normalized, ["是否", "能否", "能不能", "要不要", "怎么处理", "怎么办", "如何处理", "有没有必要", "是否有必要", "?"]) ||
    (includesAny(normalized, ["吗", "么"]) && includesAny(normalized, ["必要", "吸收", "处理", "解决", "分析"]))
  );
}

function looksLikeResearchDirection(value: string): boolean {
  const normalized = value.toLowerCase();
  return (
    includesAny(normalized, ["分析下", "分析一下", "拆解", "拆一版", "研究", "你先做", "先做", "先跑"]) &&
    includesAny(normalized, ["杀戮尖塔", "背包乱斗", "策略深度", "深度", "牌库", "机制", "类型", "steam", "评论关键词"])
  );
}

function looksLikeDesignFocus(value: string): boolean {
  const normalized = value.toLowerCase();
  return (
    includesAny(normalized, ["情绪焦点", "牌库污染", "开场技能", "收场技能", "行动力", "反应力", "技能槽", "职责冲突"]) &&
    includesAny(normalized, ["翻译成", "逐项", "拆", "加一个", "应该", "重点", "焦点"])
  );
}

function formatSessionMemoryCaptureSource(candidate: SessionMemoryCaptureCandidate): string {
  return `${candidate.sourceKind} ${formatCommand(candidate.sourceRef)}`;
}

function reviewSessionMemoryCaptureCandidates(
  candidates: SessionMemoryCaptureCandidate[],
  probe: SessionMemoryCurrentStateProbe = { latestCompleted: [], nextAction: [], newestEvidence: [] },
): ReviewedSessionMemoryCaptureCandidate[] {
  const strongestByClaim = new Map<string, SessionMemoryCaptureCandidate>();
  const maxGateOrdinalByGate = new Map<string, number>();
  const latestSteamPhaseRank = Math.max(0, ...probe.latestCompleted.map((signal) => getSteamScreeningPhaseRank(signal)));
  const completedCandidates = candidates.filter((candidate) =>
    candidate.kind === "verified_result" || candidate.kind === "completed_state"
  );

  for (const candidate of candidates) {
    const claimKey = normalizeSessionMemoryCandidateClaim(candidate.claim);
    const current = strongestByClaim.get(claimKey);
    if (!current || getSessionMemoryCaptureCandidateRank(candidate) > getSessionMemoryCaptureCandidateRank(current)) {
      strongestByClaim.set(claimKey, candidate);
    }
    for (const ref of extractGateRefs(candidate.claim)) {
      maxGateOrdinalByGate.set(ref.gate, Math.max(maxGateOrdinalByGate.get(ref.gate) ?? 0, ref.ordinal));
    }
  }

  return candidates.map((candidate) => {
    const claimKey = normalizeSessionMemoryCandidateClaim(candidate.claim);
    const strongest = strongestByClaim.get(claimKey);

    if (looksLikeLocalFlowApproval(candidate.claim)) {
      return {
        ...candidate,
        reviewBucket: "local_flow",
        reviewNote: "Short local approval/continuation signal; not durable memory.",
      };
    }

    if (candidate.kind === "task_request") {
      return {
        ...candidate,
        reviewBucket: "evidence_only",
        reviewNote: "Task request is local flow unless a completed result later confirms durable state.",
      };
    }

    if (strongest && strongest !== candidate) {
      return {
        ...candidate,
        reviewBucket: "duplicate",
        reviewNote: `Duplicate of stronger ${formatSessionMemoryCaptureSource(strongest)}.`,
      };
    }

    const staleGate = extractGateRefs(candidate.claim).find((ref) => ref.ordinal < (maxGateOrdinalByGate.get(ref.gate) ?? ref.ordinal));
    if (staleGate) {
      return {
        ...candidate,
        reviewBucket: "stale_superseded",
        reviewNote: `${staleGate.gate.toUpperCase()} has a newer gate state in the scan window.`,
      };
    }

    if (probe.latestCompleted.length > 0 && candidate.sourceKind === "summary" && looksLikeSupersededHistoricalPhase(candidate.claim)) {
      return {
        ...candidate,
        reviewBucket: "stale_superseded",
        reviewNote: "Older implementation phase is superseded by newer completed-state evidence in the scan window.",
      };
    }

    const candidateSteamPhaseRank = getSteamScreeningPhaseRank(candidate.claim);
    if (latestSteamPhaseRank > 0 && candidateSteamPhaseRank > 0 && candidateSteamPhaseRank < latestSteamPhaseRank) {
      return {
        ...candidate,
        reviewBucket: "stale_superseded",
        reviewNote: "Older Steam screening phase is superseded by a later completed category sheet.",
      };
    }

    if (completedCandidates.some((completed) => completed !== candidate && currentStateCompletionSupersedes(completed, candidate))) {
      return {
        ...candidate,
        reviewBucket: "stale_superseded",
        reviewNote: "Older next-step/progress claim is superseded by a later completed result in the same workline.",
      };
    }

    const resolvingCompleted = candidate.kind === "open_question"
      ? completedCandidates.find((completed) => completed !== candidate && currentStateCompletionResolvesQuestion(completed, candidate))
      : undefined;
    if (resolvingCompleted) {
      return {
        ...candidate,
        reviewBucket: "resolved_question",
        reviewNote: `Open question resolved by later completed_state ${formatSessionMemoryCaptureSource(resolvingCompleted)}.`,
      };
    }

    if (candidate.kind === "open_question") {
      return {
        ...candidate,
        reviewBucket: "open_question",
        reviewNote: "Open question; keep visible for review but do not treat as a decision.",
      };
    }

    if (looksLikeProcessContext(candidate.claim) || looksLikeSessionMemoryToolingMeta(candidate.claim)) {
      return {
        ...candidate,
        reviewBucket: "evidence_only",
        reviewNote: "Process/tooling context is evidence, not a durable session-memory candidate.",
      };
    }

    if (candidate.sourceKind === "summary" && candidate.claim.length > 160) {
      return {
        ...candidate,
        reviewBucket: "evidence_only",
        reviewNote: "LCM summary claim should be compressed before review.",
      };
    }

    return {
      ...candidate,
      reviewBucket: "promotable",
      reviewNote: "Concise enough for human review; still candidate-only.",
    };
  });
}

function looksLikeSupersededHistoricalPhase(value: string): boolean {
  const normalized = value.toLowerCase();
  return includesAny(normalized, [
    "first batch",
    "first-batch",
    "第一批",
    "10 samples",
    "10个样本",
    "v2 field",
    "v2字段",
    "storage",
    "安装包容量",
    "tag map",
    "标签地图",
    "template",
    "模板",
  ]);
}

function compareReviewedSessionMemoryCaptureCandidates(
  left: ReviewedSessionMemoryCaptureCandidate,
  right: ReviewedSessionMemoryCaptureCandidate,
): number {
  const bucketRank: Record<SessionMemoryCaptureReviewBucket, number> = {
    promotable: 400,
    open_question: 350,
    evidence_only: 300,
    duplicate: 200,
    local_flow: 150,
    stale_superseded: 100,
  };
  const bucketDelta = bucketRank[right.reviewBucket] - bucketRank[left.reviewBucket];
  if (bucketDelta !== 0) {
    return bucketDelta;
  }
  return compareSessionMemoryCaptureCandidates(left, right);
}

function collectCurrentStateSignals(values: string[]): string[] {
  const signals = new Set<string>();
  for (const value of values) {
    const normalized = stripLcmExpansionDetails(value).replace(/\s+/g, " ");
    if (
      !includesAny(normalized.toLowerCase(), ["commit", "提交", "写入", "落盘", "已抓取", "summary", "transcript", "canvas"]) &&
      !/\b[0-9a-f]{7,40}\b/i.test(normalized) &&
      !/\b(?:Friday-memory|memory|self-improving)\//.test(normalized)
    ) {
      continue;
    }
    for (const match of normalized.matchAll(/\b[0-9a-f]{7,40}\b/g)) {
      signals.add(match[0]!);
    }
    for (const match of normalized.matchAll(/\b(?:Friday-memory|memory|self-improving)\/[^\s`，。)）]+/g)) {
      const pathSignal = normalizeCurrentStatePathSignal(match[0]!);
      if (pathSignal && isUsefulCurrentStatePathSignal(pathSignal)) {
        signals.add(pathSignal);
      }
    }
    for (const match of normalized.matchAll(/\b(?:Friday-memory|memory|self-improving)\/[^`，。)）;；]+?\.(?:md|canvas|json|txt|xlsx|csv)\b/g)) {
      const pathSignal = normalizeCurrentStatePathSignal(match[0]!);
      if (pathSignal && isUsefulCurrentStatePathSignal(pathSignal)) {
        signals.add(pathSignal);
      }
    }
  }
  const allSignals = [...signals].sort();
  return allSignals.filter((signal) =>
    !allSignals.some((other) =>
      other !== signal &&
      other.startsWith(signal) &&
      (signal.startsWith("Friday-memory/") || signal.startsWith("memory/") || signal.startsWith("self-improving/"))
    )
  );
}

function normalizeCurrentStatePathSignal(value: string): string {
  const trimmed = value.replace(/[,.，。;；:：]+$/g, "");
  try {
    return decodeURIComponent(trimmed);
  } catch {
    return trimmed;
  }
}

function isUsefulCurrentStatePathSignal(value: string): boolean {
  if (value.startsWith("memory/")) {
    return false;
  }
  if (value.includes("/.dreams/") || value.includes(".dreams/")) {
    return false;
  }
  if (/(?:^|\/)[0-9]{4}-[0-9]{2}-[0-9]{2}-lcm-summaries\.md$/i.test(value)) {
    return false;
  }
  if (value === "self-improving/memory.md" || value === "self-improving/memory.md内容") {
    return false;
  }
  return true;
}

function stripLcmExpansionDetails(value: string): string {
  return value.replace(/(?:\n|\s)Expand for details about:.*$/s, "").trim();
}

function collectCurrentStateProbe(items: Array<{ content: string; createdAt: string; sourceKind?: "message" | "summary" }>): SessionMemoryCurrentStateProbe {
  const latestCompletedCandidates: SessionMemoryCurrentStateProbeCandidate[] = [];
  const nextActionCandidates: SessionMemoryCurrentStateProbeCandidate[] = [];
  const currentStateEvidenceTexts: string[] = [];
  const sortedItems = items
    .filter((item) => !looksLikeSessionMemoryCandidateReport(item.content))
    .slice()
    .sort((left, right) => compareTimestampDesc(left.createdAt, right.createdAt));

  for (const item of sortedItems) {
    const compactContent = stripLcmExpansionDetails(item.content).replace(/\s+/g, " ").trim();
    if (!compactContent) {
      continue;
    }
    const normalized = compactContent.toLowerCase();
    if (looksLikeCurrentStateMetaDiscussion(compactContent)) {
      continue;
    }
    const completedScore = scoreCurrentStateCompleted(compactContent);
    if (completedScore > 0) {
      latestCompletedCandidates.push({
        text: compactContent,
        createdAt: item.createdAt,
        sourceKind: item.sourceKind,
        score: completedScore,
      });
    }
    const nextActionScore = scoreCurrentStateNextAction(compactContent);
    if (nextActionScore > 0) {
      nextActionCandidates.push({
        text: compactContent,
        createdAt: item.createdAt,
        sourceKind: item.sourceKind,
        score: nextActionScore,
      });
    }
  }

  const filteredCompletedCandidates = filterSupersededCurrentStateProbeCandidates(latestCompletedCandidates);
  const latestCompletedPhaseRank = Math.max(
    0,
    ...filteredCompletedCandidates.map((candidate) => completedWorklinePhaseRank(candidate.text)),
  );
  const supportingRecentCompletedCandidates = latestCompletedCandidates.filter((candidate) => {
    if (candidate.sourceKind !== "message") {
      return false;
    }
    const rank = completedWorklinePhaseRank(candidate.text);
    return latestCompletedPhaseRank > 0 && rank > 0 && rank >= latestCompletedPhaseRank - 1;
  });
  const filteredNextActionCandidates = filterSupersededCurrentStateProbeCandidates(
    nextActionCandidates.filter((candidate) =>
      !filteredCompletedCandidates.some((completed) => completed.text === candidate.text),
    ),
    filteredCompletedCandidates,
  );
  const latestCompleted = selectCurrentStateProbeTexts(filteredCompletedCandidates);
  const nextAction = selectCurrentStateProbeTexts(filteredNextActionCandidates);
  currentStateEvidenceTexts.push(
    ...filteredCompletedCandidates.map((candidate) => candidate.text),
    ...supportingRecentCompletedCandidates.map((candidate) => candidate.text),
    ...filteredNextActionCandidates.map((candidate) => candidate.text),
  );

  return {
    latestCompleted,
    nextAction,
    newestEvidence: collectCurrentStateSignals(currentStateEvidenceTexts).slice(0, 12),
  };
}

function filterSupersededCurrentStateProbeCandidates(
  candidates: SessionMemoryCurrentStateProbeCandidate[],
  completedCandidates: SessionMemoryCurrentStateProbeCandidate[] = candidates,
): SessionMemoryCurrentStateProbeCandidate[] {
  return candidates.filter(
    (candidate) =>
      !completedCandidates.some(
        (completed) =>
          completed !== candidate &&
          (compareTimestampDesc(completed.createdAt, candidate.createdAt) <= 0 ||
            (candidate.sourceKind === "summary" && currentStateCompletionTextSupersedes(completed.text, candidate.text))) &&
          currentStateCompletionTextSupersedes(completed.text, candidate.text),
      ),
  );
}

function selectCurrentStateProbeTexts(candidates: SessionMemoryCurrentStateProbeCandidate[]): string[] {
  const seen = new Set<string>();
  const selected: string[] = [];
  const latestSteamPhaseRank = Math.max(0, ...candidates.map((candidate) => getSteamScreeningPhaseRank(candidate.text)));
  for (const candidate of candidates.slice().sort(compareCurrentStateProbeCandidates)) {
    const steamPhaseRank = getSteamScreeningPhaseRank(candidate.text);
    if (latestSteamPhaseRank > 0 && steamPhaseRank > 0 && steamPhaseRank < latestSteamPhaseRank) {
      continue;
    }
    const key = normalizeSessionMemoryCandidateClaim(candidate.text);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    selected.push(truncateMiddle(candidate.text, 180));
    if (selected.length >= 3) {
      break;
    }
  }
  return selected;
}

function compareCurrentStateProbeCandidates(
  left: SessionMemoryCurrentStateProbeCandidate,
  right: SessionMemoryCurrentStateProbeCandidate,
): number {
  const scoreDelta = right.score - left.score;
  if (scoreDelta !== 0) {
    return scoreDelta;
  }
  return compareTimestampDesc(left.createdAt, right.createdAt);
}

function scoreCurrentStateCompleted(value: string): number {
  const normalized = value.toLowerCase();
  if (looksLikeSessionMemoryToolingMeta(value) || looksLikeIncompleteOrBlockedProgress(value)) {
    return 0;
  }
  let score = 0;
  score += scoreSteamScreeningPhase(value);
  if (includesAny(normalized, ["抓完", "已继续抓", "已完成", "completed"])) {
    score += 80;
  }
  if (includesAny(normalized, ["新增", "写入", "提交", "推送", "created", "wrote", "generated", "pushed", "modified"])) {
    score += 40;
  }
  if (includesAny(normalized, ["sheet", "精选", "xlsx", "excel", "workbook", "first-batch-screening"])) {
    score += 80;
  }
  if (includesAny(normalized, ["刷宝", "steam-indie-category-research", "独游", "游戏深拆", "五条精选", "候选"])) {
    score += 40;
  }
  if (includesAny(normalized, ["代号2-godot", "code name 2", "canvas", "obsidian canvas", "架构图", "项目里", "项目内"])) {
    score += 80;
  }
  if (
    includesAny(normalized, ["demo", "运行场景", "runtime scene", "战前双方阵容", "战前阵容", "skillprogrammingscreen", "prebattlelineupscreen", "battlescreen"]) &&
    includesAny(normalized, ["canvas", "提交", "推送", "pushed", "验证", "写回", "新增"])
  ) {
    score += 140;
  }
  if (includesAny(normalized, ["验证", "没有缺失文件", "孤儿边", "节点", "边"])) {
    score += 40;
  }
  if (includesAny(normalized, ["深拆报告", "deep-dive report", "deep-dive-report", "detailed report", "证据表", "evidence table"])) {
    score += 60;
  }
  if (includesAny(normalized, ["steam-review-keyword-analysis", "review keyword analysis", "评论关键词", "review keyword"])) {
    score += 80;
  }
  if (
    (looksLikeCorrectionOrDowngrade(value) || looksLikeSystemBoundaryCheck(value)) &&
    includesAny(normalized, ["查完", "结论", "改动", "已提交", "提交推送", "提交并推送", "已推送", "pushed"])
  ) {
    score += 120;
  }
  if (includesAny(normalized, ["files: modified", "files:"])) {
    score -= 20;
  }
  return score >= 100 ? score : 0;
}

function looksLikeIncompleteOrBlockedProgress(value: string): boolean {
  const normalized = value.toLowerCase();
  return includesAny(normalized, [
    "not yet created",
    "not started",
    "no new files written",
    "files: none",
    "failed",
    "blocked",
    "未开始",
    "未创建",
    "未写入",
    "未执行",
    "没有写入",
    "无文件",
    "失败",
    "阻塞",
  ]);
}

function scoreCurrentStateNextAction(value: string): number {
  const normalized = value.toLowerCase();
  if (looksLikeSessionMemoryToolingMeta(value)) {
    return 0;
  }
  let score = 0;
  if (includesAny(normalized, ["下一步适合", "next action", "转入深拆", "开始深拆", "适合开始深拆"])) {
    score += 180;
  } else if (includesAny(normalized, ["下一步", "转入"])) {
    score += 100;
  }
  if (
    includesAny(normalized, ["草稿", "ui 草图", "ui草图", "界面草图", "第一屏", "场景 ui", "场景ui"]) &&
    includesAny(normalized, ["demo", "godot", "场景", "界面", "ui", "有空", "出一版", "整理"])
  ) {
    score += 160;
  }
  if (
    includesAny(normalized, ["战前双方阵容", "战前阵容", "技能编程", "战斗回放", "运行场景"]) &&
    includesAny(normalized, ["下一步", "草稿", "确认", "整理", "组件清单", "godot 场景拆分", "godot场景拆分"])
  ) {
    score += 140;
  }
  if (includesAny(normalized, ["游戏", "steam", "刷宝", "精选", "候选", "目录", "独游"])) {
    score += 40;
  }
  if (includesAny(normalized, ["继续"]) && includesAny(normalized, ["工作", "研究", "目录", "深拆", "抓"])) {
    score += 30;
  }
  return score >= 100 ? score : 0;
}

function scoreSteamScreeningPhase(value: string): number {
  const normalized = value.toLowerCase();
  let score = 0;
  if (
    includesAny(normalized, ["刷宝装备精选", "add loot equipment screening sheet"]) ||
    (includesAny(normalized, ["刷宝 / loot", "loot / arpg"]) &&
      includesAny(normalized, ["抓完", "新增", "完成", "completed"]) &&
      !looksLikeFutureSteamCategoryReference(normalized))
  ) {
    score += 500;
  }
  if (includesAny(normalized, ["自走棋库存精选", "auto battler/inventory", "add auto battler inventory screening sheet"])) {
    score += 300;
  }
  if (includesAny(normalized, ["rpg精选", "rpg build screening"])) {
    score += 220;
  }
  if (includesAny(normalized, ["棋牌精选", "card deckbuilding"])) {
    score += 180;
  }
  if (includesAny(normalized, ["战棋精选", "tactics screening"])) {
    score += 160;
  }
  if (includesAny(normalized, ["五条精选", "刷宝装备精选"]) && includesAny(normalized, ["战棋精选", "棋牌精选", "rpg精选", "自走棋库存精选"])) {
    score += 260;
  }
  if (includesAny(normalized, ["字段调整建议", "用户要求在新版字段", "玩法结构", "心理与情绪", "游戏本体大小"])) {
    score -= 180;
  }
  return score;
}

function getSteamScreeningPhaseRank(value: string): number {
  const normalized = value.toLowerCase();
  if (
    includesAny(normalized, ["刷宝装备精选", "add loot equipment screening sheet"]) ||
    (includesAny(normalized, ["刷宝 / loot", "loot / arpg"]) &&
      includesAny(normalized, ["抓完", "新增", "完成", "completed"]) &&
      !looksLikeFutureSteamCategoryReference(normalized))
  ) {
    return 5;
  }
  if (includesAny(normalized, ["自走棋库存精选", "auto battler/inventory", "add auto battler inventory screening sheet"])) {
    return 4;
  }
  if (includesAny(normalized, ["rpg精选", "rpg build screening"])) {
    return 3;
  }
  if (includesAny(normalized, ["棋牌精选", "card deckbuilding"])) {
    return 2;
  }
  if (includesAny(normalized, ["战棋精选", "tactics screening"])) {
    return 1;
  }
  return 0;
}

function looksLikeFutureSteamCategoryReference(normalizedValue: string): boolean {
  return includesAny(normalizedValue, [
    "next category",
    "current next category",
    "remaining category",
    "next directory",
    "下一类",
    "下一条",
    "下一路线",
    "剩余类别",
    "剩余目录",
  ]);
}

function currentStateCompletionSupersedes(
  completed: SessionMemoryCaptureCandidate,
  candidate: SessionMemoryCaptureCandidate,
): boolean {
  return (
    isSameTimeOrLaterCandidate(completed, candidate) &&
    currentStateCompletionTextSupersedes(completed.claim, candidate.claim)
  );
}

function currentStateCompletionResolvesQuestion(
  completed: SessionMemoryCaptureCandidate,
  question: SessionMemoryCaptureCandidate,
): boolean {
  return (
    isSameTimeOrLaterCandidate(completed, question) &&
    looksLikeFinalWorklineCompletion(completed.claim) &&
    sharesResolvedQuestionAnchor(completed.claim, question.claim)
  );
}

function currentStateCompletionTextSupersedes(completedValue: string, candidateValue: string): boolean {
  if (looksLikeFutureSlayDeepDiveNextAction(candidateValue)) {
    return false;
  }
  return (
    looksLikeFinalWorklineCompletion(completedValue) &&
    looksLikeSupersededProgressOrNextStep(candidateValue) &&
    sharesCurrentWorklineAnchor(completedValue, candidateValue) &&
    completedWorklinePhaseRank(completedValue) >= candidateWorklinePhaseRank(candidateValue)
  );
}

function sharesResolvedQuestionAnchor(completedValue: string, questionValue: string): boolean {
  const completed = completedValue.toLowerCase();
  const question = questionValue.toLowerCase();
  const anchorGroups = [
    ["默认索敌", "默认攻击", "默认原则", "默认"],
    ["目标", "双目标", "多目标", "打两个", "另一发", "补位", "补"],
    ["条件", "满足", "条件命中"],
    ["号位", "前排", "后排", "2号位", "3号位", "6号位", "456"],
    ["代号2-godot", "code name 2", "职业大分类"],
  ];
  const sharedGroups = anchorGroups.filter(
    (group) => group.some((anchor) => completed.includes(anchor)) && group.some((anchor) => question.includes(anchor)),
  );
  return sharedGroups.length >= 2;
}

function looksLikeFinalWorklineCompletion(value: string): boolean {
  const normalized = value.toLowerCase();
  return (
    includesAny(normalized, ["完成", "completed", "已按", "commit", "提交", "pushed", "推送", "修好了", "归进"]) &&
    includesAny(normalized, [
      "报告",
      "report",
      "deep-dive",
      "deep dive",
      "证据表",
      "evidence table",
      "代号2-godot",
      "canvas",
      "架构图",
      "项目",
    ])
  );
}

function looksLikeSupersededProgressOrNextStep(value: string): boolean {
  const normalized = value.toLowerCase();
  return includesAny(normalized, [
    "下一步",
    "next action",
    "下一步适合",
    "先做",
    "先跑",
    "证据表",
    "evidence table",
    "评论关键词",
    "review keyword",
    "抓完字幕",
    "subtitle sources",
    "subtitle",
    "已建目录",
    "选下一个游戏",
    "已总结",
    "架构图",
    "逻辑图",
    "canvas",
    "归进",
    "代号2-godot",
    "项目",
  ]);
}

function sharesCurrentWorklineAnchor(leftValue: string, rightValue: string): boolean {
  const left = leftValue.toLowerCase();
  const right = rightValue.toLowerCase();
  const codeNameAnchors = ["代号2-godot", "code name 2", "code name 2 godot"];
  const codeNameRoleAnchors = [
    "卫兵",
    "游侠",
    "重盾兵",
    "后排法师",
    "高阶法师",
    "盗贼",
    "术士",
    "盾击",
    "2v2",
    "3v2",
    "3v3",
    "站位变体",
    "默认索敌",
    "最近原则",
    "运行场景",
    "战前阵容",
    "技能编程",
    "战斗回放",
  ];
  if (
    (codeNameAnchors.some((anchor) => left.includes(anchor)) && codeNameRoleAnchors.some((anchor) => right.includes(anchor))) ||
    (codeNameAnchors.some((anchor) => right.includes(anchor)) && codeNameRoleAnchors.some((anchor) => left.includes(anchor)))
  ) {
    return true;
  }
  const anchorGroups = [
    ["slay-the-spire", "slay the spire", "杀戮尖塔"],
    ["steam-indie-category-research", "steam deep dive", "steam 深拆"],
    ["代号2-godot", "code name 2", "code name 2 godot"],
    codeNameRoleAnchors,
  ];
  if (anchorGroups.some((group) => group.some((anchor) => left.includes(anchor)) && group.some((anchor) => right.includes(anchor)))) {
    return true;
  }
  const anchors = [
    "slay-the-spire",
    "slay the spire",
    "杀戮尖塔",
    "steam-indie-category-research",
    "steam deep dive",
    "steam 深拆",
    "代号2-godot",
    "code name 2",
  ];
  return anchors.some((anchor) => left.includes(anchor) && right.includes(anchor));
}

function isSameTimeOrLaterCandidate(completed: SessionMemoryCaptureCandidate, candidate: SessionMemoryCaptureCandidate): boolean {
  const timestampDelta = compareTimestampDesc(completed.createdAt, candidate.createdAt);
  if (timestampDelta < 0) {
    return true;
  }
  if (timestampDelta > 0) {
    return false;
  }
  const completedSeq = parseMessageSourceRef(completed.sourceRef);
  const candidateSeq = parseMessageSourceRef(candidate.sourceRef);
  return completedSeq !== null && candidateSeq !== null && completedSeq > candidateSeq;
}

function parseMessageSourceRef(value: string): number | null {
  const match = /^#([0-9,]+)$/.exec(value);
  if (!match) {
    return null;
  }
  const parsed = Number.parseInt((match[1] ?? "").replace(/,/g, ""), 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function completedWorklinePhaseRank(value: string): number {
  return Math.max(1, candidateWorklinePhaseRank(value));
}

function candidateWorklinePhaseRank(value: string): number {
  const normalized = value.toLowerCase();
  if (includesAny(normalized, ["实况", "gameplay", "30 秒", "30秒", "3 分钟", "3分钟", "设计转译", "策略探索型小队"])) {
    return 4;
  }
  if (includesAny(normalized, ["steam-review-keyword-analysis", "review keyword", "评论关键词", "1e56c29"])) {
    return 3;
  }
  if (includesAny(normalized, ["b313653", "fix code name 2 canvas links", "孤儿边", "没有缺失文件", "相对路径"])) {
    return 3;
  }
  if (includesAny(normalized, ["b6a6926", "record code name 2 demo runtime scenes", "运行场景", "prebattlelineupscreen", "skillprogrammingscreen", "battlescreen", "战前阵容布局"])) {
    return 6;
  }
  if (includesAny(normalized, ["1173b49", "record code name 2 default targeting principle", "默认索敌", "最近原则"])) {
    return 5;
  }
  if (includesAny(normalized, ["60ed1ae", "split code name 2 demo planning canvases", "4 张专门 canvas", "四张专门 canvas"])) {
    return 4;
  }
  if (includesAny(normalized, ["9a778cb", "add code name 2 battle programming canvas", "战斗逻辑与技能编程.canvas"])) {
    return 3;
  }
  if (includesAny(normalized, ["af9a8fc", "add code name 2 demo scope spec", "demo v0.1 范围与表现规格"])) {
    return 2;
  }
  if (includesAny(normalized, ["f6c7321", "move source materials", "正式归进", "steam-indie-category-research 和 unicorn-overlord"])) {
    return 2;
  }
  if (includesAny(normalized, ["deep-dive report", "deep-dive-report", "深拆报告", "第一版深拆", "1b29114"])) {
    return 2;
  }
  if (includesAny(normalized, ["e2d1b54", "add code name 2 godot design notes", "html/svg", "逻辑图"])) {
    return 1;
  }
  if (includesAny(normalized, ["subtitle sources", "抓完字幕", "字幕证据表", "497e105"])) {
    return 1;
  }
  return 0;
}

function looksLikeFutureSlayDeepDiveNextAction(value: string): boolean {
  const normalized = value.toLowerCase();
  return (
    includesAny(normalized, ["slay-the-spire", "杀戮尖塔", "steam-indie-category-research"]) &&
    includesAny(normalized, ["实况", "gameplay", "30 秒", "30秒", "3 分钟", "3分钟", "设计转译", "策略探索型小队"])
  );
}

function looksLikeCurrentStateMetaDiscussion(value: string): boolean {
  const normalized = value.toLowerCase();
  return looksLikeSessionMemoryToolingMeta(value) || includesAny(normalized, [
    "superpower start",
    "我的想法",
    "有。方案",
    "方案别大改",
    "成功标准",
    "这刀如果过了",
    "candidate-only 现在证明",
    "不是“从摘要里捞候选”",
    "让 `capture-candidates`",
    "这次结果还是有问题",
    "修复没覆盖真实后续形态",
    "已补第二刀",
    "suppress capture report meta",
    "还没完全修好",
    "live 版还不稳",
    "stale next_action",
  ]);
}

function looksLikeSessionMemoryToolingMeta(value: string): boolean {
  const normalized = value.toLowerCase();
  const mentionsSessionMemoryTooling = includesAny(normalized, [
    "lossless-claw",
    "lossless claw",
    "/lossless",
    "capture-candidates",
    "current state probe",
    "session-memory",
    "session memory",
    "candidate-only",
    "next_action:",
    "latest_completed:",
    "newest_evidence:",
    "promotable:",
    "evidence_only:",
    "没有写 db",
    "没写 db",
    "report 美观",
  ]);
  if (!mentionsSessionMemoryTooling) {
    return false;
  }
  return includesAny(normalized, [
    "dry_run_report",
    "vitest",
    "focused tests",
    "focused vitest",
    "git diff --check",
    "review buckets",
    "review bucket",
    "审查",
    "读取",
    "查看",
    "测试",
    "报告层",
    "不碰 db",
    "自动写入",
    "overlay",
    "live 验证",
    "重启生效",
    "重启/重载",
    "reload",
    "candidate-only",
    "accepted memory",
    "不能自动写入",
    "不该自动",
    "修正",
    "验证",
  ]);
}

function compareTimestampDesc(left: string, right: string): number {
  const leftMs = Date.parse(left.includes("T") ? left : `${left.replace(" ", "T")}Z`);
  const rightMs = Date.parse(right.includes("T") ? right : `${right.replace(" ", "T")}Z`);
  if (Number.isFinite(leftMs) && Number.isFinite(rightMs) && leftMs !== rightMs) {
    return rightMs - leftMs;
  }
  return right.localeCompare(left);
}

function findMissedCurrentStateSignals(params: {
  signals: string[];
  emittedCandidates: SessionMemoryCaptureCandidate[];
}): string[] {
  return params.signals
    .filter((signal) => isUsefulCurrentStateSignal(signal))
    .filter((signal) => !params.emittedCandidates.some((candidate) => candidateCoversCurrentStateSignal(candidate, signal)))
    .slice(0, 12);
}

function candidateCoversCurrentStateSignal(candidate: SessionMemoryCaptureCandidate, signal: string): boolean {
  return candidate.claim.includes(signal) || (candidate.evidenceSignals ?? []).includes(signal);
}

function isUsefulCurrentStateSignal(signal: string): boolean {
  if (/^\d{6,}$/.test(signal) && !/^[0-9a-f]{7,40}$/i.test(signal)) {
    return false;
  }
  return !/[,.，。;；:"”)]$/.test(signal);
}

function classifySessionMemoryCaptureCandidate(params: {
  sourceKind: "message" | "summary";
  sourceRef: string;
  role: string;
  content: string;
  createdAt: string;
}): SessionMemoryCaptureCandidate | null {
  const content = stripPastedSessionMemoryCandidateReport(params.content).trim();
  if (!content || content.startsWith("You are a memory search agent.")) {
    return null;
  }
  const normalized = content.toLowerCase();
  const claim = truncateMiddle(content.replace(/\s+/g, " "), 220);
  const evidenceSignals = collectCurrentStateSignals([content]);
  const userAuthoredSignal =
    params.role === "user" ||
    (params.sourceKind === "summary" &&
      includesAny(normalized, ["user ", "user confirmed", "user directed", "user requested", "用户", "头儿"]));

  if (params.role === "assistant" || params.sourceKind === "summary") {
    if (looksLikeCorrectionOrDowngrade(content)) {
      return {
        kind: "correction",
        source: params.sourceKind === "summary" ? "lcm_summary" : "friday_review",
        sourceKind: params.sourceKind,
        sourceRef: params.sourceRef,
        role: params.role,
        createdAt: params.createdAt,
        claim,
        evidenceSignals,
        why: "Content records a correction or downgrade of an earlier claim.",
        confidence: "medium",
        riskIfWrong: "A corrected conclusion may be re-promoted later as if it were still valid.",
        suggestedDestination: "Friday review",
      };
    }

    if (looksLikeSystemBoundaryCheck(content)) {
      return {
        kind: "system_boundary",
        source: params.sourceKind === "summary" ? "lcm_summary" : "friday_review",
        sourceKind: params.sourceKind,
        sourceRef: params.sourceRef,
        role: params.role,
        createdAt: params.createdAt,
        claim,
        evidenceSignals,
        why: "Content records a checked runtime or memory-system boundary.",
        confidence: "medium",
        riskIfWrong: "A runtime boundary may be misstated in later handoffs.",
        suggestedDestination: "Friday review",
      };
    }
  }

  if (looksLikeProcessContext(content)) {
    return {
      kind: "workline_shift",
      source: params.sourceKind === "summary" ? "lcm_summary" : "friday_review",
      sourceKind: params.sourceKind,
      sourceRef: params.sourceRef,
      role: params.role,
      createdAt: params.createdAt,
      claim,
      evidenceSignals,
      why: "Content records orientation or startup-reading context.",
      confidence: "medium",
      riskIfWrong: "A process step may be mistaken for the active workline.",
      suggestedDestination: "Evidence only; do not promote without a concrete current-state claim.",
    };
  }

  if (userAuthoredSignal) {
    if (looksLikeLocalFlowApproval(content)) {
      return {
        kind: "task_request",
        source: params.sourceKind === "summary" ? "lcm_summary" : "user_decision",
        sourceKind: params.sourceKind,
        sourceRef: params.sourceRef,
        role: params.role,
        createdAt: params.createdAt,
        claim,
        evidenceSignals,
        why: "User gives a short local approval or continuation cue.",
        confidence: "medium",
        riskIfWrong: "A local approval may be mistaken for a durable decision.",
        suggestedDestination: "Evidence only; local flow.",
      };
    }

    if (includesAny(normalized, ["不要", "不能", "别", "不需要", "不优先", "必须", "更重要", "优先", "未经", "批准", "明确", "我没说过", "没说过这话", "错误归因"])) {
      return {
        kind: "constraint_boundary",
        source: params.sourceKind === "summary" ? "lcm_summary" : "user_decision",
        sourceKind: params.sourceKind,
        sourceRef: params.sourceRef,
        role: params.role,
        createdAt: params.createdAt,
        claim,
        evidenceSignals,
        why: "User states a boundary, priority, or exclusion that can affect future behavior.",
        confidence: "high",
        riskIfWrong: "A future answer may violate the user's stated boundary or over-prioritize the wrong axis.",
        suggestedDestination: "Friday session-memory candidate or instruction review",
      };
    }

    if (looksLikeTaskRequest(content)) {
      return {
        kind: "task_request",
        source: params.sourceKind === "summary" ? "lcm_summary" : "user_decision",
        sourceKind: params.sourceKind,
        sourceRef: params.sourceRef,
        role: params.role,
        createdAt: params.createdAt,
        claim,
        evidenceSignals,
        why: "User asks for a local action or artifact, not a durable decision.",
        confidence: "medium",
        riskIfWrong: "A task request may be mistaken for a lasting project decision.",
        suggestedDestination: "Evidence only; track result separately if completed.",
      };
    }

    if (looksLikeDesignFocus(content)) {
      return {
        kind: "design_focus",
        source: params.sourceKind === "summary" ? "lcm_summary" : "user_decision",
        sourceKind: params.sourceKind,
        sourceRef: params.sourceRef,
        role: params.role,
        createdAt: params.createdAt,
        claim,
        evidenceSignals,
        why: "User states or refines the current design focus.",
        confidence: "high",
        riskIfWrong: "The next design handoff may emphasize the wrong system pressure.",
        suggestedDestination: "Friday session-memory candidate",
      };
    }

    if (looksLikeResearchDirection(content)) {
      return {
        kind: "research_direction",
        source: params.sourceKind === "summary" ? "lcm_summary" : "user_decision",
        sourceKind: params.sourceKind,
        sourceRef: params.sourceRef,
        role: params.role,
        createdAt: params.createdAt,
        claim,
        evidenceSignals,
        why: "User points the discussion toward an analysis or research direction.",
        confidence: "medium",
        riskIfWrong: "A research direction may be preserved as a settled design decision.",
        suggestedDestination: "Friday review",
      };
    }

    if (looksLikeOpenQuestion(content)) {
      return {
        kind: "open_question",
        source: params.sourceKind === "summary" ? "lcm_summary" : "user_decision",
        sourceKind: params.sourceKind,
        sourceRef: params.sourceRef,
        role: params.role,
        createdAt: params.createdAt,
        claim,
        evidenceSignals,
        why: "User raises an unresolved question rather than making a decision.",
        confidence: "medium",
        riskIfWrong: "An open design question may be incorrectly promoted as a decision.",
        suggestedDestination: "Friday review as unresolved question",
      };
    }

    const looksLikeWorklineShift =
      includesAny(normalized, ["接下来", "之后", "继续", "切换", "转到", "开始", "新方向", "主线", "工作线", "研究"]) &&
      includesAny(normalized, ["session memory", "session-memory", "独立游戏", "steam", "品类", "方向", "工作", "研究"]);
    if (looksLikeWorklineShift) {
      return {
        kind: "workline_shift",
        source: params.sourceKind === "summary" ? "lcm_summary" : "user_decision",
        sourceKind: params.sourceKind,
        sourceRef: params.sourceRef,
        role: params.role,
        createdAt: params.createdAt,
        claim,
        evidenceSignals,
        why: "User appears to move or restate the current workline.",
        confidence: "high",
        riskIfWrong: "The active seed may stay on the previous workline and miss the new objective.",
        suggestedDestination: "Friday session-memory candidate",
      };
    }

    if (includesAny(normalized, ["决定", "确认", "同意", "批准", "落盘", "记下", "当前采用", "先按这个"])) {
      return {
        kind: "decision",
        source: params.sourceKind === "summary" ? "lcm_summary" : "user_decision",
        sourceKind: params.sourceKind,
        sourceRef: params.sourceRef,
        role: params.role,
        createdAt: params.createdAt,
        claim,
        evidenceSignals,
        why: "User appears to make or approve a decision.",
        confidence: "medium",
        riskIfWrong: "A tentative or local choice may be treated as durable without review.",
        suggestedDestination: "Friday review",
      };
    }

    if (includesAny(normalized, ["下一步", "先做", "先跑", "继续做", "开始做", "你先做"])) {
      return {
        kind: "next_action",
        source: params.sourceKind === "summary" ? "lcm_summary" : "user_decision",
        sourceKind: params.sourceKind,
        sourceRef: params.sourceRef,
        role: params.role,
        createdAt: params.createdAt,
        claim,
        evidenceSignals,
        why: "User appears to set or refine the next action.",
        confidence: "medium",
        riskIfWrong: "The next handoff may point at stale work.",
        suggestedDestination: "Friday session-memory candidate or CURRENT.md",
      };
    }
  }

  if (
    (params.role === "assistant" || params.sourceKind === "summary") &&
    includesAny(normalized, [
      "status: written",
      "integrity ok",
      "integrity_check=ok",
      "通过",
      "完成",
      "completed",
      "executed",
      "commit",
      "pushed",
      "已推送",
      "提交",
      "已抓取",
    ])
  ) {
    return {
      kind: "completed_state",
      source: "friday_review",
      sourceKind: params.sourceKind,
      sourceRef: params.sourceRef,
      role: params.role,
      createdAt: params.createdAt,
      claim,
      evidenceSignals,
      why: "Assistant reports a concrete completed state or commit that may need review.",
      confidence: "medium",
      riskIfWrong: "An unverified status claim may be preserved as fact.",
      suggestedDestination: "Friday review",
    };
  }

  return null;
}

function getSessionMemoryCaptureCandidateRank(candidate: SessionMemoryCaptureCandidate): number {
  const kindRank: Record<SessionMemoryCaptureCandidate["kind"], number> = {
    decision: 500,
    design_focus: 490,
    constraint_boundary: 480,
    system_boundary: 470,
    workline_shift: 460,
    correction: 455,
    research_direction: 440,
    next_action: 430,
    open_question: 260,
    task_request: 180,
    completed_state: 120,
    verified_result: 120,
  };
  const sourceRank: Record<SessionMemoryCaptureCandidate["source"], number> = {
    user_decision: 300,
    lcm_summary: 220,
    command_result: 120,
    friday_review: 0,
  };
  const confidenceRank = candidate.confidence === "high" ? 50 : 0;
  return kindRank[candidate.kind] + sourceRank[candidate.source] + confidenceRank;
}

function compareSessionMemoryCaptureCandidates(
  left: SessionMemoryCaptureCandidate,
  right: SessionMemoryCaptureCandidate,
): number {
  const rankDelta = getSessionMemoryCaptureCandidateRank(right) - getSessionMemoryCaptureCandidateRank(left);
  if (rankDelta !== 0) {
    return rankDelta;
  }
  return right.createdAt.localeCompare(left.createdAt);
}

async function buildSessionMemoryCaptureCandidatesText(params: {
  ctx: PluginCommandContext;
  db: DatabaseSync;
  command: SessionMemoryCaptureCandidatesCommand;
}): Promise<string> {
  const current = await resolveCurrentConversation({
    ctx: params.ctx,
    db: params.db,
  });
  const lines = [
    ...buildHeaderLines(),
    "",
    "🧠 Session Memory Candidate Capture",
    "",
  ];

  if (current.kind === "unavailable" && params.command.conversationId === undefined) {
    lines.push(
      buildSection("📍 Target conversation", [
        buildStatLine("status", "unavailable"),
        buildStatLine("reason", current.reason),
      ]),
    );
    return lines.join("\n");
  }

  const targetStats = params.command.conversationId === undefined
    ? (current.kind === "resolved" ? current.stats : null)
    : getConversationStatusStats(params.db, params.command.conversationId);
  if (!targetStats) {
    lines.push(
      buildSection("📍 Target conversation", [
        buildStatLine("status", "unavailable"),
        buildStatLine("target mode", "explicit"),
        buildStatLine("conversation id", formatNumber(params.command.conversationId ?? 0)),
        buildStatLine("reason", "conversation not found in LCM"),
      ]),
    );
    return lines.join("\n");
  }

  const rows = params.db
    .prepare(
      `SELECT seq, role, content, created_at
       FROM messages
       WHERE conversation_id = ?
         AND role IN ('user', 'assistant')
       ORDER BY seq DESC
       LIMIT ?`,
    )
    .all(targetStats.conversationId, params.command.limit) as Array<{
      seq: number;
      role: string;
      content: string;
      created_at: string;
    }>;

  const summaryRows = params.db
    .prepare(
      `SELECT summary_id, kind, content, COALESCE(latest_at, created_at) AS created_at
       FROM summaries
       WHERE conversation_id = ?
       ORDER BY COALESCE(latest_at, created_at) DESC, created_at DESC
       LIMIT ?`,
    )
    .all(targetStats.conversationId, params.command.limit) as Array<{
      summary_id: string;
      kind: string;
      content: string;
      created_at: string;
    }>;

  const scannedContents = [
    ...rows.map((row) => row.content),
    ...summaryRows.map((row) => row.content),
  ];
  const currentStateProbe = collectCurrentStateProbe([
    ...rows.map((row) => ({ content: row.content, createdAt: row.created_at, sourceKind: "message" as const })),
    ...summaryRows.map((row) => ({ content: row.content, createdAt: row.created_at, sourceKind: "summary" as const })),
  ]);
  const messageCandidates = rows
    .slice()
    .reverse()
    .map((row) =>
      classifySessionMemoryCaptureCandidate({
        sourceKind: "message",
        sourceRef: `#${formatNumber(row.seq)}`,
        role: row.role,
        content: row.content,
        createdAt: row.created_at,
      }),
    )
    .filter((candidate): candidate is SessionMemoryCaptureCandidate => candidate !== null);
  const summaryCandidates = summaryRows
    .slice()
    .reverse()
    .map((row) =>
      classifySessionMemoryCaptureCandidate({
        sourceKind: "summary",
        sourceRef: row.summary_id,
        role: row.kind,
        content: row.content,
        createdAt: row.created_at,
      }),
    )
    .filter((candidate): candidate is SessionMemoryCaptureCandidate => candidate !== null);
  const candidates = [...messageCandidates, ...summaryCandidates].sort(compareSessionMemoryCaptureCandidates);
  const reviewedCandidates = reviewSessionMemoryCaptureCandidates(candidates, currentStateProbe);
  const emittedCandidates = reviewedCandidates
    .slice()
    .sort(compareReviewedSessionMemoryCaptureCandidates)
    .slice(0, 8);
  const missedCurrentStateSignals = findMissedCurrentStateSignals({
    signals: currentStateProbe.newestEvidence.length > 0 ? currentStateProbe.newestEvidence : collectCurrentStateSignals(scannedContents),
    emittedCandidates: reviewedCandidates,
  });

  lines.push(
    buildSection("📍 Target conversation", [
      buildStatLine("target mode", params.command.conversationId === undefined ? "current" : "explicit"),
      buildStatLine("conversation id", formatNumber(targetStats.conversationId)),
      ...(params.command.conversationId === undefined || current.kind !== "resolved"
        ? []
        : [buildStatLine("current conversation id", formatNumber(current.stats.conversationId))]),
      buildStatLine(
        "session key",
        targetStats.sessionKey ? formatCommand(truncateMiddle(targetStats.sessionKey, 44)) : "missing",
      ),
      buildStatLine("message scan limit", formatNumber(params.command.limit)),
      buildStatLine("summary scan limit", formatNumber(params.command.limit)),
    ]),
    "",
    buildSection("🧪 Mode", [
      buildStatLine("mode", "dry_run_report"),
      buildStatLine("writes", "none"),
      buildStatLine("accepted memory", "none"),
      buildStatLine("review result", "candidate_only"),
    ]),
  );

  if (candidates.length === 0) {
    lines.push(
      "",
      buildSection("🛠️ Result", ["No candidate-worthy events detected in the scanned message window."]),
    );
    return lines.join("\n");
  }

  lines.push(
    "",
    buildSection("🧩 Candidate Summary", [
      buildStatLine("candidates", formatNumber(candidates.length)),
      buildStatLine("max emitted", "8"),
    ]),
    "",
    buildSection("🔎 Current State Probe", [
      buildStatLine(
        "status",
        currentStateProbe.latestCompleted.length > 0 || currentStateProbe.nextAction.length > 0 ? "detected" : "weak",
      ),
      ...(currentStateProbe.latestCompleted.length > 0
        ? currentStateProbe.latestCompleted.map((signal) => buildStatLine("latest_completed", signal))
        : [buildStatLine("latest_completed", "missing")]),
      ...(currentStateProbe.nextAction.length > 0
        ? currentStateProbe.nextAction.map((signal) => buildStatLine("next_action", signal))
        : [buildStatLine("next_action", currentStateProbe.latestCompleted.length > 0 ? "completed" : "missing")]),
      ...(currentStateProbe.newestEvidence.length > 0
        ? currentStateProbe.newestEvidence.slice(0, 8).map((signal) => buildStatLine("newest_evidence", signal))
        : [buildStatLine("newest_evidence", "missing")]),
    ]),
    "",
    buildSection("🪣 Review Buckets", [
      ...reviewedCandidates
        .filter((candidate) => candidate.reviewBucket === "promotable")
        .map((candidate) => buildStatLine("promotable", formatSessionMemoryCaptureSource(candidate))),
      ...reviewedCandidates
        .filter((candidate) => candidate.reviewBucket === "open_question")
        .map((candidate) => buildStatLine("open_question", formatSessionMemoryCaptureSource(candidate))),
      ...reviewedCandidates
        .filter((candidate) => candidate.reviewBucket === "resolved_question")
        .map((candidate) => buildStatLine("resolved_question", formatSessionMemoryCaptureSource(candidate))),
      ...reviewedCandidates
        .filter((candidate) => candidate.reviewBucket === "evidence_only")
        .map((candidate) => buildStatLine("evidence_only", formatSessionMemoryCaptureSource(candidate))),
      ...reviewedCandidates
        .filter((candidate) => candidate.reviewBucket === "duplicate")
        .map((candidate) => buildStatLine("duplicate", formatSessionMemoryCaptureSource(candidate))),
      ...reviewedCandidates
        .filter((candidate) => candidate.reviewBucket === "local_flow")
        .map((candidate) => buildStatLine("local_flow", formatSessionMemoryCaptureSource(candidate))),
      ...reviewedCandidates
        .filter((candidate) => candidate.reviewBucket === "stale_superseded")
        .map((candidate) => buildStatLine("stale/superseded", formatSessionMemoryCaptureSource(candidate))),
      ...missedCurrentStateSignals.map((signal) => buildStatLine("missed_current_state", signal)),
      ...(reviewedCandidates.length === 0 && missedCurrentStateSignals.length === 0
        ? ["No review buckets detected."]
        : []),
    ]),
  );

  for (const [index, candidate] of emittedCandidates.entries()) {
    lines.push(
      "",
      buildSection(`Candidate ${index + 1} - ${candidate.kind}`, [
        buildStatLine("source", candidate.source),
        buildStatLine("source item", `${candidate.sourceKind} ${formatCommand(candidate.sourceRef)} (${candidate.role}) at ${candidate.createdAt}`),
        buildStatLine("why candidate", candidate.why),
        buildStatLine("claim", candidate.claim),
        buildStatLine("confidence", candidate.confidence),
        buildStatLine("risk if wrong", candidate.riskIfWrong),
        buildStatLine("suggested destination", candidate.suggestedDestination),
        buildStatLine(
          "review bucket",
          candidate.reviewBucket === "stale_superseded" ? "stale/superseded" : candidate.reviewBucket,
        ),
        buildStatLine("review note", candidate.reviewNote),
        buildStatLine("review result", "candidate_only"),
      ]),
    );
  }

  return lines.join("\n");
}

async function buildDoctorText(params: {
  ctx: PluginCommandContext;
  db: DatabaseSync;
}): Promise<string> {
  const current = await resolveCurrentConversation(params);

  if (current.kind === "unavailable") {
    return [
      ...buildHeaderLines(),
      "",
      "🩺 Lossless Claw Doctor",
      "",
      buildSection("📍 Current conversation", [
        buildStatLine("status", "unavailable"),
        buildStatLine("reason", current.reason),
        buildStatLine("fallback", "Doctor is conversation-scoped, so no global scan ran."),
      ]),
    ].join("\n");
  }

  const stats = getDoctorSummaryStats(params.db, current.stats.conversationId);
  const lines = [
    ...buildHeaderLines(),
    "",
    "🩺 Lossless Claw Doctor",
    "",
    buildSection("📍 Current conversation", [
      buildStatLine("conversation id", formatNumber(current.stats.conversationId)),
      buildStatLine(
        "session key",
        current.stats.sessionKey ? formatCommand(truncateMiddle(current.stats.sessionKey, 44)) : "missing",
      ),
      buildStatLine("scope", "this conversation only"),
    ]),
    "",
    buildSection("🧪 Scan", [
      buildStatLine("detected summaries", formatNumber(stats.total)),
      buildStatLine("old-marker summaries", formatNumber(stats.old)),
      buildStatLine("truncated-marker summaries", formatNumber(stats.truncated)),
      buildStatLine("fallback-marker summaries", formatNumber(stats.fallback)),
      buildStatLine("result", stats.total === 0 ? "clean" : "issues found"),
    ]),
  ];

  if (stats.total > 0) {
    const summaryList = stats.candidates
      .slice()
      .sort((left, right) => left.summaryId.localeCompare(right.summaryId))
      .map((candidate) => `${candidate.summaryId} (${candidate.markerKind})`)
      .join(", ");
    lines.push(
      "",
      buildSection("🧷 Affected summaries", [summaryList]),
      "",
      buildSection("🛠️ Next step", [
        `${formatCommand(`${VISIBLE_COMMAND} doctor apply`)} repairs these in place for the current conversation.`,
      ]),
    );
  }

  return lines.join("\n");
}

async function buildDoctorCleanersText(params: {
  db: DatabaseSync;
}): Promise<string> {
  const scan = scanDoctorCleaners(params.db);
  const lines = [
    ...buildHeaderLines(),
    "",
    "🩺 Lossless Claw Doctor Clean",
    "",
    buildSection("🌐 Global scan", [
      buildStatLine("filters", formatNumber(scan.filters.length)),
      buildStatLine("matched conversations", formatNumber(scan.totalDistinctConversations)),
      buildStatLine("matched messages", formatNumber(scan.totalDistinctMessages)),
      buildStatLine("mode", "read-only diagnostics"),
    ]),
  ];

  if (scan.filters.every((filter) => filter.conversationCount === 0)) {
    lines.push(
      "",
      buildSection("✅ Result", ["No high-confidence cleaner candidates detected."]),
    );
    return lines.join("\n");
  }

  for (const filter of scan.filters) {
    lines.push(
      "",
      buildSection(`🧹 ${filter.label}`, [
        buildStatLine("filter id", formatCommand(filter.id)),
        buildStatLine("description", filter.description),
        buildStatLine("matched conversations", formatNumber(filter.conversationCount)),
        buildStatLine("matched messages", formatNumber(filter.messageCount)),
      ]),
    );

    if (filter.examples.length > 0) {
      lines.push(
        "",
        buildSection(
          "🧷 Examples",
          filter.examples.map((example) => buildDoctorCleanerExampleLine(example)),
        ),
      );
    }
  }

  lines.push(
    "",
    buildSection("🛠️ Next step", [
      `Review the examples, then run ${formatCommand(`${VISIBLE_COMMAND} doctor clean apply`)} to delete approved matches after Lossless Claw creates a backup.`,
    ]),
  );

  return lines.join("\n");
}

function runQuickCheck(db: DatabaseSync): string {
  const rows = db.prepare(`PRAGMA quick_check`).all() as Array<{ quick_check?: string }>;
  const results = rows
    .map((row) => row.quick_check)
    .filter((value): value is string => typeof value === "string" && value.length > 0);

  if (results.length === 0) {
    return "unknown";
  }

  if (results.length === 1 && results[0] === "ok") {
    return "ok";
  }

  return results.join("; ");
}

function isPassingQuickCheck(result: string): boolean {
  return result === "ok";
}

function getLcmBackupUnavailableReason(databasePath: string): string | null {
  if (typeof databasePath !== "string") return "Invalid database path.";
  const trimmed = databasePath.trim();
  if (!trimmed || trimmed === ":memory:" || trimmed.startsWith("file::memory:")) {
    return "Backup requires a file-backed SQLite database.";
  }
  return null;
}

async function buildBackupText(params: {
  db: DatabaseSync;
  config: LcmConfig;
}): Promise<string> {
  const lines = [
    ...buildHeaderLines(),
    "",
    "💾 Lossless Claw Backup",
    "",
  ];

  const unavailableReason = getLcmBackupUnavailableReason(params.config.databasePath);
  if (unavailableReason) {
    lines.push(
      buildSection("🛠️ Backup", [
        buildStatLine("status", "unavailable"),
        buildStatLine("reason", unavailableReason),
      ]),
    );
    return lines.join("\n");
  }

  let backupPath: string | null;
  try {
    backupPath = createLcmDatabaseBackup(params.db, {
      databasePath: params.config.databasePath,
      label: "backup",
    });
  } catch (error) {
    lines.push(
      buildSection("🛠️ Backup", [
        buildStatLine("status", "failed"),
        buildStatLine("reason", formatFailureReason(error)),
      ]),
    );
    return lines.join("\n");
  }
  if (!backupPath) {
    lines.push(
      buildSection("🛠️ Backup", [
        buildStatLine("status", "unavailable"),
        buildStatLine("reason", "Lossless Claw could not determine a backup path."),
      ]),
    );
    return lines.join("\n");
  }

  lines.push(
    buildSection("🛠️ Backup", [
      buildStatLine("status", "created"),
      buildStatLine("db path", params.config.databasePath),
      buildStatLine("backup path", backupPath),
    ]),
  );
  return lines.join("\n");
}

async function buildRotateText(params: {
  ctx: PluginCommandContext;
  db: DatabaseSync;
  config: LcmConfig;
  deps?: LcmDependencies;
  getLcm?: () => Promise<LcmCommandEngine>;
}): Promise<string> {
  const lines = [
    ...buildHeaderLines(),
    "",
    "🪓 Lossless Claw Rotate",
    "",
  ];

  const sessionKey = normalizeIdentity(params.ctx.sessionKey);
  if (!sessionKey) {
    lines.push(
      buildSection("📍 Current conversation", [
        buildStatLine("status", "unavailable"),
        buildStatLine(
          "reason",
          "OpenClaw must expose the active session key for Lossless Claw to rotate storage safely.",
        ),
      ]),
    );
    return lines.join("\n");
  }

  const current = await resolveCurrentConversation({
    ctx: params.ctx,
    db: params.db,
  });
  if (current.kind === "unavailable") {
    lines.push(
      buildSection("📍 Current conversation", [
        buildStatLine("status", "unavailable"),
        buildStatLine("reason", current.reason),
      ]),
    );
    return lines.join("\n");
  }

  if (!params.deps || !params.getLcm) {
    lines.push(
      buildSection("🛠️ Rotate", [
        buildStatLine("status", "unavailable"),
        buildStatLine("reason", "Rotate requires the runtime-backed LCM engine to be available."),
      ]),
    );
    return lines.join("\n");
  }

  const sessionId = await resolveRuntimeSessionId({
    ctx: params.ctx,
    deps: params.deps,
    current,
  });
  if (!sessionId) {
    lines.push(
      buildSection("📍 Current conversation", [
        buildStatLine("conversation id", formatNumber(current.stats.conversationId)),
        buildStatLine("session key", formatCommand(truncateMiddle(sessionKey, 44))),
        buildStatLine("messages", formatNumber(current.stats.messageCount)),
      ]),
      "",
      buildSection("🛠️ Rotate", [
        buildStatLine("status", "unavailable"),
        buildStatLine(
          "reason",
          "Lossless Claw resolved the active conversation, but OpenClaw did not expose or resolve a runtime session id, so rotate cannot locate the live transcript safely.",
        ),
      ]),
    );
    return lines.join("\n");
  }

  const transcriptPath = await params.deps.resolveSessionTranscriptFile({
    sessionId,
    sessionKey,
  });
  if (!transcriptPath || !existsSync(transcriptPath)) {
    lines.push(
      buildSection("🛠️ Rotate", [
        buildStatLine("status", "unavailable"),
        buildStatLine(
          "reason",
          "Lossless Claw could not resolve the active session transcript path, so it cannot rotate the transcript safely.",
        ),
      ]),
    );
    return lines.join("\n");
  }

  const unavailableReason = getLcmBackupUnavailableReason(params.config.databasePath);
  if (unavailableReason) {
    lines.push(
      buildSection("🛠️ Rotate", [
        buildStatLine("status", "unavailable"),
        buildStatLine("reason", unavailableReason),
      ]),
    );
    return lines.join("\n");
  }

  let result: RotateSessionStorageWithBackupResult;
  try {
    result = await (await params.getLcm()).rotateSessionStorageWithBackup({
      sessionId,
      sessionKey,
      sessionFile: transcriptPath,
      lockTimeoutMs: ROTATE_DATABASE_LOCK_TIMEOUT_MS,
    });
  } catch (error) {
    lines.push(
      buildSection("🛠️ Rotate", [
        buildStatLine("status", "failed"),
        buildStatLine("reason", formatFailureReason(error)),
      ]),
    );
    return lines.join("\n");
  }

  lines.push(
    buildSection("📍 Current conversation", [
      buildStatLine(
        "conversation id",
        formatNumber(result.currentConversationId ?? current.stats.conversationId),
      ),
      buildStatLine("session key", formatCommand(truncateMiddle(sessionKey, 44))),
      buildStatLine(
        "messages",
        formatNumber(result.currentMessageCount ?? current.stats.messageCount),
      ),
    ]),
    "",
  );

  if (result.kind === "backup_failed") {
    lines.push(
      buildSection("💾 Backup", [
        buildStatLine("status", "failed"),
        buildStatLine("reason", result.reason),
      ]),
    );
    return lines.join("\n");
  }

  if (result.kind === "unavailable" && !result.backupPath) {
    lines.push(
      buildSection("🛠️ Rotate", [
        buildStatLine("status", "unavailable"),
        buildStatLine("reason", result.reason),
      ]),
    );
    return lines.join("\n");
  }

  lines.push(
    buildSection("💾 Backup", [
      buildStatLine("status", "replaced latest"),
      buildStatLine("backup path", result.backupPath!),
    ]),
    "",
  );

  if (result.kind === "rotate_failed") {
    lines.push(
      buildSection("🛠️ Rotate", [
        buildStatLine("status", "failed"),
        buildStatLine("reason", result.reason),
      ]),
    );
    return lines.join("\n");
  }

  if (result.kind === "unavailable") {
    lines.push(
      buildSection("🛠️ Rotate", [
        buildStatLine("status", "unavailable"),
        buildStatLine("reason", result.reason),
      ]),
    );
    return lines.join("\n");
  }

  lines.push(
    buildSection("🛠️ Rotate", [
      buildStatLine("status", "rotated"),
      buildStatLine("preserved tail messages", formatNumber(result.preservedTailMessageCount)),
      buildStatLine("checkpoint bytes", formatNumber(result.checkpointSize)),
      buildStatLine("bytes removed", formatNumber(result.bytesRemoved)),
      buildStatLine("transcript", transcriptPath),
      buildStatLine("mode", "preserved current conversation and rotated transcript tail"),
    ]),
    "",
    buildSection("🧭 Notes", [
      "Current LCM conversation, summaries, and context items remain in place.",
      `${formatCommand("/new")} still prunes context only, and ${formatCommand("/reset")} still resets OpenClaw session flow.`,
    ]),
  );
  return lines.join("\n");
}

function formatFocusPreview(content: string, maxChars = 1200): string {
  const trimmed = content.trim();
  if (trimmed.length <= maxChars) {
    return trimmed;
  }
  return `${trimmed.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

function formatFocusBriefTime(value: Date | null, timezone: string): string {
  return value ? formatTimestamp(value, timezone) : "unknown";
}

function formatFocusDelta(diagnostics: {
  postFocusMessageCount: number;
  postFocusSummaryCount: number;
  postFocusTokenCount: number;
}): string {
  return [
    `${formatNumber(diagnostics.postFocusMessageCount)} messages`,
    `${formatNumber(diagnostics.postFocusSummaryCount)} summaries`,
    `~${formatNumber(diagnostics.postFocusTokenCount)} tokens`,
  ].join(", ");
}

type FocusResultMetadata = {
  citedSummaryIds: string[];
  expandedSummaryIds: string[];
  irrelevantSummaryIds: string[];
  expansionPromptCount: number;
  confidenceNotes: string[];
};

function normalizeFocusMetadataStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const seen = new Set<string>();
  const output: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") {
      continue;
    }
    const trimmed = item.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    output.push(trimmed);
  }
  return output;
}

function parseFocusResultMetadata(rawResultJson: string | null): FocusResultMetadata {
  if (!rawResultJson?.trim()) {
    return {
      citedSummaryIds: [],
      expandedSummaryIds: [],
      irrelevantSummaryIds: [],
      expansionPromptCount: 0,
      confidenceNotes: [],
    };
  }
  try {
    const parsed = JSON.parse(rawResultJson) as Record<string, unknown>;
    return {
      citedSummaryIds: normalizeFocusMetadataStringArray(parsed.citedSummaryIds),
      expandedSummaryIds: normalizeFocusMetadataStringArray(parsed.expandedSummaryIds),
      irrelevantSummaryIds: normalizeFocusMetadataStringArray(parsed.irrelevantSummaryIds),
      expansionPromptCount: Array.isArray(parsed.expansionPrompts) ? parsed.expansionPrompts.length : 0,
      confidenceNotes: normalizeFocusMetadataStringArray(parsed.confidenceNotes),
    };
  } catch {
    return {
      citedSummaryIds: [],
      expandedSummaryIds: [],
      irrelevantSummaryIds: [],
      expansionPromptCount: 0,
      confidenceNotes: [],
    };
  }
}

function formatFocusSummaryIds(ids: string[], max = 8): string {
  if (ids.length === 0) {
    return "none";
  }
  const shown = ids.slice(0, max).join(", ");
  const remaining = ids.length - max;
  return remaining > 0 ? `${shown}, +${formatNumber(remaining)} more` : shown;
}

function formatFocusConfidenceNotes(notes: string[], max = 3): string {
  if (notes.length === 0) {
    return "none";
  }
  const shown = notes.slice(0, max).map((note) => formatFocusPreview(note, 180)).join(" | ");
  const remaining = notes.length - max;
  return remaining > 0 ? `${shown} | +${formatNumber(remaining)} more` : shown;
}

function formatAssemblySkippedReasons(
  reasons: Partial<Record<string, number>>,
): string {
  const entries = Object.entries(reasons).filter(([, count]) => (count ?? 0) > 0);
  if (entries.length === 0) {
    return "none";
  }
  return entries
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([reason, count]) => `${reason}=${formatNumber(count ?? 0)}`)
    .join(", ");
}

async function buildFocusSummaryLines(params: {
  store: FocusBriefStore;
  conversationId: number;
  timezone: string;
}): Promise<string[]> {
  const active = await params.store.getActiveFocusBrief(params.conversationId);
  const latest = await params.store.getLatestFocusBrief(params.conversationId);
  if (!active) {
    return [
      buildStatLine("status", "none"),
      ...(latest
        ? [
            buildStatLine("latest generation", latest.status),
            buildStatLine("latest brief id", formatCommand(latest.briefId)),
          ]
        : []),
    ];
  }

  const diagnostics = await params.store.getFocusBriefDiagnostics(active);
  const metadata = parseFocusResultMetadata(active.rawResultJson);
  const lines = [
    buildStatLine("status", "active"),
    buildStatLine("brief id", formatCommand(active.briefId)),
    buildStatLine("created", formatFocusBriefTime(active.createdAt, params.timezone)),
    buildStatLine("prompt", JSON.stringify(formatFocusPreview(active.prompt, 160))),
    buildStatLine("tokens", `${formatNumber(active.tokenCount)} / ${formatNumber(active.targetTokens)}`),
    buildStatLine("expanded summaries", formatFocusSummaryIds(metadata.expandedSummaryIds)),
    buildStatLine("irrelevant summaries", formatFocusSummaryIds(metadata.irrelevantSummaryIds)),
    buildStatLine("expansion prompts", formatNumber(metadata.expansionPromptCount)),
    buildStatLine("confidence notes", formatFocusConfidenceNotes(metadata.confidenceNotes)),
    buildStatLine("delta since focus", formatFocusDelta(diagnostics)),
    buildStatLine("stale", formatBoolean(diagnostics.stale)),
    buildStatLine("truncated", formatBoolean(diagnostics.truncated)),
    buildStatLine("source snapshot", diagnostics.sourceContextChanged ? "obsolete" : "current"),
  ];
  if (latest && latest.briefId !== active.briefId) {
    lines.push(buildStatLine("latest generation", latest.status));
    if (latest.error) {
      lines.push(buildStatLine("latest error", latest.error));
    }
  }
  return lines;
}

// Build the read-only status response for the current conversation's latest focus brief.
async function buildFocusStatusText(params: {
  ctx: PluginCommandContext;
  db: DatabaseSync;
  config: LcmConfig;
}): Promise<string> {
  const lines = [
    ...buildHeaderLines(),
    "",
    "🎯 Lossless Claw Focus",
    "",
  ];
  const current = await resolveCurrentConversation({ ctx: params.ctx, db: params.db });
  if (current.kind === "unavailable") {
    lines.push(
      buildSection("📍 Current conversation", [
        buildStatLine("status", "unavailable"),
        buildStatLine("reason", current.reason),
      ]),
    );
    return lines.join("\n");
  }

  const store = new FocusBriefStore(params.db);
  const active = await store.getActiveFocusBrief(current.stats.conversationId);
  const latest = await store.getLatestFocusBrief(current.stats.conversationId);
  lines.push(
    buildSection("📍 Current conversation", [
      buildStatLine("conversation id", formatNumber(current.stats.conversationId)),
      buildStatLine(
        "session key",
        current.stats.sessionKey ? formatCommand(truncateMiddle(current.stats.sessionKey, 44)) : "missing",
      ),
    ]),
    "",
  );

  if (!active && !latest) {
    lines.push(
      buildSection("🎯 Focus", [
        buildStatLine("status", "none"),
        buildStatLine("usage", formatCommand(`${VISIBLE_COMMAND} focus <prompt>`)),
        buildStatLine("behavior", "generates an active focus brief overlay"),
      ]),
    );
    return lines.join("\n");
  }

  const primary = active ?? latest;
  if (!primary) {
    return lines.join("\n");
  }

  const sources = await store.getFocusBriefSources(primary.briefId);
  const cited = sources.filter((source) => source.role === "cited").map((source) => source.summaryId);
  const metadata = parseFocusResultMetadata(primary.rawResultJson);
  const diagnostics = await store.getFocusBriefDiagnostics(primary);
  lines.push(
    buildSection(active ? "🎯 Active focus brief" : "🎯 Latest focus brief", [
      buildStatLine("brief id", formatCommand(primary.briefId)),
      buildStatLine("status", primary.status),
      buildStatLine("created", formatFocusBriefTime(primary.createdAt, params.config.timezone)),
      buildStatLine("prompt", JSON.stringify(formatFocusPreview(primary.prompt, 240))),
      buildStatLine("tokens", formatNumber(primary.tokenCount)),
      buildStatLine("target tokens", formatNumber(primary.targetTokens)),
      buildStatLine("source summaries", formatNumber(sources.filter((source) => source.role === "active_input").length)),
      buildStatLine("cited summaries", cited.length > 0 ? cited.slice(0, 8).join(", ") : "none"),
      buildStatLine("expanded summaries", formatFocusSummaryIds(metadata.expandedSummaryIds)),
      buildStatLine("irrelevant summaries", formatFocusSummaryIds(metadata.irrelevantSummaryIds)),
      buildStatLine("expansion prompts", formatNumber(metadata.expansionPromptCount)),
      buildStatLine("confidence notes", formatFocusConfidenceNotes(metadata.confidenceNotes)),
      buildStatLine("generator run", primary.generatorRunId ?? "unknown"),
      buildStatLine("delta since focus", formatFocusDelta(diagnostics)),
      buildStatLine("stale", formatBoolean(diagnostics.stale)),
      buildStatLine("truncated", formatBoolean(diagnostics.truncated)),
      buildStatLine("source snapshot", diagnostics.sourceContextChanged ? "obsolete" : "current"),
    ]),
  );
  if (latest && active && latest.briefId !== active.briefId) {
    lines.push(
      "",
      buildSection("⚠️ Latest generation", [
        buildStatLine("latest generation", latest.status),
        buildStatLine("brief id", formatCommand(latest.briefId)),
        ...(latest.error ? [buildStatLine("error", latest.error)] : []),
      ]),
    );
  } else if (primary.error) {
    lines.push("", buildSection("⚠️ Error", [primary.error]));
  }
  if (primary.content.trim()) {
    lines.push("", buildSection("📝 Preview", [formatFocusPreview(primary.content)]));
  }
  return lines.join("\n");
}

// Generate an active focus brief through a delegated subagent and persist the result.
async function buildFocusGenerateText(params: {
  ctx: PluginCommandContext;
  db: DatabaseSync;
  config: LcmConfig;
  deps?: LcmDependencies;
  getLcm?: () => Promise<LcmCommandEngine>;
  prompt: string;
}): Promise<string> {
  const lines = [
    ...buildHeaderLines(),
    "",
    "🎯 Lossless Claw Focus",
    "",
  ];
  if (!params.deps || !params.getLcm) {
    lines.push(
      buildSection("🛠️ Focus", [
        buildStatLine("status", "unavailable"),
        buildStatLine(
          "reason",
          "Focus generation requires runtime dependencies for pre-focus compaction and delegated subagents.",
        ),
      ]),
    );
    return lines.join("\n");
  }

  const requesterSessionKey = normalizeIdentity(params.ctx.sessionKey);
  if (!requesterSessionKey) {
    lines.push(
      buildSection("📍 Current conversation", [
        buildStatLine("status", "unavailable"),
        buildStatLine(
          "reason",
          "OpenClaw must expose the active session key for Lossless Claw to spawn a focus subagent.",
        ),
      ]),
    );
    return lines.join("\n");
  }

  let current = await resolveCurrentConversation({ ctx: params.ctx, db: params.db });
  if (current.kind === "unavailable") {
    lines.push(
      buildSection("📍 Current conversation", [
        buildStatLine("status", "unavailable"),
        buildStatLine("reason", current.reason),
      ]),
    );
    return lines.join("\n");
  }

  const preFocusCompaction = await runFocusLifecycleCompaction({
    ctx: params.ctx,
    deps: params.deps,
    getLcm: params.getLcm,
    config: params.config,
    current,
    sessionKey: requesterSessionKey,
  });
  if (preFocusCompaction.status !== "ok") {
    lines.push(
      buildSection("📍 Current conversation", [
        buildStatLine("conversation id", formatNumber(current.stats.conversationId)),
        buildStatLine("session key", formatCommand(truncateMiddle(requesterSessionKey, 44))),
      ]),
      "",
      buildSection("🧹 Pre-focus compaction", [
        buildStatLine("status", preFocusCompaction.status),
        buildStatLine("reason", preFocusCompaction.reason),
      ]),
    );
    return lines.join("\n");
  }

  current = await resolveCurrentConversation({ ctx: params.ctx, db: params.db });
  if (current.kind === "unavailable") {
    lines.push(
      buildSection("🧹 Pre-focus compaction", [
        buildStatLine("status", "completed"),
        buildStatLine("result", preFocusCompaction.result.reason ?? "done"),
      ]),
      "",
      buildSection("📍 Current conversation", [
        buildStatLine("status", "unavailable"),
        buildStatLine("reason", current.reason),
      ]),
    );
    return lines.join("\n");
  }

  const store = new FocusBriefStore(params.db);
  const summaries = await store.getActiveContextSummaries(current.stats.conversationId);
  if (summaries.length === 0) {
    lines.push(
      buildSection("🎯 Focus", [
        buildStatLine("status", "unavailable"),
        buildStatLine("reason", "The current conversation has no active summary context items to focus."),
      ]),
    );
    return lines.join("\n");
  }

  const sourceContextHash = hashFocusSourceContext(summaries);
  const watermark = await store.getCoveredWatermark(current.stats.conversationId);
  const generation = await runDelegatedFocusBrief({
    deps: params.deps,
    requesterSessionKey,
    conversationId: current.stats.conversationId,
    focusPrompt: params.prompt,
    summaries,
  });
  const ordinalBySummaryId = new Map(summaries.map((summary) => [summary.summaryId, summary.ordinal]));
  const sources = [
    ...summaries.map((summary) => ({
      summaryId: summary.summaryId,
      ordinal: summary.ordinal,
      role: "active_input" as const,
    })),
    ...generation.citedSummaryIds.map((summaryId) => ({
      summaryId,
      ordinal: ordinalBySummaryId.get(summaryId) ?? null,
      role: "cited" as const,
    })),
    ...generation.expandedSummaryIds.map((summaryId) => ({
      summaryId,
      ordinal: ordinalBySummaryId.get(summaryId) ?? null,
      role: "expanded" as const,
    })),
    ...generation.irrelevantSummaryIds.map((summaryId) => ({
      summaryId,
      ordinal: ordinalBySummaryId.get(summaryId) ?? null,
      role: "irrelevant" as const,
    })),
  ];

  const ok = generation.status === "ok";
  const brief = await store.createFocusBrief({
    conversationId: current.stats.conversationId,
    sessionKey: requesterSessionKey,
    prompt: params.prompt,
    content: ok ? generation.briefMarkdown : "",
    status: ok ? "active" : "failed",
    tokenCount: generation.tokenCount,
    targetTokens: generation.targetTokens,
    coveredLatestAt: watermark.coveredLatestAt,
    coveredMessageSeq: watermark.coveredMessageSeq,
    sourceContextHash,
    generatorRunId: generation.runId,
    generatorSessionKey: generation.childSessionKey,
    rawResultJson:
      generation.rawResultJson ??
      JSON.stringify({
        status: generation.status,
        error: generation.error,
        rawReply: generation.rawReply,
      }),
    error: generation.error ?? null,
    sources,
    supersedeCurrentDrafts: ok,
  });

  lines.push(
    buildSection("📍 Current conversation", [
      buildStatLine("conversation id", formatNumber(current.stats.conversationId)),
      buildStatLine("session key", formatCommand(truncateMiddle(requesterSessionKey, 44))),
      buildStatLine("source summaries", formatNumber(summaries.length)),
      buildStatLine("source context hash", sourceContextHash.slice(0, 16)),
    ]),
    "",
    buildSection("🧹 Pre-focus compaction", [
      buildStatLine("status", "completed"),
      buildStatLine("compacted", formatBoolean(preFocusCompaction.result.compacted)),
      buildStatLine("result", preFocusCompaction.result.reason ?? "done"),
    ]),
    "",
    buildSection("🎯 Focus brief", [
      buildStatLine("brief id", formatCommand(brief.briefId)),
      buildStatLine("status", brief.status),
      buildStatLine("prompt", JSON.stringify(formatFocusPreview(params.prompt, 240))),
      buildStatLine("tokens", formatNumber(brief.tokenCount)),
      buildStatLine("target tokens", formatNumber(brief.targetTokens)),
      buildStatLine("cited summaries", formatFocusSummaryIds(generation.citedSummaryIds)),
      buildStatLine("expanded summaries", formatFocusSummaryIds(generation.expandedSummaryIds)),
      buildStatLine("irrelevant summaries", formatFocusSummaryIds(generation.irrelevantSummaryIds)),
      buildStatLine("expansion prompts", formatNumber(generation.expansionPrompts.length)),
      buildStatLine("confidence notes", formatFocusConfidenceNotes(generation.confidenceNotes)),
      buildStatLine("generator run", generation.runId),
      buildStatLine("generator session", truncateMiddle(generation.childSessionKey, 60)),
      buildStatLine("truncated", formatBoolean(generation.truncated)),
    ]),
  );
  if (generation.warning) {
    lines.push("", buildSection("⚠️ Generation warning", [generation.warning]));
  }
  if (!ok) {
    lines.push(
      "",
      buildSection("⚠️ Generation failed", [
        generation.error ?? "Focus brief generation failed without a specific error.",
      ]),
    );
    return lines.join("\n");
  }

  lines.push(
    "",
    buildSection("📝 Preview", [formatFocusPreview(generation.briefMarkdown)]),
  );
  return lines.join("\n");
}

function isSummaryAfterFocusWatermark(
  summary: { latestAt: string | null; createdAt: string; maxSourceSeq?: number | null },
  brief: { coveredMessageSeq: number | null; coveredLatestAt: Date | null },
): boolean {
  if (brief.coveredMessageSeq != null && summary.maxSourceSeq != null) {
    return summary.maxSourceSeq > brief.coveredMessageSeq;
  }
  if (!brief.coveredLatestAt) {
    return true;
  }
  const timestamp = summary.latestAt ?? summary.createdAt;
  const parsed = Date.parse(timestamp);
  if (!Number.isFinite(parsed)) {
    return true;
  }
  return parsed > brief.coveredLatestAt.getTime();
}

// Refresh the active focus brief by merging relevant post-focus summary deltas
// into the existing brief. The old active brief is superseded only after a new
// active replacement is generated and persisted successfully.
async function buildRefocusText(params: {
  ctx: PluginCommandContext;
  db: DatabaseSync;
  config: LcmConfig;
  deps?: LcmDependencies;
  getLcm?: () => Promise<LcmCommandEngine>;
}): Promise<string> {
  const lines = [
    ...buildHeaderLines(),
    "",
    "🎯 Lossless Claw Refocus",
    "",
  ];
  if (!params.deps || !params.getLcm) {
    lines.push(
      buildSection("🛠️ Refocus", [
        buildStatLine("status", "unavailable"),
        buildStatLine(
          "reason",
          "Refocus requires runtime dependencies for pre-refocus compaction and delegated subagents.",
        ),
      ]),
    );
    return lines.join("\n");
  }

  const requesterSessionKey = normalizeIdentity(params.ctx.sessionKey);
  if (!requesterSessionKey) {
    lines.push(
      buildSection("📍 Current conversation", [
        buildStatLine("status", "unavailable"),
        buildStatLine("reason", "OpenClaw must expose the active session key for Lossless Claw to refocus."),
      ]),
    );
    return lines.join("\n");
  }

  let current = await resolveCurrentConversation({ ctx: params.ctx, db: params.db });
  if (current.kind === "unavailable") {
    lines.push(
      buildSection("📍 Current conversation", [
        buildStatLine("status", "unavailable"),
        buildStatLine("reason", current.reason),
      ]),
    );
    return lines.join("\n");
  }

  const store = new FocusBriefStore(params.db);
  const active = await store.getActiveFocusBrief(current.stats.conversationId);
  if (!active?.content.trim()) {
    lines.push(
      buildSection("🎯 Refocus", [
        buildStatLine("status", "unavailable"),
        buildStatLine("reason", "The current conversation has no active focus brief to refresh."),
      ]),
    );
    return lines.join("\n");
  }

  const preRefocusCompaction = await runFocusLifecycleCompaction({
    ctx: params.ctx,
    deps: params.deps,
    getLcm: params.getLcm,
    config: params.config,
    current,
    sessionKey: requesterSessionKey,
  });
  if (preRefocusCompaction.status !== "ok") {
    lines.push(
      buildSection("📍 Current conversation", [
        buildStatLine("conversation id", formatNumber(current.stats.conversationId)),
        buildStatLine("session key", formatCommand(truncateMiddle(requesterSessionKey, 44))),
      ]),
      "",
      buildSection("🧹 Pre-refocus compaction", [
        buildStatLine("status", preRefocusCompaction.status),
        buildStatLine("reason", preRefocusCompaction.reason),
      ]),
    );
    return lines.join("\n");
  }

  current = await resolveCurrentConversation({ ctx: params.ctx, db: params.db });
  if (current.kind === "unavailable") {
    lines.push(
      buildSection("🧹 Pre-refocus compaction", [
        buildStatLine("status", "completed"),
        buildStatLine("result", preRefocusCompaction.result.reason ?? "done"),
      ]),
      "",
      buildSection("📍 Current conversation", [
        buildStatLine("status", "unavailable"),
        buildStatLine("reason", current.reason),
      ]),
    );
    return lines.join("\n");
  }

  const activeSummaries = await store.getActiveContextSummaries(current.stats.conversationId);
  const deltaSummaries = activeSummaries.filter((summary) =>
    isSummaryAfterFocusWatermark(summary, active),
  );
  if (deltaSummaries.length === 0) {
    lines.push(
      buildSection("📍 Current conversation", [
        buildStatLine("conversation id", formatNumber(current.stats.conversationId)),
        buildStatLine("session key", formatCommand(truncateMiddle(requesterSessionKey, 44))),
      ]),
      "",
      buildSection("🧹 Pre-refocus compaction", [
        buildStatLine("status", "completed"),
        buildStatLine("compacted", formatBoolean(preRefocusCompaction.result.compacted)),
        buildStatLine("result", preRefocusCompaction.result.reason ?? "done"),
      ]),
      "",
      buildSection("🎯 Refocus", [
        buildStatLine("status", "already current"),
        buildStatLine("active brief", formatCommand(active.briefId)),
        buildStatLine("delta summaries", "0"),
      ]),
    );
    return lines.join("\n");
  }

  const sourceContextHash = hashFocusSourceContext(activeSummaries);
  const watermark = await store.getCoveredWatermark(current.stats.conversationId);
  const generation = await runDelegatedRefocusBrief({
    deps: params.deps,
    requesterSessionKey,
    conversationId: current.stats.conversationId,
    focusPrompt: active.prompt,
    existingBriefMarkdown: active.content,
    deltaSummaries,
  });
  const ordinalBySummaryId = new Map(activeSummaries.map((summary) => [summary.summaryId, summary.ordinal]));
  const sources = [
    ...deltaSummaries.map((summary) => ({
      summaryId: summary.summaryId,
      ordinal: summary.ordinal,
      role: "active_input" as const,
    })),
    ...generation.citedSummaryIds.map((summaryId) => ({
      summaryId,
      ordinal: ordinalBySummaryId.get(summaryId) ?? null,
      role: "cited" as const,
    })),
    ...generation.expandedSummaryIds.map((summaryId) => ({
      summaryId,
      ordinal: ordinalBySummaryId.get(summaryId) ?? null,
      role: "expanded" as const,
    })),
    ...generation.irrelevantSummaryIds.map((summaryId) => ({
      summaryId,
      ordinal: ordinalBySummaryId.get(summaryId) ?? null,
      role: "irrelevant" as const,
    })),
  ];

  const ok = generation.status === "ok";
  const brief = await store.createFocusBrief({
    conversationId: current.stats.conversationId,
    sessionKey: requesterSessionKey,
    prompt: active.prompt,
    content: ok ? generation.briefMarkdown : "",
    status: ok ? "active" : "failed",
    tokenCount: generation.tokenCount,
    targetTokens: generation.targetTokens,
    coveredLatestAt: watermark.coveredLatestAt,
    coveredMessageSeq: watermark.coveredMessageSeq,
    sourceContextHash,
    generatorRunId: generation.runId,
    generatorSessionKey: generation.childSessionKey,
    rawResultJson:
      generation.rawResultJson ??
      JSON.stringify({
        status: generation.status,
        error: generation.error,
        rawReply: generation.rawReply,
      }),
    error: generation.error ?? null,
    sources,
    supersedeCurrentDrafts: ok,
  });

  lines.push(
    buildSection("📍 Current conversation", [
      buildStatLine("conversation id", formatNumber(current.stats.conversationId)),
      buildStatLine("session key", formatCommand(truncateMiddle(requesterSessionKey, 44))),
      buildStatLine("active brief", formatCommand(active.briefId)),
      buildStatLine("delta summaries", formatNumber(deltaSummaries.length)),
      buildStatLine("source context hash", sourceContextHash.slice(0, 16)),
    ]),
    "",
    buildSection("🧹 Pre-refocus compaction", [
      buildStatLine("status", "completed"),
      buildStatLine("compacted", formatBoolean(preRefocusCompaction.result.compacted)),
      buildStatLine("result", preRefocusCompaction.result.reason ?? "done"),
    ]),
    "",
    buildSection("🎯 Focus brief", [
      buildStatLine("brief id", formatCommand(brief.briefId)),
      buildStatLine("status", brief.status),
      buildStatLine("prompt", JSON.stringify(formatFocusPreview(active.prompt, 240))),
      buildStatLine("tokens", formatNumber(brief.tokenCount)),
      buildStatLine("target tokens", formatNumber(brief.targetTokens)),
      buildStatLine("cited summaries", formatFocusSummaryIds(generation.citedSummaryIds)),
      buildStatLine("expanded summaries", formatFocusSummaryIds(generation.expandedSummaryIds)),
      buildStatLine("irrelevant summaries", formatFocusSummaryIds(generation.irrelevantSummaryIds)),
      buildStatLine("expansion prompts", formatNumber(generation.expansionPrompts.length)),
      buildStatLine("confidence notes", formatFocusConfidenceNotes(generation.confidenceNotes)),
      buildStatLine("generator run", generation.runId),
      buildStatLine("generator session", truncateMiddle(generation.childSessionKey, 60)),
      buildStatLine("truncated", formatBoolean(generation.truncated)),
    ]),
  );
  if (generation.warning) {
    lines.push("", buildSection("⚠️ Generation warning", [generation.warning]));
  }
  if (!ok) {
    lines.push(
      "",
      buildSection("⚠️ Generation failed", [
        generation.error ?? "Refocus brief generation failed without a specific error.",
      ]),
    );
    return lines.join("\n");
  }

  lines.push(
    "",
    buildSection("📝 Preview", [formatFocusPreview(generation.briefMarkdown)]),
  );
  return lines.join("\n");
}

// Deactivate the current focus overlay without deleting focus history.
async function buildUnfocusText(params: {
  ctx: PluginCommandContext;
  db: DatabaseSync;
  config: LcmConfig;
  deps?: LcmDependencies;
  getLcm?: () => Promise<LcmCommandEngine>;
}): Promise<string> {
  const lines = [
    ...buildHeaderLines(),
    "",
    "🎯 Lossless Claw Focus",
    "",
  ];
  const current = await resolveCurrentConversation({ ctx: params.ctx, db: params.db });
  if (current.kind === "unavailable") {
    lines.push(
      buildSection("📍 Current conversation", [
        buildStatLine("status", "unavailable"),
        buildStatLine("reason", current.reason),
      ]),
    );
    return lines.join("\n");
  }
  const store = new FocusBriefStore(params.db);
  const active = await store.getActiveFocusBrief(current.stats.conversationId);
  if (!active) {
    lines.push(
      buildSection("🎯 Focus", [
        buildStatLine("status", "none active"),
        buildStatLine("deactivated briefs", "0"),
      ]),
    );
    return lines.join("\n");
  }

  const deactivated = await store.deactivateActiveFocusBriefs(current.stats.conversationId);
  const postUnfocusCompaction = await runFocusLifecycleCompaction({
    ctx: params.ctx,
    deps: params.deps,
    getLcm: params.getLcm,
    config: params.config,
    current,
    sessionKey:
      normalizeIdentity(params.ctx.sessionKey) ??
      normalizeIdentity(current.stats.sessionKey ?? undefined),
  });

  lines.push(
    buildSection("🎯 Focus", [
      buildStatLine("status", deactivated > 0 ? "inactive" : "none active"),
      buildStatLine("deactivated briefs", formatNumber(deactivated)),
    ]),
  );
  lines.push(
    "",
    buildSection("🧹 Post-unfocus compaction", [
      buildStatLine(
        "status",
        postUnfocusCompaction.status === "ok" ? "completed" : postUnfocusCompaction.status,
      ),
      ...(postUnfocusCompaction.status === "ok"
        ? [
            buildStatLine("compacted", formatBoolean(postUnfocusCompaction.result.compacted)),
            buildStatLine("result", postUnfocusCompaction.result.reason ?? "done"),
          ]
        : [buildStatLine("reason", postUnfocusCompaction.reason)]),
    ]),
  );
  return lines.join("\n");
}

async function buildDoctorCleanersApplyText(params: {
  db: DatabaseSync;
  config: LcmConfig;
  filterId?: DoctorCleanerId;
  vacuum: boolean;
}): Promise<string> {
  const filterIds = params.filterId ? [params.filterId] : undefined;
  const unavailableReason = getDoctorCleanerApplyUnavailableReason(params.config.databasePath);
  const lines = [
    ...buildHeaderLines(),
    "",
    "🩺 Lossless Claw Doctor Clean Apply",
    "",
    buildSection("🌐 Cleaner scope", [
      buildStatLine(
        "filters",
        filterIds && filterIds.length > 0
          ? filterIds.map((filter) => formatCommand(filter)).join(", ")
          : "all approved cleaner filters",
      ),
      buildStatLine("vacuum requested", formatBoolean(params.vacuum)),
    ]),
    "",
  ];
  if (unavailableReason) {
    lines.push(
      buildSection("🛠️ Apply", [
        buildStatLine("status", "unavailable"),
        buildStatLine("reason", unavailableReason),
      ]),
    );
    return lines.join("\n");
  }

  const before = scanDoctorCleaners(params.db, filterIds);
  lines.splice(
    lines.length - 1,
    0,
    buildSection("📊 Current matches", [
      buildStatLine("matched conversations before apply", formatNumber(before.totalDistinctConversations)),
      buildStatLine("matched messages before apply", formatNumber(before.totalDistinctMessages)),
    ]),
    "",
  );

  if (before.totalDistinctConversations === 0) {
    lines.push(
      buildSection("🛠️ Apply", [
        buildStatLine("status", "completed"),
        buildStatLine("backup path", "skipped (no matches)"),
        buildStatLine("deleted conversations", "0"),
        buildStatLine("deleted messages", "0"),
        buildStatLine("vacuumed", "no"),
        buildStatLine("quick_check", "not run (no writes)"),
        buildStatLine("result", "clean; no deletes ran"),
      ]),
    );
    return lines.join("\n");
  }

  let result: ReturnType<typeof applyDoctorCleaners>;
  try {
    result = applyDoctorCleaners(params.db, {
      databasePath: params.config.databasePath,
      filterIds,
      vacuum: params.vacuum,
    });
  } catch (error) {
    lines.push(
      buildSection("🛠️ Apply", [
        buildStatLine("status", "failed"),
        buildStatLine(
          "reason",
          error instanceof Error ? error.message : "unknown cleaner apply failure",
        ),
      ]),
    );
    return lines.join("\n");
  }

  if (result.kind === "unavailable") {
    lines.push(
      buildSection("🛠️ Apply", [
        buildStatLine("status", "unavailable"),
        buildStatLine("reason", result.reason),
      ]),
    );
    return lines.join("\n");
  }

  const quickCheck = runQuickCheck(params.db);
  const quickCheckPassed = isPassingQuickCheck(quickCheck);
  lines.push(
    buildSection("🛠️ Apply", [
      buildStatLine("status", quickCheckPassed ? "completed" : "warning"),
      buildStatLine("backup path", result.backupPath),
      buildStatLine("deleted conversations", formatNumber(result.deletedConversations)),
      buildStatLine("deleted messages", formatNumber(result.deletedMessages)),
      buildStatLine("vacuumed", formatBoolean(result.vacuumed)),
      buildStatLine("quick_check", quickCheck),
      buildStatLine(
        "result",
        quickCheckPassed
          ? result.deletedConversations > 0
            ? `removed ${formatNumber(result.deletedConversations)} conversation(s)`
            : "clean; no deletes ran"
          : "writes committed, but SQLite integrity verification reported problems; inspect the database or restore from the backup before continuing",
      ),
    ]),
  );

  return lines.join("\n");
}

async function buildDoctorApplyText(params: {
  ctx: PluginCommandContext;
  db: DatabaseSync;
  config: LcmConfig;
  deps?: LcmDependencies;
  summarize?: LcmSummarizeFn;
}): Promise<string> {
  const current = await resolveCurrentConversation(params);

  if (current.kind === "unavailable") {
    return [
      ...buildHeaderLines(),
      "",
      "🩺 Lossless Claw Doctor Apply",
      "",
      buildSection("📍 Current conversation", [
        buildStatLine("status", "unavailable"),
        buildStatLine("reason", current.reason),
        buildStatLine("fallback", "Doctor apply is conversation-scoped, so no global repair ran."),
      ]),
    ].join("\n");
  }

  const stats = getDoctorSummaryStats(params.db, current.stats.conversationId);
  let result: Awaited<ReturnType<typeof applyScopedDoctorRepair>>;
  try {
    result = await applyScopedDoctorRepair({
      db: params.db,
      config: params.config,
      conversationId: current.stats.conversationId,
      deps: params.deps,
      summarize: params.summarize,
      runtimeConfig: params.ctx.config,
      runtimeContext: readCommandRuntimeContext(params.ctx),
      sessionKey: current.stats.sessionKey ?? normalizeIdentity(params.ctx.sessionKey),
    });
  } catch (error) {
    return [
      ...buildHeaderLines(),
      "",
      "🩺 Lossless Claw Doctor Apply",
      "",
      buildSection("📍 Current conversation", [
        buildStatLine("conversation id", formatNumber(current.stats.conversationId)),
        buildStatLine(
          "session key",
          current.stats.sessionKey ? formatCommand(truncateMiddle(current.stats.sessionKey, 44)) : "missing",
        ),
        buildStatLine("scope", "this conversation only"),
      ]),
      "",
      buildSection("🛠️ Apply", [
        buildStatLine("mode", "in-place summary rewrite"),
        buildStatLine("status", "failed"),
        buildStatLine("reason", error instanceof Error ? error.message : "unknown repair failure"),
      ]),
    ].join("\n");
  }

  const lines = [
    ...buildHeaderLines(),
    "",
    "🩺 Lossless Claw Doctor Apply",
    "",
    buildSection("📍 Current conversation", [
      buildStatLine("conversation id", formatNumber(current.stats.conversationId)),
      buildStatLine(
        "session key",
        current.stats.sessionKey ? formatCommand(truncateMiddle(current.stats.sessionKey, 44)) : "missing",
      ),
      buildStatLine("scope", "this conversation only"),
    ]),
    "",
  ];

  if (result.kind === "unavailable") {
    lines.push(
      buildSection("🛠️ Apply", [
        buildStatLine("mode", "in-place summary rewrite"),
        buildStatLine("status", "unavailable"),
        buildStatLine("reason", result.reason),
      ]),
    );
    return lines.join("\n");
  }

  lines.push(
    buildSection("🛠️ Apply", [
      buildStatLine("mode", "in-place summary rewrite"),
      buildStatLine("detected summaries", formatNumber(stats.total)),
      buildStatLine("old-marker summaries", formatNumber(stats.old)),
      buildStatLine("truncated-marker summaries", formatNumber(stats.truncated)),
      buildStatLine("fallback-marker summaries", formatNumber(stats.fallback)),
      buildStatLine("repaired summaries", formatNumber(result.repaired)),
      buildStatLine("unchanged summaries", formatNumber(result.unchanged)),
      buildStatLine("skipped summaries", formatNumber(result.skipped.length)),
      buildStatLine(
        "result",
        stats.total === 0
          ? "clean; no writes ran"
          : result.repaired > 0
            ? `repaired ${formatNumber(result.repaired)} summary(s) in place`
            : "no repairs applied",
      ),
    ]),
  );

  if (result.repairedSummaryIds.length > 0) {
    lines.push(
      "",
      buildSection("🧷 Repaired summaries", [result.repairedSummaryIds.join(", ")]),
    );
  }

  if (result.skipped.length > 0) {
    lines.push(
      "",
      buildSection(
        "⚠️ Deferred",
        result.skipped.map((item) => `${item.summaryId}: ${item.reason}`),
      ),
    );
  }

  return lines.join("\n");
}

export function createLcmCommand(params: {
  db: DatabaseSync | (() => DatabaseSync | Promise<DatabaseSync>);
  config: LcmConfig;
  deps?: LcmDependencies;
  summarize?: LcmSummarizeFn;
  getLcm?: () => Promise<LcmCommandEngine>;
}): OpenClawPluginCommandDefinition {
  const getDb = async (): Promise<DatabaseSync> =>
    typeof params.db === "function" ? await params.db() : params.db;

  return {
    name: "lcm",
    nativeNames: {
      default: "lossless",
    },
    nativeProgressMessages: {
      telegram: "Lossless Claw is working...",
    },
    description:
      "Lossless Claw health, backups, compaction, junk review, and doctor tools.",
    acceptsArgs: true,
    handler: async (ctx) => {
      const parsed = parseLcmCommand(ctx.args);
      switch (parsed.kind) {
        case "status":
          return { text: await buildStatusText({ ctx, db: await getDb(), config: params.config }) };
        case "backup":
          return {
            text: await buildBackupText({
              db: await getDb(),
              config: params.config,
            }),
          };
        case "rotate":
          return {
            text: await buildRotateText({
              ctx,
              db: await getDb(),
              config: params.config,
              deps: params.deps,
              getLcm: params.getLcm,
            }),
          };
        case "focus_status":
          return { text: await buildFocusStatusText({ ctx, db: await getDb(), config: params.config }) };
        case "focus_generate":
          return {
            text: await buildFocusGenerateText({
              ctx,
              db: await getDb(),
              config: params.config,
              deps: params.deps,
              getLcm: params.getLcm,
              prompt: parsed.prompt,
            }),
          };
        case "refocus":
          return {
            text: await buildRefocusText({
              ctx,
              db: await getDb(),
              config: params.config,
              deps: params.deps,
              getLcm: params.getLcm,
            }),
          };
        case "unfocus":
          return {
            text: await buildUnfocusText({
              ctx,
              db: await getDb(),
              config: params.config,
              deps: params.deps,
              getLcm: params.getLcm,
            }),
          };
        case "doctor":
          return parsed.apply
            ? {
                text: await buildDoctorApplyText({
                  ctx,
                  db: await getDb(),
                  config: params.config,
                  deps: params.deps,
                  summarize: params.summarize,
                }),
              }
            : { text: await buildDoctorText({ ctx, db: await getDb() }) };
        case "doctor_cleaners":
          return parsed.apply
            ? {
                text: await buildDoctorCleanersApplyText({
                  db: await getDb(),
                  config: params.config,
                  filterId: parsed.filterId,
                  vacuum: parsed.vacuum,
                }),
              }
            : { text: await buildDoctorCleanersText({ db: await getDb() }) };
        case "session_memory_mode":
          return {
            text: await buildSessionMemoryModeText({
              ctx,
              db: await getDb(),
              getLcm: params.getLcm,
              action: parsed.action,
            }),
          };
        case "session_memory_profile":
          return {
            text: await buildSessionMemoryProfileText({
              ctx,
              db: await getDb(),
              getLcm: params.getLcm,
              action: parsed.action,
            }),
          };
        case "session_memory_schema":
          return {
            text: buildSessionMemorySchemaMaintenanceText({
              config: params.config,
              command: parsed.command,
            }),
          };
        case "session_memory_carry_forward":
          return {
            text: await buildSessionMemoryCarryForwardText({
              ctx,
              db: await getDb(),
              config: params.config,
              command: parsed.command,
            }),
          };
        case "session_memory_append_reviewed":
          return {
            text: await buildSessionMemoryAppendReviewedText({
              ctx,
              db: await getDb(),
              config: params.config,
              command: parsed.command,
            }),
          };
        case "session_memory_capture_candidates":
          return {
            text: await buildSessionMemoryCaptureCandidatesText({
              ctx,
              db: await getDb(),
              command: parsed.command,
            }),
          };
        case "help":
          return { text: buildHelpText(parsed.error) };
      }
    },
  };
}

export const __testing = {
  parseLcmCommand,
  parseSessionMemorySchemaArgs,
  detectDoctorMarker,
  getDoctorSummaryStats,
  getLcmStatusStats,
  getConversationStatusStats,
  scanDoctorCleaners,
  resolveCurrentConversation,
  resolveContextEngineSlot,
  resolvePluginEnabled,
  resolvePluginSelected,
};
