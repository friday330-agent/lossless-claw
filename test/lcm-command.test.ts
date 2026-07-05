import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runLcmMigrations } from "../src/db/migration.js";
import { getLcmDbFeatures } from "../src/db/features.js";
import { createLcmDatabaseConnection, closeLcmConnection } from "../src/db/connection.js";
import { resolveLcmConfig } from "../src/db/config.js";
import { ConversationStore } from "../src/store/conversation-store.js";
import { FocusBriefStore } from "../src/store/focus-brief-store.js";
import { SummaryStore } from "../src/store/summary-store.js";
import { createLcmCommand, __testing } from "../src/plugin/lcm-command.js";
import { writeSessionMemorySeedPacket } from "../src/session-memory-writer.js";
import {
  DEFAULT_SESSION_MEMORY_OVERLAY_CONFIG,
  lookupSessionMemoryOverlay,
  renderSessionMemoryOverlay,
} from "../src/session-memory.js";
import type { LcmSummarizeFn } from "../src/summarize.js";
import type { LcmDependencies } from "../src/types.js";
import { assemblySourceTelemetry } from "../src/assembly-source-telemetry.js";

function createCommandFixture(options?: {
  summarize?: LcmSummarizeFn;
  deps?: LcmDependencies;
  getLcm?: () => Promise<{
    rotateSessionStorageWithBackup: (...args: unknown[]) => Promise<unknown>;
    compact?: (...args: unknown[]) => Promise<unknown>;
  }>;
}) {
  const tempDir = mkdtempSync(join(tmpdir(), "lossless-claw-command-"));
  const dbPath = join(tempDir, "lcm.db");
  const db = createLcmDatabaseConnection(dbPath);
  const { fts5Available } = getLcmDbFeatures(db);
  runLcmMigrations(db, { fts5Available });
  const conversationStore = new ConversationStore(db, { fts5Available });
  const summaryStore = new SummaryStore(db, { fts5Available });
  const config = resolveLcmConfig({}, { dbPath });
  const command = createLcmCommand({
    db,
    config,
    summarize: options?.summarize,
    deps: options?.deps,
    getLcm: options?.getLcm,
  });
  return { tempDir, dbPath, db, config, command, conversationStore, summaryStore };
}

function createCommandContext(
  args?: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    channel: "telegram",
    isAuthorizedSender: true,
    commandBody: args ? `/lossless ${args}` : "/lossless",
    args,
    config: {
      plugins: {
        entries: {
          "lossless-claw": {
            enabled: true,
          },
        },
        slots: {
          contextEngine: "lossless-claw",
        },
      },
    },
    requestConversationBinding: async () => ({ status: "error" as const, message: "unsupported" }),
    detachConversationBinding: async () => ({ removed: false }),
    getCurrentConversationBinding: async () => null,
    ...overrides,
  };
}

describe("lcm command", () => {
  const tempDirs = new Set<string>();
  const dbPaths = new Set<string>();

  afterEach(() => {
    vi.restoreAllMocks();
    assemblySourceTelemetry.reset();
    for (const dbPath of dbPaths) {
      closeLcmConnection(dbPath);
    }
    dbPaths.clear();
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    tempDirs.clear();
  });

  it("reports compact global status and help hints", async () => {
    const fixture = createCommandFixture();
    tempDirs.add(fixture.tempDir);
    dbPaths.add(fixture.dbPath);

    const conversation = await fixture.conversationStore.createConversation({
      sessionId: "status-session",
      title: "Status fixture",
    });
    const [firstMessage, secondMessage] = await fixture.conversationStore.createMessagesBulk([
      {
        conversationId: conversation.conversationId,
        seq: 0,
        role: "user",
        content: "first source message",
        tokenCount: 10,
      },
      {
        conversationId: conversation.conversationId,
        seq: 1,
        role: "assistant",
        content: "second source message",
        tokenCount: 12,
      },
    ]);

    await fixture.summaryStore.insertSummary({
      summaryId: "sum_leaf",
      conversationId: conversation.conversationId,
      kind: "leaf",
      depth: 0,
      content: `leaf summary\n${"[Truncated from 2048 tokens]"}`,
      tokenCount: 50,
      sourceMessageTokenCount: 22,
    });
    await fixture.summaryStore.insertSummary({
      summaryId: "sum_parent",
      conversationId: conversation.conversationId,
      kind: "condensed",
      depth: 1,
      content: "condensed summary",
      tokenCount: 25,
      sourceMessageTokenCount: 22,
    });
    await fixture.summaryStore.linkSummaryToMessages("sum_leaf", [
      firstMessage.messageId,
      secondMessage.messageId,
    ]);
    await fixture.summaryStore.linkSummaryToParents("sum_parent", ["sum_leaf"]);

    const result = await fixture.command.handler(createCommandContext());
    expect(result.text).toContain("**🦀 Lossless Claw");
    expect(result.text).toContain("Help: `/lossless help`");
    expect(result.text).toContain("Alias: `/lcm`");
    expect(result.text).toContain("**🧩 Plugin**");
    expect(result.text).toContain("enabled: yes");
    expect(result.text).toContain("selected: yes (slot=lossless-claw)");
    expect(result.text).toContain(`db path: ${fixture.dbPath}`);
    expect(result.text).toContain("**🌐 Global**");
    expect(result.text).toContain("summaries: 2 (1 leaf, 1 condensed)");
    expect(result.text).toContain("stored summary tokens: 75");
    expect(result.text).toContain("summarized source tokens: 22");
    expect(result.text).not.toContain("warning (1 issue; run `/lossless doctor`)");
    expect(result.text).not.toContain("doctor: warning");
    expect(result.text).toContain("**📍 Current conversation**");
    expect(result.text).toContain("status: unavailable");
    expect(result.text).toContain("OpenClaw did not expose an active session key or session id here");
  });

  it("resolves current conversation stats when the host provides a session key", async () => {
    const fixture = createCommandFixture();
    tempDirs.add(fixture.tempDir);
    dbPaths.add(fixture.dbPath);

    const conversation = await fixture.conversationStore.createConversation({
      sessionId: "session-key-status-session",
      sessionKey: "agent:main:telegram:direct:4242",
      title: "Current conversation fixture",
    });
    const [firstMessage, secondMessage] = await fixture.conversationStore.createMessagesBulk([
      {
        conversationId: conversation.conversationId,
        seq: 0,
        role: "user",
        content: "current conversation message one",
        tokenCount: 8,
      },
      {
        conversationId: conversation.conversationId,
        seq: 1,
        role: "assistant",
        content: "current conversation message two",
        tokenCount: 13,
      },
    ]);

    await fixture.summaryStore.insertSummary({
      summaryId: "current_leaf",
      conversationId: conversation.conversationId,
      kind: "leaf",
      depth: 0,
      content: `current summary body\n${"[Truncated from 512 tokens]"}`,
      tokenCount: 7,
      sourceMessageTokenCount: 21,
    });
    await fixture.summaryStore.linkSummaryToMessages("current_leaf", [
      firstMessage.messageId,
      secondMessage.messageId,
    ]);
    await fixture.summaryStore.insertSummary({
      summaryId: "current_parent",
      conversationId: conversation.conversationId,
      kind: "condensed",
      depth: 1,
      content: "current parent summary",
      tokenCount: 5,
      descendantTokenCount: 7,
      sourceMessageTokenCount: 21,
    });
    await fixture.summaryStore.linkSummaryToParents("current_parent", ["current_leaf"]);
    await fixture.summaryStore.replaceContextRangeWithSummary({
      conversationId: conversation.conversationId,
      startOrdinal: 0,
      endOrdinal: 1,
      summaryId: "current_parent",
    });

    const result = await fixture.command.handler(
      createCommandContext(undefined, {
        sessionKey: "agent:main:telegram:direct:4242",
      }),
    );

    expect(result.text).toContain("**📍 Current conversation**");
    expect(result.text).not.toContain("status: resolved via session key");
    expect(result.text).toContain(`conversation id: ${conversation.conversationId}`);
    expect(result.text).toContain("session key: `agent:main:telegram:direct:4242`");
    expect(result.text).not.toContain("session id:");
    expect(result.text).toContain("messages: 2");
    expect(result.text).toContain("summaries: 2 (1 leaf, 1 condensed)");
    expect(result.text).toContain("stored summary tokens: 12");
    expect(result.text).toContain("summarized source tokens: 21");
    expect(result.text).toContain("tokens in context: 5");
    expect(result.text).toContain("compression ratio: 1:6");
    expect(result.text).toContain("doctor: 1 issue(s) in this conversation");
  });

  it("reports focus usage when no brief exists for the current conversation", async () => {
    const fixture = createCommandFixture();
    tempDirs.add(fixture.tempDir);
    dbPaths.add(fixture.dbPath);

    await fixture.conversationStore.createConversation({
      sessionId: "focus-empty-session",
      sessionKey: "agent:main:telegram:direct:focus-empty",
      title: "Focus empty fixture",
    });

    const result = await fixture.command.handler(
      createCommandContext("focus", {
        sessionKey: "agent:main:telegram:direct:focus-empty",
      }),
    );

    expect(result.text).toContain("Lossless Claw Focus");
    expect(result.text).toContain("status: none");
    expect(result.text).toContain("usage: `/lossless focus <prompt>`");
  });

  it("generates and persists an active focus brief through a delegated subagent", async () => {
    const fixture = createCommandFixture();
    tempDirs.add(fixture.tempDir);
    dbPaths.add(fixture.dbPath);
    const sessionKey = "agent:main:telegram:direct:focus-generate";
    const lifecycleEvents: string[] = [];

    const currentConversation = await fixture.conversationStore.createConversation({
      sessionId: "focus-generate-session",
      sessionKey,
      title: "Focus generation fixture",
    });
    const [firstMessage, secondMessage] = await fixture.conversationStore.createMessagesBulk([
      {
        conversationId: currentConversation.conversationId,
        seq: 0,
        role: "user",
        content: "Alpha auth work started.",
        tokenCount: 6,
      },
      {
        conversationId: currentConversation.conversationId,
        seq: 1,
        role: "assistant",
        content: "Alpha auth work reached the review stage.",
        tokenCount: 8,
      },
    ]);
    fixture.db
      .prepare(`UPDATE messages SET created_at = ? WHERE conversation_id = ?`)
      .run("2026-05-15 00:00:00", currentConversation.conversationId);
    await fixture.summaryStore.insertSummary({
      summaryId: "focus_leaf",
      conversationId: currentConversation.conversationId,
      kind: "leaf",
      depth: 0,
      content: "Alpha auth implementation details.",
      tokenCount: 50,
      sourceMessageTokenCount: 14,
    });
    await fixture.summaryStore.linkSummaryToMessages("focus_leaf", [
      firstMessage.messageId,
      secondMessage.messageId,
    ]);
    await fixture.summaryStore.insertSummary({
      summaryId: "focus_parent",
      conversationId: currentConversation.conversationId,
      kind: "condensed",
      depth: 1,
      content: "Alpha auth current state and review notes.",
      tokenCount: 20,
      descendantTokenCount: 50,
      sourceMessageTokenCount: 14,
    });
    await fixture.summaryStore.linkSummaryToParents("focus_parent", ["focus_leaf"]);
    fixture.db
      .prepare(`UPDATE summaries SET latest_at = ? WHERE summary_id = ?`)
      .run("2026-05-15 00:00:00", "focus_parent");
    await fixture.summaryStore.replaceContextRangeWithSummary({
      conversationId: currentConversation.conversationId,
      startOrdinal: 0,
      endOrdinal: 1,
      summaryId: "focus_parent",
    });

    let agentRuns = 0;
    let sessionReads = 0;
    const callGateway = vi.fn(async (request: { method: string; params?: Record<string, unknown> }) => {
      if (request.method === "agent") {
        agentRuns += 1;
        lifecycleEvents.push(`agent-${agentRuns}`);
        if (agentRuns === 1) {
          expect(String(request.params?.message)).toContain("Gather Lossless focus evidence.");
          expect(String(request.params?.message)).toContain("lcm_grep");
          expect(String(request.params?.message)).toContain("do NOT call lcm_expand_query");
        } else {
          expect(String(request.params?.message)).toContain("Synthesize the final Lossless focus context brief.");
          expect(String(request.params?.message)).toContain("Evidence dossier");
        }
        return { runId: `focus-run-${agentRuns}` };
      }
      if (request.method === "agent.wait") {
        return { status: "ok" };
      }
      if (request.method === "sessions.get") {
        sessionReads += 1;
        return {
          messages: [
            {
              role: "assistant",
              content:
                sessionReads === 1
                  ? JSON.stringify({
                      evidenceMarkdown:
                        "## Evidence Dossier\n- focus_parent cites alpha auth review state.\n- focus_leaf expands implementation details.",
                      citedSummaryIds: ["focus_parent"],
                      expandedSummaryIds: ["focus_leaf"],
                      irrelevantSummaryIds: ["unrelated_summary"],
                      expansionPrompts: [
                        {
                          prompt: "Expand the alpha auth implementation details.",
                          summaryIds: ["focus_leaf"],
                        },
                      ],
                      confidenceNotes: ["focus_parent was in active context"],
                      truncated: false,
                    })
                  : JSON.stringify({
                      briefMarkdown: `## Focused Narrative\n${"Alpha auth is ready for review. ".repeat(8_000)}`,
                      citedSummaryIds: ["focus_parent"],
                      expandedSummaryIds: ["focus_leaf"],
                      irrelevantSummaryIds: ["unrelated_summary"],
                      expansionPrompts: [
                        {
                          prompt: "Expand the alpha auth implementation details.",
                          summaryIds: ["focus_leaf"],
                        },
                      ],
                      confidenceNotes: ["focus_parent was in active context"],
                      truncated: false,
                    }),
            },
          ],
        };
      }
      if (request.method === "sessions.delete") {
        return { ok: true };
      }
      throw new Error(`unexpected gateway method ${request.method}`);
    });
    const deps = {
      config: fixture.config,
      complete: vi.fn(),
      callGateway,
      resolveModel: () => ({ provider: "test", model: "test-model" }),
      parseAgentSessionKey: (key: string) => {
        const match = /^agent:([^:]+):(.*)$/.exec(key);
        return match ? { agentId: match[1] ?? "main", suffix: match[2] ?? "" } : null;
      },
      isSubagentSessionKey: (key: string) => key.includes(":subagent:"),
      normalizeAgentId: (id?: string) => id?.trim() || "main",
      buildSubagentSystemPrompt: () => "subagent system prompt",
      readLatestAssistantReply: (messages: unknown[]) => {
        const latest = messages.at(-1) as { content?: unknown } | undefined;
        return typeof latest?.content === "string" ? latest.content : undefined;
      },
      resolveAgentDir: () => fixture.tempDir,
      resolveSessionIdFromSessionKey: async () => undefined,
      resolveSessionTranscriptFile: async () => undefined,
      agentLaneSubagent: "subagent",
      log: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      },
    } as unknown as LcmDependencies;
    const compact = vi.fn(async () => {
      lifecycleEvents.push("compact");
      return { ok: true, compacted: true, reason: "forced full sweep" };
    });
    const command = createLcmCommand({
      db: fixture.db,
      config: fixture.config,
      deps,
      getLcm: async () => ({
        compact,
        rotateSessionStorageWithBackup: vi.fn(),
      }),
    });

    const result = await command.handler(
      createCommandContext("focus alpha auth review state", {
        sessionKey,
      }),
    );

    expect(result.text).toContain("Focus brief");
    expect(result.text).toContain("Pre-focus compaction");
    expect(result.text).toContain("compacted: yes");
    expect(result.text).toContain("status: active");
    expect(result.text).toContain("Alpha auth is ready for review.");
    expect(lifecycleEvents.slice(0, 3)).toEqual(["compact", "agent-1", "agent-2"]);
    expect(compact).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "focus-generate-session",
        sessionKey,
        compactionTarget: "threshold",
        force: true,
      }),
    );
    expect(callGateway.mock.calls.map((call) => call[0].method)).toEqual([
      "agent",
      "agent.wait",
      "sessions.get",
      "agent",
      "agent.wait",
      "sessions.get",
      "sessions.delete",
    ]);
    const brief = fixture.db
      .prepare(`SELECT brief_id, prompt, status, content, generator_run_id, raw_result_json FROM focus_briefs`)
      .get() as {
      brief_id: string;
      prompt: string;
      status: string;
      content: string;
      generator_run_id: string;
      raw_result_json: string;
    };
    expect(brief.prompt).toBe("alpha auth review state");
    expect(brief.status).toBe("active");
    expect(brief.content).toContain("Alpha auth is ready for review.");
    expect(brief.generator_run_id).toBe("focus-run-2");
    const rawResult = JSON.parse(brief.raw_result_json) as {
      citedSummaryIds?: string[];
      expandedSummaryIds?: string[];
      irrelevantSummaryIds?: string[];
      confidenceNotes?: string[];
    };
    expect(rawResult.citedSummaryIds).toEqual(["focus_parent"]);
    expect(rawResult.expandedSummaryIds).toEqual(["focus_leaf"]);
    expect(rawResult.irrelevantSummaryIds).toEqual(["unrelated_summary"]);
    expect(rawResult.confidenceNotes).toEqual(["focus_parent was in active context"]);
    const sources = fixture.db
      .prepare(`SELECT summary_id, role FROM focus_brief_sources ORDER BY role, summary_id`)
      .all() as Array<{ summary_id: string; role: string }>;
    expect(sources).toEqual([
      { summary_id: "focus_parent", role: "active_input" },
      { summary_id: "focus_parent", role: "cited" },
      { summary_id: "focus_leaf", role: "expanded" },
      { summary_id: "unrelated_summary", role: "irrelevant" },
    ]);

    const [postFocusMessage] = await fixture.conversationStore.createMessagesBulk([
      {
        conversationId: currentConversation.conversationId,
        seq: 2,
        role: "user",
        content: "Alpha auth post-focus review note.",
        tokenCount: 9,
      },
    ]);
    await fixture.summaryStore.insertSummary({
      summaryId: "focus_delta",
      conversationId: currentConversation.conversationId,
      kind: "leaf",
      depth: 0,
      content: "Alpha auth post-focus context.",
      tokenCount: 11,
      sourceMessageTokenCount: 9,
      latestAt: new Date("2026-05-16T00:00:00Z"),
    });
    await fixture.summaryStore.linkSummaryToMessages("focus_delta", [postFocusMessage.messageId]);
    await fixture.summaryStore.replaceContextRangeWithSummary({
      conversationId: currentConversation.conversationId,
      startOrdinal: 0,
      endOrdinal: 0,
      summaryId: "focus_delta",
    });
    const focusStore = new FocusBriefStore(fixture.db);
    await focusStore.createFocusBrief({
      conversationId: currentConversation.conversationId,
      prompt: "failed refocus",
      content: "",
      status: "failed",
      error: "generation timed out",
      supersedeCurrentDrafts: false,
    });

    const status = await command.handler(
      createCommandContext("focus", {
        sessionKey,
      }),
    );
    expect(status.text).toContain(`brief id: \`${brief.brief_id}\``);
    expect(status.text).toContain("status: active");
    expect(status.text).toContain("source summaries: 1");
    expect(status.text).toContain("cited summaries: focus_parent");
    expect(status.text).toContain("expanded summaries: focus_leaf");
    expect(status.text).toContain("irrelevant summaries: unrelated_summary");
    expect(status.text).toContain("expansion prompts: 1");
    expect(status.text).toContain("confidence notes: focus_parent was in active context");
    expect(status.text).toContain("delta since focus: 1 messages, 1 summaries, ~20 tokens");
    expect(status.text).toContain("stale: yes");
    expect(status.text).toContain("source snapshot: obsolete");
    expect(status.text).toContain("latest generation: failed");
    expect(status.text).toContain("generation timed out");

    const generalStatus = await command.handler(
      createCommandContext("status", {
        sessionKey,
      }),
    );
    expect(generalStatus.text).toContain("**🎯 Focus**");
    expect(generalStatus.text).toContain("status: active");
    expect(generalStatus.text).toContain("expanded summaries: focus_leaf");
    expect(generalStatus.text).toContain("confidence notes: focus_parent was in active context");
    expect(generalStatus.text).toContain("delta since focus: 1 messages, 1 summaries, ~20 tokens");

    const unfocus = await command.handler(
      createCommandContext("unfocus", {
        sessionKey,
      }),
    );
    expect(unfocus.text).toContain("status: inactive");
    expect(unfocus.text).toContain("deactivated briefs: 1");
    expect(unfocus.text).toContain("Post-unfocus compaction");
    expect(compact).toHaveBeenCalledTimes(2);
    expect(
      fixture.db
        .prepare(`SELECT status FROM focus_briefs WHERE brief_id = ?`)
        .get(brief.brief_id),
    ).toEqual({ status: "inactive" });
  });

  it("refocuses an active focus brief from post-focus delta summaries", async () => {
    const fixture = createCommandFixture();
    tempDirs.add(fixture.tempDir);
    dbPaths.add(fixture.dbPath);
    const sessionKey = "agent:main:telegram:direct:refocus-generate";
    const lifecycleEvents: string[] = [];

    const currentConversation = await fixture.conversationStore.createConversation({
      sessionId: "refocus-generate-session",
      sessionKey,
      title: "Refocus generation fixture",
    });
    const [oldMessage, deltaMessage] = await fixture.conversationStore.createMessagesBulk([
      {
        conversationId: currentConversation.conversationId,
        seq: 0,
        role: "user",
        content: "Original focus setup.",
        tokenCount: 5,
      },
      {
        conversationId: currentConversation.conversationId,
        seq: 1,
        role: "assistant",
        content: "New delta after focus.",
        tokenCount: 6,
      },
    ]);
    await fixture.summaryStore.insertSummary({
      summaryId: "refocus_old",
      conversationId: currentConversation.conversationId,
      kind: "leaf",
      depth: 0,
      content: "Original focus source.",
      tokenCount: 20,
      sourceMessageTokenCount: 5,
      latestAt: new Date("2026-05-15T00:00:00Z"),
    });
    await fixture.summaryStore.linkSummaryToMessages("refocus_old", [oldMessage.messageId]);
    await fixture.summaryStore.insertSummary({
      summaryId: "refocus_delta",
      conversationId: currentConversation.conversationId,
      kind: "leaf",
      depth: 0,
      content: "New relevant delta for the original prompt.",
      tokenCount: 30,
      sourceMessageTokenCount: 6,
      latestAt: new Date("2026-05-16T00:00:00Z"),
    });
    await fixture.summaryStore.linkSummaryToMessages("refocus_delta", [deltaMessage.messageId]);
    await fixture.summaryStore.appendContextSummary(
      currentConversation.conversationId,
      "refocus_old",
    );
    await fixture.summaryStore.appendContextSummary(
      currentConversation.conversationId,
      "refocus_delta",
    );
    const focusStore = new FocusBriefStore(fixture.db);
    const oldBrief = await focusStore.createFocusBrief({
      conversationId: currentConversation.conversationId,
      sessionKey,
      prompt: "agent configuration",
      content: "Existing focus brief baseline.",
      status: "active",
      tokenCount: 40,
      targetTokens: 12_000,
      coveredLatestAt: "2026-05-15T00:00:00.000Z",
      coveredMessageSeq: 0,
      sourceContextHash: "old-hash",
      sources: [{ summaryId: "refocus_old", ordinal: 0, role: "active_input" }],
      supersedeCurrentDrafts: true,
    });

    let agentRuns = 0;
    let sessionReads = 0;
    const callGateway = vi.fn(async (request: { method: string; params?: Record<string, unknown> }) => {
      if (request.method === "agent") {
        agentRuns += 1;
        lifecycleEvents.push(`agent-${agentRuns}`);
        const message = String(request.params?.message);
        if (agentRuns === 1) {
          expect(message).toContain("Gather Lossless refocus delta evidence.");
          expect(message).toContain("Existing focus brief baseline.");
          expect(message).toContain("refocus_delta");
          expect(message).not.toContain("refocus_old");
        } else {
          expect(message).toContain("Synthesize the refreshed Lossless focus context brief.");
          expect(message).toContain("Existing focus brief baseline.");
        }
        return { runId: `refocus-run-${agentRuns}` };
      }
      if (request.method === "agent.wait") {
        return { status: "ok" };
      }
      if (request.method === "sessions.get") {
        sessionReads += 1;
        return {
          messages: [
            {
              role: "assistant",
              content:
                sessionReads === 1
                  ? JSON.stringify({
                      evidenceMarkdown: "## Delta Evidence\n- refocus_delta updates agent configuration.",
                      citedSummaryIds: ["refocus_delta"],
                      expandedSummaryIds: ["refocus_delta"],
                      irrelevantSummaryIds: [],
                      expansionPrompts: [],
                      confidenceNotes: ["Delta only."],
                      truncated: false,
                    })
                  : JSON.stringify({
                      briefMarkdown: `Existing baseline plus refocus_delta update. ${"Merged relevant delta. ".repeat(8_000)}`,
                      citedSummaryIds: ["refocus_delta"],
                      expandedSummaryIds: ["refocus_delta"],
                      irrelevantSummaryIds: [],
                      expansionPrompts: [],
                      confidenceNotes: ["Merged relevant delta."],
                      truncated: false,
                    }),
            },
          ],
        };
      }
      if (request.method === "sessions.delete") {
        return { ok: true };
      }
      throw new Error(`unexpected gateway method ${request.method}`);
    });
    const deps = {
      config: fixture.config,
      complete: vi.fn(),
      callGateway,
      resolveModel: () => ({ provider: "test", model: "test-model" }),
      parseAgentSessionKey: (key: string) => {
        const match = /^agent:([^:]+):(.*)$/.exec(key);
        return match ? { agentId: match[1] ?? "main", suffix: match[2] ?? "" } : null;
      },
      isSubagentSessionKey: (key: string) => key.includes(":subagent:"),
      normalizeAgentId: (id?: string) => id?.trim() || "main",
      buildSubagentSystemPrompt: () => "subagent system prompt",
      readLatestAssistantReply: (messages: unknown[]) => {
        const latest = messages.at(-1) as { content?: unknown } | undefined;
        return typeof latest?.content === "string" ? latest.content : undefined;
      },
      resolveAgentDir: () => fixture.tempDir,
      resolveSessionIdFromSessionKey: async () => undefined,
      resolveSessionTranscriptFile: async () => undefined,
      agentLaneSubagent: "subagent",
      log: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      },
    } as unknown as LcmDependencies;
    const compact = vi.fn(async () => {
      lifecycleEvents.push("compact");
      return { ok: true, compacted: true, reason: "forced full sweep" };
    });
    const command = createLcmCommand({
      db: fixture.db,
      config: fixture.config,
      deps,
      getLcm: async () => ({
        compact,
        rotateSessionStorageWithBackup: vi.fn(),
      }),
    });

    const result = await command.handler(
      createCommandContext("refocus", {
        sessionKey,
      }),
    );

    expect(result.text).toContain("Focus brief");
    expect(result.text).toContain("status: active");
    expect(result.text).toContain("delta summaries: 1");
    expect(result.text).toContain("Existing baseline plus refocus_delta update.");
    expect(lifecycleEvents.slice(0, 3)).toEqual(["compact", "agent-1", "agent-2"]);
    const rows = fixture.db
      .prepare(`SELECT brief_id, prompt, status, content FROM focus_briefs ORDER BY rowid`)
      .all() as Array<{ brief_id: string; prompt: string; status: string; content: string }>;
    expect(rows).toEqual([
      expect.objectContaining({
        brief_id: oldBrief.briefId,
        prompt: "agent configuration",
        status: "superseded",
      }),
      expect.objectContaining({
        prompt: "agent configuration",
        status: "active",
        content: expect.stringContaining("Existing baseline plus refocus_delta update."),
      }),
    ]);
    const sources = fixture.db
      .prepare(`SELECT summary_id, role FROM focus_brief_sources ORDER BY role, summary_id`)
      .all() as Array<{ summary_id: string; role: string }>;
    expect(sources).toContainEqual({ summary_id: "refocus_delta", role: "active_input" });
    expect(sources).toContainEqual({ summary_id: "refocus_delta", role: "cited" });
  });

  it("keeps the active focus brief when refocus generation fails", async () => {
    const fixture = createCommandFixture();
    tempDirs.add(fixture.tempDir);
    dbPaths.add(fixture.dbPath);
    const sessionKey = "agent:main:telegram:direct:refocus-fails";
    const currentConversation = await fixture.conversationStore.createConversation({
      sessionId: "refocus-fails-session",
      sessionKey,
    });
    const [message] = await fixture.conversationStore.createMessagesBulk([
      {
        conversationId: currentConversation.conversationId,
        seq: 1,
        role: "user",
        content: "Delta message.",
        tokenCount: 4,
      },
    ]);
    await fixture.summaryStore.insertSummary({
      summaryId: "refocus_failed_delta",
      conversationId: currentConversation.conversationId,
      kind: "leaf",
      depth: 0,
      content: "Delta content.",
      tokenCount: 10,
      latestAt: new Date("2026-05-16T00:00:00Z"),
    });
    await fixture.summaryStore.linkSummaryToMessages("refocus_failed_delta", [message.messageId]);
    await fixture.summaryStore.appendContextSummary(
      currentConversation.conversationId,
      "refocus_failed_delta",
    );
    const focusStore = new FocusBriefStore(fixture.db);
    const active = await focusStore.createFocusBrief({
      conversationId: currentConversation.conversationId,
      sessionKey,
      prompt: "agent configuration",
      content: "Still active baseline.",
      status: "active",
      coveredLatestAt: "2026-05-15T00:00:00.000Z",
      coveredMessageSeq: 0,
      supersedeCurrentDrafts: true,
    });
    const deps = {
      config: fixture.config,
      complete: vi.fn(),
      callGateway: vi.fn(async (request: { method: string }) => {
        if (request.method === "agent") return { runId: "refocus-failed-run" };
        if (request.method === "agent.wait") return { status: "timeout" };
        if (request.method === "sessions.delete") return { ok: true };
        throw new Error(`unexpected gateway method ${request.method}`);
      }),
      resolveModel: () => ({ provider: "test", model: "test-model" }),
      parseAgentSessionKey: () => ({ agentId: "main", suffix: "test" }),
      isSubagentSessionKey: (key: string) => key.includes(":subagent:"),
      normalizeAgentId: (id?: string) => id?.trim() || "main",
      buildSubagentSystemPrompt: () => "subagent system prompt",
      readLatestAssistantReply: () => undefined,
      resolveAgentDir: () => fixture.tempDir,
      resolveSessionIdFromSessionKey: async () => undefined,
      resolveSessionTranscriptFile: async () => undefined,
      agentLaneSubagent: "subagent",
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    } as unknown as LcmDependencies;
    const command = createLcmCommand({
      db: fixture.db,
      config: fixture.config,
      deps,
      getLcm: async () => ({
        compact: vi.fn(async () => ({ ok: true, compacted: true, reason: "forced full sweep" })),
        rotateSessionStorageWithBackup: vi.fn(),
      }),
    });

    const result = await command.handler(
      createCommandContext("refocus", {
        sessionKey,
      }),
    );

    expect(result.text).toContain("Generation failed");
    expect(
      fixture.db.prepare(`SELECT status FROM focus_briefs WHERE brief_id = ?`).get(active.briefId),
    ).toEqual({ status: "active" });
  });

  it("reports deferred compaction maintenance state in status output", async () => {
    const fixture = createCommandFixture();
    tempDirs.add(fixture.tempDir);
    dbPaths.add(fixture.dbPath);

    const conversation = await fixture.conversationStore.createConversation({
      sessionId: "maintenance-status-session",
      sessionKey: "agent:main:telegram:maintenance:1",
      title: "Maintenance fixture",
    });
    fixture.db
      .prepare(
        `INSERT INTO conversation_compaction_maintenance (
           conversation_id,
           pending,
           requested_at,
           reason,
           running,
           last_started_at,
           last_finished_at,
           last_failure_summary,
           token_budget,
           current_token_count,
           updated_at
         ) VALUES (?, 1, ?, ?, 0, ?, ?, ?, ?, ?, datetime('now'))`,
      )
      .run(
        conversation.conversationId,
        "2026-04-12T00:00:00.000Z",
        "budget-trigger",
        "2026-04-12T00:05:00.000Z",
        "2026-04-12T00:07:00.000Z",
        "provider timeout",
        128_000,
        96_000,
      );

    const result = await fixture.command.handler(
      createCommandContext(undefined, {
        sessionKey: "agent:main:telegram:maintenance:1",
        sessionId: "maintenance-status-session",
      }),
    );

    expect(result.text).toContain("**🛠️ Maintenance**");
    expect(result.text).toContain("state: pending");
    expect(result.text).toContain("reason: budget-trigger");
    expect(result.text).toContain("last failure: provider timeout");
    expect(result.text).toContain("requested token budget: 128,000");
    expect(result.text).toContain("observed token count: 96,000");
  });

  it("reports assembly source telemetry in status output", async () => {
    const fixture = createCommandFixture();
    tempDirs.add(fixture.tempDir);
    dbPaths.add(fixture.dbPath);

    const conversation = await fixture.conversationStore.createConversation({
      sessionId: "assembly-source-status-session",
      sessionKey: "agent:main:telegram:assembly-source:1",
      title: "Assembly source fixture",
    });
    assemblySourceTelemetry.record({
      conversationId: conversation.conversationId,
      selectedSource: "raw_only",
      reason: "no_summaries",
      hasSummaries: false,
      hasActiveFocus: false,
    });
    assemblySourceTelemetry.record({
      conversationId: conversation.conversationId,
      selectedSource: "focus_brief",
      hasSummaries: true,
      hasActiveFocus: true,
    });

    const result = await fixture.command.handler(
      createCommandContext("status", {
        sessionKey: "agent:main:telegram:assembly-source:1",
        sessionId: "assembly-source-status-session",
      }),
    );

    expect(result.text).toContain("**📦 Assembly source**");
    expect(result.text).toContain("last selected: focus_brief");
    expect(result.text).toContain("counts: raw_only=1, dag_summary=0, focus_brief=1");
    expect(result.text).toContain("skipped: no_summaries=1");
  });

  it("falls back to the active session id when the current session key is not stored yet", async () => {
    const fixture = createCommandFixture();
    tempDirs.add(fixture.tempDir);
    dbPaths.add(fixture.dbPath);

    const conversation = await fixture.conversationStore.createConversation({
      sessionId: "fallback-session-id",
      title: "Fallback conversation fixture",
    });
    await fixture.conversationStore.createMessagesBulk([
      {
        conversationId: conversation.conversationId,
        seq: 0,
        role: "user",
        content: "fallback message",
        tokenCount: 5,
      },
    ]);

    const result = await fixture.command.handler(
      createCommandContext(undefined, {
        sessionKey: "agent:main:telegram:direct:not-yet-stored",
        sessionId: "fallback-session-id",
      }),
    );

    expect(result.text).toContain("**📍 Current conversation**");
    expect(result.text).not.toContain(
      "status: resolved from active session key via session id fallback",
    );
    expect(result.text).toContain(`conversation id: ${conversation.conversationId}`);
    expect(result.text).not.toContain("session id:");
    expect(result.text).toContain("session key: missing");
    expect(result.text).toContain("messages: 1");
    expect(result.text).toContain("tokens in context: 0");
    expect(result.text).toContain("compression ratio: n/a");
  });

  it("refuses session id fallback when it resolves to a different stored session key", async () => {
    const fixture = createCommandFixture();
    tempDirs.add(fixture.tempDir);
    dbPaths.add(fixture.dbPath);

    await fixture.conversationStore.createConversation({
      sessionId: "mismatch-session-id",
      sessionKey: "agent:main:telegram:direct:stored",
      title: "Mismatched fallback fixture",
    });

    const result = await fixture.command.handler(
      createCommandContext(undefined, {
        sessionKey: "agent:main:telegram:direct:active",
        sessionId: "mismatch-session-id",
      }),
    );

    expect(result.text).toContain("📍 Current conversation");
    expect(result.text).toContain("status: unavailable");
    expect(result.text).toContain("Active session key `agent:main:telegram:direct:active` is not stored in LCM yet.");
    expect(result.text).toContain("but it is bound to `agent:main:telegram:direct:stored`, so Global stats are safer.");
    expect(result.text).toContain("fallback: Showing Global stats only.");
  });

  it("scopes doctor output to the resolved current conversation when issues exist", async () => {
    const fixture = createCommandFixture();
    tempDirs.add(fixture.tempDir);
    dbPaths.add(fixture.dbPath);

    const currentConversation = await fixture.conversationStore.createConversation({
      sessionId: "doctor-current",
      sessionKey: "agent:main:telegram:direct:doctor-current",
    });
    const otherConversation = await fixture.conversationStore.createConversation({
      sessionId: "doctor-other",
      sessionKey: "agent:main:telegram:direct:doctor-other",
    });

    await fixture.summaryStore.insertSummary({
      summaryId: "sum_current_old",
      conversationId: currentConversation.conversationId,
      kind: "leaf",
      depth: 0,
      content: `${"[LCM fallback summary; truncated for context management]"}\nlegacy fallback`,
      tokenCount: 10,
    });
    await fixture.summaryStore.insertSummary({
      summaryId: "sum_current_new",
      conversationId: currentConversation.conversationId,
      kind: "leaf",
      depth: 0,
      content: `useful summary body\n${"[Truncated from 999 tokens]"}`,
      tokenCount: 11,
    });
    await fixture.summaryStore.insertSummary({
      summaryId: "sum_other_new",
      conversationId: otherConversation.conversationId,
      kind: "leaf",
      depth: 0,
      content: `other summary body\n${"[Truncated from 123 tokens]"}`,
      tokenCount: 7,
    });

    const result = await fixture.command.handler(
      createCommandContext("doctor", {
        sessionKey: "agent:main:telegram:direct:doctor-current",
      }),
    );

    expect(result.text).toContain("🩺 Lossless Claw Doctor");
    expect(result.text).toContain(`conversation id: ${currentConversation.conversationId}`);
    expect(result.text).toContain("scope: this conversation only");
    expect(result.text).toContain("detected summaries: 2");
    expect(result.text).toContain("old-marker summaries: 1");
    expect(result.text).toContain("truncated-marker summaries: 1");
    expect(result.text).toContain("result: issues found");
    expect(result.text).toContain("sum_current_new (new), sum_current_old (old)");
    expect(result.text).toContain("**🛠️ Next step**");
    expect(result.text).toContain("`/lossless doctor apply` repairs these in place for the current conversation.");
    expect(result.text).not.toContain("sum_other_new");
    expect(result.text).not.toContain(`conversation id: ${otherConversation.conversationId}`);
  });

  it("reports a clean scoped doctor result for the resolved current conversation", async () => {
    const fixture = createCommandFixture();
    tempDirs.add(fixture.tempDir);
    dbPaths.add(fixture.dbPath);

    const currentConversation = await fixture.conversationStore.createConversation({
      sessionId: "doctor-clean",
      sessionKey: "agent:main:telegram:direct:doctor-clean",
    });
    const otherConversation = await fixture.conversationStore.createConversation({
      sessionId: "doctor-dirty",
      sessionKey: "agent:main:telegram:direct:doctor-dirty",
    });

    await fixture.summaryStore.insertSummary({
      summaryId: "sum_clean",
      conversationId: currentConversation.conversationId,
      kind: "leaf",
      depth: 0,
      content: "healthy summary",
      tokenCount: 9,
    });
    await fixture.summaryStore.insertSummary({
      summaryId: "sum_dirty",
      conversationId: otherConversation.conversationId,
      kind: "leaf",
      depth: 0,
      content: `dirty summary\n${"[Truncated from 333 tokens]"}`,
      tokenCount: 12,
    });

    const result = await fixture.command.handler(
      createCommandContext("doctor", {
        sessionKey: "agent:main:telegram:direct:doctor-clean",
      }),
    );

    expect(result.text).toContain("🩺 Lossless Claw Doctor");
    expect(result.text).toContain(`conversation id: ${currentConversation.conversationId}`);
    expect(result.text).toContain("scope: this conversation only");
    expect(result.text).toContain("detected summaries: 0");
    expect(result.text).toContain("result: clean");
    expect(result.text).not.toContain("🧷 Affected summaries");
    expect(result.text).not.toContain("sum_dirty");
  });

  it("reports doctor as unavailable when the current conversation cannot be resolved", async () => {
    const fixture = createCommandFixture();
    tempDirs.add(fixture.tempDir);
    dbPaths.add(fixture.dbPath);

    const otherConversation = await fixture.conversationStore.createConversation({
      sessionId: "doctor-unresolved-other",
      sessionKey: "agent:main:telegram:direct:doctor-unresolved-other",
    });

    await fixture.summaryStore.insertSummary({
      summaryId: "sum_unresolved_other",
      conversationId: otherConversation.conversationId,
      kind: "leaf",
      depth: 0,
      content: `other summary body\n${"[Truncated from 204 tokens]"}`,
      tokenCount: 16,
    });

    const result = await fixture.command.handler(
      createCommandContext("doctor", {
        sessionKey: "agent:main:telegram:direct:not-stored",
        sessionId: "doctor-unresolved-missing",
      }),
    );

    expect(result.text).toContain("🩺 Lossless Claw Doctor");
    expect(result.text).toContain("status: unavailable");
    expect(result.text).toContain(
      "No LCM conversation is stored yet for active session key `agent:main:telegram:direct:not-stored` or active session id `doctor-unresolved-missing`.",
    );
    expect(result.text).toContain("fallback: Doctor is conversation-scoped, so no global scan ran.");
    expect(result.text).not.toContain("detected summaries:");
    expect(result.text).not.toContain("sum_unresolved_other");
  });

  it("reports global high-confidence cleaner candidates with examples", async () => {
    const fixture = createCommandFixture();
    tempDirs.add(fixture.tempDir);
    dbPaths.add(fixture.dbPath);

    const archivedSubagent = await fixture.conversationStore.createConversation({
      sessionId: "doctor-cleaner-archived-subagent",
      sessionKey: "agent:main:subagent:worker-1",
    });
    await fixture.conversationStore.createMessagesBulk([
      {
        conversationId: archivedSubagent.conversationId,
        seq: 0,
        role: "assistant",
        content: "archived subagent chatter",
        tokenCount: 4,
      },
    ]);
    await fixture.conversationStore.archiveConversation(archivedSubagent.conversationId);

    const cronConversation = await fixture.conversationStore.createConversation({
      sessionId: "doctor-cleaner-cron",
      sessionKey: "agent:main:cron:nightly",
    });
    await fixture.conversationStore.createMessagesBulk([
      {
        conversationId: cronConversation.conversationId,
        seq: 0,
        role: "assistant",
        content: "cron wake-up",
        tokenCount: 3,
      },
    ]);

    const nullSubagent = await fixture.conversationStore.createConversation({
      sessionId: "doctor-cleaner-null-subagent",
    });
    await fixture.conversationStore.createMessagesBulk([
      {
        conversationId: nullSubagent.conversationId,
        seq: 1,
        role: "user",
        content: "[Subagent Context] Inspect the repo and summarize the issue.",
        tokenCount: 12,
      },
      {
        conversationId: nullSubagent.conversationId,
        seq: 2,
        role: "assistant",
        content: "Working through the task now.",
        tokenCount: 7,
      },
    ]);

    const normalConversation = await fixture.conversationStore.createConversation({
      sessionId: "doctor-cleaner-normal",
      sessionKey: "agent:main:main",
    });
    await fixture.conversationStore.createMessagesBulk([
      {
        conversationId: normalConversation.conversationId,
        seq: 0,
        role: "user",
        content: "ordinary conversation",
        tokenCount: 4,
      },
    ]);

    await fixture.conversationStore.archiveConversation(nullSubagent.conversationId);

    const liveNullSubagent = await fixture.conversationStore.createConversation({
      sessionId: "doctor-cleaner-live-null-subagent",
    });
    await fixture.conversationStore.createMessagesBulk([
      {
        conversationId: liveNullSubagent.conversationId,
        seq: 0,
        role: "user",
        content: "[Subagent Context] Live child session still in progress.",
        tokenCount: 8,
      },
      {
        conversationId: liveNullSubagent.conversationId,
        seq: 1,
        role: "assistant",
        content: "Still active and should not be treated as junk.",
        tokenCount: 10,
      },
    ]);

    const result = await fixture.command.handler(createCommandContext("doctor clean"));

    expect(result.text).toContain("🩺 Lossless Claw Doctor Clean");
    expect(result.text).toContain("mode: read-only diagnostics");
    expect(result.text).toContain("matched conversations: 3");
    expect(result.text).toContain("matched messages: 4");
    expect(result.text).toContain("filter id: `archived_subagents`");
    expect(result.text).toContain("filter id: `cron_sessions`");
    expect(result.text).toContain("filter id: `null_subagent_context`");
    expect(result.text).toContain("agent:main:subagent:worker-1");
    expect(result.text).toContain("agent:main:cron:nightly");
    expect(result.text).toContain("\"[Subagent Context] Inspect the repo and summarize the issue.\"");
    expect(result.text).toContain("run `/lossless doctor clean apply`");
    expect(result.text).not.toContain("\"[Subagent Context] Live child session still in progress.\"");
    expect(result.text).not.toContain("doctor-cleaner-normal");
    expect(result.text).not.toContain("ordinary conversation");
  });

  it("reports a clean doctor clean scan when no high-confidence candidates exist", async () => {
    const fixture = createCommandFixture();
    tempDirs.add(fixture.tempDir);
    dbPaths.add(fixture.dbPath);

    const currentConversation = await fixture.conversationStore.createConversation({
      sessionId: "doctor-cleaners-clean",
      sessionKey: "agent:main:main",
    });
    await fixture.conversationStore.createMessagesBulk([
      {
        conversationId: currentConversation.conversationId,
        seq: 0,
        role: "user",
        content: "healthy conversation",
        tokenCount: 3,
      },
    ]);

    const result = await fixture.command.handler(createCommandContext("doctor clean"));

    expect(result.text).toContain("🩺 Lossless Claw Doctor Clean");
    expect(result.text).toContain("matched conversations: 0");
    expect(result.text).toContain("matched messages: 0");
    expect(result.text).toContain("No high-confidence cleaner candidates detected.");
    expect(result.text).not.toContain("🧹 Archived subagents");
  });

  it("applies all doctor clean filters with backup-first deletion and preserves unrelated conversations", async () => {
    const fixture = createCommandFixture();
    tempDirs.add(fixture.tempDir);
    dbPaths.add(fixture.dbPath);

    const archivedSubagent = await fixture.conversationStore.createConversation({
      sessionId: "doctor-cleaner-apply-archived-subagent",
      sessionKey: "agent:main:subagent:apply-worker",
    });
    await fixture.conversationStore.createMessagesBulk([
      {
        conversationId: archivedSubagent.conversationId,
        seq: 0,
        role: "assistant",
        content: "archived worker output",
        tokenCount: 5,
      },
    ]);
    await fixture.conversationStore.archiveConversation(archivedSubagent.conversationId);

    const cronConversation = await fixture.conversationStore.createConversation({
      sessionId: "doctor-cleaner-apply-cron",
      sessionKey: "agent:main:cron:apply-nightly",
    });
    await fixture.conversationStore.createMessagesBulk([
      {
        conversationId: cronConversation.conversationId,
        seq: 0,
        role: "assistant",
        content: "cron cleanup run",
        tokenCount: 4,
      },
    ]);

    const nullSubagent = await fixture.conversationStore.createConversation({
      sessionId: "doctor-cleaner-apply-null",
    });
    await fixture.conversationStore.createMessagesBulk([
      {
        conversationId: nullSubagent.conversationId,
        seq: 1,
        role: "user",
        content: "[Subagent Context] Collect evidence and respond.",
        tokenCount: 8,
      },
      {
        conversationId: nullSubagent.conversationId,
        seq: 2,
        role: "assistant",
        content: "Subagent result",
        tokenCount: 4,
      },
    ]);
    await fixture.conversationStore.archiveConversation(nullSubagent.conversationId);

    const liveNullSubagent = await fixture.conversationStore.createConversation({
      sessionId: "doctor-cleaner-apply-live-null",
    });
    await fixture.conversationStore.createMessagesBulk([
      {
        conversationId: liveNullSubagent.conversationId,
        seq: 0,
        role: "user",
        content: "[Subagent Context] Live child session still in progress.",
        tokenCount: 8,
      },
      {
        conversationId: liveNullSubagent.conversationId,
        seq: 1,
        role: "assistant",
        content: "Still active and should not be treated as junk.",
        tokenCount: 10,
      },
    ]);

    const normalConversation = await fixture.conversationStore.createConversation({
      sessionId: "doctor-cleaner-apply-normal",
      sessionKey: "agent:main:main",
    });
    await fixture.conversationStore.createMessagesBulk([
      {
        conversationId: normalConversation.conversationId,
        seq: 0,
        role: "user",
        content: "keep this conversation",
        tokenCount: 4,
      },
    ]);

    const result = await fixture.command.handler(createCommandContext("doctor clean apply"));

    const backupPath = result.text.match(/backup path: (.+)/)?.[1]?.trim();
    const quickCheck = fixture.db.prepare(`PRAGMA quick_check`).get() as { quick_check?: string } | undefined;
    const remainingNormal = await fixture.conversationStore.getConversation(normalConversation.conversationId);
    const removedArchived = await fixture.conversationStore.getConversation(archivedSubagent.conversationId);
    const removedCron = await fixture.conversationStore.getConversation(cronConversation.conversationId);
    const removedNull = await fixture.conversationStore.getConversation(nullSubagent.conversationId);
    const remainingLiveNull = await fixture.conversationStore.getConversation(liveNullSubagent.conversationId);

    expect(result.text).toContain("🩺 Lossless Claw Doctor Clean Apply");
    expect(result.text).toContain("matched conversations before apply: 3");
    expect(result.text).toContain("deleted conversations: 3");
    expect(result.text).toContain("deleted messages: 4");
    expect(result.text).toContain("vacuumed: no");
    expect(result.text).toContain("quick_check: ok");
    expect(backupPath).toBeTruthy();
    expect(existsSync(backupPath!)).toBe(true);
    expect(quickCheck?.quick_check).toBe("ok");
    expect(remainingNormal?.conversationId).toBe(normalConversation.conversationId);
    expect(remainingLiveNull?.conversationId).toBe(liveNullSubagent.conversationId);
    expect(removedArchived).toBeNull();
    expect(removedCron).toBeNull();
    expect(removedNull).toBeNull();
  });

  it("applies a single doctor clean filter without deleting other candidate classes", async () => {
    const fixture = createCommandFixture();
    tempDirs.add(fixture.tempDir);
    dbPaths.add(fixture.dbPath);

    const archivedSubagent = await fixture.conversationStore.createConversation({
      sessionId: "doctor-cleaner-single-archived",
      sessionKey: "agent:main:subagent:single-worker",
    });
    await fixture.conversationStore.createMessagesBulk([
      {
        conversationId: archivedSubagent.conversationId,
        seq: 0,
        role: "assistant",
        content: "archived single worker output",
        tokenCount: 5,
      },
    ]);
    await fixture.conversationStore.archiveConversation(archivedSubagent.conversationId);

    const cronConversation = await fixture.conversationStore.createConversation({
      sessionId: "doctor-cleaner-single-cron",
      sessionKey: "agent:main:cron:single-nightly",
    });
    await fixture.conversationStore.createMessagesBulk([
      {
        conversationId: cronConversation.conversationId,
        seq: 0,
        role: "assistant",
        content: "cron single run",
        tokenCount: 4,
      },
    ]);

    const result = await fixture.command.handler(
      createCommandContext("doctor clean apply cron_sessions"),
    );

    const remainingArchived = await fixture.conversationStore.getConversation(archivedSubagent.conversationId);
    const removedCron = await fixture.conversationStore.getConversation(cronConversation.conversationId);

    expect(result.text).toContain("filters: `cron_sessions`");
    expect(result.text).toContain("matched conversations before apply: 1");
    expect(result.text).toContain("deleted conversations: 1");
    expect(remainingArchived?.conversationId).toBe(archivedSubagent.conversationId);
    expect(removedCron).toBeNull();
  });

  it("vacuums after doctor clean apply when requested", async () => {
    const fixture = createCommandFixture();
    tempDirs.add(fixture.tempDir);
    dbPaths.add(fixture.dbPath);

    const cronConversation = await fixture.conversationStore.createConversation({
      sessionId: "doctor-cleaner-vacuum-cron",
      sessionKey: "agent:main:cron:vacuum-nightly",
    });
    await fixture.conversationStore.createMessagesBulk([
      {
        conversationId: cronConversation.conversationId,
        seq: 0,
        role: "assistant",
        content: "cron vacuum run",
        tokenCount: 4,
      },
    ]);

    const result = await fixture.command.handler(
      createCommandContext("doctor clean apply cron_sessions vacuum"),
    );
    const walCheckpoint = fixture.db
      .prepare(`PRAGMA wal_checkpoint`)
      .get() as { busy?: number; log?: number; checkpointed?: number } | undefined;

    expect(result.text).toContain("filters: `cron_sessions`");
    expect(result.text).toContain("vacuum requested: yes");
    expect(result.text).toContain("deleted conversations: 1");
    expect(result.text).toContain("vacuumed: yes");
    expect(walCheckpoint?.busy).toBe(0);
  });

  it("warns when doctor clean apply quick_check reports integrity issues", async () => {
    const fixture = createCommandFixture();
    tempDirs.add(fixture.tempDir);
    dbPaths.add(fixture.dbPath);

    const cronConversation = await fixture.conversationStore.createConversation({
      sessionId: "doctor-cleaner-warning-cron",
      sessionKey: "agent:main:cron:warning-nightly",
    });
    await fixture.conversationStore.createMessagesBulk([
      {
        conversationId: cronConversation.conversationId,
        seq: 0,
        role: "assistant",
        content: "cron warning run",
        tokenCount: 4,
      },
    ]);

    const config = resolveLcmConfig({}, { dbPath: fixture.dbPath });
    const dbWithQuickCheckWarning = new Proxy(fixture.db, {
      get(target, prop, receiver) {
        if (prop === "prepare") {
          return (sql: string) => {
            if (sql === "PRAGMA quick_check") {
              return {
                all: () => [{ quick_check: "row 1 missing from index example_idx" }],
              };
            }
            return target.prepare(sql);
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as unknown as typeof fixture.db;
    const command = createLcmCommand({
      db: dbWithQuickCheckWarning,
      config,
    });

    const result = await command.handler(
      createCommandContext("doctor clean apply cron_sessions"),
    );

    expect(result.text).toContain("status: warning");
    expect(result.text).toContain("quick_check: row 1 missing from index example_idx");
    expect(result.text).toContain("writes committed, but SQLite integrity verification reported problems");
  });

  it("keeps doctor apply as a clean scoped no-op when no issues exist", async () => {
    const summarize = vi.fn(async () => "should not run");
    const fixture = createCommandFixture({ summarize: summarize as LcmSummarizeFn });
    tempDirs.add(fixture.tempDir);
    dbPaths.add(fixture.dbPath);

    const currentConversation = await fixture.conversationStore.createConversation({
      sessionId: "doctor-apply-clean",
      sessionKey: "agent:main:telegram:direct:doctor-apply-clean",
    });

    await fixture.summaryStore.insertSummary({
      summaryId: "sum_clean_apply",
      conversationId: currentConversation.conversationId,
      kind: "leaf",
      depth: 0,
      content: "healthy summary",
      tokenCount: 8,
    });

    const result = await fixture.command.handler(
      createCommandContext("doctor apply", {
        sessionKey: "agent:main:telegram:direct:doctor-apply-clean",
      }),
    );

    expect(result.text).toContain("🩺 Lossless Claw Doctor Apply");
    expect(result.text).toContain("scope: this conversation only");
    expect(result.text).toContain("detected summaries: 0");
    expect(result.text).toContain("repaired summaries: 0");
    expect(result.text).toContain("result: clean; no writes ran");
    expect(summarize).not.toHaveBeenCalled();
  });

  it("repairs scoped doctor summaries in place and feeds repaired children into parents", async () => {
    const summarize = vi.fn(async (text: string, _aggressive?: boolean, options?: Parameters<LcmSummarizeFn>[2]) => {
      if (options?.isCondensed) {
        return `CONDENSED REPAIR\n${text}`;
      }
      return `LEAF REPAIR\n${text}`;
    });
    const fixture = createCommandFixture({ summarize: summarize as LcmSummarizeFn });
    tempDirs.add(fixture.tempDir);
    dbPaths.add(fixture.dbPath);

    const currentConversation = await fixture.conversationStore.createConversation({
      sessionId: "doctor-apply-current",
      sessionKey: "agent:main:telegram:direct:doctor-apply-current",
    });
    const [firstMessage, secondMessage] = await fixture.conversationStore.createMessagesBulk([
      {
        conversationId: currentConversation.conversationId,
        seq: 0,
        role: "user",
        content: "first broken message",
        tokenCount: 6,
      },
      {
        conversationId: currentConversation.conversationId,
        seq: 1,
        role: "assistant",
        content: "second broken message",
        tokenCount: 7,
      },
    ]);

    await fixture.summaryStore.insertSummary({
      summaryId: "sum_leaf_fix",
      conversationId: currentConversation.conversationId,
      kind: "leaf",
      depth: 0,
      content: `broken leaf\n${"[Truncated from 512 tokens]"}`,
      tokenCount: 11,
      sourceMessageTokenCount: 13,
    });
    await fixture.summaryStore.linkSummaryToMessages("sum_leaf_fix", [
      firstMessage.messageId,
      secondMessage.messageId,
    ]);

    await fixture.summaryStore.insertSummary({
      summaryId: "sum_parent_fix",
      conversationId: currentConversation.conversationId,
      kind: "condensed",
      depth: 1,
      content: `${"[LCM fallback summary; truncated for context management]"}\nold parent`,
      tokenCount: 9,
    });
    await fixture.summaryStore.linkSummaryToParents("sum_parent_fix", ["sum_leaf_fix"]);

    const result = await fixture.command.handler(
      createCommandContext("doctor apply", {
        sessionKey: "agent:main:telegram:direct:doctor-apply-current",
      }),
    );

    const repairedLeaf = await fixture.summaryStore.getSummary("sum_leaf_fix");
    const repairedParent = await fixture.summaryStore.getSummary("sum_parent_fix");

    expect(result.text).toContain("detected summaries: 2");
    expect(result.text).toContain("repaired summaries: 2");
    expect(result.text).toContain("result: repaired 2 summary(s) in place");
    expect(result.text).toContain("sum_leaf_fix, sum_parent_fix");
    expect(summarize).toHaveBeenCalledTimes(2);
    expect(repairedLeaf?.content).toContain("LEAF REPAIR");
    expect(repairedLeaf?.content).not.toContain("[Truncated from");
    expect(repairedParent?.content).toContain("CONDENSED REPAIR");
    expect(repairedParent?.content).toContain("LEAF REPAIR");
    expect(repairedParent?.content).not.toContain("[LCM fallback summary");
  });

  it("reports doctor apply as unavailable when the current conversation cannot be resolved and does not repair globally", async () => {
    const summarize = vi.fn(async () => "should not run");
    const fixture = createCommandFixture({ summarize: summarize as LcmSummarizeFn });
    tempDirs.add(fixture.tempDir);
    dbPaths.add(fixture.dbPath);

    const otherConversation = await fixture.conversationStore.createConversation({
      sessionId: "doctor-apply-unresolved-other",
      sessionKey: "agent:main:telegram:direct:doctor-apply-unresolved-other",
    });

    await fixture.summaryStore.insertSummary({
      summaryId: "sum_unresolved_apply_other",
      conversationId: otherConversation.conversationId,
      kind: "leaf",
      depth: 0,
      content: `other summary body\n${"[Truncated from 204 tokens]"}`,
      tokenCount: 16,
    });

    const result = await fixture.command.handler(
      createCommandContext("doctor apply", {
        sessionKey: "agent:main:telegram:direct:not-stored",
        sessionId: "doctor-apply-unresolved-missing",
      }),
    );

    const untouched = await fixture.summaryStore.getSummary("sum_unresolved_apply_other");

    expect(result.text).toContain("🩺 Lossless Claw Doctor Apply");
    expect(result.text).toContain("status: unavailable");
    expect(result.text).toContain(
      "No LCM conversation is stored yet for active session key `agent:main:telegram:direct:not-stored` or active session id `doctor-apply-unresolved-missing`.",
    );
    expect(result.text).toContain("fallback: Doctor apply is conversation-scoped, so no global repair ran.");
    expect(result.text).not.toContain("detected summaries:");
    expect(summarize).not.toHaveBeenCalled();
    expect(untouched?.content).toContain("[Truncated from 204 tokens]");
  });

  it("uses the normal runtime model chain for doctor apply when no explicit summary model is set", async () => {
    const hostBoundComplete = vi.fn(async () => ({
      text: "HOST BOUND REPAIR",
    }));
    const runtimeComplete = vi.fn(async () => ({
      content: [{ type: "text", text: "RUNTIME REPAIR" }],
    }));
    const config = resolveLcmConfig({}, { dbPath: "/tmp/unused.db" });
    const deps: LcmDependencies = {
      config,
      complete: runtimeComplete as LcmDependencies["complete"],
      callGateway: vi.fn(async () => ({})) as LcmDependencies["callGateway"],
      resolveModel: vi.fn((modelRef?: string) => {
        const [provider, model] = String(modelRef ?? "anthropic/claude-haiku-4-5").split("/", 2);
        return { provider, model };
      }) as LcmDependencies["resolveModel"],
      parseAgentSessionKey: vi.fn(() => ({ agentId: "main", suffix: "test" })) as LcmDependencies["parseAgentSessionKey"],
      isSubagentSessionKey: vi.fn(() => false) as LcmDependencies["isSubagentSessionKey"],
      normalizeAgentId: vi.fn((id?: string) => id?.trim() || "main") as LcmDependencies["normalizeAgentId"],
      buildSubagentSystemPrompt: vi.fn(() => "subagent prompt") as LcmDependencies["buildSubagentSystemPrompt"],
      readLatestAssistantReply: vi.fn(() => undefined) as LcmDependencies["readLatestAssistantReply"],
      resolveAgentDir: vi.fn(() => tmpdir()) as LcmDependencies["resolveAgentDir"],
      resolveSessionIdFromSessionKey: vi.fn(async () => undefined) as LcmDependencies["resolveSessionIdFromSessionKey"],
      resolveSessionTranscriptFile: vi.fn(async () => undefined) as LcmDependencies["resolveSessionTranscriptFile"],
      agentLaneSubagent: "subagent",
      log: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      },
    };

    const fixture = createCommandFixture({ deps });
    tempDirs.add(fixture.tempDir);
    dbPaths.add(fixture.dbPath);

    const currentConversation = await fixture.conversationStore.createConversation({
      sessionId: "doctor-apply-runtime-config",
      sessionKey: "agent:main:telegram:direct:doctor-apply-runtime-config",
    });
    const [message] = await fixture.conversationStore.createMessagesBulk([
      {
        conversationId: currentConversation.conversationId,
        seq: 0,
        role: "user",
        content: "runtime-config-backed broken message",
        tokenCount: 7,
      },
    ]);

    await fixture.summaryStore.insertSummary({
      summaryId: "sum_runtime_fix",
      conversationId: currentConversation.conversationId,
      kind: "leaf",
      depth: 0,
      content: `broken leaf\n${"[Truncated from 111 tokens]"}`,
      tokenCount: 10,
    });
    await fixture.summaryStore.linkSummaryToMessages("sum_runtime_fix", [message.messageId]);

    const result = await fixture.command.handler(
      createCommandContext("doctor apply", {
        sessionKey: "agent:main:telegram:direct:doctor-apply-runtime-config",
        runtimeContext: {
          authProfileId: "openai-codex:work",
          llm: {
            complete: hostBoundComplete,
          },
        },
        config: {
          agents: {
            defaults: {
              model: "anthropic/claude-haiku-4-5",
            },
          },
          plugins: {
            entries: {
              "lossless-claw": {
                enabled: true,
              },
            },
            slots: {
              contextEngine: "lossless-claw",
            },
          },
        },
      }),
    );

    const repaired = await fixture.summaryStore.getSummary("sum_runtime_fix");

    expect(result.text).toContain("repaired summaries: 1");
    expect(result.text).not.toContain("could not resolve a summarizer");
    expect(runtimeComplete).toHaveBeenCalled();
    expect(runtimeComplete.mock.calls[0]?.[0]).toMatchObject({
      agentId: "main",
      authProfileId: "openai-codex:work",
      runtimeLlmComplete: hostBoundComplete,
    });
    expect(hostBoundComplete).not.toHaveBeenCalled();
    expect(repaired?.content).toContain("RUNTIME REPAIR");
    expect(repaired?.content).not.toContain("[Truncated from 111 tokens]");
  });

  it("creates a standalone database backup", async () => {
    const fixture = createCommandFixture();
    tempDirs.add(fixture.tempDir);
    dbPaths.add(fixture.dbPath);

    const result = await fixture.command.handler(createCommandContext("backup"));
    const backupPath = result.text.match(/backup path: (.+)/)?.[1]?.trim();

    expect(result.text).toContain("💾 Lossless Claw Backup");
    expect(result.text).toContain("status: created");
    expect(result.text).toContain(`db path: ${fixture.dbPath}`);
    expect(backupPath).toBeTruthy();
    expect(existsSync(backupPath!)).toBe(true);
  });

  it("reports backup failure with structured output", async () => {
    const fixture = createCommandFixture();
    tempDirs.add(fixture.tempDir);
    dbPaths.add(fixture.dbPath);
    vi.spyOn(fixture.db, "exec").mockImplementation(() => {
      throw new Error("disk full");
    });

    const result = await fixture.command.handler(createCommandContext("backup"));

    expect(result.text).toContain("💾 Lossless Claw Backup");
    expect(result.text).toContain("status: failed");
    expect(result.text).toContain("reason: disk full");
  });

  it("keeps session-memory schema apply dry-run by default and only creates an explicit temp DB with confirmation", async () => {
    const fixture = createCommandFixture();
    tempDirs.add(fixture.tempDir);
    dbPaths.add(fixture.dbPath);

    const sessionMemoryDir = join(fixture.tempDir, "session-memory-maintenance");
    const sessionMemoryDbPath = join(sessionMemoryDir, "session-memory.db");
    const config = resolveLcmConfig({}, {
      sessionMemoryOverlay: {
        dbPath: sessionMemoryDbPath,
      },
    });
    const command = createLcmCommand({ db: fixture.db, config });
    const runCommand = async (args: string): Promise<{ text: string }> => {
      return await command.handler!(createCommandContext(args)) as { text: string };
    };

    const dryRun = await runCommand(`session-memory schema apply --db ${sessionMemoryDbPath}`);
    const confirmation = dryRun.text.match(/execute confirmation: ([a-z0-9_:-]+)/)?.[1];

    expect(dryRun.text).toContain("Session Memory Schema Maintenance");
    expect(dryRun.text).toContain("status: dry_run");
    expect(dryRun.text).toContain(`target db: ${sessionMemoryDbPath}`);
    expect(dryRun.text).toContain("db state: absent");
    expect(dryRun.text).toContain("backup required: no");
    expect(confirmation).toBeTruthy();
    expect(existsSync(sessionMemoryDir)).toBe(false);
    expect(existsSync(sessionMemoryDbPath)).toBe(false);

    const badConfirmation = await runCommand(
      `session-memory schema apply --execute --confirm wrong --db ${sessionMemoryDbPath}`,
    );
    expect(badConfirmation.text).toContain("status: refused");
    expect(badConfirmation.text).toContain("reason: confirmation token mismatch");
    expect(existsSync(sessionMemoryDbPath)).toBe(false);

    const executed = await runCommand(
      `session-memory schema apply --execute --confirm ${confirmation} --db ${sessionMemoryDbPath}`,
    );
    expect(executed.text).toContain("status: created");
    expect(executed.text).toContain("post-check: compatible");
    expect(existsSync(sessionMemoryDbPath)).toBe(true);

    const db = new DatabaseSync(sessionMemoryDbPath, { readOnly: true });
    try {
      const userVersion = db.prepare("PRAGMA user_version").get() as { user_version?: unknown };
      const migration = db
        .prepare("SELECT schema_version FROM schema_migrations ORDER BY applied_at DESC LIMIT 1")
        .get() as { schema_version?: unknown } | undefined;
      expect(Number(userVersion.user_version)).toBe(1);
      expect(Number(migration?.schema_version)).toBe(1);
    } finally {
      db.close();
    }

    const check = await runCommand(`session-memory schema check --db ${sessionMemoryDbPath}`);
    expect(check.text).toContain("Session Memory Schema Check");
    expect(check.text).toContain("status: compatible");
  });

  it("sets and clears volatile session-memory overlay mode and render profile through /lossless", async () => {
    const fixture = createCommandFixture();
    tempDirs.add(fixture.tempDir);
    dbPaths.add(fixture.dbPath);
    const sessionMemoryDbPath = join(fixture.tempDir, "session-memory.db");
    const config = resolveLcmConfig({}, {
      dbPath: fixture.dbPath,
      sessionMemoryOverlay: {
        dbPath: sessionMemoryDbPath,
      },
    });
    let overrideMode: "native" | "overlay-readonly" | undefined;
    let overrideRenderProfile: "grouped" | "compact" | undefined;
    const engine = {
      getSessionMemoryOverlayMode: vi.fn(() => ({
        sessionId: "session-memory-command-session",
        sessionKey: "agent:main:webchat:session-memory-command",
        overrideMode,
        overrideRenderProfile,
        effectiveMode: overrideMode === "overlay-readonly" ? "overlay-readonly" : "native",
        killSwitchEnabled: false,
        renderVersion: config.sessionMemoryOverlay.renderVersion,
        configuredRenderProfile: config.sessionMemoryOverlay.renderProfile,
        renderProfile: overrideRenderProfile ?? config.sessionMemoryOverlay.renderProfile,
        dbPath: config.sessionMemoryOverlay.dbPath,
        maxTokens: config.sessionMemoryOverlay.maxTokens,
      })),
      setSessionMemoryOverlayMode: vi.fn((params: { mode: "native" | "overlay-readonly" }) => {
        overrideMode = params.mode;
        return engine.getSessionMemoryOverlayMode();
      }),
      clearSessionMemoryOverlayMode: vi.fn(() => {
        overrideMode = undefined;
        return engine.getSessionMemoryOverlayMode();
      }),
      setSessionMemoryOverlayRenderProfile: vi.fn((params: { renderProfile: "grouped" | "compact" }) => {
        overrideRenderProfile = params.renderProfile;
        return engine.getSessionMemoryOverlayMode();
      }),
      clearSessionMemoryOverlayRenderProfile: vi.fn(() => {
        overrideRenderProfile = undefined;
        return engine.getSessionMemoryOverlayMode();
      }),
    };
    const command = createLcmCommand({
      db: fixture.db,
      config,
      getLcm: async () => engine,
    });
    const ctx = (args: string) =>
      createCommandContext(args, {
        sessionId: "session-memory-command-session",
        sessionKey: "agent:main:webchat:session-memory-command",
      });

    const status = await command.handler!(ctx("session-memory status")) as { text: string };
    expect(status.text).toContain("Session Memory");
    expect(status.text).toContain("effective mode: native");
    expect(status.text).toContain("override: unset");

    const enabled = await command.handler!(ctx("session-memory overlay-readonly")) as { text: string };
    expect(enabled.text).toContain("status: updated");
    expect(enabled.text).toContain("effective mode: overlay-readonly");
    expect(enabled.text).toContain("persistence: volatile; not written to openclaw.json");

    const compact = await command.handler!(ctx("session-memory profile compact")) as { text: string };
    expect(compact.text).toContain("status: updated");
    expect(compact.text).toContain("render profile: compact");
    expect(compact.text).toContain("profile override: compact");
    expect(config.sessionMemoryOverlay.renderProfile).toBe("grouped");

    const profileCleared = await command.handler!(ctx("session-memory profile clear")) as { text: string };
    expect(profileCleared.text).toContain("status: cleared");
    expect(profileCleared.text).toContain("render profile: grouped");
    expect(profileCleared.text).toContain("profile override: unset");

    const forcedNative = await command.handler!(ctx("session-memory native")) as { text: string };
    expect(forcedNative.text).toContain("effective mode: native");
    expect(forcedNative.text).toContain("override: native");

    const cleared = await command.handler!(ctx("session-memory clear")) as { text: string };
    expect(cleared.text).toContain("status: cleared");
    expect(cleared.text).toContain("override: unset");
    expect(config.sessionMemoryOverlay.enabled).toBe(false);
    expect(existsSync(sessionMemoryDbPath)).toBe(false);
  });

  it("refuses session-memory schema execute against the resolved real DB path in Gate 4", async () => {
    const fixture = createCommandFixture();
    tempDirs.add(fixture.tempDir);
    dbPaths.add(fixture.dbPath);

    const realDbPath = resolveLcmConfig({}, {}).sessionMemoryOverlay.dbPath;
    const config = resolveLcmConfig({}, {});
    const command = createLcmCommand({ db: fixture.db, config });
    const runCommand = async (args: string): Promise<{ text: string }> => {
      return await command.handler!(createCommandContext(args)) as { text: string };
    };

    const dryRun = await runCommand("session-memory schema apply");
    const confirmation = dryRun.text.match(/execute confirmation: ([a-z0-9_:-]+)/)?.[1];
    expect(confirmation).toBeTruthy();

    const result = await runCommand(`session-memory schema apply --execute --confirm ${confirmation}`);
    expect(result.text).toContain("status: refused");
    expect(result.text).toContain("reason: execute requires an explicit temp DB path or --allow-real-db");
    expect(existsSync(realDbPath)).toBe(false);
    expect(existsSync(`${realDbPath}-wal`)).toBe(false);
    expect(existsSync(`${realDbPath}-shm`)).toBe(false);
  });

  it("creates the resolved real session-memory DB only with explicit Gate 5 approval", async () => {
    const fixture = createCommandFixture();
    tempDirs.add(fixture.tempDir);
    dbPaths.add(fixture.dbPath);

    const realDbDir = mkdtempSync(join(process.cwd(), ".session-memory-gate5-real-"));
    tempDirs.add(realDbDir);
    const realDbPath = join(realDbDir, "session-memory.db");
    const config = resolveLcmConfig({}, {
      sessionMemoryOverlay: {
        dbPath: realDbPath,
      },
    });
    const command = createLcmCommand({ db: fixture.db, config });
    const runCommand = async (args: string): Promise<{ text: string }> => {
      return await command.handler!(createCommandContext(args)) as { text: string };
    };

    const dryRun = await runCommand("session-memory schema apply");
    const confirmation = dryRun.text.match(/execute confirmation: ([a-z0-9_:-]+)/)?.[1];
    expect(confirmation).toBeTruthy();
    expect(dryRun.text).toContain("status: dry_run");
    expect(dryRun.text).toContain(`target db: ${realDbPath}`);
    expect(existsSync(realDbPath)).toBe(false);

    const explicitPath = await runCommand(
      `session-memory schema apply --execute --allow-real-db --confirm ${confirmation} --db ${realDbPath}`,
    );
    expect(explicitPath.text).toContain("status: refused");
    expect(explicitPath.text).toContain(
      "reason: --allow-real-db uses the resolved session-memory DB path; omit --db",
    );
    expect(existsSync(realDbPath)).toBe(false);

    const created = await runCommand(
      `session-memory schema apply --execute --allow-real-db --confirm ${confirmation}`,
    );
    expect(created.text).toContain("status: created");
    expect(created.text).toContain("post-check: compatible");
    expect(existsSync(realDbPath)).toBe(true);

    const check = await runCommand("session-memory schema check");
    expect(check.text).toContain("Session Memory Schema Check");
    expect(check.text).toContain("status: compatible");
  });

  it("carries reviewed session-memory entries into the current conversation only with confirmation", async () => {
    const fixture = createCommandFixture();
    tempDirs.add(fixture.tempDir);
    dbPaths.add(fixture.dbPath);

    const sessionMemoryDbPath = join(fixture.tempDir, "session-memory-carry-forward.db");
    const config = resolveLcmConfig({}, {
      dbPath: fixture.dbPath,
      sessionMemoryOverlay: {
        dbPath: sessionMemoryDbPath,
      },
    });
    const command = createLcmCommand({ db: fixture.db, config });
    const runCommand = async (args: string): Promise<{ text: string }> => {
      return await command.handler!(createCommandContext(args, {
        sessionId: "session-memory-carry-target",
        sessionKey: "agent:main:webchat:session-memory-carry-target",
      })) as { text: string };
    };

    const targetConversation = await fixture.conversationStore.createConversation({
      sessionId: "session-memory-carry-target",
      sessionKey: "agent:main:webchat:session-memory-carry-target",
    });

    const schemaDryRun = await runCommand(`session-memory schema apply --db ${sessionMemoryDbPath}`);
    const schemaConfirmation = schemaDryRun.text.match(/execute confirmation: ([a-z0-9_:-]+)/)?.[1];
    expect(schemaConfirmation).toBeTruthy();
    const schemaCreated = await runCommand(
      `session-memory schema apply --execute --confirm ${schemaConfirmation} --db ${sessionMemoryDbPath}`,
    );
    expect(schemaCreated.text).toContain("status: created");

    const seed = writeSessionMemorySeedPacket({
      dbPath: sessionMemoryDbPath,
      lcmDbPath: fixture.dbPath,
      packet: {
        session: {
          sessionId: "session-memory-carry-source",
          conversationId: 2520,
          sessionKey: "agent:main:webchat:session-memory-carry-source",
        },
        segment: {
          segmentId: "segment-memory-carry-source",
          seq: 1,
        },
        entries: [
          {
            entryId: "entry-memory-carry-source-decision",
            kind: "decision",
            confidence: 0.95,
            priority: 30,
            body: "Normal /new continues the previous workline and carries reviewed seed forward.",
            sourceRefs: [{ type: "workspace_file", path: "Friday-memory/CURRENT.md" }],
          },
        ],
      },
    });
    expect(seed).toMatchObject({ ok: true, entryCount: 1 });

    const dryRun = await runCommand("session-memory carry-forward --from 2520");
    const confirmation = dryRun.text.match(/execute confirmation: ([a-z0-9_:-]+)/)?.[1];
    expect(dryRun.text).toContain("Session Memory Carry-Forward");
    expect(dryRun.text).toContain("status: dry_run");
    expect(dryRun.text).toContain("conversation id: 2,520");
    expect(dryRun.text).toContain(`conversation id: ${targetConversation.conversationId}`);
    expect(confirmation).toBeTruthy();
    const dryRunDb = new DatabaseSync(sessionMemoryDbPath, { readOnly: true });
    try {
      expect(
        (dryRunDb
          .prepare("SELECT COUNT(*) AS count FROM entries WHERE session_id = ?")
          .get("session-memory-carry-target") as { count: number }).count,
      ).toBe(0);
    } finally {
      dryRunDb.close();
    }

    const refused = await runCommand("session-memory carry-forward --from 2520 --execute --confirm wrong");
    expect(refused.text).toContain("status: refused");
    expect(refused.text).toContain("reason: confirmation token mismatch");

    const executed = await runCommand(
      `session-memory carry-forward --from 2520 --execute --confirm ${confirmation}`,
    );
    expect(executed.text).toContain("status: written");
    expect(executed.text).toContain("entries carried: 1");
    expect(executed.text).toContain("links written: 1");

    const sessionMemoryDb = new DatabaseSync(sessionMemoryDbPath, { readOnly: true });
    try {
      expect(
        (sessionMemoryDb
          .prepare("SELECT COUNT(*) AS count FROM sessions WHERE conversation_id = ?")
          .get(targetConversation.conversationId) as { count: number }).count,
      ).toBe(1);
      expect(
        (sessionMemoryDb
          .prepare("SELECT COUNT(*) AS count FROM entries WHERE origin_entry_id = ?")
          .get("entry-memory-carry-source-decision") as { count: number }).count,
      ).toBe(1);
      expect(
        (sessionMemoryDb
          .prepare("SELECT COUNT(*) AS count FROM links WHERE relation = 'carried_to'")
          .get() as { count: number }).count,
      ).toBe(1);
    } finally {
      sessionMemoryDb.close();
    }
  });

  it("reattaches reviewed session-memory entries from an archived same-sessionKey fork only through temp DB confirmation", async () => {
    const fixture = createCommandFixture();
    tempDirs.add(fixture.tempDir);
    dbPaths.add(fixture.dbPath);

    const sharedSessionKey = "agent:main:dashboard:same-session-key-fork";
    const sourceConversation = await fixture.conversationStore.createConversation({
      sessionId: "session-memory-reattach-source",
      sessionKey: sharedSessionKey,
      title: "Old UI conversation",
    });
    await fixture.conversationStore.archiveConversation(sourceConversation.conversationId);
    const targetConversation = await fixture.conversationStore.createConversation({
      sessionId: "session-memory-reattach-target",
      sessionKey: sharedSessionKey,
      title: "Forked active conversation",
    });

    const sessionMemoryDbPath = join(fixture.tempDir, "session-memory-reattach.db");
    const config = resolveLcmConfig({}, {
      dbPath: fixture.dbPath,
      sessionMemoryOverlay: {
        dbPath: sessionMemoryDbPath,
      },
    });
    const command = createLcmCommand({ db: fixture.db, config });
    const runCommand = async (args: string): Promise<{ text: string }> => {
      return await command.handler!(createCommandContext(args, {
        sessionId: "session-memory-reattach-target",
        sessionKey: sharedSessionKey,
      })) as { text: string };
    };

    const schemaDryRun = await runCommand(`session-memory schema apply --db ${sessionMemoryDbPath}`);
    const schemaConfirmation = schemaDryRun.text.match(/execute confirmation: ([a-z0-9_:-]+)/)?.[1];
    expect(schemaConfirmation).toBeTruthy();
    const schemaCreated = await runCommand(
      `session-memory schema apply --execute --confirm ${schemaConfirmation} --db ${sessionMemoryDbPath}`,
    );
    expect(schemaCreated.text).toContain("status: created");

    const seed = writeSessionMemorySeedPacket({
      dbPath: sessionMemoryDbPath,
      lcmDbPath: fixture.dbPath,
      packet: {
        session: {
          sessionId: "session-memory-reattach-source",
          conversationId: sourceConversation.conversationId,
          sessionKey: sharedSessionKey,
        },
        segment: {
          segmentId: "segment-memory-reattach-source",
          seq: 1,
        },
        entries: [
          {
            entryId: "entry-memory-reattach-boundary",
            kind: "constraint",
            confidence: 0.95,
            priority: 80,
            body: "Gate47D reattach should recover only reviewed durable entries from the old same-sessionKey conversation.",
            sourceRefs: [{ type: "workspace_file", path: "Friday-memory/CURRENT.md" }],
          },
        ],
      },
    });
    expect(seed).toMatchObject({ ok: true, entryCount: 1 });

    const dryRun = await runCommand("session-memory reattach");
    const confirmation = dryRun.text.match(/execute confirmation: ([a-z0-9_:-]+)/)?.[1];
    expect(dryRun.text).toContain("Session Memory Reattach");
    expect(dryRun.text).toContain("status: dry_run");
    expect(dryRun.text).toContain(`conversation id: ${sourceConversation.conversationId}`);
    expect(dryRun.text).toContain(`conversation id: ${targetConversation.conversationId}`);
    expect(dryRun.text).toContain("same-sessionKey candidates: 1");
    expect(confirmation).toBeTruthy();

    const dryRunDb = new DatabaseSync(sessionMemoryDbPath, { readOnly: true });
    try {
      expect(
        (dryRunDb
          .prepare("SELECT COUNT(*) AS count FROM sessions WHERE conversation_id = ?")
          .get(targetConversation.conversationId) as { count: number }).count,
      ).toBe(0);
    } finally {
      dryRunDb.close();
    }

    const nonTempDir = join(process.cwd(), ".session-memory-reattach-real");
    tempDirs.add(nonTempDir);
    mkdirSync(nonTempDir, { recursive: true });
    const nonTempDbPath = join(nonTempDir, "session-memory.db");
    copyFileSync(sessionMemoryDbPath, nonTempDbPath);
    const nonTempDryRun = await runCommand(`session-memory reattach --db ${nonTempDbPath}`);
    const nonTempConfirmation = nonTempDryRun.text.match(/execute confirmation: ([a-z0-9_:-]+)/)?.[1];
    expect(nonTempConfirmation).toBeTruthy();
    const nonTempRefused = await runCommand(
      `session-memory reattach --db ${nonTempDbPath} --execute --confirm ${nonTempConfirmation}`,
    );
    expect(nonTempRefused.text).toContain("status: refused");
    expect(nonTempRefused.text).toContain("reason: real DB carry-forward requires a separate approved backup gate");

    const nonTempExplicitPathRefused = await runCommand(
      `session-memory reattach --db ${nonTempDbPath} --allow-real-db --execute --confirm ${nonTempConfirmation}`,
    );
    expect(nonTempExplicitPathRefused.text).toContain("status: refused");
    expect(nonTempExplicitPathRefused.text).toContain("reason: --allow-real-db uses the resolved session-memory DB path; omit --db");

    const realConfig = resolveLcmConfig({}, {
      dbPath: fixture.dbPath,
      sessionMemoryOverlay: {
        dbPath: nonTempDbPath,
      },
    });
    const realCommand = createLcmCommand({ db: fixture.db, config: realConfig });
    const runRealCommand = async (args: string): Promise<{ text: string }> => {
      return await realCommand.handler!(createCommandContext(args, {
        sessionId: "session-memory-reattach-target",
        sessionKey: sharedSessionKey,
      })) as { text: string };
    };
    const realDryRun = await runRealCommand("session-memory reattach --allow-real-db");
    const realConfirmation = realDryRun.text.match(/execute confirmation: ([a-z0-9_:-]+)/)?.[1];
    expect(realDryRun.text).toContain("real DB execution: allowed by explicit flag");
    expect(realDryRun.text).toContain("status: dry_run");
    expect(realConfirmation).toBeTruthy();
    const realExecuted = await runRealCommand(
      `session-memory reattach --allow-real-db --execute --confirm ${realConfirmation}`,
    );
    expect(realExecuted.text).toContain("status: written");
    expect(realExecuted.text).toContain("entries carried: 1");
    const realDuplicateRefused = await runRealCommand(
      `session-memory reattach --allow-real-db --execute --confirm ${realConfirmation}`,
    );
    expect(realDuplicateRefused.text).toContain("status: refused");
    expect(realDuplicateRefused.text).toContain("reason: target_already_has_entries");

    const realSessionMemoryDb = new DatabaseSync(nonTempDbPath, { readOnly: true });
    try {
      expect(
        (realSessionMemoryDb
          .prepare("SELECT COUNT(*) AS count FROM sessions WHERE conversation_id = ?")
          .get(targetConversation.conversationId) as { count: number }).count,
      ).toBe(1);
      expect(
        (realSessionMemoryDb
          .prepare("SELECT COUNT(*) AS count FROM entries WHERE origin_entry_id = ?")
          .get("entry-memory-reattach-boundary") as { count: number }).count,
      ).toBe(1);
    } finally {
      realSessionMemoryDb.close();
    }

    const executed = await runCommand(`session-memory reattach --execute --confirm ${confirmation}`);
    expect(executed.text).toContain("status: written");
    expect(executed.text).toContain("entries carried: 1");

    const sessionMemoryDb = new DatabaseSync(sessionMemoryDbPath, { readOnly: true });
    try {
      expect(
        (sessionMemoryDb
          .prepare("SELECT COUNT(*) AS count FROM sessions WHERE conversation_id = ?")
          .get(targetConversation.conversationId) as { count: number }).count,
      ).toBe(1);
      expect(
        (sessionMemoryDb
          .prepare("SELECT COUNT(*) AS count FROM entries WHERE origin_entry_id = ?")
          .get("entry-memory-reattach-boundary") as { count: number }).count,
      ).toBe(1);
    } finally {
      sessionMemoryDb.close();
    }
  });

  it("reattaches into an explicit target conversation only through temp DB confirmation", async () => {
    const fixture = createCommandFixture();
    tempDirs.add(fixture.tempDir);
    dbPaths.add(fixture.dbPath);

    const sourceSessionKey = "agent:main:dashboard:old-ui-session-key";
    const currentSessionKey = "agent:main:dashboard:current-live-session-key";
    const sourceConversation = await fixture.conversationStore.createConversation({
      sessionId: "session-memory-target-source",
      sessionKey: sourceSessionKey,
      title: "Old UI conversation",
    });
    await fixture.conversationStore.archiveConversation(sourceConversation.conversationId);
    const explicitTargetConversation = await fixture.conversationStore.createConversation({
      sessionId: "session-memory-target-explicit",
      sessionKey: sourceSessionKey,
      title: "Old UI fork needing repair",
    });
    const currentConversation = await fixture.conversationStore.createConversation({
      sessionId: "session-memory-target-current",
      sessionKey: currentSessionKey,
      title: "Current live conversation",
    });

    const sessionMemoryDbPath = join(fixture.tempDir, "session-memory-explicit-target.db");
    const config = resolveLcmConfig({}, {
      dbPath: fixture.dbPath,
      sessionMemoryOverlay: {
        dbPath: sessionMemoryDbPath,
      },
    });
    const command = createLcmCommand({ db: fixture.db, config });
    const runCommand = async (args: string): Promise<{ text: string }> => {
      return await command.handler!(createCommandContext(args, {
        sessionId: "session-memory-target-current",
        sessionKey: currentSessionKey,
      })) as { text: string };
    };

    const schemaDryRun = await runCommand(`session-memory schema apply --db ${sessionMemoryDbPath}`);
    const schemaConfirmation = schemaDryRun.text.match(/execute confirmation: ([a-z0-9_:-]+)/)?.[1];
    expect(schemaConfirmation).toBeTruthy();
    const schemaCreated = await runCommand(
      `session-memory schema apply --execute --confirm ${schemaConfirmation} --db ${sessionMemoryDbPath}`,
    );
    expect(schemaCreated.text).toContain("status: created");

    const seed = writeSessionMemorySeedPacket({
      dbPath: sessionMemoryDbPath,
      lcmDbPath: fixture.dbPath,
      packet: {
        session: {
          sessionId: "session-memory-target-source",
          conversationId: sourceConversation.conversationId,
          sessionKey: sourceSessionKey,
        },
        segment: {
          segmentId: "segment-memory-target-source",
          seq: 1,
        },
        entries: [
          {
            entryId: "entry-memory-target-boundary",
            kind: "constraint",
            confidence: 0.95,
            priority: 80,
            body: "Gate47F target selection may repair a specific old UI fork only after dry-run proof.",
            sourceRefs: [{ type: "workspace_file", path: "Friday-memory/CURRENT.md" }],
          },
        ],
      },
    });
    expect(seed).toMatchObject({ ok: true, entryCount: 1 });

    const dryRun = await runCommand(
      `session-memory reattach --from-session-key ${sourceSessionKey} --to-conversation ${explicitTargetConversation.conversationId}`,
    );
    const confirmation = dryRun.text.match(/execute confirmation: ([a-z0-9_:-]+)/)?.[1];
    expect(dryRun.text).toContain("Session Memory Reattach");
    expect(dryRun.text).toContain("status: dry_run");
    expect(dryRun.text).toContain("target mode: explicit");
    expect(dryRun.text).toContain(`conversation id: ${explicitTargetConversation.conversationId}`);
    expect(dryRun.text).toContain(`current conversation id: ${currentConversation.conversationId}`);
    expect(dryRun.text).toContain(`conversation id: ${sourceConversation.conversationId}`);
    expect(confirmation).toBeTruthy();

    const dryRunDb = new DatabaseSync(sessionMemoryDbPath, { readOnly: true });
    try {
      expect(
        (dryRunDb
          .prepare("SELECT COUNT(*) AS count FROM sessions WHERE conversation_id = ?")
          .get(explicitTargetConversation.conversationId) as { count: number }).count,
      ).toBe(0);
    } finally {
      dryRunDb.close();
    }

    const executed = await runCommand(
      `session-memory reattach --from-session-key ${sourceSessionKey} --to-conversation ${explicitTargetConversation.conversationId} --execute --confirm ${confirmation}`,
    );
    expect(executed.text).toContain("status: written");
    expect(executed.text).toContain("entries carried: 1");

    const currentLookup = await lookupSessionMemoryOverlay(
      {
        conversationId: currentConversation.conversationId,
        sessionKey: currentSessionKey,
      },
      {
        ...DEFAULT_SESSION_MEMORY_OVERLAY_CONFIG,
        enabled: true,
        dbPath: sessionMemoryDbPath,
        lcmDbPath: fixture.dbPath,
      },
    );
    expect(currentLookup).toMatchObject({ ok: false, reason: "no_active_entries" });

    const targetLookup = await lookupSessionMemoryOverlay(
      {
        conversationId: explicitTargetConversation.conversationId,
        sessionKey: sourceSessionKey,
      },
      {
        ...DEFAULT_SESSION_MEMORY_OVERLAY_CONFIG,
        enabled: true,
        dbPath: sessionMemoryDbPath,
        lcmDbPath: fixture.dbPath,
      },
    );
    expect(targetLookup).toMatchObject({
      ok: true,
      source: "session_memory_overlay",
      sessionId: "session-memory-target-explicit",
    });
    expect(targetLookup.ok ? targetLookup.entries : []).toEqual([
      expect.objectContaining({
        body: "Gate47F target selection may repair a specific old UI fork only after dry-run proof.",
      }),
    ]);
    const postExecuteDb = new DatabaseSync(sessionMemoryDbPath, { readOnly: true });
    try {
      expect(
        (postExecuteDb
          .prepare("SELECT COUNT(*) AS count FROM entries WHERE origin_entry_id = ?")
          .get("entry-memory-target-boundary") as { count: number }).count,
      ).toBe(1);
    } finally {
      postExecuteDb.close();
    }

    const rendered = renderSessionMemoryOverlay(targetLookup, {
      ...DEFAULT_SESSION_MEMORY_OVERLAY_CONFIG,
      enabled: true,
      dbPath: sessionMemoryDbPath,
      lcmDbPath: fixture.dbPath,
    });
    expect(rendered).toMatchObject({
      ok: true,
      source: "session_memory_overlay",
      entryCount: 1,
    });
    expect(rendered.ok ? rendered.content : "").toContain("Gate47F target selection");
  });

  it("carries reviewed replacement facts from an explicit temp-DB replacement packet", async () => {
    const fixture = createCommandFixture();
    tempDirs.add(fixture.tempDir);
    dbPaths.add(fixture.dbPath);

    const sessionMemoryDbPath = join(fixture.tempDir, "session-memory-carry-replacements.db");
    const replacementsPath = join(fixture.tempDir, "replacement-packet.json");
    const config = resolveLcmConfig({}, {
      dbPath: fixture.dbPath,
      sessionMemoryOverlay: {
        dbPath: sessionMemoryDbPath,
      },
    });
    const command = createLcmCommand({ db: fixture.db, config });
    const runCommand = async (args: string): Promise<{ text: string }> => {
      return await command.handler!(createCommandContext(args, {
        sessionId: "session-memory-replacement-target",
        sessionKey: "agent:main:webchat:session-memory-replacement-target",
      })) as { text: string };
    };

    const targetConversation = await fixture.conversationStore.createConversation({
      sessionId: "session-memory-replacement-target",
      sessionKey: "agent:main:webchat:session-memory-replacement-target",
    });

    const schemaDryRun = await runCommand(`session-memory schema apply --db ${sessionMemoryDbPath}`);
    const schemaConfirmation = schemaDryRun.text.match(/execute confirmation: ([a-z0-9_:-]+)/)?.[1];
    expect(schemaConfirmation).toBeTruthy();
    const schemaCreated = await runCommand(
      `session-memory schema apply --execute --confirm ${schemaConfirmation} --db ${sessionMemoryDbPath}`,
    );
    expect(schemaCreated.text).toContain("status: created");

    const seed = writeSessionMemorySeedPacket({
      dbPath: sessionMemoryDbPath,
      lcmDbPath: fixture.dbPath,
      packet: {
        session: {
          sessionId: "session-memory-replacement-source",
          conversationId: 2800,
          sessionKey: "agent:main:webchat:session-memory-replacement-source",
        },
        segment: {
          segmentId: "segment-memory-replacement-source",
          seq: 1,
        },
        entries: [
          {
            entryId: "entry-memory-stale-state",
            kind: "fact",
            confidence: 0.82,
            priority: 20,
            body: "The current conversation 2565 has active seed rows copied from 2549.",
            sourceRefs: [{ type: "workspace_file", path: "Friday-memory/plans/Friday/session-memory-gate24-grouped-vs-compact-readonly-eval-2026-06-20.md" }],
          },
        ],
      },
    });
    expect(seed).toMatchObject({ ok: true, entryCount: 1 });

    writeFileSync(replacementsPath, JSON.stringify({
      replacementEntries: [
        {
          sourceEntryId: "entry-memory-stale-state",
          entryId: "entry-memory-refreshed-state",
          body: "Gate 28 replacement packets are temp-DB-only; runtime overlay remains disabled.",
          confidence: 0.91,
          priority: 25,
          sourceRefs: [{ type: "workspace_file", path: "Friday-memory/plans/Friday/session-memory-gate28-replacement-packet-cli-2026-06-20.md" }],
        },
      ],
    }));

    const dryRun = await runCommand(`session-memory carry-forward --from 2800 --replacements ${replacementsPath}`);
    const confirmation = dryRun.text.match(/execute confirmation: ([a-z0-9_:-]+)/)?.[1];
    expect(dryRun.text).toContain("status: dry_run");
    expect(dryRun.text).toContain("replacement entries: 1");
    expect(confirmation).toBeTruthy();

    const dryRunDb = new DatabaseSync(sessionMemoryDbPath, { readOnly: true });
    try {
      expect(
        (dryRunDb
          .prepare("SELECT COUNT(*) AS count FROM entries WHERE session_id = ?")
          .get("session-memory-replacement-target") as { count: number }).count,
      ).toBe(0);
    } finally {
      dryRunDb.close();
    }

    const executed = await runCommand(
      `session-memory carry-forward --from 2800 --replacements ${replacementsPath} --execute --confirm ${confirmation}`,
    );
    expect(executed.text).toContain("status: written");
    expect(executed.text).toContain("entries carried: 1");
    expect(executed.text).toContain("entries replaced: 1");

    const sessionMemoryDb = new DatabaseSync(sessionMemoryDbPath, { readOnly: true });
    try {
      expect(
        sessionMemoryDb
          .prepare("SELECT status, superseded_by_entry_id FROM entries WHERE entry_id = ?")
          .get("entry-memory-stale-state"),
      ).toEqual({
        status: "superseded",
        superseded_by_entry_id: "entry-memory-refreshed-state",
      });
      expect(
        sessionMemoryDb
          .prepare("SELECT status, origin_entry_id, body FROM entries WHERE entry_id = ?")
          .get("entry-memory-refreshed-state"),
      ).toEqual({
        status: "active",
        origin_entry_id: "entry-memory-stale-state",
        body: "Gate 28 replacement packets are temp-DB-only; runtime overlay remains disabled.",
      });
      expect(
        (sessionMemoryDb
          .prepare("SELECT COUNT(*) AS count FROM links WHERE relation = 'supersedes'")
          .get() as { count: number }).count,
      ).toBe(1);
      expect(
        (sessionMemoryDb
          .prepare("SELECT COUNT(*) AS count FROM sessions WHERE conversation_id = ?")
          .get(targetConversation.conversationId) as { count: number }).count,
      ).toBe(1);
    } finally {
      sessionMemoryDb.close();
    }
  });

  it("appends one reviewed semantic entry from an explicit packet only with confirmation", async () => {
    const fixture = createCommandFixture();
    tempDirs.add(fixture.tempDir);
    dbPaths.add(fixture.dbPath);

    const sessionMemoryDbPath = join(fixture.tempDir, "session-memory-append-reviewed.db");
    const entryPath = join(fixture.tempDir, "append-reviewed-entry.json");
    const config = resolveLcmConfig({}, {
      dbPath: fixture.dbPath,
      sessionMemoryOverlay: {
        dbPath: sessionMemoryDbPath,
      },
    });
    const command = createLcmCommand({ db: fixture.db, config });
    const runCommand = async (args: string): Promise<{ text: string }> => {
      return await command.handler!(createCommandContext(args, {
        sessionId: "session-memory-append-target",
        sessionKey: "agent:main:webchat:session-memory-append-target",
      })) as { text: string };
    };

    const targetConversation = await fixture.conversationStore.createConversation({
      sessionId: "session-memory-append-target",
      sessionKey: "agent:main:webchat:session-memory-append-target",
    });

    const schemaDryRun = await runCommand(`session-memory schema apply --db ${sessionMemoryDbPath}`);
    const schemaConfirmation = schemaDryRun.text.match(/execute confirmation: ([a-z0-9_:-]+)/)?.[1];
    expect(schemaConfirmation).toBeTruthy();
    const schemaCreated = await runCommand(
      `session-memory schema apply --execute --confirm ${schemaConfirmation} --db ${sessionMemoryDbPath}`,
    );
    expect(schemaCreated.text).toContain("status: created");

    writeSessionMemorySeedPacket({
      dbPath: sessionMemoryDbPath,
      lcmDbPath: fixture.dbPath,
      packet: {
        session: {
          sessionId: "session-memory-append-target",
          conversationId: targetConversation.conversationId,
          sessionKey: "agent:main:webchat:session-memory-append-target",
        },
        segment: {
          segmentId: "segment-memory-append-target",
          seq: 1,
        },
        entries: [
          {
            entryId: "entry-memory-append-existing",
            kind: "decision",
            confidence: 0.9,
            priority: 30,
            body: "Gate 41 added a controlled semantic append writer primitive.",
            sourceRefs: [{ type: "workspace_file", path: "Friday-memory/CURRENT.md" }],
          },
        ],
      },
    });
    const sessionMemoryDb = new DatabaseSync(sessionMemoryDbPath);
    try {
      sessionMemoryDb.exec(`
        ALTER TABLE entries ADD COLUMN logical_kind TEXT NULL;
        ALTER TABLE entries ADD COLUMN project_id TEXT NULL;
        ALTER TABLE entries ADD COLUMN workline_id TEXT NULL;
        ALTER TABLE entries ADD COLUMN details_json TEXT NULL;
        ALTER TABLE entries ADD COLUMN evidence_level TEXT NULL;
        ALTER TABLE entries ADD COLUMN review_state TEXT NULL;
        CREATE INDEX entries_project_workline_status_idx ON entries (project_id, workline_id, status);
        CREATE INDEX entries_logical_kind_status_idx ON entries (logical_kind, status);
        INSERT INTO schema_migrations (migration_id, schema_version, applied_at, checksum, description)
        VALUES (
          'session_memory_v0_2_entry_semantic_fields',
          2,
          '2026-06-28T12:45:00.000Z',
          'test-semantic-append-command',
          'Add semantic entry fields'
        );
        PRAGMA user_version = 2;
      `);
    } finally {
      sessionMemoryDb.close();
    }

    const approvedRealDbDir = join(
      process.cwd(),
      `.lossless-claw-command-real-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    mkdirSync(approvedRealDbDir);
    tempDirs.add(approvedRealDbDir);
    const approvedRealDbPath = join(approvedRealDbDir, "session-memory-approved-real.db");
    copyFileSync(sessionMemoryDbPath, approvedRealDbPath);
    const approvedRealConfig = resolveLcmConfig({}, {
      dbPath: fixture.dbPath,
      sessionMemoryOverlay: {
        dbPath: approvedRealDbPath,
      },
    });
    const approvedRealCommand = createLcmCommand({ db: fixture.db, config: approvedRealConfig });
    const runApprovedRealCommand = async (args: string): Promise<{ text: string }> => {
      return await approvedRealCommand.handler!(createCommandContext(args, {
        sessionId: "session-memory-append-target",
        sessionKey: "agent:main:webchat:session-memory-append-target",
      })) as { text: string };
    };

    writeFileSync(entryPath, JSON.stringify({
      entry: {
        entryId: "gate42-reviewed-command-entry",
        kind: "decision",
        logicalKind: "reviewed_decision",
        projectId: "lossless-session-memory",
        worklineId: "gate42-semantic-append-command",
        details: {
          decision: "Gate 42 exposes semantic append as a dry-run-first command.",
          includes: ["entry packet digest", "confirmation token", "temp DB execution"],
          not_types: ["automatic capture", "runtime overlay enablement", "real DB write"],
          conditions: ["execute requires confirmation"],
          source_decision_ref: "source_refs_json[0]",
        },
        evidenceLevel: "committed_plan_plus_reverse_review",
        reviewState: "accepted",
        confidence: 0.93,
        priority: 94,
        title: "Gate 42 dry-run-first semantic append command",
        body: "Gate 42 should expose the semantic append writer through a dry-run-first command without enabling automatic capture.",
        sourceRefs: [{ type: "workspace_file", path: "Friday-memory/CURRENT.md" }],
      },
    }));

    const dryRun = await runCommand(`session-memory append-reviewed --entry ${entryPath}`);
    const confirmation = dryRun.text.match(/execute confirmation: ([a-z0-9_:-]+)/)?.[1];
    expect(dryRun.text).toContain("Session Memory Reviewed Append");
    expect(dryRun.text).toContain("status: dry_run");
    expect(dryRun.text).toContain("entry id: `gate42-reviewed-command-entry`");
    expect(dryRun.text).toContain("logical kind: reviewed_decision");
    expect(confirmation).toBeTruthy();

    const dryRunDb = new DatabaseSync(sessionMemoryDbPath, { readOnly: true });
    try {
      expect(
        (dryRunDb
          .prepare("SELECT COUNT(*) AS count FROM entries WHERE entry_id = ?")
          .get("gate42-reviewed-command-entry") as { count: number }).count,
      ).toBe(0);
    } finally {
      dryRunDb.close();
    }

    const nonTempDbPath = join("test-fixtures", "session-memory-real.db");
    const nonTempDryRun = await runCommand(`session-memory append-reviewed --entry ${entryPath} --db ${nonTempDbPath}`);
    const nonTempConfirmation = nonTempDryRun.text.match(/execute confirmation: ([a-z0-9_:-]+)/)?.[1];
    expect(nonTempConfirmation).toBeTruthy();
    const nonTempRefused = await runCommand(
      `session-memory append-reviewed --entry ${entryPath} --db ${nonTempDbPath} --execute --confirm ${nonTempConfirmation}`,
    );
    expect(nonTempRefused.text).toContain("status: refused");
    expect(nonTempRefused.text).toContain("reason: real DB append requires a separate approved backup gate");

    const nonTempExplicitRealRefused = await runCommand(
      `session-memory append-reviewed --entry ${entryPath} --db ${nonTempDbPath} --allow-real-db --execute --confirm ${nonTempConfirmation}`,
    );
    expect(nonTempExplicitRealRefused.text).toContain("status: refused");
    expect(nonTempExplicitRealRefused.text).toContain(
      "reason: --allow-real-db uses the resolved session-memory DB path; omit --db",
    );

    const refused = await runCommand(`session-memory append-reviewed --entry ${entryPath} --execute --confirm wrong`);
    expect(refused.text).toContain("status: refused");
    expect(refused.text).toContain("reason: confirmation token mismatch");

    const executed = await runCommand(
      `session-memory append-reviewed --entry ${entryPath} --execute --confirm ${confirmation}`,
    );
    expect(executed.text).toContain("status: written");
    expect(executed.text).toContain("entry id: `gate42-reviewed-command-entry`");
    expect(executed.text).toContain("segment id: `segment-memory-append-target`");

    const postWriteDb = new DatabaseSync(sessionMemoryDbPath, { readOnly: true });
    try {
      expect(
        postWriteDb
          .prepare("SELECT logical_kind, project_id, workline_id, evidence_level, review_state FROM entries WHERE entry_id = ?")
          .get("gate42-reviewed-command-entry"),
      ).toEqual({
        logical_kind: "reviewed_decision",
        project_id: "lossless-session-memory",
        workline_id: "gate42-semantic-append-command",
        evidence_level: "committed_plan_plus_reverse_review",
        review_state: "accepted",
      });
      expect(
        postWriteDb
          .prepare("SELECT entry_count FROM segments WHERE segment_id = ?")
          .get("segment-memory-append-target"),
      ).toEqual({ entry_count: 2 });
    } finally {
      postWriteDb.close();
    }

    const approvedRealDryRun = await runApprovedRealCommand(
      `session-memory append-reviewed --entry ${entryPath} --allow-real-db`,
    );
    const approvedRealConfirmation = approvedRealDryRun.text.match(/execute confirmation: ([a-z0-9_:-]+)/)?.[1];
    expect(approvedRealDryRun.text).toContain("status: dry_run");
    expect(approvedRealDryRun.text).toContain("real DB execution: allowed by explicit flag");
    expect(approvedRealConfirmation).toBeTruthy();
    const approvedRealExecuted = await runApprovedRealCommand(
      `session-memory append-reviewed --entry ${entryPath} --allow-real-db --execute --confirm ${approvedRealConfirmation}`,
    );
    expect(approvedRealExecuted.text).toContain("status: written");
    const approvedRealPostWriteDb = new DatabaseSync(approvedRealDbPath, { readOnly: true });
    try {
      expect(
        approvedRealPostWriteDb
          .prepare("SELECT logical_kind, project_id, workline_id, evidence_level, review_state FROM entries WHERE entry_id = ?")
          .get("gate42-reviewed-command-entry"),
      ).toEqual({
        logical_kind: "reviewed_decision",
        project_id: "lossless-session-memory",
        workline_id: "gate42-semantic-append-command",
        evidence_level: "committed_plan_plus_reverse_review",
        review_state: "accepted",
      });
    } finally {
      approvedRealPostWriteDb.close();
    }
  });

  it("appends one reviewed semantic entry into an explicit target conversation", async () => {
    const fixture = createCommandFixture();
    tempDirs.add(fixture.tempDir);
    dbPaths.add(fixture.dbPath);

    const currentSessionKey = "agent:main:webchat:append-reviewed-current";
    const explicitTargetSessionKey = "agent:main:webchat:append-reviewed-explicit-target";
    const currentConversation = await fixture.conversationStore.createConversation({
      sessionId: "session-memory-append-current",
      sessionKey: currentSessionKey,
    });
    const explicitTargetConversation = await fixture.conversationStore.createConversation({
      sessionId: "session-memory-append-explicit-target",
      sessionKey: explicitTargetSessionKey,
    });

    const sessionMemoryDbPath = join(fixture.tempDir, "session-memory-append-reviewed-explicit-target.db");
    const entryPath = join(fixture.tempDir, "append-reviewed-explicit-target-entry.json");
    const config = resolveLcmConfig({}, {
      dbPath: fixture.dbPath,
      sessionMemoryOverlay: {
        dbPath: sessionMemoryDbPath,
      },
    });
    const command = createLcmCommand({ db: fixture.db, config });
    const runCommand = async (args: string): Promise<{ text: string }> => {
      return await command.handler!(createCommandContext(args, {
        sessionId: "session-memory-append-current",
        sessionKey: currentSessionKey,
      })) as { text: string };
    };

    const schemaDryRun = await runCommand(`session-memory schema apply --db ${sessionMemoryDbPath}`);
    const schemaConfirmation = schemaDryRun.text.match(/execute confirmation: ([a-z0-9_:-]+)/)?.[1];
    expect(schemaConfirmation).toBeTruthy();
    const schemaCreated = await runCommand(
      `session-memory schema apply --execute --confirm ${schemaConfirmation} --db ${sessionMemoryDbPath}`,
    );
    expect(schemaCreated.text).toContain("status: created");

    writeSessionMemorySeedPacket({
      dbPath: sessionMemoryDbPath,
      lcmDbPath: fixture.dbPath,
      packet: {
        session: {
          sessionId: "session-memory-append-explicit-target",
          conversationId: explicitTargetConversation.conversationId,
          sessionKey: explicitTargetSessionKey,
        },
        segment: {
          segmentId: "segment-memory-append-explicit-target",
          seq: 1,
        },
        entries: [
          {
            entryId: "entry-memory-append-explicit-existing",
            kind: "decision",
            confidence: 0.9,
            priority: 30,
            body: "Gate 50 proved reviewed append needs explicit target binding before real writes.",
            sourceRefs: [{ type: "workspace_file", path: "Friday-memory/CURRENT.md" }],
          },
        ],
      },
    });
    const sessionMemoryDb = new DatabaseSync(sessionMemoryDbPath);
    try {
      sessionMemoryDb.exec(`
        ALTER TABLE entries ADD COLUMN logical_kind TEXT NULL;
        ALTER TABLE entries ADD COLUMN project_id TEXT NULL;
        ALTER TABLE entries ADD COLUMN workline_id TEXT NULL;
        ALTER TABLE entries ADD COLUMN details_json TEXT NULL;
        ALTER TABLE entries ADD COLUMN evidence_level TEXT NULL;
        ALTER TABLE entries ADD COLUMN review_state TEXT NULL;
        CREATE INDEX entries_project_workline_status_idx ON entries (project_id, workline_id, status);
        CREATE INDEX entries_logical_kind_status_idx ON entries (logical_kind, status);
        INSERT INTO schema_migrations (migration_id, schema_version, applied_at, checksum, description)
        VALUES (
          'session_memory_v0_2_entry_semantic_fields',
          2,
          '2026-06-28T12:45:00.000Z',
          'test-semantic-append-explicit-target-command',
          'Add semantic entry fields'
        );
        PRAGMA user_version = 2;
      `);
    } finally {
      sessionMemoryDb.close();
    }

    writeFileSync(entryPath, JSON.stringify({
      entry: {
        entryId: "gate50a-reviewed-explicit-target-entry",
        kind: "decision",
        logicalKind: "reviewed_decision",
        projectId: "lossless-session-memory",
        worklineId: "gate50a-append-reviewed-target-selection",
        details: {
          decision: "append-reviewed target selection must bind dry-run and execute to the explicit conversation.",
          target_conversation_id: explicitTargetConversation.conversationId,
          not_types: ["automatic capture", "runtime overlay enablement", "real DB write"],
        },
        evidenceLevel: "committed_plan_plus_reverse_review",
        reviewState: "accepted",
        confidence: 0.92,
        priority: 92,
        title: "append-reviewed explicit target binding",
        body: "append-reviewed should support explicit target conversation binding before any reviewed write to a repaired old UI fork.",
        sourceRefs: [{ type: "workspace_file", path: "Friday-memory/CURRENT.md" }],
      },
    }));

    const dryRun = await runCommand(
      `session-memory append-reviewed --entry ${entryPath} --to-conversation ${explicitTargetConversation.conversationId}`,
    );
    const confirmation = dryRun.text.match(/execute confirmation: ([a-z0-9_:-]+)/)?.[1];
    expect(dryRun.text).toContain("Session Memory Reviewed Append");
    expect(dryRun.text).toContain("status: dry_run");
    expect(dryRun.text).toContain("target mode: explicit");
    expect(dryRun.text).toContain(`conversation id: ${explicitTargetConversation.conversationId}`);
    expect(dryRun.text).toContain(`current conversation id: ${currentConversation.conversationId}`);
    expect(dryRun.text).toContain("entry id: `gate50a-reviewed-explicit-target-entry`");
    expect(confirmation).toBeTruthy();

    const dryRunDb = new DatabaseSync(sessionMemoryDbPath, { readOnly: true });
    try {
      expect(
        (dryRunDb
          .prepare("SELECT COUNT(*) AS count FROM entries WHERE entry_id = ?")
          .get("gate50a-reviewed-explicit-target-entry") as { count: number }).count,
      ).toBe(0);
    } finally {
      dryRunDb.close();
    }

    const executed = await runCommand(
      `session-memory append-reviewed --entry ${entryPath} --to-conversation ${explicitTargetConversation.conversationId} --execute --confirm ${confirmation}`,
    );
    expect(executed.text).toContain("status: written");
    expect(executed.text).toContain("entry id: `gate50a-reviewed-explicit-target-entry`");
    expect(executed.text).toContain("segment id: `segment-memory-append-explicit-target`");

    const postWriteDb = new DatabaseSync(sessionMemoryDbPath, { readOnly: true });
    try {
      expect(
        postWriteDb
          .prepare(
            `SELECT s.conversation_id, e.logical_kind, e.project_id, e.workline_id, e.evidence_level, e.review_state
             FROM entries e
             JOIN sessions s ON s.session_id = e.session_id
             WHERE e.entry_id = ?`,
          )
          .get("gate50a-reviewed-explicit-target-entry"),
      ).toEqual({
        conversation_id: explicitTargetConversation.conversationId,
        logical_kind: "reviewed_decision",
        project_id: "lossless-session-memory",
        workline_id: "gate50a-append-reviewed-target-selection",
        evidence_level: "committed_plan_plus_reverse_review",
        review_state: "accepted",
      });
      expect(
        (postWriteDb
          .prepare(
            `SELECT COUNT(*) AS count
             FROM entries e
             JOIN sessions s ON s.session_id = e.session_id
             WHERE s.conversation_id = ?`,
          )
          .get(currentConversation.conversationId) as { count: number }).count,
      ).toBe(0);
    } finally {
      postWriteDb.close();
    }
  });

  it("reports session-memory capture candidates without writing session-memory DB", async () => {
    const fixture = createCommandFixture();
    tempDirs.add(fixture.tempDir);
    dbPaths.add(fixture.dbPath);

    const sessionMemoryDbPath = join(fixture.tempDir, "session-memory-capture-candidates.db");
    const sessionKey = "agent:main:webchat:session-memory-capture-candidates";
    const config = resolveLcmConfig({}, {
      dbPath: fixture.dbPath,
      sessionMemoryOverlay: {
        dbPath: sessionMemoryDbPath,
      },
    });
    const command = createLcmCommand({ db: fixture.db, config });
    const conversation = await fixture.conversationStore.createConversation({
      sessionId: "session-memory-capture-candidates",
      sessionKey,
    });

    await fixture.conversationStore.createMessagesBulk([
      {
        conversationId: conversation.conversationId,
        seq: 0,
        role: "user",
        content: "我们继续 session memory 的工作，先修没有自动化导致验证费劲的问题。",
        tokenCount: 18,
      },
      {
        conversationId: conversation.conversationId,
        seq: 1,
        role: "assistant",
        content: "我会先做只读候选报告，不写真实 DB。",
        tokenCount: 14,
      },
      {
        conversationId: conversation.conversationId,
        seq: 2,
        role: "user",
        content: "所以我们接下来就是要研究 Steam 上独立游戏的品类，但更重要的是玩法，不是美术。",
        tokenCount: 24,
      },
      {
        conversationId: conversation.conversationId,
        seq: 3,
        role: "user",
        content: "不要优先恐怖 / 氛围探索，也不优先 Cozy / 收集养成。",
        tokenCount: 18,
      },
    ]);

    const result = await command.handler!(createCommandContext(
      "session-memory capture-candidates --limit 10",
      {
        sessionId: "session-memory-capture-candidates",
        sessionKey,
      },
    )) as { text: string };

    expect(result.text).toContain("Session Memory Candidate Capture");
    expect(result.text).toContain("mode: dry_run_report");
    expect(result.text).toContain("writes: none");
    expect(result.text).toContain("accepted memory: none");
    expect(result.text).toContain("Candidate 1 - constraint_boundary");
    expect(result.text).toContain("workline_shift");
    expect(result.text).toContain("source: user_decision");
    expect(result.text).toContain("constraint_boundary");
    expect(result.text).toContain("review result: candidate_only");
    expect(existsSync(sessionMemoryDbPath)).toBe(false);
  });

  it("reports session-memory capture candidates from summaries when raw messages are stale", async () => {
    const fixture = createCommandFixture();
    tempDirs.add(fixture.tempDir);
    dbPaths.add(fixture.dbPath);

    const sessionMemoryDbPath = join(fixture.tempDir, "session-memory-capture-candidates-summary.db");
    const config = resolveLcmConfig({}, {
      dbPath: fixture.dbPath,
      sessionMemoryOverlay: {
        dbPath: sessionMemoryDbPath,
      },
    });
    const command = createLcmCommand({ db: fixture.db, config });
    const sessionKey = "agent:main:webchat:session-memory-capture-candidates-summary";
    const conversation = await fixture.conversationStore.createConversation({
      sessionId: "session-memory-capture-candidates-summary",
      sessionKey,
    });
    await fixture.conversationStore.createMessagesBulk([
      {
        conversationId: conversation.conversationId,
        seq: 0,
        role: "assistant",
        content: "最近只剩下一条实现完成摘要。",
        tokenCount: 12,
      },
    ]);
    await fixture.summaryStore.insertSummary({
      summaryId: "sum_session_memory_candidate_workline",
      conversationId: conversation.conversationId,
      kind: "leaf",
      content: "用户确认接下来研究 Steam 上独立游戏的品类，更重要的是玩法，不是美术；不要优先恐怖 / 氛围探索。",
      tokenCount: 28,
      latestAt: new Date("2026-07-03T07:20:00.000Z"),
    });

    const result = await command.handler!(createCommandContext(
      "session-memory capture-candidates --limit 1",
      {
        sessionId: "session-memory-capture-candidates-summary",
        sessionKey,
      },
    )) as { text: string };

    expect(result.text).toContain("Session Memory Candidate Capture");
    expect(result.text).toContain("summary scan limit: 1");
    expect(result.text).toContain("source: lcm_summary");
    expect(result.text).toContain("source item: summary `sum_session_memory_candidate_workline`");
    expect(result.text).toContain("review result: candidate_only");
    expect(existsSync(sessionMemoryDbPath)).toBe(false);
  });

  it("prioritizes user-authored session-memory candidates over assistant status noise", async () => {
    const fixture = createCommandFixture();
    tempDirs.add(fixture.tempDir);
    dbPaths.add(fixture.dbPath);

    const sessionMemoryDbPath = join(fixture.tempDir, "session-memory-capture-candidates-priority.db");
    const config = resolveLcmConfig({}, {
      dbPath: fixture.dbPath,
      sessionMemoryOverlay: {
        dbPath: sessionMemoryDbPath,
      },
    });
    const command = createLcmCommand({ db: fixture.db, config });
    const sessionKey = "agent:main:webchat:session-memory-capture-candidates-priority";
    const conversation = await fixture.conversationStore.createConversation({
      sessionId: "session-memory-capture-candidates-priority",
      sessionKey,
    });
    await fixture.conversationStore.createMessagesBulk([
      ...Array.from({ length: 10 }, (_, index) => ({
        conversationId: conversation.conversationId,
        seq: index,
        role: "assistant",
        content: `验证完成，commit pushed，build 通过。status item ${index}`,
        tokenCount: 12,
      })),
      {
        conversationId: conversation.conversationId,
        seq: 10,
        role: "user",
        content: "这两份规划都同意，但今晚不直接接自动写入。",
        tokenCount: 16,
      },
    ]);

    const result = await command.handler!(createCommandContext(
      "session-memory capture-candidates --limit 80",
      {
        sessionId: "session-memory-capture-candidates-priority",
        sessionKey,
      },
    )) as { text: string };

    expect(result.text).toContain("Candidate 1 - decision");
    expect(result.text).toContain("source: user_decision");
    expect(result.text).toContain("这两份规划都同意");
    expect(result.text).toContain("max emitted: 8");
    expect(existsSync(sessionMemoryDbPath)).toBe(false);
  });

  it("ignores pasted session-memory candidate reports", async () => {
    const fixture = createCommandFixture();
    tempDirs.add(fixture.tempDir);
    dbPaths.add(fixture.dbPath);

    const sessionMemoryDbPath = join(fixture.tempDir, "session-memory-capture-candidates-report-noise.db");
    const config = resolveLcmConfig({}, {
      dbPath: fixture.dbPath,
      sessionMemoryOverlay: {
        dbPath: sessionMemoryDbPath,
      },
    });
    const command = createLcmCommand({ db: fixture.db, config });
    const sessionKey = "agent:main:webchat:session-memory-capture-candidates-report-noise";
    const conversation = await fixture.conversationStore.createConversation({
      sessionId: "session-memory-capture-candidates-report-noise",
      sessionKey,
    });
    await fixture.conversationStore.createMessagesBulk([
      {
        conversationId: conversation.conversationId,
        seq: 0,
        role: "user",
        content: [
          "**🦀 Lossless Claw v0.11.3**",
          "🧠 Session Memory Candidate Capture",
          "**🧩 Candidate Summary**",
          "candidates: 8",
          "**Candidate 1 - workline_shift**",
          "claim: 所以我们接下来是暂停session memory?还是继续讨论一会再转其他话题?",
          "writes: none",
          "accepted memory: none",
          "review result: candidate_only",
        ].join("\n"),
        tokenCount: 80,
      },
      {
        conversationId: conversation.conversationId,
        seq: 1,
        role: "user",
        content: "ok 这两份规划都同意",
        tokenCount: 8,
      },
    ]);

    const result = await command.handler!(createCommandContext(
      "session-memory capture-candidates --limit 80",
      {
        sessionId: "session-memory-capture-candidates-report-noise",
        sessionKey,
      },
    )) as { text: string };

    expect(result.text).toContain("Candidate 1 - decision");
    expect(result.text).toContain("ok 这两份规划都同意");
    expect(result.text).not.toContain("所以我们接下来是暂停session memory");
    expect(existsSync(sessionMemoryDbPath)).toBe(false);
  });

  it("keeps user corrections before pasted session-memory candidate reports", async () => {
    const fixture = createCommandFixture();
    tempDirs.add(fixture.tempDir);
    dbPaths.add(fixture.dbPath);

    const sessionMemoryDbPath = join(fixture.tempDir, "session-memory-capture-candidates-report-wrapper.db");
    const config = resolveLcmConfig({}, {
      dbPath: fixture.dbPath,
      sessionMemoryOverlay: {
        dbPath: sessionMemoryDbPath,
      },
    });
    const command = createLcmCommand({ db: fixture.db, config });
    const sessionKey = "agent:main:webchat:session-memory-capture-candidates-report-wrapper";
    const conversation = await fixture.conversationStore.createConversation({
      sessionId: "session-memory-capture-candidates-report-wrapper",
      sessionKey,
    });
    await fixture.conversationStore.createMessagesBulk([
      {
        conversationId: conversation.conversationId,
        seq: 0,
        role: "user",
        content: [
          "我没说过这话 可能是active memory的问题",
          "**🦀 Lossless Claw v0.11.3**",
          "Help: `/lossless help` · Alias: `/lcm`",
          "",
          "🧠 Session Memory Candidate Capture",
          "",
          "**📍 Target conversation**",
          "  target mode: current",
          "  conversation id: 3,100",
          "  session key: `agent:main:dashboard:c…1fe-b375-c442de37ff90`",
          "  message scan limit: 80",
          "  summary scan limit: 80",
          "",
          "**🧪 Mode**",
          "  mode: dry_run_report",
          "  writes: none",
          "  accepted memory: none",
          "  review result: candidate_only",
          "",
          "**🛠️ Result**",
          "  No candidate-worthy events detected in the scanned message window.",
        ].join("\n"),
        tokenCount: 90,
      },
    ]);

    const result = await command.handler!(createCommandContext(
      "session-memory capture-candidates --limit 80",
      {
        sessionId: "session-memory-capture-candidates-report-wrapper",
        sessionKey,
      },
    )) as { text: string };

    expect(result.text).toContain("Candidate 1 - constraint_boundary");
    expect(result.text).toContain("claim: 我没说过这话 可能是active memory的问题");
    expect(result.text).not.toContain("claim: 我没说过这话 可能是active memory的问题 **🦀 Lossless Claw");
    expect(result.text).toContain("writes: none");
    expect(result.text).toContain("accepted memory: none");
    expect(existsSync(sessionMemoryDbPath)).toBe(false);
  });

  it("demotes short operational approvals with task wording to local flow", async () => {
    const fixture = createCommandFixture();
    tempDirs.add(fixture.tempDir);
    dbPaths.add(fixture.dbPath);

    const sessionMemoryDbPath = join(fixture.tempDir, "session-memory-capture-candidates-operational-approval.db");
    const config = resolveLcmConfig({}, {
      dbPath: fixture.dbPath,
      sessionMemoryOverlay: {
        dbPath: sessionMemoryDbPath,
      },
    });
    const command = createLcmCommand({ db: fixture.db, config });
    const sessionKey = "agent:main:webchat:session-memory-capture-candidates-operational-approval";
    const conversation = await fixture.conversationStore.createConversation({
      sessionId: "session-memory-capture-candidates-operational-approval",
      sessionKey,
    });
    await fixture.conversationStore.createMessagesBulk([
      {
        conversationId: conversation.conversationId,
        seq: 0,
        role: "user",
        content: "可以 先开始修吧",
        tokenCount: 6,
      },
    ]);

    const result = await command.handler!(createCommandContext(
      "session-memory capture-candidates --limit 80",
      {
        sessionId: "session-memory-capture-candidates-operational-approval",
        sessionKey,
      },
    )) as { text: string };

    expect(result.text).toContain("local_flow: message `#0`");
    expect(result.text).toContain("review bucket: local_flow");
    expect(result.text).not.toContain("promotable: message `#0`");
    expect(result.text).toContain("writes: none");
    expect(result.text).toContain("accepted memory: none");
    expect(existsSync(sessionMemoryDbPath)).toBe(false);
  });

  it("buckets duplicate stale and missed-current-state session-memory capture candidates", async () => {
    const fixture = createCommandFixture();
    tempDirs.add(fixture.tempDir);
    dbPaths.add(fixture.dbPath);

    const sessionMemoryDbPath = join(fixture.tempDir, "session-memory-capture-candidates-buckets.db");
    const config = resolveLcmConfig({}, {
      dbPath: fixture.dbPath,
      sessionMemoryOverlay: {
        dbPath: sessionMemoryDbPath,
      },
    });
    const command = createLcmCommand({ db: fixture.db, config });
    const sessionKey = "agent:main:webchat:session-memory-capture-candidates-buckets";
    const conversation = await fixture.conversationStore.createConversation({
      sessionId: "session-memory-capture-candidates-buckets",
      sessionKey,
    });

    await fixture.conversationStore.createMessagesBulk([
      {
        conversationId: conversation.conversationId,
        seq: 0,
        role: "user",
        content: "批准只读 Chrome bilibili.com cookie 只用于抓这三条圣兽之王字幕，cookie 值不能打印或保存。",
        tokenCount: 24,
      },
      ...Array.from({ length: 9 }, (_, index) => ({
        conversationId: conversation.conversationId,
        seq: index + 1,
        role: "user",
        content: `不要把自动写入当默认路径，边界规则 ${index} 必须保留。`,
        tokenCount: 14,
      })),
      {
        conversationId: conversation.conversationId,
        seq: 10,
        role: "assistant",
        content: "字幕已抓取并提交 497240e Add Unicorn Overlord subtitles，随后写入 Friday-memory/work/unicorn-overlord/combat-mechanics-summary-2026-07-04.md。",
        tokenCount: 32,
      },
    ]);

    await fixture.summaryStore.insertSummary({
      summaryId: "sum_duplicate_cookie_boundary",
      conversationId: conversation.conversationId,
      kind: "leaf",
      content: "用户批准只读 Chrome bilibili.com cookie 只用于抓这三条圣兽之王字幕，cookie 值不能打印或保存。",
      tokenCount: 24,
      latestAt: new Date("2026-07-04T00:01:00.000Z"),
    });
    await fixture.summaryStore.insertSummary({
      summaryId: "sum_gate50f_old_dry_run",
      conversationId: conversation.conversationId,
      kind: "leaf",
      content: "Gate50F dry-run completed and committed; reviewed packets are still only staged dry-run.",
      tokenCount: 20,
      latestAt: new Date("2026-07-04T00:02:00.000Z"),
    });
    await fixture.summaryStore.insertSummary({
      summaryId: "sum_gate50g_old_preflight",
      conversationId: conversation.conversationId,
      kind: "leaf",
      content: "Gate50G preflight completed with byte-exact backup before the reviewed append.",
      tokenCount: 18,
      latestAt: new Date("2026-07-04T00:03:00.000Z"),
    });
    await fixture.summaryStore.insertSummary({
      summaryId: "sum_gate50h_real_append",
      conversationId: conversation.conversationId,
      kind: "leaf",
      content: "Gate50H executed the real reviewed append; entries=75, 2997=>6 active, integrity_check=ok.",
      tokenCount: 22,
      latestAt: new Date("2026-07-04T00:04:00.000Z"),
    });
    await fixture.summaryStore.insertSummary({
      summaryId: "sum_process_startup_ok",
      conversationId: conversation.conversationId,
      kind: "leaf",
      content: "User said OK 继续, assistant re-read STARTUP.md and CURRENT.md to rebuild context before continuing work.",
      tokenCount: 18,
      latestAt: new Date("2026-07-04T00:05:00.000Z"),
    });

    const result = await command.handler!(createCommandContext(
      "session-memory capture-candidates --limit 100",
      {
        sessionId: "session-memory-capture-candidates-buckets",
        sessionKey,
      },
    )) as { text: string };

    expect(result.text).toContain("Review Buckets");
    expect(result.text).toContain("promotable:");
    expect(result.text).toContain("evidence_only:");
    expect(result.text).toContain("duplicate:");
    expect(result.text).toContain("stale/superseded:");
    expect(result.text).toContain("missed_current_state:");
    expect(result.text).toContain("duplicate: summary `sum_duplicate_cookie_boundary`");
    expect(result.text).toContain("stale/superseded: summary `sum_gate50f_old_dry_run`");
    expect(result.text).toContain("stale/superseded: summary `sum_gate50g_old_preflight`");
    expect(result.text).toContain("evidence_only: summary `sum_process_startup_ok`");
    expect(result.text).toContain("missed_current_state: 497240e");
    expect(result.text).toContain("missed_current_state: Friday-memory/work/unicorn-overlord/combat-mechanics-summary-2026-07-04.md");
    expect(result.text).toContain("writes: none");
    expect(result.text).toContain("accepted memory: none");
    expect(existsSync(sessionMemoryDbPath)).toBe(false);
  });

  it("reports current-state probe and local-flow approvals for post-category completion turns", async () => {
    const fixture = createCommandFixture();
    tempDirs.add(fixture.tempDir);
    dbPaths.add(fixture.dbPath);

    const sessionMemoryDbPath = join(fixture.tempDir, "session-memory-capture-candidates-current-probe.db");
    const config = resolveLcmConfig({}, {
      dbPath: fixture.dbPath,
      sessionMemoryOverlay: {
        dbPath: sessionMemoryDbPath,
      },
    });
    const command = createLcmCommand({ db: fixture.db, config });
    const sessionKey = "agent:main:webchat:session-memory-capture-candidates-current-probe";
    const conversation = await fixture.conversationStore.createConversation({
      sessionId: "session-memory-capture-candidates-current-probe",
      sessionKey,
    });

    await fixture.conversationStore.createMessagesBulk([
      {
        conversationId: conversation.conversationId,
        seq: 0,
        role: "user",
        content: "可以 继续吧",
        tokenCount: 4,
      },
      {
        conversationId: conversation.conversationId,
        seq: 1,
        role: "assistant",
        content:
          "抓完了 `刷宝 / Loot / ARPG / 装备驱动`。Excel 新增 `刷宝装备精选` sheet，五条精选目录都齐了：`战棋精选`、`棋牌精选`、`RPG精选`、`自走棋库存精选`、`刷宝装备精选`。提交并推送：`4f03a90 Add loot equipment screening sheet`。下一步适合开始深拆。",
        tokenCount: 64,
      },
      {
        conversationId: conversation.conversationId,
        seq: 2,
        role: "assistant",
        content:
          "有。方案别大改，先做一刀“当前态优先裁决层”。目标是让 `capture-candidates` 不再只是从摘要里捞候选。如果这刀过了，再考虑第二步。",
        tokenCount: 38,
      },
      {
        conversationId: conversation.conversationId,
        seq: 3,
        role: "assistant",
        content:
          "改完了。在 `lossless-claw` 做了报告层修正，只动 `capture-candidates`，不碰 DB、不自动写入、不启用 overlay。提交并推送：`2996792 Prioritize current state in capture candidates`。",
        tokenCount: 42,
      },
      {
        conversationId: conversation.conversationId,
        seq: 4,
        role: "assistant",
        content:
          "这次 live 验证说明 `Current State Probe` 已经生效，但第一刀还太贪，需要继续收窄 session-memory 工具验证噪音。",
        tokenCount: 32,
      },
    ]);

    await fixture.summaryStore.insertSummary({
      summaryId: "sum_old_first_batch",
      conversationId: conversation.conversationId,
      kind: "leaf",
      content: "第一批10个样本数据已填充并提交。使用Steam API抓取Balatro等10个A类游戏。",
      tokenCount: 24,
      latestAt: new Date("2026-07-04T10:27:53.000Z"),
    });
    await fixture.summaryStore.insertSummary({
      summaryId: "sum_old_tag_map",
      conversationId: conversation.conversationId,
      kind: "leaf",
      content: "肉鸽/构筑标签地图已生成：完成8个样本和标签地图模板。",
      tokenCount: 20,
      latestAt: new Date("2026-07-04T14:07:49.000Z"),
    });
    await fixture.summaryStore.insertSummary({
      summaryId: "sum_workbook_base",
      conversationId: conversation.conversationId,
      kind: "leaf",
      content: "Steam独立游戏分类工作簿已升级为多sheet主表，包含6条类型线和145唯一appid。",
      tokenCount: 24,
      latestAt: new Date("2026-07-04T14:55:59.000Z"),
    });
    await fixture.summaryStore.insertSummary({
      summaryId: "sum_old_card_sheet",
      conversationId: conversation.conversationId,
      kind: "leaf",
      content:
        "Completed 棋牌精选 sheet 的 30 个候选数据填充（从 Steam API 拉取评论数、好评率、标签并分类写入）。头部优先深拆杀戮尖塔、小丑牌、Cobalt Core。",
      tokenCount: 42,
      latestAt: new Date("2026-07-04T15:56:57.000Z"),
    });
    await fixture.summaryStore.insertSummary({
      summaryId: "sum_old_rpg_sheet",
      conversationId: conversation.conversationId,
      kind: "leaf",
      content:
        "Completed RPG build screening: 30 games written to new sheet \"RPG精选\" (Stoneshard, Darkest Dungeon I/II, Path of Achra).",
      tokenCount: 36,
      latestAt: new Date("2026-07-04T16:03:29.000Z"),
    });
    await fixture.summaryStore.insertSummary({
      summaryId: "sum_old_auto_battler_sheet",
      conversationId: conversation.conversationId,
      kind: "leaf",
      content:
        "Completed auto battler/inventory screening category: committed and pushed commit d3ee8af. Current next category is 刷宝 / Loot / ARPG / 装备驱动.",
      tokenCount: 40,
      latestAt: new Date("2026-07-04T16:36:36.000Z"),
    });
    await fixture.summaryStore.insertSummary({
      summaryId: "sum_old_field_suggestions",
      conversationId: conversation.conversationId,
      kind: "leaf",
      content:
        "Excel文件（first-batch-screening-2026-07-04.xlsx）已生成并提交推送（14a39a6）。用户要求在新版字段中额外添加“玩法结构”、“心理与情绪”、“游戏本体大小”。",
      tokenCount: 44,
      latestAt: new Date("2026-07-04T18:27:00.000Z"),
    });

    const result = await command.handler!(createCommandContext(
      "session-memory capture-candidates --limit 80",
      {
        sessionId: "session-memory-capture-candidates-current-probe",
        sessionKey,
      },
    )) as { text: string };

    expect(result.text).toContain("Current State Probe");
    expect(result.text).toContain("status: detected");
    expect(result.text).toContain("latest_completed:");
    expect(result.text).toContain("刷宝装备精选");
    expect(result.text).toContain("战棋精选");
    expect(result.text).toContain("next_action:");
    expect(result.text).toContain("开始深拆");
    expect(result.text).toContain("newest_evidence: 4f03a90");
    expect(result.text).not.toContain("latest_completed: Completed auto battler");
    expect(result.text).not.toContain("latest_completed: Completed RPG build");
    expect(result.text).not.toContain("latest_completed: Completed 棋牌精选");
    expect(result.text).not.toContain("next_action: Excel文件");
    expect(result.text).not.toContain("next_action: 用户要求在新版字段");
    expect(result.text).not.toContain("latest_completed: 有。方案别大改");
    expect(result.text).not.toContain("latest_completed: 改完了");
    expect(result.text).not.toContain("next_action: 改完了");
    expect(result.text).not.toContain("newest_evidence: 14a39a6");
    expect(result.text).not.toContain("newest_evidence: 2996792");
    expect(result.text).not.toContain("promotable: message `#3`");
    expect(result.text).toContain("evidence_only: message `#3`");
    expect(result.text).toContain("evidence_only: message `#4`");
    expect(result.text).toContain("local_flow: message `#0`");
    expect(result.text).toContain("review bucket: local_flow");
    expect(result.text).toContain("stale/superseded: summary `sum_old_first_batch`");
    expect(result.text).toContain("stale/superseded: summary `sum_old_tag_map`");
    expect(result.text).toContain("writes: none");
    expect(result.text).toContain("accepted memory: none");
    expect(existsSync(sessionMemoryDbPath)).toBe(false);
  });

  it("supersedes stale subtitle evidence next-actions after a deep-dive report is completed", async () => {
    const fixture = createCommandFixture();
    tempDirs.add(fixture.tempDir);
    dbPaths.add(fixture.dbPath);

    const sessionMemoryDbPath = join(fixture.tempDir, "session-memory-capture-candidates-report-complete.db");
    const config = resolveLcmConfig({}, {
      dbPath: fixture.dbPath,
      sessionMemoryOverlay: {
        dbPath: sessionMemoryDbPath,
      },
    });
    const command = createLcmCommand({ db: fixture.db, config });
    const sessionKey = "agent:main:webchat:session-memory-capture-candidates-report-complete";
    const conversation = await fixture.conversationStore.createConversation({
      sessionId: "session-memory-capture-candidates-report-complete",
      sessionKey,
    });

    await fixture.conversationStore.createMessagesBulk([
      {
        conversationId: conversation.conversationId,
        seq: 316,
        role: "assistant",
        content:
          "已建目录并抓完字幕： [slay-the-spire](/Users/shige/.openclaw/workspace/Friday-memory/work/steam-indie-category-research/slay-the-spire/)。提交并推送：`497e105 Add Slay the Spire subtitle sources` 下一步适合做“字幕证据表”：从 4 份 transcript 里标注决策、随机性/控制、卡牌/奖励/路线设计、情绪词、重复投入来源。",
        tokenCount: 70,
      },
      {
        conversationId: conversation.conversationId,
        seq: 317,
        role: "user",
        content: "可以 你需要给我的是详细的报告 按照你的深度拆解模版 ,如果里面并没有提到,那就先空着别瞎编",
        tokenCount: 30,
      },
      {
        conversationId: conversation.conversationId,
        seq: 436,
        role: "assistant",
        content:
          "好了，已按游戏单独建目录并完成第一版深拆报告。主报告在：Friday-memory/work/steam-indie-category-research/slay-the-spire/slay-the-spire-deep-dive-report-2026-07-05.md。支撑文件：Friday-memory/work/steam-indie-category-research/slay-the-spire/steam-official-snapshot-2026-07-05.md 和 Friday-memory/work/steam-indie-category-research/slay-the-spire/subtitle-evidence-table-2026-07-05.md。验证：cookie 值扫描未发现具体 cookie 值落盘，git diff --check 通过，commit + push：`1b29114 Add Slay the Spire deep dive report`。",
        tokenCount: 68,
      },
    ]);
    fixture.db
      .prepare(`UPDATE messages SET created_at = ? WHERE conversation_id = ? AND seq = ?`)
      .run("2026-07-05 08:28:28", conversation.conversationId, 316);
    fixture.db
      .prepare(`UPDATE messages SET created_at = ? WHERE conversation_id = ? AND seq = ?`)
      .run("2026-07-05 08:58:55", conversation.conversationId, 317);
    fixture.db
      .prepare(`UPDATE messages SET created_at = ? WHERE conversation_id = ? AND seq = ?`)
      .run("2026-07-05 08:58:56", conversation.conversationId, 436);
    await fixture.summaryStore.insertSummary({
      summaryId: "sum_review_noise",
      conversationId: conversation.conversationId,
      kind: "leaf",
      content:
        "用户审查lossless-claw dry_run_report，发现Current State Probe仍显示旧状态（“做字幕证据表”），但实际已完成第一版深拆报告并提交1b29114。决策：保留#317、提升#436、降级#316。\n\nExpand for details about: 14个candidate具体claim、用户逐条分析、agent-guardrail全文、lossless-claw SKILL全文、self-improving/memory.md内容",
      tokenCount: 84,
      latestAt: new Date("2026-07-05T12:22:51.000Z"),
    });
    await fixture.summaryStore.insertSummary({
      summaryId: "sum_test_noise",
      conversationId: conversation.conversationId,
      kind: "leaf",
      content:
        "Ran focused vitest tests for session-memory capture-candidates: initially one failure in \"supersedes stale subtitle evidence next-actions after a deep-dive report is completed\" due to truncated path in newest_evidence assertion. Fixed by adding currentStateCompletionSupersedes logic.\n\nExpand for details about: test case messages and assertions, git diff --check result",
      tokenCount: 78,
      latestAt: new Date("2026-07-05T12:22:51.000Z"),
    });
    await fixture.summaryStore.insertSummary({
      summaryId: "sum_loaded_noise",
      conversationId: conversation.conversationId,
      kind: "leaf",
      content:
        "Agent loaded Friday Guardrail (11-point operational discipline) and HOT tier memory rules. Found existing steam-indie-category-research work folder. All 5 Bilibili video metadata lookups returned Browser session is required. Slay the Spire analysis folder not yet created. Subtitle extraction for 5 videos not started. No new files written. Files: none\n\nExpand for details about: Bilibili subtitle command parameters, all 5 BV video titles/metadata if retrievable",
      tokenCount: 62,
      latestAt: new Date("2026-07-05T12:22:51.000Z"),
    });

    const result = await command.handler!(createCommandContext(
      "session-memory capture-candidates --limit 80",
      {
        sessionId: "session-memory-capture-candidates-report-complete",
        sessionKey,
      },
    )) as { text: string };

    expect(result.text).toContain("Current State Probe");
    expect(result.text).toContain("latest_completed:");
    expect(result.text).toContain("第一版深拆报告");
    expect(result.text).toContain("newest_evidence: 1b29114");
    expect(result.text).toContain("newest_evidence: Friday-memory/work/steam-indie-category-research/slay-the-spire/slay-the-spire-deep-dive-report-2026-07-05.md");
    expect(result.text).toContain("newest_evidence: Friday-memory/work/steam-indie-category-research/slay-the-spire/steam-official-snapshot-2026-07-05.md");
    expect(result.text).toContain("newest_evidence: Friday-memory/work/steam-indie-category-research/slay-the-spire/subtitle-evidence-table-2026-07-05.md");
    expect(result.text).not.toContain("latest_completed: 用户审查lossless-claw dry_run_report");
    expect(result.text).not.toContain("latest_completed: Ran focused vitest tests");
    expect(result.text).not.toContain("latest_completed: Agent loaded Friday Guardrail");
    expect(result.text).not.toContain("next_action: 用户审查lossless-claw dry_run_report");
    expect(result.text).not.toContain("next_action: Ran focused vitest tests");
    expect(result.text).not.toContain("next_action: 好了，已按游戏单独建目录并完成第一版深拆报告");
    expect(result.text).not.toContain("next_action: 已完成Slay the Spire深拆报告构建");
    expect(result.text).not.toContain("newest_evidence: self-improving/memory.md内容");
    expect(result.text).not.toContain("missed_current_state: Friday-memory/work/steam-indie-category-research/slay-the-spire/slay-the-spire-deep-dive-report-2026-07-05.md");
    expect(result.text).not.toContain("missed_current_state: Friday-memory/work/steam-indie-category-research/slay-the-spire/steam-official-snapshot-2026-07-05.md");
    expect(result.text).not.toContain("missed_current_state: Friday-memory/work/steam-indie-category-research/slay-the-spire/subtitle-evidence-table-2026-07-05.md");
    expect(result.text).toContain("promotable: message `#317`");
    expect(result.text).toContain("promotable: message `#436`");
    expect(result.text).toContain("stale/superseded: message `#316`");
    expect(result.text).not.toContain("promotable: message `#316`");
    expect(result.text).not.toContain("next_action: 已建目录并抓完字幕");
    expect(result.text).not.toContain("latest_completed: 已建目录并抓完字幕");
    expect(result.text).not.toContain("newest_evidence: 497e105");
    expect(result.text).toContain("writes: none");
    expect(result.text).toContain("accepted memory: none");
    expect(existsSync(sessionMemoryDbPath)).toBe(false);
  });

  it("rotates the current session and replaces the latest rotate backup", async () => {
    const transcriptPath = join(tmpdir(), `lossless-claw-rotate-${Date.now()}.jsonl`);
    writeFileSync(transcriptPath, "{\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"existing\"}]}}\n");
    tempDirs.add(transcriptPath);

    let currentConversationId = 0;
    let mockedBackupPath = "";
    const rotateSessionStorageWithBackup = vi.fn(async () => ({
      kind: "rotated" as const,
      currentConversationId,
      currentMessageCount: 1,
      backupPath: mockedBackupPath,
      preservedTailMessageCount: 8,
      checkpointSize: 1234,
      bytesRemoved: 4567,
    }));
    const deps = {
      resolveSessionIdFromSessionKey: vi.fn(async () => undefined),
      resolveSessionTranscriptFile: vi.fn(async () => transcriptPath),
    } as unknown as LcmDependencies;
    const fixture = createCommandFixture({
      deps,
      getLcm: async () => ({
        rotateSessionStorageWithBackup,
      }),
    });
    tempDirs.add(fixture.tempDir);
    dbPaths.add(fixture.dbPath);

    const currentConversation = await fixture.conversationStore.createConversation({
      sessionId: "rotate-session",
      sessionKey: "agent:main:main",
    });
    currentConversationId = currentConversation.conversationId;
    mockedBackupPath = join(fixture.tempDir, "lcm.db.rotate-latest.bak");
    writeFileSync(mockedBackupPath, "backup");
    await fixture.conversationStore.createMessagesBulk([
      {
        conversationId: currentConversation.conversationId,
        seq: 0,
        role: "user",
        content: "first message",
        tokenCount: 2,
      },
    ]);

    const result = await fixture.command.handler(
      createCommandContext("rotate", {
        sessionId: "rotate-session",
        sessionKey: "agent:main:main",
      }),
    );

    const backupPath = result.text.match(/backup path: (.+)/)?.[1]?.trim();

    expect(result.text).toContain("🪓 Lossless Claw Rotate");
    expect(result.text).toContain("status: replaced latest");
    expect(result.text).toContain("status: rotated");
    expect(result.text).toContain("preserved tail messages: 8");
    expect(result.text).toContain("bytes removed: 4,567");
    expect(result.text).toContain("mode: preserved current conversation and rotated transcript tail");
    expect(backupPath).toBeTruthy();
    expect(backupPath?.endsWith(".rotate-latest.bak")).toBe(true);
    expect(existsSync(backupPath!)).toBe(true);

    const second = await fixture.command.handler(
      createCommandContext("rotate", {
        sessionId: "rotate-session",
        sessionKey: "agent:main:main",
      }),
    );
    const secondBackupPath = second.text.match(/backup path: (.+)/)?.[1]?.trim();
    expect(secondBackupPath).toBe(backupPath);
    expect(existsSync(secondBackupPath!)).toBe(true);

    expect(rotateSessionStorageWithBackup).toHaveBeenCalledWith({
      sessionId: "rotate-session",
      sessionKey: "agent:main:main",
      sessionFile: transcriptPath,
      lockTimeoutMs: 30_000,
    });
  });

  it("renders engine-reported rotate stats after waiting for other DB work", async () => {
    const transcriptPath = join(tmpdir(), `lossless-claw-rotate-backup-fail-${Date.now()}.jsonl`);
    writeFileSync(transcriptPath, "{\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"existing\"}]}}\n");
    tempDirs.add(transcriptPath);

    let currentConversationId = 0;
    let mockedBackupPath = "";
    const rotateSessionStorageWithBackup = vi.fn(async () => ({
      kind: "rotated" as const,
      currentConversationId,
      currentMessageCount: 2,
      backupPath: mockedBackupPath,
      preservedTailMessageCount: 6,
      checkpointSize: 1234,
      bytesRemoved: 789,
    }));
    const deps = {
      resolveSessionIdFromSessionKey: vi.fn(async () => undefined),
      resolveSessionTranscriptFile: vi.fn(async () => transcriptPath),
    } as unknown as LcmDependencies;
    const fixture = createCommandFixture({
      deps,
      getLcm: async () => ({
        rotateSessionStorageWithBackup,
      }),
    });
    tempDirs.add(fixture.tempDir);
    dbPaths.add(fixture.dbPath);

    const currentConversation = await fixture.conversationStore.createConversation({
      sessionId: "rotate-backup-failure-session",
      sessionKey: "agent:main:main",
    });
    currentConversationId = currentConversation.conversationId;
    mockedBackupPath = join(fixture.tempDir, "lcm.db.rotate-latest.bak");
    writeFileSync(mockedBackupPath, "backup");
    await fixture.conversationStore.createMessagesBulk([
      {
        conversationId: currentConversation.conversationId,
        seq: 0,
        role: "user",
        content: "first message",
        tokenCount: 2,
      },
    ]);
    const result = await fixture.command.handler(
      createCommandContext("rotate", {
        sessionId: "rotate-backup-failure-session",
        sessionKey: "agent:main:main",
      }),
    );

    expect(result.text).toContain("🪓 Lossless Claw Rotate");
    expect(result.text).toContain("messages: 2");
    expect(result.text).toContain("status: replaced latest");
    expect(result.text).toContain("status: rotated");
    expect(result.text).toContain("preserved tail messages: 6");
    expect(rotateSessionStorageWithBackup).toHaveBeenCalledWith({
      sessionId: "rotate-backup-failure-session",
      sessionKey: "agent:main:main",
      sessionFile: transcriptPath,
      lockTimeoutMs: 30_000,
    });
  });

  it("resolves the runtime session id from the session key when rotate lacks ctx.sessionId", async () => {
    const transcriptPath = join(tmpdir(), `lossless-claw-rotate-runtime-session-id-${Date.now()}.jsonl`);
    writeFileSync(transcriptPath, "{\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"existing\"}]}}\n");
    tempDirs.add(transcriptPath);

    let currentConversationId = 0;
    let mockedBackupPath = "";
    const resolveSessionIdFromSessionKey = vi.fn(async () => "runtime-session-id");
    const resolveSessionTranscriptFile = vi.fn(async () => transcriptPath);
    const rotateSessionStorageWithBackup = vi.fn(async () => ({
      kind: "rotated" as const,
      currentConversationId,
      currentMessageCount: 1,
      backupPath: mockedBackupPath,
      preservedTailMessageCount: 8,
      checkpointSize: 1234,
      bytesRemoved: 4567,
    }));
    const deps = {
      resolveSessionIdFromSessionKey,
      resolveSessionTranscriptFile,
    } as unknown as LcmDependencies;
    const fixture = createCommandFixture({
      deps,
      getLcm: async () => ({
        rotateSessionStorageWithBackup,
      }),
    });
    tempDirs.add(fixture.tempDir);
    dbPaths.add(fixture.dbPath);

    const currentConversation = await fixture.conversationStore.createConversation({
      sessionId: "stored-session-id",
      sessionKey: "agent:main:main",
    });
    currentConversationId = currentConversation.conversationId;
    mockedBackupPath = join(fixture.tempDir, "lcm.db.rotate-latest.bak");
    writeFileSync(mockedBackupPath, "backup");
    await fixture.conversationStore.createMessagesBulk([
      {
        conversationId: currentConversation.conversationId,
        seq: 0,
        role: "user",
        content: "first message",
        tokenCount: 2,
      },
    ]);

    const result = await fixture.command.handler(
      createCommandContext("rotate", {
        sessionKey: "agent:main:main",
      }),
    );

    expect(result.text).toContain("status: rotated");
    expect(resolveSessionIdFromSessionKey).toHaveBeenCalledWith("agent:main:main");
    expect(resolveSessionTranscriptFile).toHaveBeenCalledWith({
      sessionId: "runtime-session-id",
      sessionKey: "agent:main:main",
    });
    expect(rotateSessionStorageWithBackup).toHaveBeenCalledWith({
      sessionId: "runtime-session-id",
      sessionKey: "agent:main:main",
      sessionFile: transcriptPath,
      lockTimeoutMs: 30_000,
    });
  });

  it("falls back to the stored conversation session id when runtime rotate resolution is unavailable", async () => {
    const transcriptPath = join(tmpdir(), `lossless-claw-rotate-stored-session-id-${Date.now()}.jsonl`);
    writeFileSync(transcriptPath, "{\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"existing\"}]}}\n");
    tempDirs.add(transcriptPath);

    let currentConversationId = 0;
    let mockedBackupPath = "";
    const resolveSessionIdFromSessionKey = vi.fn(async () => undefined);
    const resolveSessionTranscriptFile = vi.fn(async () => transcriptPath);
    const rotateSessionStorageWithBackup = vi.fn(async () => ({
      kind: "rotated" as const,
      currentConversationId,
      currentMessageCount: 1,
      backupPath: mockedBackupPath,
      preservedTailMessageCount: 8,
      checkpointSize: 1234,
      bytesRemoved: 4567,
    }));
    const deps = {
      resolveSessionIdFromSessionKey,
      resolveSessionTranscriptFile,
    } as unknown as LcmDependencies;
    const fixture = createCommandFixture({
      deps,
      getLcm: async () => ({
        rotateSessionStorageWithBackup,
      }),
    });
    tempDirs.add(fixture.tempDir);
    dbPaths.add(fixture.dbPath);

    const currentConversation = await fixture.conversationStore.createConversation({
      sessionId: "stored-session-id",
      sessionKey: "agent:main:main",
    });
    currentConversationId = currentConversation.conversationId;
    mockedBackupPath = join(fixture.tempDir, "lcm.db.rotate-latest.bak");
    writeFileSync(mockedBackupPath, "backup");
    await fixture.conversationStore.createMessagesBulk([
      {
        conversationId: currentConversation.conversationId,
        seq: 0,
        role: "user",
        content: "first message",
        tokenCount: 2,
      },
    ]);

    const result = await fixture.command.handler(
      createCommandContext("rotate", {
        sessionKey: "agent:main:main",
      }),
    );

    expect(result.text).toContain("status: rotated");
    expect(resolveSessionIdFromSessionKey).toHaveBeenCalledWith("agent:main:main");
    expect(resolveSessionTranscriptFile).toHaveBeenCalledWith({
      sessionId: "stored-session-id",
      sessionKey: "agent:main:main",
    });
    expect(rotateSessionStorageWithBackup).toHaveBeenCalledWith({
      sessionId: "stored-session-id",
      sessionKey: "agent:main:main",
      sessionFile: transcriptPath,
      lockTimeoutMs: 30_000,
    });
  });

  it("reports rotate as unavailable when no session id can be resolved for the live transcript", async () => {
    const resolveSessionIdFromSessionKey = vi.fn(async () => undefined);
    const resolveSessionTranscriptFile = vi.fn(async () => undefined);
    const rotateSessionStorageWithBackup = vi.fn(async () => ({
      kind: "rotated" as const,
      currentConversationId: 0,
      currentMessageCount: 0,
      backupPath: "unused",
      preservedTailMessageCount: 0,
      checkpointSize: 0,
      bytesRemoved: 0,
    }));
    const deps = {
      resolveSessionIdFromSessionKey,
      resolveSessionTranscriptFile,
    } as unknown as LcmDependencies;
    const fixture = createCommandFixture({
      deps,
      getLcm: async () => ({
        rotateSessionStorageWithBackup,
      }),
    });
    tempDirs.add(fixture.tempDir);
    dbPaths.add(fixture.dbPath);

    await fixture.conversationStore.createConversation({
      sessionId: "",
      sessionKey: "agent:main:main",
    });

    const result = await fixture.command.handler(
      createCommandContext("rotate", {
        sessionKey: "agent:main:main",
      }),
    );

    expect(result.text).toContain("🪓 Lossless Claw Rotate");
    expect(result.text).toContain("status: unavailable");
    expect(result.text).toContain("did not expose or resolve a runtime session id");
    expect(resolveSessionIdFromSessionKey).toHaveBeenCalledWith("agent:main:main");
    expect(resolveSessionTranscriptFile).not.toHaveBeenCalled();
    expect(rotateSessionStorageWithBackup).not.toHaveBeenCalled();
  });

  it("reports rotate failure when the engine reports a backup failure", async () => {
    const transcriptPath = join(tmpdir(), `lossless-claw-rotate-backup-fail-${Date.now()}.jsonl`);
    writeFileSync(transcriptPath, "{\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"existing\"}]}}\n");
    tempDirs.add(transcriptPath);

    let currentConversationId = 0;
    const rotateSessionStorageWithBackup = vi.fn(async () => ({
      kind: "backup_failed" as const,
      currentConversationId,
      currentMessageCount: 1,
      reason: "SQLITE_BUSY",
    }));
    const deps = {
      resolveSessionIdFromSessionKey: vi.fn(async () => undefined),
      resolveSessionTranscriptFile: vi.fn(async () => transcriptPath),
    } as unknown as LcmDependencies;
    const fixture = createCommandFixture({
      deps,
      getLcm: async () => ({
        rotateSessionStorageWithBackup,
      }),
    });
    tempDirs.add(fixture.tempDir);
    dbPaths.add(fixture.dbPath);

    const currentConversation = await fixture.conversationStore.createConversation({
      sessionId: "rotate-backup-failure-session",
      sessionKey: "agent:main:main",
    });
    currentConversationId = currentConversation.conversationId;
    await fixture.conversationStore.createMessagesBulk([
      {
        conversationId: currentConversation.conversationId,
        seq: 0,
        role: "user",
        content: "first message",
        tokenCount: 2,
      },
    ]);

    const result = await fixture.command.handler(
      createCommandContext("rotate", {
        sessionId: "rotate-backup-failure-session",
        sessionKey: "agent:main:main",
      }),
    );

    expect(result.text).toContain("🪓 Lossless Claw Rotate");
    expect(result.text).toContain("status: failed");
    expect(result.text).toContain("reason: SQLITE_BUSY");
    expect(rotateSessionStorageWithBackup).toHaveBeenCalled();
  });

  it("reports rotate failure after the engine already created a backup", async () => {
    const transcriptPath = join(tmpdir(), `lossless-claw-rotate-engine-fail-${Date.now()}.jsonl`);
    writeFileSync(transcriptPath, "{\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"existing\"}]}}\n");
    tempDirs.add(transcriptPath);

    let currentConversationId = 0;
    let mockedBackupPath = "";
    const rotateSessionStorageWithBackup = vi.fn(async () => ({
      kind: "rotate_failed" as const,
      currentConversationId,
      currentMessageCount: 1,
      backupPath: mockedBackupPath,
      reason: "rotate exploded",
    }));
    const deps = {
      resolveSessionIdFromSessionKey: vi.fn(async () => undefined),
      resolveSessionTranscriptFile: vi.fn(async () => transcriptPath),
    } as unknown as LcmDependencies;
    const fixture = createCommandFixture({
      deps,
      getLcm: async () => ({
        rotateSessionStorageWithBackup,
      }),
    });
    tempDirs.add(fixture.tempDir);
    dbPaths.add(fixture.dbPath);

    const currentConversation = await fixture.conversationStore.createConversation({
      sessionId: "rotate-engine-failure-session",
      sessionKey: "agent:main:main",
    });
    currentConversationId = currentConversation.conversationId;
    mockedBackupPath = join(fixture.tempDir, "lcm.db.rotate-latest.bak");
    writeFileSync(mockedBackupPath, "backup");
    await fixture.conversationStore.createMessagesBulk([
      {
        conversationId: currentConversation.conversationId,
        seq: 0,
        role: "user",
        content: "first message",
        tokenCount: 2,
      },
    ]);

    const result = await fixture.command.handler(
      createCommandContext("rotate", {
        sessionId: "rotate-engine-failure-session",
        sessionKey: "agent:main:main",
      }),
    );

    expect(result.text).toContain("🪓 Lossless Claw Rotate");
    expect(result.text).toContain("status: replaced latest");
    expect(result.text).toContain("status: failed");
    expect(result.text).toContain("reason: rotate exploded");
    expect(result.text).toContain("backup path:");
  });

  it("reports rotate as unavailable when OpenClaw does not expose a session key", async () => {
    const fixture = createCommandFixture();
    tempDirs.add(fixture.tempDir);
    dbPaths.add(fixture.dbPath);

    const result = await fixture.command.handler(
      createCommandContext("rotate", {
        sessionId: "rotate-missing-session-key",
      }),
    );

    expect(result.text).toContain("🪓 Lossless Claw Rotate");
    expect(result.text).toContain("status: unavailable");
    expect(result.text).toContain("OpenClaw must expose the active session key");
  });

  it("prefers the active conversation when multiple rows share the same session key", async () => {
    const fixture = createCommandFixture();
    tempDirs.add(fixture.tempDir);
    dbPaths.add(fixture.dbPath);

    const archived = await fixture.conversationStore.createConversation({
      sessionId: "shared-key-old",
      sessionKey: "agent:main:main",
    });
    await fixture.conversationStore.archiveConversation(archived.conversationId);
    const active = await fixture.conversationStore.createConversation({
      sessionId: "shared-key-new",
      sessionKey: "agent:main:main",
    });

    const result = await fixture.command.handler(
      createCommandContext("status", {
        sessionKey: "agent:main:main",
      }),
    );

    expect(result.text).toContain(`conversation id: ${active.conversationId}`);
    expect(result.text).not.toContain(`conversation id: ${archived.conversationId}`);
  });

  it("prefers the active conversation when session_id fallback rows share the same timestamp", async () => {
    const fixture = createCommandFixture();
    tempDirs.add(fixture.tempDir);
    dbPaths.add(fixture.dbPath);

    const archived = await fixture.conversationStore.createConversation({
      sessionId: "shared-session-id",
      sessionKey: "agent:main:archived",
    });
    await fixture.conversationStore.archiveConversation(archived.conversationId);
    const active = await fixture.conversationStore.createConversation({
      sessionId: "shared-session-id",
      sessionKey: "agent:main:active",
    });

    const tiedTimestamp = "2026-04-11 22:57:00";
    fixture.db
      .prepare(`UPDATE conversations SET created_at = ? WHERE conversation_id IN (?, ?)`)
      .run(tiedTimestamp, archived.conversationId, active.conversationId);

    const result = await fixture.command.handler(
      createCommandContext("status", {
        sessionId: "shared-session-id",
      }),
    );

    expect(result.text).toContain(`conversation id: ${active.conversationId}`);
    expect(result.text).not.toContain(`conversation id: ${archived.conversationId}`);
  });

  it("falls back to help text for unsupported subcommands", async () => {
    const fixture = createCommandFixture();
    tempDirs.add(fixture.tempDir);
    dbPaths.add(fixture.dbPath);

    const result = await fixture.command.handler(createCommandContext("rewrite"));
    expect(result.text).toContain("⚠️ Unknown subcommand `rewrite`.");
    expect(result.text).toContain("`/lossless backup`");
    expect(result.text).toContain("`/lossless rotate`");
    expect(result.text).toContain("`/lossless help`");
    expect(result.text).toContain("`/lcm` is accepted as a shorter alias.");
  });

  it("accepts db as a lazy function and does not invoke it for help", async () => {
    const dbFn = vi.fn((): never => {
      throw new Error("should not be called for help");
    });
    const config = resolveLcmConfig({}, { dbPath: "/tmp/unused.db" });
    const command = createLcmCommand({ db: dbFn, config });

    const result = await command.handler(createCommandContext("help"));
    expect(result.text).toContain("/lossless");
    expect(dbFn).not.toHaveBeenCalled();
  });

  it("invokes the lazy db function for status subcommand", async () => {
    const fixture = createCommandFixture();
    tempDirs.add(fixture.tempDir);
    dbPaths.add(fixture.dbPath);

    const db = createLcmDatabaseConnection(fixture.dbPath);
    const config = resolveLcmConfig({}, { dbPath: fixture.dbPath });
    const dbFn = vi.fn(() => db);
    const command = createLcmCommand({ db: dbFn, config });

    const result = await command.handler(createCommandContext());
    expect(dbFn).toHaveBeenCalled();
    expect(result.text).toContain("**🦀 Lossless Claw");
  });

  it("awaits an async lazy db function for status subcommand", async () => {
    const fixture = createCommandFixture();
    tempDirs.add(fixture.tempDir);
    dbPaths.add(fixture.dbPath);

    const db = createLcmDatabaseConnection(fixture.dbPath);
    const config = resolveLcmConfig({}, { dbPath: fixture.dbPath });
    const dbFn = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      return db;
    });
    const command = createLcmCommand({ db: dbFn, config });

    const result = await command.handler(createCommandContext());
    expect(dbFn).toHaveBeenCalled();
    expect(result.text).toContain("**🦀 Lossless Claw");
  });

  it("registers a Telegram native progress placeholder", () => {
    const config = resolveLcmConfig({}, { dbPath: "/tmp/unused.db" });
    const command = createLcmCommand({ db: vi.fn(), config });

    expect(command.nativeProgressMessages).toEqual({
      telegram: "Lossless Claw is working...",
    });
  });
});

describe("lcm command helpers", () => {
  it("parses focus command forms without flag syntax", () => {
    expect(__testing.parseLcmCommand("focus alpha auth review")).toEqual({
      kind: "focus_generate",
      prompt: "alpha auth review",
    });
    expect(__testing.parseLcmCommand("focus")).toEqual({ kind: "focus_status" });
    expect(__testing.parseLcmCommand("refocus")).toEqual({ kind: "refocus" });
    expect(__testing.parseLcmCommand("unfocus")).toEqual({ kind: "unfocus" });
  });

  it("treats only the canonical engine id and empty slot state as selected", () => {
    expect(__testing.resolvePluginSelected({})).toBe(true);
    expect(
      __testing.resolvePluginSelected({
        plugins: {
          slots: {
            contextEngine: "default",
          },
        },
      }),
    ).toBe(false);
    expect(
      __testing.resolvePluginSelected({
        plugins: {
          slots: {
            contextEngine: "legacy",
          },
        },
      }),
    ).toBe(false);
  });
});
