import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { resolveLcmConfig } from "../src/db/config.js";
import {
  DEFAULT_SESSION_MEMORY_OVERLAY_CONFIG,
  lookupSessionMemoryOverlay,
  renderSessionMemoryOverlay,
} from "../src/session-memory.js";
import { buildSessionMemorySchemaMaintenanceText } from "../src/session-memory-maintenance.js";
import {
  carryForwardSessionMemoryEntries,
  rejectSessionMemoryEntries,
  refreshSessionMemoryEntries,
  type SessionMemorySeedPacket,
  writeSessionMemorySeedPacket,
} from "../src/session-memory-writer.js";

function createSchemaFixture(): { tempDir: string; dbPath: string; cleanup: () => void } {
  const tempDir = mkdtempSync(join(tmpdir(), "lossless-session-memory-writer-"));
  const dbPath = join(tempDir, "session-memory.db");
  const config = resolveLcmConfig(
    {},
    {
      sessionMemoryOverlay: {
        dbPath,
      },
    },
  );
  const dryRun = buildSessionMemorySchemaMaintenanceText({
    config,
    command: {
      action: "apply",
      dbPath,
      execute: false,
      allowRealDb: false,
    },
  });
  const confirmation = dryRun.match(/execute confirmation: ([a-z0-9_:-]+)/)?.[1];
  if (!confirmation) {
    throw new Error("expected session-memory schema confirmation token");
  }
  const created = buildSessionMemorySchemaMaintenanceText({
    config,
    command: {
      action: "apply",
      dbPath,
      execute: true,
      confirm: confirmation,
      allowRealDb: false,
    },
  });
  if (!created.includes("status: created")) {
    throw new Error(`expected temp schema creation, got:\n${created}`);
  }
  return {
    tempDir,
    dbPath,
    cleanup: () => rmSync(tempDir, { recursive: true, force: true }),
  };
}

function createCompatibleLcmDb(tempDir: string): string {
  const dbPath = join(tempDir, "lcm.db");
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(`
      CREATE TABLE conversations (
        conversation_id INTEGER PRIMARY KEY,
        session_id TEXT NOT NULL,
        session_key TEXT
      );
      CREATE TABLE summaries (
        summary_id TEXT PRIMARY KEY,
        conversation_id INTEGER NOT NULL
      );
      CREATE TABLE messages (
        message_id INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_id INTEGER NOT NULL,
        seq INTEGER NOT NULL
      );
      CREATE TABLE context_items (
        conversation_id INTEGER NOT NULL,
        ordinal INTEGER NOT NULL
      );
      CREATE TABLE summary_messages (
        summary_id TEXT NOT NULL,
        message_id INTEGER NOT NULL
      );
      CREATE TABLE focus_briefs (
        brief_id TEXT PRIMARY KEY,
        conversation_id INTEGER NOT NULL,
        session_key TEXT
      );
      CREATE TABLE focus_brief_sources (
        brief_id TEXT NOT NULL,
        summary_id TEXT NOT NULL
      );
    `);
  } finally {
    db.close();
  }
  return dbPath;
}

function basePacket(overrides: Partial<SessionMemorySeedPacket> = {}): SessionMemorySeedPacket {
  return {
    session: {
      sessionId: "session-gate7",
      conversationId: 123,
      sessionKey: "agent:main:test",
      title: "Gate 7 fixture",
      ...overrides.session,
    },
    segment: {
      segmentId: "segment-gate7",
      seq: 1,
      tokenEstimate: 120,
      ...overrides.segment,
    },
    entries: overrides.entries ?? [
      {
        entryId: "entry-decision",
        kind: "decision",
        confidence: 0.9,
        priority: 20,
        body: "Gate 7 only proves writer behavior on temp DBs.",
        sourceRefs: [{ type: "workspace_file", path: "Friday-memory/CURRENT.md", line: 82 }],
      },
    ],
    links: overrides.links,
  };
}

function countRows(dbPath: string, tableName: "sessions" | "segments" | "entries" | "links"): number {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return (db.prepare(`SELECT COUNT(*) AS count FROM ${tableName}`).get() as { count: number }).count;
  } finally {
    db.close();
  }
}

describe("session-memory writer", () => {
  it("writes a manual seed to a temp DB and renders it through the read-only overlay", async () => {
    const fixture = createSchemaFixture();
    try {
      const written = writeSessionMemorySeedPacket({
        dbPath: fixture.dbPath,
        lcmDbPath: join(fixture.tempDir, "missing-lcm.db"),
        now: new Date("2026-06-15T14:30:00.000Z"),
        packet: basePacket({
          entries: [
            {
              entryId: "entry-decision",
              kind: "decision",
              confidence: 0.9,
              priority: 20,
              body: "Gate 7 only proves writer behavior on temp DBs.",
              sourceRefs: [{ type: "workspace_file", path: "Friday-memory/CURRENT.md", line: 82 }],
            },
            {
              entryId: "entry-next",
              kind: "next_action",
              confidence: 0.8,
              priority: 10,
              body: "Keep the real session-memory DB unseeded until Gate 8.",
              sourceRefs: [{ type: "sidecar_sample", path: "Friday-memory/work/lossless-current.md" }],
            },
          ],
          links: [
            {
              linkId: "link-entry-supports",
              srcType: "entry",
              srcId: "entry-next",
              relation: "supports",
              dstType: "entry",
              dstId: "entry-decision",
              confidence: 0.7,
            },
          ],
        }),
      });

      expect(written).toMatchObject({
        ok: true,
        status: "written",
        sessionId: "session-gate7",
        segmentId: "segment-gate7",
        entryCount: 2,
        linkCount: 1,
        updatedAt: "2026-06-15T14:30:00.000Z",
      });

      const db = new DatabaseSync(fixture.dbPath, { readOnly: true });
      try {
        expect((db.prepare("SELECT COUNT(*) AS count FROM sessions").get() as { count: number }).count).toBe(1);
        expect((db.prepare("SELECT COUNT(*) AS count FROM segments").get() as { count: number }).count).toBe(1);
        expect((db.prepare("SELECT COUNT(*) AS count FROM entries").get() as { count: number }).count).toBe(2);
        expect((db.prepare("SELECT COUNT(*) AS count FROM links").get() as { count: number }).count).toBe(1);
        expect(
          (db.prepare("SELECT entry_count FROM segments WHERE segment_id = ?").get("segment-gate7") as {
            entry_count: number;
          }).entry_count,
        ).toBe(2);
        expect(
          (db.prepare("SELECT updated_at FROM sessions WHERE session_id = ?").get("session-gate7") as {
            updated_at: string;
          }).updated_at,
        ).toBe("2026-06-15T14:30:00.000Z");
        expect(
          (db.prepare("SELECT updated_at FROM segments WHERE segment_id = ?").get("segment-gate7") as {
            updated_at: string;
          }).updated_at,
        ).toBe("2026-06-15T14:30:00.000Z");
      } finally {
        db.close();
      }

      const lookup = await lookupSessionMemoryOverlay(
        {
          conversationId: 123,
          sessionKey: "agent:main:test",
        },
        {
          ...DEFAULT_SESSION_MEMORY_OVERLAY_CONFIG,
          enabled: true,
          dbPath: fixture.dbPath,
          lcmDbPath: join(fixture.tempDir, "missing-lcm.db"),
          staleAfterMs: 7 * 24 * 60 * 60 * 1000,
        },
      );
      expect(lookup).toMatchObject({
        ok: true,
        source: "session_memory_overlay",
        sessionId: "session-gate7",
        segmentId: "segment-gate7",
      });

      const rendered = renderSessionMemoryOverlay(lookup, {
        ...DEFAULT_SESSION_MEMORY_OVERLAY_CONFIG,
        enabled: true,
        dbPath: fixture.dbPath,
        lcmDbPath: join(fixture.tempDir, "missing-lcm.db"),
        staleAfterMs: 7 * 24 * 60 * 60 * 1000,
      });
      expect(rendered).toMatchObject({
        ok: true,
        source: "session_memory_overlay",
        entryCount: 2,
        segmentId: "segment-gate7",
        sourceRefsCount: 2,
      });
      expect(rendered.ok && rendered.content).toContain("Decisions:");
      expect(rendered.ok && rendered.content).toContain("Next actions:");
      expect(rendered.ok && rendered.content).toContain("workspace_file:Friday-memory/CURRENT.md:82");
    } finally {
      fixture.cleanup();
    }
  });

  it("rejects raw transcript-shaped bodies before writing rows", () => {
    const fixture = createSchemaFixture();
    try {
      const result = writeSessionMemorySeedPacket({
        dbPath: fixture.dbPath,
        lcmDbPath: join(fixture.tempDir, "missing-lcm.db"),
        packet: basePacket({
          entries: [
            {
              entryId: "entry-raw",
              kind: "fact",
              confidence: 0.5,
              body: "user: copy this\nassistant: raw transcript copy",
            },
          ],
        }),
      });

      expect(result).toEqual({
        ok: false,
        status: "refused",
        reason: "raw_transcript_detected",
      });
      expect(countRows(fixture.dbPath, "entries")).toBe(0);
    } finally {
      fixture.cleanup();
    }
  });

  it("rejects invalid packet fields and source-ref shapes before writing rows", () => {
    const fixture = createSchemaFixture();
    try {
      const missingConversationId = writeSessionMemorySeedPacket({
        dbPath: fixture.dbPath,
        lcmDbPath: join(fixture.tempDir, "missing-lcm.db"),
        packet: basePacket({
          session: {
            sessionId: "session-missing-conversation-id",
            conversationId: undefined as never,
          },
        }),
      });
      expect(missingConversationId).toMatchObject({
        ok: false,
        reason: "invalid_packet",
        detail: "session.conversationId is required",
      });

      const invalidKind = writeSessionMemorySeedPacket({
        dbPath: fixture.dbPath,
        lcmDbPath: join(fixture.tempDir, "missing-lcm.db"),
        packet: basePacket({
          entries: [
            {
              entryId: "entry-invalid-kind",
              kind: "memo",
              confidence: 0.5,
              body: "Invalid kind should be refused.",
            },
          ],
        }),
      });
      expect(invalidKind).toMatchObject({ ok: false, reason: "invalid_packet" });

      const invalidStatus = writeSessionMemorySeedPacket({
        dbPath: fixture.dbPath,
        lcmDbPath: join(fixture.tempDir, "missing-lcm.db"),
        packet: basePacket({
          entries: [
            {
              entryId: "entry-invalid-status",
              kind: "fact",
              status: "settled",
              confidence: 0.5,
              body: "First writer slice only accepts active entries.",
            },
          ],
        }),
      });
      expect(invalidStatus).toMatchObject({ ok: false, reason: "invalid_packet" });

      const invalidSourceRef = writeSessionMemorySeedPacket({
        dbPath: fixture.dbPath,
        lcmDbPath: join(fixture.tempDir, "missing-lcm.db"),
        packet: basePacket({
          entries: [
            {
              entryId: "entry-invalid-ref",
              kind: "fact",
              confidence: 0.5,
              body: "Unknown source ref should be refused.",
              sourceRefs: [{ type: "unknown_ref" } as never],
            },
          ],
        }),
      });
      expect(invalidSourceRef).toMatchObject({ ok: false, reason: "invalid_packet" });
      expect(countRows(fixture.dbPath, "entries")).toBe(0);
    } finally {
      fixture.cleanup();
    }
  });

  it("marks active entries rejected through an explicit maintenance writer action", () => {
    const fixture = createSchemaFixture();
    try {
      const written = writeSessionMemorySeedPacket({
        dbPath: fixture.dbPath,
        lcmDbPath: join(fixture.tempDir, "missing-lcm.db"),
        packet: basePacket({
          entries: [
            {
              entryId: "entry-to-reject",
              kind: "fact",
              confidence: 0.9,
              body: "This reviewed seed entry will be rejected by a maintenance action.",
            },
            {
              entryId: "entry-to-reject-second",
              kind: "constraint",
              confidence: 0.9,
              body: "This second entry shares the same segment and must reject in the same action.",
            },
          ],
        }),
      });
      expect(written).toMatchObject({ ok: true, entryCount: 2 });

      const realPathRefusal = rejectSessionMemoryEntries({
        dbPath: join(process.cwd(), ".session-memory-writer-real", "session-memory.db"),
        entryIds: ["entry-to-reject"],
      });
      expect(realPathRefusal).toEqual({
        ok: false,
        status: "refused",
        reason: "real_db_refused",
      });

      const rejected = rejectSessionMemoryEntries({
        dbPath: fixture.dbPath,
        entryIds: ["entry-to-reject", "entry-to-reject-second"],
        now: new Date("2026-06-15T18:10:00.000Z"),
      });
      expect(rejected).toEqual({
        ok: true,
        status: "rejected",
        entryCount: 2,
        sessionCount: 1,
        segmentCount: 1,
        updatedAt: "2026-06-15T18:10:00.000Z",
      });

      const db = new DatabaseSync(fixture.dbPath, { readOnly: true });
      try {
        expect(
          (db.prepare("SELECT status, settled_at FROM entries WHERE entry_id = ?").get("entry-to-reject") as {
            status: string;
            settled_at: string;
          }),
        ).toEqual({
          status: "rejected",
          settled_at: "2026-06-15T18:10:00.000Z",
        });
        expect(
          (db.prepare("SELECT status, settled_at FROM entries WHERE entry_id = ?").get("entry-to-reject-second") as {
            status: string;
            settled_at: string;
          }),
        ).toEqual({
          status: "rejected",
          settled_at: "2026-06-15T18:10:00.000Z",
        });
      } finally {
        db.close();
      }
    } finally {
      fixture.cleanup();
    }
  });

  it("carries active reviewed entries forward to a new conversation in a temp DB", async () => {
    const fixture = createSchemaFixture();
    try {
      const seeded = writeSessionMemorySeedPacket({
        dbPath: fixture.dbPath,
        lcmDbPath: join(fixture.tempDir, "missing-lcm.db"),
        now: new Date("2026-06-19T06:20:00.000Z"),
        packet: basePacket({
          session: {
            sessionId: "session-old",
            conversationId: 2520,
            sessionKey: "agent:main:dashboard:old",
          },
          segment: {
            segmentId: "segment-old",
            seq: 1,
          },
          entries: [
            {
              entryId: "entry-old-constraint",
              kind: "constraint",
              confidence: 0.95,
              priority: 30,
              body: "Do not enable session-memory runtime without a separate approval gate.",
              sourceRefs: [{ type: "workspace_file", path: "Friday-memory/CURRENT.md", line: 46 }],
            },
            {
              entryId: "entry-old-next",
              kind: "risk",
              confidence: 0.9,
              priority: 20,
              body: "Conversation-local seed can go stale without a refresh policy.",
              sourceRefs: [{ type: "workspace_file", path: "Friday-memory/plans/Friday/session-memory-gate15-new-seed-lifecycle-policy-2026-06-19.md" }],
            },
          ],
        }),
      });
      expect(seeded).toMatchObject({ ok: true, entryCount: 2 });

      const carried = carryForwardSessionMemoryEntries({
        dbPath: fixture.dbPath,
        lcmDbPath: join(fixture.tempDir, "missing-lcm.db"),
        fromConversationId: 2520,
        fromSessionKey: "agent:main:dashboard:old",
        to: {
          sessionId: "session-new",
          conversationId: 2521,
          sessionKey: "agent:main:dashboard:new",
        },
        now: new Date("2026-06-19T06:30:00.000Z"),
      });
      expect(carried).toMatchObject({
        ok: true,
        status: "written",
        fromConversationId: 2520,
        toConversationId: 2521,
        sessionId: "session-new",
        entryCount: 2,
        linkCount: 2,
        updatedAt: "2026-06-19T06:30:00.000Z",
      });
      expect(carried.ok && carried.carriedEntryIds).toEqual([
        {
          fromEntryId: "entry-old-constraint",
          toEntryId: "carry:2521:entry:0d9452a64838e034",
        },
        {
          fromEntryId: "entry-old-next",
          toEntryId: "carry:2521:entry:a373a1a3c9d82813",
        },
      ]);

      const db = new DatabaseSync(fixture.dbPath, { readOnly: true });
      try {
        expect((db.prepare("SELECT COUNT(*) AS count FROM sessions").get() as { count: number }).count).toBe(2);
        expect((db.prepare("SELECT COUNT(*) AS count FROM segments").get() as { count: number }).count).toBe(2);
        expect((db.prepare("SELECT COUNT(*) AS count FROM entries").get() as { count: number }).count).toBe(4);
        expect((db.prepare("SELECT COUNT(*) AS count FROM links WHERE relation = 'carried_to'").get() as { count: number }).count).toBe(2);
        expect(
          db
            .prepare("SELECT origin_entry_id, updated_at FROM entries WHERE entry_id = ?")
            .get("carry:2521:entry:0d9452a64838e034"),
        ).toEqual({
          origin_entry_id: "entry-old-constraint",
          updated_at: "2026-06-19T06:30:00.000Z",
        });
      } finally {
        db.close();
      }

      const lookup = await lookupSessionMemoryOverlay(
        {
          conversationId: 2521,
          sessionKey: "agent:main:dashboard:new",
        },
        {
          ...DEFAULT_SESSION_MEMORY_OVERLAY_CONFIG,
          enabled: true,
          dbPath: fixture.dbPath,
          lcmDbPath: join(fixture.tempDir, "missing-lcm.db"),
          staleAfterMs: 7 * 24 * 60 * 60 * 1000,
        },
      );
      expect(lookup).toMatchObject({
        ok: true,
        source: "session_memory_overlay",
        sessionId: "session-new",
      });

      const rendered = renderSessionMemoryOverlay(lookup, {
        ...DEFAULT_SESSION_MEMORY_OVERLAY_CONFIG,
        enabled: true,
        dbPath: fixture.dbPath,
        lcmDbPath: join(fixture.tempDir, "missing-lcm.db"),
        staleAfterMs: 7 * 24 * 60 * 60 * 1000,
      });
      expect(rendered).toMatchObject({
        ok: true,
        source: "session_memory_overlay",
        entryCount: 2,
      });
      expect(rendered.ok && rendered.content).toContain("Constraints:");
      expect(rendered.ok && rendered.content).toContain("Risks:");

      const unrelatedLookup = await lookupSessionMemoryOverlay(
        {
          conversationId: 999999,
          sessionKey: "agent:main:dashboard:new",
        },
        {
          ...DEFAULT_SESSION_MEMORY_OVERLAY_CONFIG,
          enabled: true,
          dbPath: fixture.dbPath,
          lcmDbPath: join(fixture.tempDir, "missing-lcm.db"),
          staleAfterMs: 7 * 24 * 60 * 60 * 1000,
        },
      );
      expect(unrelatedLookup).toEqual({
        ok: false,
        source: "session_memory_overlay",
        reason: "no_active_entries",
      });
    } finally {
      fixture.cleanup();
    }
  });

  it("does not carry current-state facts or next actions as active entries", async () => {
    const fixture = createSchemaFixture();
    try {
      const seeded = writeSessionMemorySeedPacket({
        dbPath: fixture.dbPath,
        lcmDbPath: join(fixture.tempDir, "missing-lcm.db"),
        now: new Date("2026-06-20T06:00:00.000Z"),
        packet: basePacket({
          session: {
            sessionId: "session-stale-source",
            conversationId: 2565,
            sessionKey: "agent:main:dashboard:source",
          },
          segment: {
            segmentId: "segment-stale-source",
            seq: 1,
          },
          entries: [
            {
              entryId: "entry-long-constraint",
              kind: "constraint",
              confidence: 0.95,
              priority: 50,
              body: "Do not enable runtime overlay without a separate named approval gate.",
              sourceRefs: [{ type: "workspace_file", path: "Friday-memory/CURRENT.md" }],
            },
            {
              entryId: "entry-stable-decision",
              kind: "decision",
              confidence: 0.9,
              priority: 40,
              body: "Normal /new continues the previous workline and may carry reviewed durable seed.",
              sourceRefs: [{ type: "workspace_file", path: "Friday-memory/STARTUP.md" }],
            },
            {
              entryId: "entry-durable-fact",
              kind: "fact",
              confidence: 0.85,
              priority: 30,
              body: "Session-memory is a reviewed working-memory overlay for facts, decisions, risks, and next steps.",
              sourceRefs: [{ type: "workspace_file", path: "Friday-memory/work/lossless-current.md" }],
            },
            {
              entryId: "entry-current-state-fact",
              kind: "fact",
              confidence: 0.8,
              priority: 20,
              body: "The real session-memory DB currently has active reviewed seed rows only for older conversations 2331 and 2360; current conversation 2520 has no active seed rows.",
              sourceRefs: [{ type: "workspace_file", path: "Friday-memory/daily/Main-2026-06-19.md" }],
            },
            {
              entryId: "entry-completed-next-action",
              kind: "next_action",
              confidence: 0.8,
              priority: 10,
              body: "First prove this exact packet on a temp DB before any real DB write.",
              sourceRefs: [{ type: "workspace_file", path: "Friday-memory/plans/Friday/session-memory-current-conversation-seed-carry-forward-2026-06-19.md" }],
            },
          ],
        }),
      });
      expect(seeded).toMatchObject({ ok: true, entryCount: 5 });

      const carried = carryForwardSessionMemoryEntries({
        dbPath: fixture.dbPath,
        lcmDbPath: join(fixture.tempDir, "missing-lcm.db"),
        fromConversationId: 2565,
        fromSessionKey: "agent:main:dashboard:source",
        to: {
          sessionId: "session-refresh-target",
          conversationId: 2566,
          sessionKey: "agent:main:dashboard:target",
        },
        now: new Date("2026-06-20T06:05:00.000Z"),
      });

      expect(carried).toMatchObject({
        ok: true,
        status: "written",
        entryCount: 3,
        linkCount: 3,
        skippedEntryIds: [
          { entryId: "entry-current-state-fact", reason: "current_state_fact_requires_refresh" },
          { entryId: "entry-completed-next-action", reason: "next_action_requires_refresh" },
        ],
      });

      const db = new DatabaseSync(fixture.dbPath, { readOnly: true });
      try {
        const carriedBodies = db
          .prepare(
            `SELECT e.origin_entry_id AS origin_entry_id, e.kind AS kind, e.body AS body
             FROM entries e
             JOIN sessions s ON s.session_id = e.session_id
             WHERE s.conversation_id = ? AND e.status = 'active'
             ORDER BY e.priority DESC`,
          )
          .all(2566) as Array<{ origin_entry_id: string; kind: string; body: string }>;
        expect(carriedBodies.map((entry) => entry.origin_entry_id)).toEqual([
          "entry-long-constraint",
          "entry-stable-decision",
          "entry-durable-fact",
        ]);
        expect(carriedBodies.map((entry) => entry.kind)).toEqual(["constraint", "decision", "fact"]);
        expect(carriedBodies.map((entry) => entry.body).join("\n")).not.toContain("current conversation 2520 has no active seed rows");
        expect(carriedBodies.map((entry) => entry.body).join("\n")).not.toContain("First prove this exact packet");
      } finally {
        db.close();
      }
    } finally {
      fixture.cleanup();
    }
  });

  it("marks skipped source entries while carrying durable entries forward", () => {
    const fixture = createSchemaFixture();
    try {
      const seeded = writeSessionMemorySeedPacket({
        dbPath: fixture.dbPath,
        lcmDbPath: join(fixture.tempDir, "missing-lcm.db"),
        now: new Date("2026-06-20T07:10:00.000Z"),
        packet: basePacket({
          session: {
            sessionId: "session-mark-source",
            conversationId: 2700,
            sessionKey: "agent:main:dashboard:mark-source",
          },
          segment: {
            segmentId: "segment-mark-source",
            seq: 1,
          },
          entries: [
            {
              entryId: "entry-mark-constraint",
              kind: "constraint",
              confidence: 0.95,
              priority: 30,
              body: "Keep runtime overlay disabled until a separate approval gate.",
              sourceRefs: [{ type: "workspace_file", path: "Friday-memory/CURRENT.md" }],
            },
            {
              entryId: "entry-mark-current-fact",
              kind: "fact",
              confidence: 0.85,
              priority: 20,
              body: "The current conversation 2565 has active seed rows copied from 2549.",
              sourceRefs: [{ type: "workspace_file", path: "Friday-memory/plans/Friday/session-memory-gate24-grouped-vs-compact-readonly-eval-2026-06-20.md" }],
            },
            {
              entryId: "entry-mark-next-action",
              kind: "next_action",
              confidence: 0.8,
              priority: 10,
              body: "Compare grouped and compact overlay render output next.",
              sourceRefs: [{ type: "workspace_file", path: "Friday-memory/STARTUP.md" }],
            },
          ],
        }),
      });
      expect(seeded).toMatchObject({ ok: true, entryCount: 3 });

      const carried = carryForwardSessionMemoryEntries({
        dbPath: fixture.dbPath,
        lcmDbPath: join(fixture.tempDir, "missing-lcm.db"),
        fromConversationId: 2700,
        fromSessionKey: "agent:main:dashboard:mark-source",
        to: {
          sessionId: "session-mark-target",
          conversationId: 2701,
          sessionKey: "agent:main:dashboard:mark-target",
        },
        now: new Date("2026-06-20T07:15:00.000Z"),
      });

      expect(carried).toMatchObject({
        ok: true,
        status: "written",
        entryCount: 1,
        linkCount: 1,
        skippedEntryIds: [
          { entryId: "entry-mark-current-fact", reason: "current_state_fact_requires_refresh" },
          { entryId: "entry-mark-next-action", reason: "next_action_requires_refresh" },
        ],
      });

      const db = new DatabaseSync(fixture.dbPath, { readOnly: true });
      try {
        expect(
          db
            .prepare("SELECT status, settled_at FROM entries WHERE entry_id = ?")
            .get("entry-mark-constraint"),
        ).toEqual({ status: "active", settled_at: null });
        expect(
          db
            .prepare("SELECT status, settled_at FROM entries WHERE entry_id = ?")
            .get("entry-mark-current-fact"),
        ).toEqual({ status: "stale", settled_at: "2026-06-20T07:15:00.000Z" });
        expect(
          db
            .prepare("SELECT status, settled_at FROM entries WHERE entry_id = ?")
            .get("entry-mark-next-action"),
        ).toEqual({ status: "settled", settled_at: "2026-06-20T07:15:00.000Z" });
        expect(
          (db
            .prepare("SELECT COUNT(*) AS count FROM entries WHERE status = 'active' AND origin_entry_id IS NOT NULL")
            .get() as { count: number }).count,
        ).toBe(1);
      } finally {
        db.close();
      }
    } finally {
      fixture.cleanup();
    }
  });

  it("can supersede skipped current-state facts with reviewed replacement entries", () => {
    const fixture = createSchemaFixture();
    try {
      const seeded = writeSessionMemorySeedPacket({
        dbPath: fixture.dbPath,
        lcmDbPath: join(fixture.tempDir, "missing-lcm.db"),
        now: new Date("2026-06-20T08:00:00.000Z"),
        packet: basePacket({
          session: {
            sessionId: "session-replace-source",
            conversationId: 2800,
            sessionKey: "agent:main:dashboard:replace-source",
          },
          segment: {
            segmentId: "segment-replace-source",
            seq: 1,
          },
          entries: [
            {
              entryId: "entry-stale-db-state",
              kind: "fact",
              confidence: 0.82,
              priority: 20,
              body: "The current conversation 2565 has active seed rows copied from 2549.",
              sourceRefs: [{ type: "workspace_file", path: "Friday-memory/plans/Friday/session-memory-gate24-grouped-vs-compact-readonly-eval-2026-06-20.md" }],
            },
          ],
        }),
      });
      expect(seeded).toMatchObject({ ok: true, entryCount: 1 });

      const carried = carryForwardSessionMemoryEntries({
        dbPath: fixture.dbPath,
        lcmDbPath: join(fixture.tempDir, "missing-lcm.db"),
        fromConversationId: 2800,
        fromSessionKey: "agent:main:dashboard:replace-source",
        to: {
          sessionId: "session-replace-target",
          conversationId: 2801,
          sessionKey: "agent:main:dashboard:replace-target",
        },
        replacementEntries: [
          {
            sourceEntryId: "entry-stale-db-state",
            entryId: "entry-refreshed-db-state",
            body: "Gate 27 source replacement is temp-DB-only; live runtime overlay remains disabled and this replacement has not been written to the real DB.",
            confidence: 0.9,
            priority: 25,
            sourceRefs: [{ type: "workspace_file", path: "Friday-memory/plans/Friday/session-memory-gate27-refreshed-replacement-supersession-2026-06-20.md" }],
          },
        ],
        now: new Date("2026-06-20T08:05:00.000Z"),
      });

      expect(carried).toMatchObject({
        ok: true,
        status: "written",
        entryCount: 1,
        replacementEntryIds: [
          { fromEntryId: "entry-stale-db-state", toEntryId: "entry-refreshed-db-state" },
        ],
      });

      const db = new DatabaseSync(fixture.dbPath, { readOnly: true });
      try {
        expect(
          db
            .prepare("SELECT status, settled_at, superseded_by_entry_id FROM entries WHERE entry_id = ?")
            .get("entry-stale-db-state"),
        ).toEqual({
          status: "superseded",
          settled_at: "2026-06-20T08:05:00.000Z",
          superseded_by_entry_id: "entry-refreshed-db-state",
        });
        expect(
          db
            .prepare("SELECT kind, status, origin_entry_id, body FROM entries WHERE entry_id = ?")
            .get("entry-refreshed-db-state"),
        ).toEqual({
          kind: "fact",
          status: "active",
          origin_entry_id: "entry-stale-db-state",
          body: "Gate 27 source replacement is temp-DB-only; live runtime overlay remains disabled and this replacement has not been written to the real DB.",
        });
        expect(
          (db
            .prepare("SELECT COUNT(*) AS count FROM links WHERE relation = 'supersedes' AND src_id = ? AND dst_id = ?")
            .get("entry-refreshed-db-state", "entry-stale-db-state") as { count: number }).count,
        ).toBe(1);
      } finally {
        db.close();
      }
    } finally {
      fixture.cleanup();
    }
  });

  it("refreshes stale current conversation entries in place", async () => {
    const fixture = createSchemaFixture();
    try {
      const seeded = writeSessionMemorySeedPacket({
        dbPath: fixture.dbPath,
        lcmDbPath: join(fixture.tempDir, "missing-lcm.db"),
        now: new Date("2026-06-20T10:20:00.000Z"),
        packet: basePacket({
          session: {
            sessionId: "session-refresh-in-place",
            conversationId: 2565,
            sessionKey: "agent:main:dashboard:current",
          },
          segment: {
            segmentId: "segment-refresh-in-place",
            seq: 1,
          },
          entries: [
            {
              entryId: "entry-refresh-constraint",
              kind: "constraint",
              confidence: 0.97,
              priority: 50,
              body: "Do not write the real DB, edit config, restart gateway, or enable runtime overlay without a separately approved named gate.",
              sourceRefs: [{ type: "workspace_file", path: "Friday-memory/CURRENT.md" }],
            },
            {
              entryId: "entry-refresh-stale-fact",
              kind: "fact",
              confidence: 0.96,
              priority: 45,
              body: "The real session-memory DB currently has active reviewed seed rows only for older conversations 2331 and 2360; current conversation 2520 has no active seed rows.",
              sourceRefs: [{ type: "workspace_file", path: "Friday-memory/STARTUP.md" }],
            },
            {
              entryId: "entry-refresh-decision",
              kind: "decision",
              confidence: 0.93,
              priority: 40,
              body: "Proceed with practical Lossless integration as a read-only reviewed working-memory overlay.",
              sourceRefs: [{ type: "workspace_file", path: "Friday-memory/work/lossless-current.md" }],
            },
            {
              entryId: "entry-refresh-next-action",
              kind: "next_action",
              confidence: 0.94,
              priority: 35,
              body: "First prove this exact packet on a temp DB before any real DB write.",
              sourceRefs: [{ type: "workspace_file", path: "Friday-memory/plans/Friday/session-memory-current-conversation-seed-carry-forward-2026-06-19.md" }],
            },
            {
              entryId: "entry-refresh-risk",
              kind: "risk",
              confidence: 0.9,
              priority: 30,
              body: "Conversation-local seed is insufficient unless reviewed project facts are carried or refreshed.",
              sourceRefs: [{ type: "workspace_file", path: "Friday-memory/plans/Friday/session-memory-gate10-operational-policy-and-effect-validation-2026-06-16.md" }],
            },
          ],
        }),
      });
      expect(seeded).toMatchObject({ ok: true, entryCount: 5 });

      const refreshed = refreshSessionMemoryEntries({
        dbPath: fixture.dbPath,
        lcmDbPath: join(fixture.tempDir, "missing-lcm.db"),
        conversationId: 2565,
        sessionKey: "agent:main:dashboard:current",
        replacementEntries: [
          {
            sourceEntryId: "entry-refresh-stale-fact",
            entryId: "entry-refresh-current-db-state",
            body: "The real session-memory DB has active reviewed seed rows for conversations 2331, 2360, 2520, 2538, 2549, and 2565; runtime overlay insertion remains disabled.",
            confidence: 0.96,
            priority: 45,
            sourceRefs: [{ type: "workspace_file", path: "Friday-memory/STARTUP.md" }],
          },
        ],
        now: new Date("2026-06-20T10:25:00.000Z"),
      });

      expect(refreshed).toMatchObject({
        ok: true,
        status: "written",
        conversationId: 2565,
        sessionId: "session-refresh-in-place",
        entryCount: 1,
        linkCount: 1,
        skippedEntryIds: [
          { entryId: "entry-refresh-stale-fact", reason: "current_state_fact_requires_refresh" },
          { entryId: "entry-refresh-next-action", reason: "next_action_requires_refresh" },
        ],
        replacementEntryIds: [
          { fromEntryId: "entry-refresh-stale-fact", toEntryId: "entry-refresh-current-db-state" },
        ],
      });

      const db = new DatabaseSync(fixture.dbPath, { readOnly: true });
      try {
        expect(
          db
            .prepare("SELECT status, settled_at, superseded_by_entry_id FROM entries WHERE entry_id = ?")
            .get("entry-refresh-stale-fact"),
        ).toEqual({
          status: "superseded",
          settled_at: "2026-06-20T10:25:00.000Z",
          superseded_by_entry_id: "entry-refresh-current-db-state",
        });
        expect(
          db
            .prepare("SELECT status, settled_at, superseded_by_entry_id FROM entries WHERE entry_id = ?")
            .get("entry-refresh-next-action"),
        ).toEqual({
          status: "settled",
          settled_at: "2026-06-20T10:25:00.000Z",
          superseded_by_entry_id: null,
        });
        expect(
          db
            .prepare("SELECT kind, status, origin_entry_id, body FROM entries WHERE entry_id = ?")
            .get("entry-refresh-current-db-state"),
        ).toEqual({
          kind: "fact",
          status: "active",
          origin_entry_id: "entry-refresh-stale-fact",
          body: "The real session-memory DB has active reviewed seed rows for conversations 2331, 2360, 2520, 2538, 2549, and 2565; runtime overlay insertion remains disabled.",
        });
        expect(
          (db
            .prepare("SELECT COUNT(*) AS count FROM links WHERE relation = 'supersedes' AND src_id = ? AND dst_id = ?")
            .get("entry-refresh-current-db-state", "entry-refresh-stale-fact") as { count: number }).count,
        ).toBe(1);
      } finally {
        db.close();
      }

      const lookup = await lookupSessionMemoryOverlay(
        {
          conversationId: 2565,
          sessionKey: "agent:main:dashboard:current",
        },
        {
          ...DEFAULT_SESSION_MEMORY_OVERLAY_CONFIG,
          enabled: true,
          dbPath: fixture.dbPath,
          lcmDbPath: join(fixture.tempDir, "missing-lcm.db"),
          staleAfterMs: 7 * 24 * 60 * 60 * 1000,
        },
      );
      expect(lookup).toMatchObject({
        ok: true,
        source: "session_memory_overlay",
        entries: expect.arrayContaining([
          expect.objectContaining({ entryId: "entry-refresh-current-db-state", kind: "fact" }),
          expect.objectContaining({ entryId: "entry-refresh-constraint", kind: "constraint" }),
        ]),
      });
      expect(lookup.ok && lookup.entries.map((entry) => entry.entryId)).not.toContain("entry-refresh-stale-fact");
      expect(lookup.ok && lookup.entries.map((entry) => entry.entryId)).not.toContain("entry-refresh-next-action");
    } finally {
      fixture.cleanup();
    }
  });

  it("fails closed when carry-forward has no active source entries", () => {
    const fixture = createSchemaFixture();
    try {
      const carried = carryForwardSessionMemoryEntries({
        dbPath: fixture.dbPath,
        lcmDbPath: join(fixture.tempDir, "missing-lcm.db"),
        fromConversationId: 2520,
        to: {
          sessionId: "session-new",
          conversationId: 2521,
        },
      });
      expect(carried).toEqual({
        ok: false,
        status: "refused",
        reason: "no_active_entries",
      });
      expect(countRows(fixture.dbPath, "sessions")).toBe(0);
    } finally {
      fixture.cleanup();
    }
  });

  it("fails closed when an LCM-backed source ref is missing", () => {
    const fixture = createSchemaFixture();
    try {
      const lcmDbPath = createCompatibleLcmDb(fixture.tempDir);
      const result = writeSessionMemorySeedPacket({
        dbPath: fixture.dbPath,
        lcmDbPath,
        packet: basePacket({
          entries: [
            {
              entryId: "entry-missing-summary",
              kind: "evidence",
              confidence: 0.7,
              body: "LCM-backed source refs must point at existing provenance.",
              sourceRefs: [{ type: "lcm_summary", summaryId: "missing-summary" }],
            },
          ],
        }),
      });

      expect(result).toMatchObject({
        ok: false,
        status: "refused",
        reason: "source_ref_missing",
      });
      expect(countRows(fixture.dbPath, "entries")).toBe(0);
    } finally {
      fixture.cleanup();
    }
  });

  it("rolls back the whole packet when a write fails", () => {
    const fixture = createSchemaFixture();
    try {
      const first = writeSessionMemorySeedPacket({
        dbPath: fixture.dbPath,
        lcmDbPath: join(fixture.tempDir, "missing-lcm.db"),
        packet: basePacket(),
      });
      expect(first).toMatchObject({ ok: true, entryCount: 1 });

      const second = writeSessionMemorySeedPacket({
        dbPath: fixture.dbPath,
        lcmDbPath: join(fixture.tempDir, "missing-lcm.db"),
        packet: basePacket({
          session: {
            sessionId: "session-gate7-second",
            conversationId: 123,
            sessionKey: "agent:main:test",
          },
          segment: {
            segmentId: "segment-gate7-second",
            seq: 1,
          },
          entries: [
            {
              entryId: "entry-decision",
              kind: "fact",
              confidence: 0.8,
              body: "This duplicate entry id should fail the transaction.",
            },
          ],
        }),
      });

      expect(second).toMatchObject({
        ok: false,
        status: "failed",
        reason: "write_failed",
      });
      expect(countRows(fixture.dbPath, "sessions")).toBe(1);
      expect(countRows(fixture.dbPath, "segments")).toBe(1);
      expect(countRows(fixture.dbPath, "entries")).toBe(1);
    } finally {
      fixture.cleanup();
    }
  });

  it("refuses non-temp DB paths in Gate 7", () => {
    const realDbPath = join(process.cwd(), ".session-memory-writer-real", "session-memory.db");
    const result = writeSessionMemorySeedPacket({
      dbPath: realDbPath,
      lcmDbPath: join(tmpdir(), "missing-lcm.db"),
      packet: basePacket(),
    });

    expect(result).toEqual({
      ok: false,
      status: "refused",
      reason: "real_db_refused",
    });

    const carried = carryForwardSessionMemoryEntries({
      dbPath: realDbPath,
      lcmDbPath: join(tmpdir(), "missing-lcm.db"),
      fromConversationId: 2520,
      to: {
        sessionId: "session-new",
        conversationId: 2521,
      },
    });
    expect(carried).toEqual({
      ok: false,
      status: "refused",
      reason: "real_db_refused",
    });
  });

  it("writes to a real DB path only with explicit Gate 8 approval", () => {
    const realDir = join(process.cwd(), ".session-memory-writer-real");
    const realDbPath = join(realDir, "session-memory.db");
    rmSync(realDir, { recursive: true, force: true });
    mkdirSync(realDir, { recursive: true });
    try {
      const config = resolveLcmConfig(
        {},
        {
          sessionMemoryOverlay: {
            dbPath: realDbPath,
          },
        },
      );
      const dryRun = buildSessionMemorySchemaMaintenanceText({
        config,
        command: {
          action: "apply",
          execute: false,
          allowRealDb: true,
        },
      });
      const confirmation = dryRun.match(/execute confirmation: ([a-z0-9_:-]+)/)?.[1];
      if (!confirmation) {
        throw new Error("expected real DB schema confirmation token");
      }
      const created = buildSessionMemorySchemaMaintenanceText({
        config,
        command: {
          action: "apply",
          execute: true,
          allowRealDb: true,
          confirm: confirmation,
        },
      });
      expect(created).toContain("status: created");

      const refused = writeSessionMemorySeedPacket({
        dbPath: realDbPath,
        lcmDbPath: join(realDir, "missing-lcm.db"),
        packet: basePacket(),
      });
      expect(refused).toEqual({
        ok: false,
        status: "refused",
        reason: "real_db_refused",
      });

      const written = writeSessionMemorySeedPacket({
        dbPath: realDbPath,
        lcmDbPath: join(realDir, "missing-lcm.db"),
        allowRealDb: true,
        now: new Date("2026-06-15T17:30:00.000Z"),
        packet: basePacket({
          session: {
            sessionId: "session-gate8",
            conversationId: 123,
            sessionKey: "agent:main:test",
          },
          segment: {
            segmentId: "segment-gate8",
            seq: 1,
          },
          entries: [
            {
              entryId: "entry-gate8-seed",
              kind: "fact",
              confidence: 0.9,
              body: "Gate 8 allows an explicitly approved manual seed write to the real DB path.",
              sourceRefs: [{ type: "workspace_file", path: "Friday-memory/CURRENT.md" }],
            },
          ],
        }),
      });
      expect(written).toMatchObject({
        ok: true,
        status: "written",
        sessionId: "session-gate8",
        segmentId: "segment-gate8",
        entryCount: 1,
        linkCount: 0,
      });
      expect(countRows(realDbPath, "entries")).toBe(1);
    } finally {
      rmSync(realDir, { recursive: true, force: true });
    }
  });
});
