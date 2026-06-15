import { mkdtempSync, rmSync } from "node:fs";
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
import { type SessionMemorySeedPacket, writeSessionMemorySeedPacket } from "../src/session-memory-writer.js";

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
  });
});
