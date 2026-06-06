import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
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
    const futureFixture = createCompatibleSessionMemoryFixture({ userVersion: 2, migrationVersion: 2 });

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
            updatedAt: "2026-06-06T08:04:00.000Z",
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
});

function insertActiveSessionMemoryEntry(
  db: DatabaseSync,
  options?: {
    body?: string;
    sourceRefsJson?: string;
  },
): void {
  db.exec(`
    INSERT INTO sessions (
      session_id, conversation_id, session_key, status, title, started_at, ended_at, created_at, updated_at, metadata_json
    ) VALUES (
      'session-active', 123, 'agent:main:test', 'active', NULL, '2026-06-06T08:00:00.000Z', NULL,
      '2026-06-06T08:00:00.000Z', '2026-06-06T08:05:00.000Z', NULL
    );
    INSERT INTO segments (
      segment_id, session_id, seq, status, start_ref_json, end_ref_json, token_estimate, entry_count,
      opened_at, closed_at, created_at, updated_at
    ) VALUES (
      'segment-active', 'session-active', 1, 'active', NULL, NULL, 42, 1,
      '2026-06-06T08:00:00.000Z', NULL, '2026-06-06T08:00:00.000Z', '2026-06-06T08:05:00.000Z'
    );
  `);
  db.prepare(
    `INSERT INTO entries (
      entry_id, session_id, segment_id, kind, status, confidence, priority, title, body, source_refs_json,
      origin_entry_id, superseded_by_entry_id, created_at, updated_at, settled_at
    ) VALUES (
      'entry-1', 'session-active', 'segment-active', 'decision', 'active', 0.9, 10, NULL,
      ?, ?, NULL, NULL, '2026-06-06T08:03:00.000Z', '2026-06-06T08:04:00.000Z', NULL
    )`,
  ).run(
    options?.body ?? "Keep session-memory read-only until assembler wiring is separately approved.",
    options?.sourceRefsJson ?? "[]",
  );
}

function createCompatibleSessionMemoryFixture(options?: {
  userVersion?: number;
  migrationVersion?: number;
  includeIndexes?: boolean;
  includeUniqueConstraints?: boolean;
}): { tempDir: string; dbPath: string; cleanup: () => void } {
  const tempDir = mkdtempSync(join(tmpdir(), "lossless-session-memory-compatible-"));
  const dbPath = join(tempDir, "session-memory.db");
  const userVersion = options?.userVersion ?? 1;
  const migrationVersion = options?.migrationVersion ?? 1;
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA user_version = ${userVersion};
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
      status TEXT NOT NULL,
      title TEXT NULL,
      started_at TEXT NOT NULL,
      ended_at TEXT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
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
      body TEXT NOT NULL,
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
    INSERT INTO schema_migrations (
      migration_id, schema_version, applied_at, checksum, description
    ) VALUES (
      'fixture-schema', ${migrationVersion}, '2026-06-06T08:00:00.000Z', 'fixture', 'fixture schema'
    );
  `);
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
}): { dbPath: string; cleanup: () => void } {
  const tempDir = mkdtempSync(join(tmpdir(), "lossless-session-memory-lcm-"));
  const dbPath = join(tempDir, "lcm.db");
  const db = new DatabaseSync(dbPath);
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
