import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_SESSION_MEMORY_OVERLAY_CONFIG,
  parseSessionMemorySidecar,
  resolveSessionMemoryOverlay,
} from "../src/session-memory.js";

const VALID_SIDECAR = [
  "current topic: Lossless latest adaptation",
  "user goal: Keep the latest-native focus route and avoid runtime mutation",
  "must-remember current conclusions: Upstream focus overlay already exists",
  "current stop point: Phase 2 baseline passed in a sanitized test env",
  "current risk: MiniMax drift must not re-enter generation paths",
  "next step: Add parser-only session-memory diagnostics",
].join("\n");

describe("session-memory parser-only adapter", () => {
  it("parses a fresh six-field sidecar as an inactive candidate", () => {
    const result = parseSessionMemorySidecar({
      content: VALID_SIDECAR,
      sourcePath: "/tmp/session-memory.md",
      modifiedAt: new Date("2026-05-26T08:00:00.000Z"),
      now: new Date("2026-05-26T09:00:00.000Z"),
    });

    expect(result).toMatchObject({
      ok: true,
      candidate: {
        source: "session_memory_candidate",
        freshness: "fresh",
        budget: "within_budget",
        sourcePath: "/tmp/session-memory.md",
      },
    });
    expect(result.ok && result.candidate.fields.currentTopic).toBe("Lossless latest adaptation");
  });

  it("classifies stale sidecars with a skip reason", () => {
    const result = parseSessionMemorySidecar({
      content: VALID_SIDECAR,
      sourcePath: "/tmp/session-memory.md",
      modifiedAt: new Date("2026-05-24T08:00:00.000Z"),
      now: new Date("2026-05-26T09:00:00.000Z"),
      staleAfterMs: 24 * 60 * 60 * 1000,
    });

    expect(result).toMatchObject({
      ok: false,
      source: "session_memory_candidate",
      reason: "stale_session_memory",
    });
  });

  it("rejects malformed sidecars with missing, duplicate, empty, and unknown shapes", () => {
    const base = {
      sourcePath: "/tmp/session-memory.md",
      modifiedAt: new Date("2026-05-26T08:00:00.000Z"),
      now: new Date("2026-05-26T09:00:00.000Z"),
    };

    expect(parseSessionMemorySidecar({ ...base, content: "current topic: x" })).toMatchObject({
      ok: false,
      reason: "malformed_session_memory",
    });
    expect(
      parseSessionMemorySidecar({
        ...base,
        content: `${VALID_SIDECAR}\ncurrent topic: duplicate`,
      }),
    ).toMatchObject({ ok: false, reason: "malformed_session_memory" });
    expect(
      parseSessionMemorySidecar({
        ...base,
        content: VALID_SIDECAR.replace("next step: Add parser-only session-memory diagnostics", "next step: "),
      }),
    ).toMatchObject({ ok: false, reason: "malformed_session_memory" });
    expect(
      parseSessionMemorySidecar({
        ...base,
        content: `${VALID_SIDECAR}\nextra heading`,
      }),
    ).toMatchObject({ ok: false, reason: "malformed_session_memory" });
  });

  it("reports over-budget candidates without truncating them into active context", () => {
    const result = parseSessionMemorySidecar({
      content: VALID_SIDECAR,
      sourcePath: "/tmp/session-memory.md",
      modifiedAt: new Date("2026-05-26T08:00:00.000Z"),
      now: new Date("2026-05-26T09:00:00.000Z"),
      maxTokens: 1,
    });

    expect(result).toMatchObject({
      ok: false,
      source: "session_memory_candidate",
      reason: "over_budget",
    });
  });
});

describe("session-memory read-only overlay boundary", () => {
  it("skips disabled overlay lookup before any DB side effect", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lossless-session-memory-disabled-"));
    const dbPath = join(tempDir, "session-memory.db");
    let lookupCalled = false;

    try {
      const result = await resolveSessionMemoryOverlay({
        config: {
          ...DEFAULT_SESSION_MEMORY_OVERLAY_CONFIG,
          enabled: false,
          dbPath,
        },
        request: {
          conversationId: 123,
          sessionId: "session-disabled",
          sessionKey: "agent:main:test",
        },
        lookup: async () => {
          lookupCalled = true;
          writeFileSync(dbPath, "must not be created");
          return {
            ok: false,
            source: "session_memory_overlay",
            reason: "read_error",
          };
        },
      });

      expect(result).toEqual({
        ok: false,
        source: "session_memory_overlay",
        reason: "disabled",
      });
      expect(lookupCalled).toBe(false);
      expect(existsSync(dbPath)).toBe(false);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("skips enabled default lookup when the DB is absent without creating it", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lossless-session-memory-absent-"));
    const dbPath = join(tempDir, "session-memory.db");

    try {
      const result = await resolveSessionMemoryOverlay({
        config: {
          ...DEFAULT_SESSION_MEMORY_OVERLAY_CONFIG,
          enabled: true,
          dbPath,
        },
        request: {
          conversationId: 123,
          sessionId: "session-absent",
          sessionKey: "agent:main:test",
        },
      });

      expect(result).toEqual({
        ok: false,
        source: "session_memory_overlay",
        reason: "db_absent",
      });
      expect(existsSync(dbPath)).toBe(false);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("converts enabled lookup failures into read_error without DB side effects", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lossless-session-memory-read-error-"));
    const dbPath = join(tempDir, "session-memory.db");

    try {
      const result = await resolveSessionMemoryOverlay({
        config: {
          ...DEFAULT_SESSION_MEMORY_OVERLAY_CONFIG,
          enabled: true,
          dbPath,
        },
        request: {
          conversationId: 123,
          sessionId: "session-read-error",
          sessionKey: "agent:main:test",
        },
        lookup: async () => {
          throw new Error("read-only open failed");
        },
      });

      expect(result).toEqual({
        ok: false,
        source: "session_memory_overlay",
        reason: "read_error",
      });
      expect(existsSync(dbPath)).toBe(false);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
