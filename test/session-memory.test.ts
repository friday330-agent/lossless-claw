import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  buildSessionMemoryOverlayTelemetry,
  DEFAULT_SESSION_MEMORY_OVERLAY_CONFIG,
  parseSessionMemorySidecar,
  renderSessionMemoryOverlay,
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

  it("lets the kill switch skip before lookup or DB side effects", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lossless-session-memory-kill-switch-"));
    const dbPath = join(tempDir, "session-memory.db");
    let lookupCalled = false;

    try {
      const result = await resolveSessionMemoryOverlay({
        config: {
          ...DEFAULT_SESSION_MEMORY_OVERLAY_CONFIG,
          enabled: true,
          killSwitchEnabled: true,
          dbPath,
        },
        request: {
          conversationId: 123,
          sessionId: "session-kill-switch",
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
        reason: "kill_switch",
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

  it("treats unreadable DB files as read_error", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lossless-session-memory-invalid-db-"));
    const dbPath = join(tempDir, "session-memory.db");
    writeFileSync(dbPath, "not a sqlite database");

    try {
      const result = await resolveSessionMemoryOverlay({
        config: {
          ...DEFAULT_SESSION_MEMORY_OVERLAY_CONFIG,
          enabled: true,
          dbPath,
        },
        request: {
          conversationId: 123,
          sessionId: "session-invalid-db",
          sessionKey: "agent:main:test",
        },
      });

      expect(result).toEqual({
        ok: false,
        source: "session_memory_overlay",
        reason: "read_error",
      });
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("skips read-only fixture DBs with missing schema without creating WAL sidecars", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lossless-session-memory-missing-schema-"));
    const dbPath = join(tempDir, "session-memory.db");
    const db = new DatabaseSync(dbPath);
    db.exec("CREATE TABLE unrelated (id TEXT PRIMARY KEY)");
    db.close();

    try {
      const result = await resolveSessionMemoryOverlay({
        config: {
          ...DEFAULT_SESSION_MEMORY_OVERLAY_CONFIG,
          enabled: true,
          dbPath,
        },
        request: {
          conversationId: 123,
          sessionId: "session-missing-schema",
          sessionKey: "agent:main:test",
        },
      });

      expect(result).toEqual({
        ok: false,
        source: "session_memory_overlay",
        reason: "schema_missing",
      });
      expect(existsSync(`${dbPath}-wal`)).toBe(false);
      expect(existsSync(`${dbPath}-shm`)).toBe(false);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("skips fixture DBs with old and future schema versions", async () => {
    const oldFixture = createCompatibleSessionMemoryFixture({ userVersion: 0, migrationVersion: 0 });
    const futureFixture = createCompatibleSessionMemoryFixture({ userVersion: 3, migrationVersion: 3 });

    try {
      await expect(
        resolveSessionMemoryOverlay({
          config: {
            ...DEFAULT_SESSION_MEMORY_OVERLAY_CONFIG,
            enabled: true,
            dbPath: oldFixture.dbPath,
          },
          request: {
            conversationId: 123,
            sessionKey: "agent:main:test",
          },
        }),
      ).resolves.toEqual({
        ok: false,
        source: "session_memory_overlay",
        reason: "schema_too_old",
      });

      await expect(
        resolveSessionMemoryOverlay({
          config: {
            ...DEFAULT_SESSION_MEMORY_OVERLAY_CONFIG,
            enabled: true,
            dbPath: futureFixture.dbPath,
          },
          request: {
            conversationId: 123,
            sessionKey: "agent:main:test",
          },
        }),
      ).resolves.toEqual({
        ok: false,
        source: "session_memory_overlay",
        reason: "schema_too_new",
      });
    } finally {
      oldFixture.cleanup();
      futureFixture.cleanup();
    }
  });

  it("reads active entries from additive v2 schema DBs through the stable v1 projection", async () => {
    const fixture = createCompatibleSessionMemoryFixture({
      userVersion: 2,
      migrationVersion: 2,
      includeSemanticColumns: true,
    });
    const db = new DatabaseSync(fixture.dbPath);
    insertActiveSessionMemoryEntry(db, {
      sourceRefsJson: '[{"type":"workspace_file","path":"Friday-memory/CURRENT.md","line":1}]',
    });
    db
      .prepare(
        `UPDATE entries
         SET logical_kind = 'reviewed_decision',
             project_id = 'lossless-session-memory',
             workline_id = 'gate40-first-reviewed-entry',
             details_json = '{"decision":"fixture"}',
             evidence_level = 'committed_plan',
             review_state = 'accepted'
         WHERE entry_id = 'entry-1'`,
      )
      .run();
    db.close();

    try {
      const result = await resolveSessionMemoryOverlay({
        config: {
          ...DEFAULT_SESSION_MEMORY_OVERLAY_CONFIG,
          enabled: true,
          dbPath: fixture.dbPath,
        },
        request: {
          conversationId: 123,
          sessionKey: "agent:main:test",
        },
      });

      expect(result).toMatchObject({
        ok: true,
        source: "session_memory_overlay",
        sessionId: "session-active",
        segmentId: "segment-active",
        entries: [
          {
            entryId: "entry-1",
            kind: "decision",
            body: "Keep session-memory read-only until assembler wiring is separately approved.",
          },
        ],
      });
    } finally {
      fixture.cleanup();
    }
  });

  it("skips fixture DBs with missing required lookup indexes", async () => {
    const fixture = createCompatibleSessionMemoryFixture({ includeIndexes: false });

    try {
      const result = await resolveSessionMemoryOverlay({
        config: {
          ...DEFAULT_SESSION_MEMORY_OVERLAY_CONFIG,
          enabled: true,
          dbPath: fixture.dbPath,
        },
        request: {
          conversationId: 123,
          sessionKey: "agent:main:test",
        },
      });

      expect(result).toEqual({
        ok: false,
        source: "session_memory_overlay",
        reason: "schema_index_missing",
      });
    } finally {
      fixture.cleanup();
    }
  });

  it("skips fixture DBs with missing required columns", async () => {
    const cases = [
      {
        name: "sessions.updated_at",
        fixture: createCompatibleSessionMemoryFixture({
          includeIndexes: false,
          omitColumns: { sessions: ["updated_at"] },
        }),
      },
      {
        name: "entries.body",
        fixture: createCompatibleSessionMemoryFixture({ omitColumns: { entries: ["body"] } }),
      },
      {
        name: "schema_migrations.schema_version",
        fixture: createCompatibleSessionMemoryFixture({ omitColumns: { schema_migrations: ["schema_version"] } }),
      },
    ];

    try {
      for (const { name, fixture } of cases) {
        const result = await resolveSessionMemoryOverlay({
          config: {
            ...DEFAULT_SESSION_MEMORY_OVERLAY_CONFIG,
            enabled: true,
            dbPath: fixture.dbPath,
          },
          request: {
            conversationId: 123,
            sessionKey: "agent:main:test",
          },
        });

        expect(result, name).toEqual({
          ok: false,
          source: "session_memory_overlay",
          reason: "schema_missing",
        });
      }
    } finally {
      for (const { fixture } of cases) {
        fixture.cleanup();
      }
    }
  });

  it("skips fixture DBs with missing required unique constraints", async () => {
    const fixture = createCompatibleSessionMemoryFixture({ includeUniqueConstraints: false });

    try {
      const result = await resolveSessionMemoryOverlay({
        config: {
          ...DEFAULT_SESSION_MEMORY_OVERLAY_CONFIG,
          enabled: true,
          dbPath: fixture.dbPath,
        },
        request: {
          conversationId: 123,
          sessionKey: "agent:main:test",
        },
      });

      expect(result).toEqual({
        ok: false,
        source: "session_memory_overlay",
        reason: "schema_constraint_missing",
      });
    } finally {
      fixture.cleanup();
    }
  });

  it("skips compatible fixture DBs with no active entries", async () => {
    const fixture = createCompatibleSessionMemoryFixture();

    try {
      const result = await resolveSessionMemoryOverlay({
        config: {
          ...DEFAULT_SESSION_MEMORY_OVERLAY_CONFIG,
          enabled: true,
          dbPath: fixture.dbPath,
        },
        request: {
          conversationId: 123,
          sessionKey: "agent:main:test",
        },
      });

      expect(result).toEqual({
        ok: false,
        source: "session_memory_overlay",
        reason: "no_active_entries",
      });
    } finally {
      fixture.cleanup();
    }
  });

  it("skips active entries when the DB overlay projection is stale", async () => {
    const fixture = createCompatibleSessionMemoryFixture();
    const db = new DatabaseSync(fixture.dbPath);
    insertActiveSessionMemoryEntry(db, {
      sessionUpdatedAt: "2000-01-01T00:00:00.000Z",
      segmentUpdatedAt: "2000-01-01T00:00:00.000Z",
      entryUpdatedAt: "2000-01-01T00:00:00.000Z",
    });
    db.close();

    try {
      const result = await resolveSessionMemoryOverlay({
        config: {
          ...DEFAULT_SESSION_MEMORY_OVERLAY_CONFIG,
          enabled: true,
          dbPath: fixture.dbPath,
          staleAfterMs: 1,
        },
        request: {
          conversationId: 123,
          sessionKey: "agent:main:test",
        },
      });

      expect(result).toEqual({
        ok: false,
        source: "session_memory_overlay",
        reason: "stale_projection",
      });
    } finally {
      fixture.cleanup();
    }
  });

  it("keeps old active entries when the active segment has a fresh projection timestamp", async () => {
    const fixture = createCompatibleSessionMemoryFixture();
    const db = new DatabaseSync(fixture.dbPath);
    insertActiveSessionMemoryEntry(db, {
      sessionUpdatedAt: "2999-01-01T00:00:00.000Z",
      segmentUpdatedAt: "2999-01-01T00:00:00.000Z",
      entryUpdatedAt: "2000-01-01T00:00:00.000Z",
    });
    db.close();

    try {
      const result = await resolveSessionMemoryOverlay({
        config: {
          ...DEFAULT_SESSION_MEMORY_OVERLAY_CONFIG,
          enabled: true,
          dbPath: fixture.dbPath,
          staleAfterMs: 1,
        },
        request: {
          conversationId: 123,
          sessionKey: "agent:main:test",
        },
      });

      expect(result).toMatchObject({
        ok: true,
        source: "session_memory_overlay",
        entries: [
          {
            entryId: "entry-1",
            updatedAt: "2000-01-01T00:00:00.000Z",
          },
        ],
      });
    } finally {
      fixture.cleanup();
    }
  });

  it("skips active entries when the lcm provenance DB schema is incompatible", async () => {
    const fixture = createCompatibleSessionMemoryFixture();
    const lcmFixture = createLcmFixture({ compatibleSchema: false });
    const db = new DatabaseSync(fixture.dbPath);
    insertActiveSessionMemoryEntry(db, {
      sourceRefsJson: '[{"type":"lcm_summary","summary_id":"sum_example"}]',
    });
    db.close();

    try {
      const result = await resolveSessionMemoryOverlay({
        config: {
          ...DEFAULT_SESSION_MEMORY_OVERLAY_CONFIG,
          enabled: true,
          dbPath: fixture.dbPath,
          lcmDbPath: lcmFixture.dbPath,
        },
        request: {
          conversationId: 123,
          sessionKey: "agent:main:test",
        },
      });

      expect(result).toEqual({
        ok: false,
        source: "session_memory_overlay",
        reason: "lcm_schema_incompatible",
      });
    } finally {
      fixture.cleanup();
      lcmFixture.cleanup();
    }
  });

  it("skips lcm-backed entries when required lcm anchor tables are missing", async () => {
    const fixture = createCompatibleSessionMemoryFixture();
    const lcmFixture = createLcmFixture({ summaries: ["sum_example"], omitTables: ["context_items"] });
    const db = new DatabaseSync(fixture.dbPath);
    insertActiveSessionMemoryEntry(db, {
      sourceRefsJson: '[{"type":"lcm_summary","summary_id":"sum_example"}]',
    });
    db.close();

    try {
      const result = await resolveSessionMemoryOverlay({
        config: {
          ...DEFAULT_SESSION_MEMORY_OVERLAY_CONFIG,
          enabled: true,
          dbPath: fixture.dbPath,
          lcmDbPath: lcmFixture.dbPath,
        },
        request: {
          conversationId: 123,
          sessionKey: "agent:main:test",
        },
      });

      expect(result).toEqual({
        ok: false,
        source: "session_memory_overlay",
        reason: "lcm_schema_incompatible",
      });
    } finally {
      fixture.cleanup();
      lcmFixture.cleanup();
    }
  });

  it("skips lcm-backed entries when required lcm anchor columns are missing", async () => {
    const fixture = createCompatibleSessionMemoryFixture();
    const lcmFixture = createLcmFixture({
      focusBriefs: ["focus_example"],
      omitColumns: { focus_brief_sources: ["summary_id"] },
    });
    const db = new DatabaseSync(fixture.dbPath);
    insertActiveSessionMemoryEntry(db, {
      sourceRefsJson: '[{"type":"focus_brief","brief_id":"focus_example"}]',
    });
    db.close();

    try {
      const result = await resolveSessionMemoryOverlay({
        config: {
          ...DEFAULT_SESSION_MEMORY_OVERLAY_CONFIG,
          enabled: true,
          dbPath: fixture.dbPath,
          lcmDbPath: lcmFixture.dbPath,
        },
        request: {
          conversationId: 123,
          sessionKey: "agent:main:test",
        },
      });

      expect(result).toEqual({
        ok: false,
        source: "session_memory_overlay",
        reason: "lcm_schema_incompatible",
      });
    } finally {
      fixture.cleanup();
      lcmFixture.cleanup();
    }
  });

  it("keeps local-only source refs independent from lcm DB availability", async () => {
    const fixture = createCompatibleSessionMemoryFixture();
    const db = new DatabaseSync(fixture.dbPath);
    insertActiveSessionMemoryEntry(db, {
      sourceRefsJson:
        '[{"type":"workspace_file","path":"Friday-memory/CURRENT.md","line":1},{"type":"checkpoint","checkpoint_id":"checkpoint-1"}]',
    });
    db.close();

    try {
      const result = await resolveSessionMemoryOverlay({
        config: {
          ...DEFAULT_SESSION_MEMORY_OVERLAY_CONFIG,
          enabled: true,
          dbPath: fixture.dbPath,
          lcmDbPath: join(fixture.tempDir, "missing-lcm.db"),
        },
        request: {
          conversationId: 123,
          sessionKey: "agent:main:test",
        },
      });

      expect(result).toMatchObject({
        ok: true,
        source: "session_memory_overlay",
        entries: [
          {
            sourceRefs: [
              { type: "workspace_file", path: "Friday-memory/CURRENT.md", line: 1 },
              { type: "checkpoint", checkpointId: "checkpoint-1" },
            ],
          },
        ],
      });
    } finally {
      fixture.cleanup();
    }
  });

  it("skips active entries when lcm source refs are missing", async () => {
    const fixture = createCompatibleSessionMemoryFixture();
    const lcmFixture = createLcmFixture();
    const db = new DatabaseSync(fixture.dbPath);
    insertActiveSessionMemoryEntry(db, {
      sourceRefsJson: '[{"type":"lcm_summary","summary_id":"sum_missing"}]',
    });
    db.close();

    try {
      const result = await resolveSessionMemoryOverlay({
        config: {
          ...DEFAULT_SESSION_MEMORY_OVERLAY_CONFIG,
          enabled: true,
          dbPath: fixture.dbPath,
          lcmDbPath: lcmFixture.dbPath,
        },
        request: {
          conversationId: 123,
          sessionKey: "agent:main:test",
        },
      });

      expect(result).toEqual({
        ok: false,
        source: "session_memory_overlay",
        reason: "source_ref_missing",
      });
    } finally {
      fixture.cleanup();
      lcmFixture.cleanup();
    }
  });

  it("skips active entries that contain raw transcript-shaped body text", async () => {
    const fixture = createCompatibleSessionMemoryFixture();
    const db = new DatabaseSync(fixture.dbPath);
    insertActiveSessionMemoryEntry(db, {
      body: ["user: Can you inspect the DB?", "assistant: I will check it now."].join("\n"),
    });
    db.close();

    try {
      const result = await resolveSessionMemoryOverlay({
        config: {
          ...DEFAULT_SESSION_MEMORY_OVERLAY_CONFIG,
          enabled: true,
          dbPath: fixture.dbPath,
        },
        request: {
          conversationId: 123,
          sessionKey: "agent:main:test",
        },
      });

      expect(result).toEqual({
        ok: false,
        source: "session_memory_overlay",
        reason: "raw_transcript_detected",
      });
    } finally {
      fixture.cleanup();
    }
  });

  it("does not create Friday-memory files for workspace source refs", async () => {
    const fixture = createCompatibleSessionMemoryFixture();
    const db = new DatabaseSync(fixture.dbPath);
    insertActiveSessionMemoryEntry(db, {
      sourceRefsJson: '[{"type":"workspace_file","path":"Friday-memory/CURRENT.md","line":1}]',
    });
    db.close();
    const tempFridayMemoryPath = join(fixture.tempDir, "Friday-memory");

    try {
      const result = await resolveSessionMemoryOverlay({
        config: {
          ...DEFAULT_SESSION_MEMORY_OVERLAY_CONFIG,
          enabled: true,
          dbPath: fixture.dbPath,
        },
        request: {
          conversationId: 123,
          sessionKey: "agent:main:test",
        },
      });

      expect(result).toMatchObject({
        ok: true,
        source: "session_memory_overlay",
        entries: [
          {
            sourceRefs: [{ type: "workspace_file", path: "Friday-memory/CURRENT.md", line: 1 }],
          },
        ],
      });
      expect(existsSync(tempFridayMemoryPath)).toBe(false);
    } finally {
      fixture.cleanup();
    }
  });

  it("reads active entries from a compatible fixture DB without creating WAL sidecars", async () => {
    const fixture = createCompatibleSessionMemoryFixture();
    const lcmFixture = createLcmFixture({
      summaries: ["sum_example"],
      focusBriefs: ["focus_example"],
      messages: [
        { conversationId: 123, seq: 260 },
        { conversationId: 123, seq: 280 },
      ],
    });
    const db = new DatabaseSync(fixture.dbPath);
    insertActiveSessionMemoryEntry(db, {
      sourceRefsJson:
        '[{"type":"lcm_summary","summary_id":"sum_example"},{"type":"focus_brief","brief_id":"focus_example"},{"type":"lcm_message_range","conversation_id":123,"session_key":"agent:main:test","start_seq":260,"end_seq":280}]',
    });
    db.close();

    try {
      const result = await resolveSessionMemoryOverlay({
        config: {
          ...DEFAULT_SESSION_MEMORY_OVERLAY_CONFIG,
          enabled: true,
          dbPath: fixture.dbPath,
          lcmDbPath: lcmFixture.dbPath,
        },
        request: {
          conversationId: 123,
          sessionKey: "agent:main:test",
        },
      });

      expect(result).toMatchObject({
        ok: true,
        source: "session_memory_overlay",
        sessionId: "session-active",
        segmentId: "segment-active",
        entries: [
          {
            entryId: "entry-1",
            segmentId: "segment-active",
            kind: "decision",
            priority: 10,
            body: "Keep session-memory read-only until assembler wiring is separately approved.",
            updatedAt: "2999-01-01T00:00:00.000Z",
            sourceRefs: [
              { type: "lcm_summary", summaryId: "sum_example" },
              { type: "focus_brief", briefId: "focus_example" },
              {
                type: "lcm_message_range",
                conversationId: 123,
                sessionKey: "agent:main:test",
                startSeq: 260,
                endSeq: 280,
              },
            ],
          },
        ],
      });
      expect(result.ok && result.projectionKey).toContain("entry-1");
      expect(existsSync(`${fixture.dbPath}-wal`)).toBe(false);
      expect(existsSync(`${fixture.dbPath}-shm`)).toBe(false);
    } finally {
      fixture.cleanup();
      lcmFixture.cleanup();
    }
  });

  it("renders active entries in deterministic groups and skips over-budget output by default", async () => {
    const lookupResult = {
      ok: true as const,
      source: "session_memory_overlay" as const,
      sessionId: "session-active",
      segmentId: "segment-active",
      projectionKey: "entry-constraint|entry-decision|entry-action",
      entries: [
        {
          entryId: "entry-action",
          segmentId: "segment-active",
          kind: "next_action" as const,
          priority: 5,
          body: "Add fixture tests before assembler wiring.",
          updatedAt: "2026-06-06T08:02:00.000Z",
          sourceRefs: [{ type: "workspace_file" as const, path: "Friday-memory/CURRENT.md", line: 55 }],
        },
        {
          entryId: "entry-decision",
          segmentId: "segment-active",
          kind: "decision" as const,
          priority: 10,
          body: "Keep focus first, session-memory second, fresh tail last.",
          updatedAt: "2026-06-06T08:01:00.000Z",
          sourceRefs: [{ type: "focus_brief" as const, briefId: "focus_123" }],
        },
        {
          entryId: "entry-constraint",
          segmentId: "segment-active",
          kind: "constraint" as const,
          priority: 1,
          body: "Do not create the real session-memory DB.",
          updatedAt: "2026-06-06T08:03:00.000Z",
          sourceRefs: [{ type: "lcm_summary" as const, summaryId: "sum_123" }],
        },
      ],
    };

    const rendered = renderSessionMemoryOverlay(lookupResult, {
      ...DEFAULT_SESSION_MEMORY_OVERLAY_CONFIG,
      enabled: true,
      maxTokens: 800,
    });

    expect(rendered).toMatchObject({
      ok: true,
      source: "session_memory_overlay",
      tokenCount: expect.any(Number),
      ordering: "after_focus_before_fresh_tail",
    });
    if (!rendered.ok) {
      throw new Error("expected rendered session-memory overlay");
    }
    expect(rendered.content).toContain(
      '<session_memory source="session_memory" version="session_memory_overlay_v1" session_id="session-active" segment_id="segment-active" entries="3"',
    );
    expect(rendered.content.indexOf("Constraints:\n- Do not create the real session-memory DB.")).toBeLessThan(
      rendered.content.indexOf("Decisions:\n- Keep focus first, session-memory second, fresh tail last."),
    );
    expect(rendered.content.indexOf("Decisions:\n- Keep focus first, session-memory second, fresh tail last.")).toBeLessThan(
      rendered.content.indexOf("Next actions:\n- Add fixture tests before assembler wiring."),
    );
    expect(rendered.content).toContain("Source refs:");
    expect(rendered.content).toContain("entry_id=entry-constraint refs=[lcm_summary:sum_123]");
    expect(rendered.content).toContain("entry_id=entry-decision refs=[focus_brief:focus_123]");
    expect(rendered.content).toContain("entry_id=entry-action refs=[workspace_file:Friday-memory/CURRENT.md:55]");

    const overBudget = renderSessionMemoryOverlay(lookupResult, {
      ...DEFAULT_SESSION_MEMORY_OVERLAY_CONFIG,
      enabled: true,
      maxTokens: 1,
      truncationEnabled: false,
    });

    expect(overBudget).toEqual({
      ok: false,
      source: "session_memory_overlay",
      reason: "over_budget",
    });
  });

  it("keeps an active experiment objective anchor ahead of business artifact facts", async () => {
    const lookupResult = {
      ok: true as const,
      source: "session_memory_overlay" as const,
      sessionId: "session-gate46",
      segmentId: "segment-gate46",
      projectionKey: "gate46-objective-anchor",
      entries: [
        {
          entryId: "gate46-business-artifact",
          segmentId: "segment-gate46",
          kind: "fact" as const,
          priority: 95,
          body: "W550 created the FirArt wiki architecture canvas and Friday verified that Obsidian can list it.",
          updatedAt: "2026-07-01T07:10:00.000Z",
          sourceRefs: [{ type: "workspace_file" as const, path: "Friday-memory/work/w550-skills-observation.md" }],
        },
        {
          entryId: "gate46-objective-anchor",
          segmentId: "segment-gate46",
          kind: "constraint" as const,
          priority: 100,
          body: "Current active experiment: test whether session-memory helps Friday preserve the real objective of this W550 trial, not merely whether the requested canvas artifact exists.",
          updatedAt: "2026-07-01T07:12:00.000Z",
          sourceRefs: [
            {
              type: "workspace_file" as const,
              path: "Friday-memory/plans/Friday/session-memory-gate46-objective-anchor-canary-2026-07-01.md",
            },
          ],
        },
        {
          entryId: "gate46-failure-signal",
          segmentId: "segment-gate46",
          kind: "risk" as const,
          priority: 90,
          body: "Failure signal: answering only with canvas path, JSON validity, or Obsidian visibility misses the session-memory test objective.",
          updatedAt: "2026-07-01T07:13:00.000Z",
          sourceRefs: [
            {
              type: "workspace_file" as const,
              path: "Friday-memory/plans/Friday/session-memory-gate46-objective-anchor-canary-2026-07-01.md",
            },
          ],
        },
      ],
    };

    const rendered = renderSessionMemoryOverlay(lookupResult, {
      ...DEFAULT_SESSION_MEMORY_OVERLAY_CONFIG,
      enabled: true,
      maxTokens: 800,
    });

    if (!rendered.ok) {
      throw new Error("expected rendered session-memory overlay");
    }
    expect(rendered.content.indexOf("Current active experiment: test whether session-memory")).toBeLessThan(
      rendered.content.indexOf("W550 created the FirArt wiki architecture canvas"),
    );
    expect(rendered.content).toContain(
      "Failure signal: answering only with canvas path, JSON validity, or Obsidian visibility misses the session-memory test objective.",
    );
  });

  it("renders a compact overlay profile with typed bullets and a smaller token footprint", async () => {
    const lookupResult = {
      ok: true as const,
      source: "session_memory_overlay" as const,
      sessionId: "session-active",
      segmentId: "segment-active",
      projectionKey: "entry-key",
      entries: [
        {
          entryId: "entry-action",
          segmentId: "segment-active",
          kind: "next_action" as const,
          priority: 5,
          body: "Improve compact overlay render profile before any runtime enablement.",
          updatedAt: "2026-06-20T05:02:00.000Z",
          sourceRefs: [{ type: "workspace_file" as const, path: "Friday-memory/CURRENT.md", line: 55 }],
        },
        {
          entryId: "entry-decision",
          segmentId: "segment-active",
          kind: "decision" as const,
          priority: 10,
          body: "Keep runtime overlay insertion disabled while evaluating render shape.",
          updatedAt: "2026-06-20T05:01:00.000Z",
          sourceRefs: [{ type: "focus_brief" as const, briefId: "focus_123" }],
        },
        {
          entryId: "entry-constraint",
          segmentId: "segment-active",
          kind: "constraint" as const,
          priority: 1,
          body: "Do not run another writer gate for this render-profile improvement.",
          updatedAt: "2026-06-20T05:03:00.000Z",
          sourceRefs: [{ type: "lcm_summary" as const, summaryId: "sum_123" }],
        },
      ],
    };

    const grouped = renderSessionMemoryOverlay(lookupResult, {
      ...DEFAULT_SESSION_MEMORY_OVERLAY_CONFIG,
      enabled: true,
      maxTokens: 800,
      renderProfile: "grouped",
    });
    const compact = renderSessionMemoryOverlay(lookupResult, {
      ...DEFAULT_SESSION_MEMORY_OVERLAY_CONFIG,
      enabled: true,
      maxTokens: 800,
      renderProfile: "compact",
    });

    if (!grouped.ok || !compact.ok) {
      throw new Error("expected grouped and compact session-memory overlays");
    }
    expect(compact.content).toContain('profile="compact"');
    expect(compact.content).toContain("- constraint id=entry-constraint refs=1:");
    expect(compact.content).toContain("- decision id=entry-decision refs=1:");
    expect(compact.content).toContain("- next_action id=entry-action refs=1:");
    expect(compact.content).not.toContain("Source refs:");
    expect(compact.content).not.toContain("workspace_file:Friday-memory/CURRENT.md:55");
    expect(compact.tokenCount).toBeLessThan(grouped.tokenCount);
    expect(compact.projectionKey).not.toBe(grouped.projectionKey);
  });

  it("builds separate session-memory telemetry and projection keys without selected-source labels", async () => {
    const baseLookupResult = {
      ok: true as const,
      source: "session_memory_overlay" as const,
      sessionId: "session-active",
      segmentId: "segment-active",
      projectionKey: "legacy-entry-key",
      entries: [
        {
          entryId: "entry-1",
          segmentId: "segment-active",
          kind: "decision" as const,
          priority: 10,
          body: "Keep session-memory telemetry separate from assembly source labels.",
          bodyHash: "body-hash-1",
          version: 1,
          updatedAt: "2026-06-06T08:01:00.000Z",
          sourceRefs: [{ type: "lcm_summary" as const, summaryId: "sum_123" }],
        },
      ],
    };
    const config = {
      ...DEFAULT_SESSION_MEMORY_OVERLAY_CONFIG,
      enabled: true,
      maxTokens: 800,
      renderVersion: "session_memory_overlay_v1",
    };

    const rendered = renderSessionMemoryOverlay(baseLookupResult, config);
    expect(rendered).toMatchObject({
      ok: true,
      source: "session_memory_overlay",
      projectionKey: expect.stringMatching(/^session_memory_overlay_v1:/),
    });
    if (!rendered.ok) {
      throw new Error("expected rendered session-memory overlay");
    }

    const telemetry = buildSessionMemoryOverlayTelemetry(rendered);
    expect(telemetry).toEqual({
      surface: "session_memory",
      state: "inserted",
      insertedCount: 1,
      skippedCount: 0,
      skippedReason: undefined,
      renderedTokens: rendered.tokenCount,
      entryCount: 1,
      segmentId: "segment-active",
      sourceRefsCount: 1,
      projectionKey: rendered.projectionKey,
      effectiveMode: "overlay-readonly",
      renderVersion: "session_memory_overlay_v1",
      renderProfile: "grouped",
    });
    expect(JSON.stringify(telemetry)).not.toContain("raw_only");
    expect(JSON.stringify(telemetry)).not.toContain("dag_summary");
    expect(JSON.stringify(telemetry)).not.toContain("focus_brief");

    const changedSourceRefs = renderSessionMemoryOverlay(
      {
        ...baseLookupResult,
        entries: [
          {
            ...baseLookupResult.entries[0],
            sourceRefs: [{ type: "focus_brief" as const, briefId: "focus_123" }],
          },
        ],
      },
      config,
    );
    const changedCap = renderSessionMemoryOverlay(baseLookupResult, {
      ...config,
      maxTokens: 1600,
    });
    const skippedTelemetry = buildSessionMemoryOverlayTelemetry({
      ok: false,
      source: "session_memory_overlay",
      reason: "db_absent",
    });

    expect(changedSourceRefs.ok && changedSourceRefs.projectionKey).not.toBe(rendered.projectionKey);
    expect(changedCap.ok && changedCap.projectionKey).not.toBe(rendered.projectionKey);
    expect(skippedTelemetry).toEqual({
      surface: "session_memory",
      state: "skipped",
      insertedCount: 0,
      skippedCount: 1,
      skippedReason: "db_absent",
      renderedTokens: 0,
      entryCount: 0,
      segmentId: undefined,
      sourceRefsCount: 0,
      projectionKey: undefined,
      effectiveMode: "native",
      renderVersion: "session_memory_overlay_v1",
      renderProfile: "grouped",
    });
  });
});

function insertActiveSessionMemoryEntry(
  db: DatabaseSync,
  options?: {
    body?: string;
    sourceRefsJson?: string;
    sessionUpdatedAt?: string;
    segmentUpdatedAt?: string;
    entryUpdatedAt?: string;
  },
): void {
  const sessionUpdatedAt = options?.sessionUpdatedAt ?? "2999-01-01T00:00:00.000Z";
  const segmentUpdatedAt = options?.segmentUpdatedAt ?? "2999-01-01T00:00:00.000Z";
  const entryUpdatedAt = options?.entryUpdatedAt ?? "2999-01-01T00:00:00.000Z";
  db.exec(`
    INSERT INTO sessions (
      session_id, conversation_id, session_key, status, title, started_at, ended_at, created_at, updated_at, metadata_json
    ) VALUES (
      'session-active', 123, 'agent:main:test', 'active', NULL, '2026-06-06T08:00:00.000Z', NULL,
      '2026-06-06T08:00:00.000Z', '${sessionUpdatedAt}', NULL
    );
    INSERT INTO segments (
      segment_id, session_id, seq, status, start_ref_json, end_ref_json, token_estimate, entry_count,
      opened_at, closed_at, created_at, updated_at
    ) VALUES (
      'segment-active', 'session-active', 1, 'active', NULL, NULL, 42, 1,
      '2026-06-06T08:00:00.000Z', NULL, '2026-06-06T08:00:00.000Z', '${segmentUpdatedAt}'
    );
  `);
  db.prepare(
    `INSERT INTO entries (
      entry_id, session_id, segment_id, kind, status, confidence, priority, title, body, source_refs_json,
      origin_entry_id, superseded_by_entry_id, created_at, updated_at, settled_at
    ) VALUES (
      'entry-1', 'session-active', 'segment-active', 'decision', 'active', 0.9, 10, NULL,
      ?, ?, NULL, NULL, '2026-06-06T08:03:00.000Z', ?, NULL
    )`,
  ).run(
    options?.body ?? "Keep session-memory read-only until assembler wiring is separately approved.",
    options?.sourceRefsJson ?? "[]",
    entryUpdatedAt,
  );
}

function createCompatibleSessionMemoryFixture(options?: {
  userVersion?: number;
  migrationVersion?: number;
  includeIndexes?: boolean;
  includeUniqueConstraints?: boolean;
  includeSemanticColumns?: boolean;
  omitColumns?: Record<string, string[]>;
}): { tempDir: string; dbPath: string; cleanup: () => void } {
  const tempDir = mkdtempSync(join(tmpdir(), "lossless-session-memory-compatible-"));
  const dbPath = join(tempDir, "session-memory.db");
  const userVersion = options?.userVersion ?? 1;
  const migrationVersion = options?.migrationVersion ?? 1;
  const shouldIncludeColumn = (tableName: string, columnName: string): boolean => {
    return !(options?.omitColumns?.[tableName] ?? []).includes(columnName);
  };
  const columnLine = (tableName: string, columnName: string, ddl: string): string => {
    return shouldIncludeColumn(tableName, columnName) ? `${ddl},` : "";
  };
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA user_version = ${userVersion};
    CREATE TABLE schema_migrations (
      ${columnLine("schema_migrations", "migration_id", "migration_id TEXT PRIMARY KEY")}
      ${columnLine("schema_migrations", "schema_version", "schema_version INTEGER NOT NULL")}
      ${columnLine("schema_migrations", "applied_at", "applied_at TEXT NOT NULL")}
      ${columnLine("schema_migrations", "checksum", "checksum TEXT NOT NULL")}
      ${shouldIncludeColumn("schema_migrations", "description") ? "description TEXT NOT NULL" : "fixture_tail TEXT NULL"}
    );
    CREATE TABLE sessions (
      session_id TEXT PRIMARY KEY,
      conversation_id INTEGER NULL,
      session_key TEXT NULL,
      status TEXT NOT NULL,
      title TEXT NULL,
      started_at TEXT NOT NULL,
      ended_at TEXT NULL,
      created_at TEXT NOT NULL,
      ${columnLine("sessions", "updated_at", "updated_at TEXT NOT NULL")}
      metadata_json TEXT NULL
    );
    CREATE TABLE segments (
      segment_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      status TEXT NOT NULL,
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
      session_id TEXT NOT NULL,
      segment_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      status TEXT NOT NULL,
      confidence REAL NOT NULL,
      priority INTEGER NOT NULL DEFAULT 0,
      title TEXT NULL,
      ${columnLine("entries", "body", "body TEXT NOT NULL")}
      source_refs_json TEXT NULL,
      origin_entry_id TEXT NULL,
      superseded_by_entry_id TEXT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      settled_at TEXT NULL
    );
    CREATE TABLE checkpoints (
      checkpoint_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      from_segment_id TEXT NOT NULL,
      to_segment_id TEXT NULL,
      reason TEXT NOT NULL,
      trigger_snapshot_json TEXT NOT NULL,
      summary TEXT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE carry_forward (
      carry_id TEXT PRIMARY KEY,
      checkpoint_id TEXT NOT NULL,
      from_entry_id TEXT NOT NULL,
      to_entry_id TEXT NULL,
      priority INTEGER NOT NULL DEFAULT 0,
      reason TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE links (
      link_id TEXT PRIMARY KEY,
      src_type TEXT NOT NULL,
      src_id TEXT NOT NULL,
      relation TEXT NOT NULL,
      dst_type TEXT NOT NULL,
      dst_id TEXT NOT NULL,
      confidence REAL NULL,
      source_refs_json TEXT NULL,
      created_at TEXT NOT NULL
    );
  `);
  const migrationColumns = [
    ["migration_id", "fixture-schema"],
    ["schema_version", migrationVersion],
    ["applied_at", "2026-06-06T08:00:00.000Z"],
    ["checksum", "fixture"],
    ["description", "fixture schema"],
  ].filter(([column]) => shouldIncludeColumn("schema_migrations", String(column)));
  db
    .prepare(
      `INSERT INTO schema_migrations (${migrationColumns.map(([column]) => column).join(", ")}) VALUES (${migrationColumns
        .map(() => "?")
        .join(", ")})`,
    )
    .run(...migrationColumns.map(([, value]) => value));
  if (options?.includeIndexes !== false) {
    db.exec(`
      CREATE INDEX sessions_status_updated_at_idx ON sessions (status, updated_at);
      CREATE INDEX segments_session_status_seq_idx ON segments (session_id, status, seq);
      CREATE INDEX entries_session_status_priority_updated_at_idx ON entries (session_id, status, priority, updated_at);
      CREATE INDEX entries_segment_status_kind_idx ON entries (segment_id, status, kind);
      CREATE INDEX links_src_relation_idx ON links (src_type, src_id, relation);
      CREATE INDEX links_dst_relation_idx ON links (dst_type, dst_id, relation);
    `);
  }
  if (options?.includeUniqueConstraints !== false) {
    db.exec(`
      CREATE UNIQUE INDEX segments_session_seq_unique_idx ON segments (session_id, seq);
      CREATE UNIQUE INDEX links_unique_edge_idx ON links (src_type, src_id, relation, dst_type, dst_id);
    `);
  }
  if (options?.includeSemanticColumns) {
    db.exec(`
      ALTER TABLE entries ADD COLUMN logical_kind TEXT NULL;
      ALTER TABLE entries ADD COLUMN project_id TEXT NULL;
      ALTER TABLE entries ADD COLUMN workline_id TEXT NULL;
      ALTER TABLE entries ADD COLUMN details_json TEXT NULL;
      ALTER TABLE entries ADD COLUMN evidence_level TEXT NULL;
      ALTER TABLE entries ADD COLUMN review_state TEXT NULL;
      CREATE INDEX entries_project_workline_status_idx ON entries (project_id, workline_id, status);
      CREATE INDEX entries_logical_kind_status_idx ON entries (logical_kind, status);
    `);
  }
  db.close();

  return {
    tempDir,
    dbPath,
    cleanup: () => rmSync(tempDir, { recursive: true, force: true }),
  };
}

function createLcmFixture(options?: {
  compatibleSchema?: boolean;
  summaries?: string[];
  focusBriefs?: string[];
  messages?: Array<{ conversationId: number; seq: number }>;
  omitTables?: string[];
  omitColumns?: Record<string, string[]>;
}): { dbPath: string; cleanup: () => void } {
  const tempDir = mkdtempSync(join(tmpdir(), "lossless-session-memory-lcm-"));
  const dbPath = join(tempDir, "lcm.db");
  const db = new DatabaseSync(dbPath);
  const shouldIncludeTable = (tableName: string): boolean => !(options?.omitTables ?? []).includes(tableName);
  const shouldIncludeColumn = (tableName: string, columnName: string): boolean => {
    return !(options?.omitColumns?.[tableName] ?? []).includes(columnName);
  };
  if (options?.compatibleSchema === false) {
    db.exec("CREATE TABLE unrelated (id TEXT PRIMARY KEY)");
  } else {
    db.exec(`
      CREATE TABLE conversations (
        conversation_id INTEGER PRIMARY KEY,
        session_id TEXT NOT NULL,
        session_key TEXT,
        title TEXT,
        bootstrapped_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        active INTEGER NOT NULL DEFAULT 1,
        archived_at TEXT
      );
      CREATE TABLE summaries (
        summary_id TEXT PRIMARY KEY,
        conversation_id INTEGER NOT NULL,
        kind TEXT NOT NULL,
        depth INTEGER NOT NULL DEFAULT 0,
        content TEXT NOT NULL,
        token_count INTEGER NOT NULL,
        earliest_at TEXT,
        latest_at TEXT,
        descendant_count INTEGER NOT NULL DEFAULT 0,
        descendant_token_count INTEGER NOT NULL DEFAULT 0,
        source_message_token_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        file_ids TEXT NOT NULL DEFAULT '[]',
        model TEXT NOT NULL DEFAULT 'unknown'
      );
      CREATE TABLE messages (
        message_id INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_id INTEGER NOT NULL,
        seq INTEGER NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        token_count INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        identity_hash TEXT,
        large_content TEXT,
        UNIQUE (conversation_id, seq)
      );
      ${
        shouldIncludeTable("context_items")
          ? `
      CREATE TABLE context_items (
        conversation_id INTEGER NOT NULL,
        ordinal INTEGER NOT NULL,
        content TEXT NOT NULL,
        PRIMARY KEY (conversation_id, ordinal)
      );`
          : ""
      }
      ${
        shouldIncludeTable("summary_messages")
          ? `
      CREATE TABLE summary_messages (
        summary_id TEXT NOT NULL,
        message_id INTEGER NOT NULL,
        PRIMARY KEY (summary_id, message_id)
      );`
          : ""
      }
      CREATE TABLE focus_briefs (
        brief_id TEXT PRIMARY KEY,
        conversation_id INTEGER NOT NULL,
        session_key TEXT,
        prompt TEXT NOT NULL,
        content TEXT NOT NULL,
        status TEXT NOT NULL,
        token_count INTEGER NOT NULL DEFAULT 0,
        target_tokens INTEGER NOT NULL DEFAULT 0,
        covered_latest_at TEXT,
        covered_message_seq INTEGER,
        source_context_hash TEXT NOT NULL DEFAULT '',
        generator_run_id TEXT,
        generator_session_key TEXT,
        raw_result_json TEXT,
        error TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        superseded_at TEXT
      );
      ${
        shouldIncludeTable("focus_brief_sources")
          ? `
      CREATE TABLE focus_brief_sources (
        brief_id TEXT NOT NULL,
        ${shouldIncludeColumn("focus_brief_sources", "summary_id") ? "summary_id TEXT NOT NULL," : ""}
        source_kind TEXT NOT NULL DEFAULT 'summary'
      );`
          : ""
      }
      INSERT INTO conversations (
        conversation_id, session_id, session_key, title, created_at, updated_at, active
      ) VALUES (
        123, 'session-active', 'agent:main:test', 'fixture', '2026-06-06T08:00:00.000Z',
        '2026-06-06T08:00:00.000Z', 1
      );
    `);
    for (const summaryId of options?.summaries ?? []) {
      db.prepare(
        `INSERT INTO summaries (
          summary_id, conversation_id, kind, depth, content, token_count, created_at
        ) VALUES (?, 123, 'leaf', 0, 'fixture', 1, '2026-06-06T08:00:00.000Z')`,
      ).run(summaryId);
    }
    for (const briefId of options?.focusBriefs ?? []) {
      db.prepare(
        `INSERT INTO focus_briefs (
          brief_id, conversation_id, session_key, prompt, content, status, token_count, target_tokens,
          source_context_hash, created_at, updated_at
        ) VALUES (?, 123, 'agent:main:test', 'fixture', 'fixture', 'active', 1, 1, 'fixture',
          '2026-06-06T08:00:00.000Z', '2026-06-06T08:00:00.000Z')`,
      ).run(briefId);
    }
    for (const message of options?.messages ?? []) {
      db.prepare(
        `INSERT INTO messages (
          conversation_id, seq, role, content, token_count, created_at
        ) VALUES (?, ?, 'user', 'fixture', 1, '2026-06-06T08:00:00.000Z')`,
      ).run(message.conversationId, message.seq);
    }
  }
  db.close();

  return {
    dbPath,
    cleanup: () => rmSync(tempDir, { recursive: true, force: true }),
  };
}
