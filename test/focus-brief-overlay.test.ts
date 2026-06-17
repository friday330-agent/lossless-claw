import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { ContextAssembler } from "../src/assembler.js";
import { runLcmMigrations } from "../src/db/migration.js";
import { ConversationStore } from "../src/store/conversation-store.js";
import { FocusBriefStore } from "../src/store/focus-brief-store.js";
import { SummaryStore } from "../src/store/summary-store.js";

function createTestDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  runLcmMigrations(db, { fts5Available: false });
  return db;
}

describe("focus brief assembly overlay", () => {
  const dbs = new Set<DatabaseSync>();

  afterEach(() => {
    for (const db of dbs) {
      db.close();
    }
    dbs.clear();
  });

  it("replaces covered summaries with the active focus brief and preserves post-focus context", async () => {
    const db = createTestDb();
    dbs.add(db);
    const conversationStore = new ConversationStore(db, { fts5Available: false });
    const summaryStore = new SummaryStore(db, { fts5Available: false });
    const focusStore = new FocusBriefStore(db);
    const assembler = new ContextAssembler(conversationStore, summaryStore, "UTC", focusStore);

    const conversation = await conversationStore.createConversation({
      sessionId: "focus-overlay-session",
      sessionKey: "agent:main:telegram:direct:focus-overlay",
    });
    const [firstMessage, secondMessage] = await conversationStore.createMessagesBulk([
      {
        conversationId: conversation.conversationId,
        seq: 0,
        role: "user",
        content: "Covered implementation plan.",
        tokenCount: 5,
      },
      {
        conversationId: conversation.conversationId,
        seq: 1,
        role: "assistant",
        content: "Covered review notes.",
        tokenCount: 5,
      },
    ]);
    await summaryStore.insertSummary({
      summaryId: "covered_summary",
      conversationId: conversation.conversationId,
      kind: "leaf",
      depth: 0,
      content: "Covered summary content that should be masked.",
      tokenCount: 8,
      latestAt: new Date("2026-01-01T00:00:00.000Z"),
      sourceMessageTokenCount: 10,
    });
    await summaryStore.linkSummaryToMessages("covered_summary", [
      firstMessage.messageId,
      secondMessage.messageId,
    ]);
    await summaryStore.replaceContextRangeWithSummary({
      conversationId: conversation.conversationId,
      startOrdinal: 0,
      endOrdinal: 1,
      summaryId: "covered_summary",
    });
    const watermark = await focusStore.getCoveredWatermark(conversation.conversationId);

    const [postFocusRaw, postFocusSummarized] = await conversationStore.createMessagesBulk([
      {
        conversationId: conversation.conversationId,
        seq: 2,
        role: "user",
        content: "Post-focus raw update that must stay visible.",
        tokenCount: 7,
      },
      {
        conversationId: conversation.conversationId,
        seq: 3,
        role: "assistant",
        content: "Post-focus summarized update.",
        tokenCount: 6,
      },
    ]);
    await summaryStore.appendContextMessage(conversation.conversationId, postFocusRaw.messageId);
    await summaryStore.appendContextMessage(conversation.conversationId, postFocusSummarized.messageId);
    await summaryStore.insertSummary({
      summaryId: "post_focus_summary",
      conversationId: conversation.conversationId,
      kind: "leaf",
      depth: 0,
      content: "Post-focus summary content that must stay visible.",
      tokenCount: 8,
      latestAt: new Date("2026-01-02T00:00:00.000Z"),
      sourceMessageTokenCount: 6,
    });
    await summaryStore.linkSummaryToMessages("post_focus_summary", [
      postFocusSummarized.messageId,
    ]);
    await summaryStore.replaceContextRangeWithSummary({
      conversationId: conversation.conversationId,
      startOrdinal: 2,
      endOrdinal: 2,
      summaryId: "post_focus_summary",
    });

    const brief = await focusStore.createFocusBrief({
      conversationId: conversation.conversationId,
      prompt: "focus overlay",
      content: "Focused context brief content.",
      status: "active",
      tokenCount: 5,
      targetTokens: 12,
      coveredLatestAt: watermark.coveredLatestAt,
      coveredMessageSeq: watermark.coveredMessageSeq,
      sourceContextHash: "overlay-test",
      sources: [{ summaryId: "covered_summary", ordinal: 0, role: "active_input" }],
      supersedeCurrentDrafts: true,
    });

    const result = await assembler.assemble({
      conversationId: conversation.conversationId,
      tokenBudget: 10_000,
      freshTailCount: 8,
    });
    const joined = result.messages
      .map((message) =>
        typeof message.content === "string" ? message.content : JSON.stringify(message.content),
      )
      .join("\n");

    expect(joined).toContain(`<focus_brief id="${brief.briefId}"`);
    expect(joined).toContain("Focused context brief content.");
    expect(joined).not.toContain("Covered summary content that should be masked.");
    expect(joined).toContain("Post-focus raw update that must stay visible.");
    expect(joined).toContain("Post-focus summary content that must stay visible.");
    expect(db
      .prepare(`SELECT item_type, message_id, summary_id FROM context_items WHERE conversation_id = ? ORDER BY ordinal`)
      .all(conversation.conversationId)).toEqual([
      { item_type: "summary", message_id: null, summary_id: "covered_summary" },
      { item_type: "message", message_id: postFocusRaw.messageId, summary_id: null },
      { item_type: "summary", message_id: null, summary_id: "post_focus_summary" },
    ]);
  });

  it("masks reshaped covered summaries by watermark instead of source id", async () => {
    const db = createTestDb();
    dbs.add(db);
    const conversationStore = new ConversationStore(db, { fts5Available: false });
    const summaryStore = new SummaryStore(db, { fts5Available: false });
    const focusStore = new FocusBriefStore(db);
    const assembler = new ContextAssembler(conversationStore, summaryStore, "UTC", focusStore);

    const conversation = await conversationStore.createConversation({
      sessionId: "focus-overlay-reshape-session",
    });
    const [sourceMessage] = await conversationStore.createMessagesBulk([
      {
        conversationId: conversation.conversationId,
        seq: 0,
        role: "user",
        content: "Original covered source.",
        tokenCount: 5,
      },
    ]);
    await summaryStore.insertSummary({
      summaryId: "reshaped_covered_summary",
      conversationId: conversation.conversationId,
      kind: "leaf",
      depth: 0,
      content: "Reshaped covered summary content that should be masked.",
      tokenCount: 8,
      latestAt: new Date("2026-02-01T00:00:00.000Z"),
      sourceMessageTokenCount: 5,
    });
    await summaryStore.linkSummaryToMessages("reshaped_covered_summary", [sourceMessage.messageId]);
    await summaryStore.replaceContextRangeWithSummary({
      conversationId: conversation.conversationId,
      startOrdinal: 0,
      endOrdinal: 0,
      summaryId: "reshaped_covered_summary",
    });

    await focusStore.createFocusBrief({
      conversationId: conversation.conversationId,
      prompt: "focus after reshape",
      content: "Focus brief survives DAG reshaping.",
      status: "active",
      tokenCount: 6,
      targetTokens: 12,
      coveredLatestAt: "2026-02-01T00:00:00.000Z",
      coveredMessageSeq: 0,
      sourceContextHash: "reshape-test",
      sources: [{ summaryId: "original_masked_summary", ordinal: 0, role: "active_input" }],
      supersedeCurrentDrafts: true,
    });

    const result = await assembler.assemble({
      conversationId: conversation.conversationId,
      tokenBudget: 10_000,
      freshTailCount: 8,
    });
    const joined = result.messages
      .map((message) =>
        typeof message.content === "string" ? message.content : JSON.stringify(message.content),
      )
      .join("\n");

    expect(joined).toContain("Focus brief survives DAG reshaping.");
    expect(joined).not.toContain("Reshaped covered summary content that should be masked.");
  });

  it("masks covered condensed summaries without direct message links", async () => {
    const db = createTestDb();
    dbs.add(db);
    const conversationStore = new ConversationStore(db, { fts5Available: false });
    const summaryStore = new SummaryStore(db, { fts5Available: false });
    const focusStore = new FocusBriefStore(db);
    const assembler = new ContextAssembler(conversationStore, summaryStore, "UTC", focusStore);

    const conversation = await conversationStore.createConversation({
      sessionId: "focus-overlay-condensed-session",
    });
    const [sourceMessage] = await conversationStore.createMessagesBulk([
      {
        conversationId: conversation.conversationId,
        seq: 0,
        role: "user",
        content: "Covered source inside condensed summary.",
        tokenCount: 5,
      },
    ]);
    await summaryStore.insertSummary({
      summaryId: "condensed_leaf_summary",
      conversationId: conversation.conversationId,
      kind: "leaf",
      depth: 0,
      content: "Leaf summary content.",
      tokenCount: 5,
      latestAt: new Date("2026-03-01T00:00:00.000Z"),
      sourceMessageTokenCount: 5,
    });
    await summaryStore.linkSummaryToMessages("condensed_leaf_summary", [sourceMessage.messageId]);
    await summaryStore.insertSummary({
      summaryId: "covered_condensed_summary",
      conversationId: conversation.conversationId,
      kind: "condensed",
      depth: 1,
      content: "Condensed summary content that should be masked.",
      tokenCount: 8,
      sourceMessageTokenCount: 0,
    });
    await summaryStore.linkSummaryToParents("covered_condensed_summary", ["condensed_leaf_summary"]);
    await summaryStore.replaceContextRangeWithSummary({
      conversationId: conversation.conversationId,
      startOrdinal: 0,
      endOrdinal: 0,
      summaryId: "covered_condensed_summary",
    });
    const watermark = await focusStore.getCoveredWatermark(conversation.conversationId);

    await focusStore.createFocusBrief({
      conversationId: conversation.conversationId,
      prompt: "focus condensed summary",
      content: "Focus brief masks condensed summary.",
      status: "active",
      tokenCount: 6,
      targetTokens: 12,
      coveredLatestAt: watermark.coveredLatestAt,
      coveredMessageSeq: watermark.coveredMessageSeq,
      sourceContextHash: "condensed-test",
      sources: [{ summaryId: "covered_condensed_summary", ordinal: 0, role: "active_input" }],
      supersedeCurrentDrafts: true,
    });

    const result = await assembler.assemble({
      conversationId: conversation.conversationId,
      tokenBudget: 10_000,
      freshTailCount: 8,
    });
    const joined = result.messages.map((message) => String(message.content)).join("\n");

    expect(watermark.coveredMessageSeq).toBe(0);
    expect(joined).toContain("Focus brief masks condensed summary.");
    expect(joined).not.toContain("Condensed summary content that should be masked.");
  });
});

describe("session memory assembly overlay", () => {
  const dbs = new Set<DatabaseSync>();

  afterEach(() => {
    for (const db of dbs) {
      db.close();
    }
    dbs.clear();
  });

  it("records a disabled session-memory overlay skip without reading from lookup", async () => {
    const db = createTestDb();
    dbs.add(db);
    const conversationStore = new ConversationStore(db, { fts5Available: false });
    const summaryStore = new SummaryStore(db, { fts5Available: false });
    let lookupCalled = false;
    const assembler = new ContextAssembler(
      conversationStore,
      summaryStore,
      "UTC",
      undefined,
      {
        lookup: async () => {
          lookupCalled = true;
          return {
            ok: false,
            source: "session_memory_overlay",
            reason: "read_error",
          };
        },
      },
    );

    const conversation = await conversationStore.createConversation({
      sessionId: "session-memory-disabled-overlay-session",
      sessionKey: "agent:main:webchat:direct:session-memory-disabled-overlay",
    });
    const [firstMessage, secondMessage] = await conversationStore.createMessagesBulk([
      {
        conversationId: conversation.conversationId,
        seq: 0,
        role: "user",
        content: "Ordinary context item before the overlay seam.",
        tokenCount: 7,
      },
      {
        conversationId: conversation.conversationId,
        seq: 1,
        role: "assistant",
        content: "Ordinary context item after the overlay seam.",
        tokenCount: 7,
      },
    ]);
    await summaryStore.appendContextMessage(conversation.conversationId, firstMessage.messageId);
    await summaryStore.appendContextMessage(conversation.conversationId, secondMessage.messageId);

    const result = await assembler.assemble({
      conversationId: conversation.conversationId,
      tokenBudget: 10_000,
      freshTailCount: 8,
    });
    const joined = result.messages
      .map((message) =>
        typeof message.content === "string" ? message.content : JSON.stringify(message.content),
      )
      .join("\n");

    expect(lookupCalled).toBe(false);
    expect(joined).toContain("Ordinary context item before the overlay seam.");
    expect(joined).toContain("Ordinary context item after the overlay seam.");
    expect(joined).not.toContain("<session_memory");
    expect(result.debug?.sessionMemoryOverlay).toEqual({
      surface: "session_memory",
      state: "skipped",
      insertedCount: 0,
      skippedCount: 1,
      skippedReason: "disabled",
      renderedTokens: 0,
      entryCount: 0,
      segmentId: undefined,
      sourceRefsCount: 0,
      projectionKey: undefined,
      effectiveMode: "native",
      renderVersion: "session_memory_overlay_v1",
    });
  });

  it("inserts an enabled session-memory overlay after focus and before fresh tail", async () => {
    const db = createTestDb();
    dbs.add(db);
    const conversationStore = new ConversationStore(db, { fts5Available: false });
    const summaryStore = new SummaryStore(db, { fts5Available: false });
    const focusStore = new FocusBriefStore(db);
    const assembler = new ContextAssembler(
      conversationStore,
      summaryStore,
      "UTC",
      focusStore,
      {
        config: { enabled: true },
        lookup: async () => ({
          ok: true,
          source: "session_memory_overlay",
          sessionId: "session-memory-enabled-session",
          segmentId: "segment-active",
          projectionKey: "lookup-projection-key",
          entries: [
            {
              entryId: "entry-decision",
              segmentId: "segment-active",
              kind: "decision",
              priority: 90,
              body: "Session-memory overlay decision.",
              updatedAt: "2026-06-06T12:00:00.000Z",
              sourceRefs: [],
              bodyHash: "body-hash",
              version: 1,
            },
          ],
        }),
      },
    );

    const conversation = await conversationStore.createConversation({
      sessionId: "session-memory-enabled-session",
      sessionKey: "agent:main:webchat:direct:session-memory-enabled-overlay",
    });
    const [coveredMessage, freshMessage] = await conversationStore.createMessagesBulk([
      {
        conversationId: conversation.conversationId,
        seq: 0,
        role: "user",
        content: "Covered source message.",
        tokenCount: 5,
      },
      {
        conversationId: conversation.conversationId,
        seq: 1,
        role: "assistant",
        content: "Fresh tail message that must remain last.",
        tokenCount: 7,
      },
    ]);
    await summaryStore.insertSummary({
      summaryId: "session_memory_covered_summary",
      conversationId: conversation.conversationId,
      kind: "leaf",
      depth: 0,
      content: "Covered summary content that should be masked by focus.",
      tokenCount: 8,
      latestAt: new Date("2026-06-06T11:00:00.000Z"),
      sourceMessageTokenCount: 5,
    });
    await summaryStore.linkSummaryToMessages("session_memory_covered_summary", [
      coveredMessage.messageId,
    ]);
    await summaryStore.replaceContextRangeWithSummary({
      conversationId: conversation.conversationId,
      startOrdinal: 0,
      endOrdinal: 0,
      summaryId: "session_memory_covered_summary",
    });
    await summaryStore.appendContextMessage(conversation.conversationId, freshMessage.messageId);
    await focusStore.createFocusBrief({
      conversationId: conversation.conversationId,
      prompt: "focus before session memory",
      content: "Focus brief content before session memory.",
      status: "active",
      tokenCount: 6,
      targetTokens: 12,
      coveredLatestAt: "2026-06-06T11:00:00.000Z",
      coveredMessageSeq: 0,
      sourceContextHash: "session-memory-overlay-test",
      sources: [{ summaryId: "session_memory_covered_summary", ordinal: 0, role: "active_input" }],
      supersedeCurrentDrafts: true,
    });

    const result = await assembler.assemble({
      conversationId: conversation.conversationId,
      tokenBudget: 10_000,
      freshTailCount: 1,
    });
    const joined = result.messages
      .map((message) =>
        typeof message.content === "string" ? message.content : JSON.stringify(message.content),
      )
      .join("\n");

    const focusIndex = joined.indexOf("Focus brief content before session memory.");
    const sessionMemoryIndex = joined.indexOf("Session-memory overlay decision.");
    const freshTailIndex = joined.indexOf("Fresh tail message that must remain last.");
    expect(focusIndex).toBeGreaterThanOrEqual(0);
    expect(sessionMemoryIndex).toBeGreaterThan(focusIndex);
    expect(freshTailIndex).toBeGreaterThan(sessionMemoryIndex);
    expect(joined).not.toContain("Covered summary content that should be masked by focus.");
    expect(result.debug?.sessionMemoryOverlay).toMatchObject({
      surface: "session_memory",
      state: "inserted",
      insertedCount: 1,
      skippedCount: 0,
      entryCount: 1,
      segmentId: "segment-active",
      effectiveMode: "overlay-readonly",
      renderVersion: "session_memory_overlay_v1",
    });
  });
});
