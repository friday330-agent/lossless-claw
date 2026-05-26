import { estimateTokens } from "./estimate-tokens.js";

const DEFAULT_STALE_AFTER_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_TOKENS = 800;

const REQUIRED_FIELDS = [
  ["current topic", "currentTopic"],
  ["user goal", "userGoal"],
  ["must-remember current conclusions", "mustRememberCurrentConclusions"],
  ["current stop point", "currentStopPoint"],
  ["current risk", "currentRisk"],
  ["next step", "nextStep"],
] as const;

type SessionMemoryFieldKey = (typeof REQUIRED_FIELDS)[number][1];

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
  const expected = new Map(REQUIRED_FIELDS);
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
    const key = expected.get(label);
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
