import type { ConversationStore, MessageRecord } from "./store/conversation-store.js";
import type { SummaryRecord, SummaryStore } from "./store/summary-store.js";

/**
 * A compact, caller-facing description of the raw span covered by a summary.
 *
 * The span is intentionally expressed in terms of already-persisted message
 * ids, sequence numbers, timestamps, and token counts. It does not mutate the
 * database and it does not assume future schema fields exist.
 */
export type SummaryRawSpanDiagnostic = {
  messageCount: number;
  firstMessageId: number | null;
  lastMessageId: number | null;
  firstSeq: number | null;
  lastSeq: number | null;
  earliestAt: Date | null;
  latestAt: Date | null;
  tokenCount: number;
  missingMessageIds: number[];
};

/**
 * A small manifest for one summary node. This is the minimum information needed
 * to answer: "what raw span does this summary cover, what lower summaries does
 * it depend on, and what is the smallest safe rebuild boundary?"
 */
export type SummaryDiagnosticNode = {
  summaryId: string;
  kind: SummaryRecord["kind"];
  depth: number;
  tokenCount: number;
  descendantCount: number;
  descendantTokenCount: number;
  sourceMessageTokenCount: number;
  earliestAt: Date | null;
  latestAt: Date | null;
  parentSummaryIds: string[];
  childSummaryIds: string[];
  rawSpan: SummaryRawSpanDiagnostic;
  suspectedIssues: string[];
};

export type SummaryRebuildBoundary = {
  /** The smallest persisted node that should be recomputed first. */
  rebuildRootSummaryId: string;
  /** Raw message ids directly covered by the rebuild root. Empty for parent-only condensed nodes. */
  sourceMessageIds: number[];
  /** Summary ids that directly feed this root and may need re-read/replay. */
  parentSummaryIds: string[];
  /** Newer summaries that should be considered stale if the root changes. */
  dependentSummaryIds: string[];
  /** Human-readable explanation of why this is the smallest safe boundary. */
  reason: string;
};

export type SummaryDiagnosticReport = {
  found: boolean;
  summaryId: string;
  conversationId?: number;
  node?: SummaryDiagnosticNode;
  rebuildBoundary?: SummaryRebuildBoundary;
};

function sortMessagesBySeq(messages: MessageRecord[]): MessageRecord[] {
  return messages.slice().sort((left, right) => left.seq - right.seq || left.messageId - right.messageId);
}

function buildRawSpanDiagnostic(params: {
  messageIds: number[];
  messages: MessageRecord[];
}): SummaryRawSpanDiagnostic {
  const sortedMessages = sortMessagesBySeq(params.messages);
  const presentIds = new Set(sortedMessages.map((message) => message.messageId));
  const missingMessageIds = params.messageIds.filter((messageId) => !presentIds.has(messageId));
  const first = sortedMessages[0];
  const last = sortedMessages[sortedMessages.length - 1];

  return {
    messageCount: sortedMessages.length,
    firstMessageId: first?.messageId ?? null,
    lastMessageId: last?.messageId ?? null,
    firstSeq: first?.seq ?? null,
    lastSeq: last?.seq ?? null,
    earliestAt: first?.createdAt ?? null,
    latestAt: last?.createdAt ?? null,
    tokenCount: sortedMessages.reduce((total, message) => total + Math.max(0, message.tokenCount), 0),
    missingMessageIds,
  };
}

function collectSuspectedIssues(params: {
  summary: SummaryRecord;
  parentSummaryIds: string[];
  childSummaryIds: string[];
  rawSpan: SummaryRawSpanDiagnostic;
}): string[] {
  const issues: string[] = [];
  if (params.summary.kind === "leaf" && params.rawSpan.messageCount === 0) {
    issues.push("leaf_summary_has_no_source_messages");
  }
  if (params.summary.kind === "condensed" && params.parentSummaryIds.length === 0) {
    issues.push("condensed_summary_has_no_parent_summaries");
  }
  if (params.rawSpan.missingMessageIds.length > 0) {
    issues.push("summary_references_missing_messages");
  }
  if (params.summary.earliestAt === null || params.summary.latestAt === null) {
    issues.push("summary_missing_time_span_metadata");
  }
  if (
    params.summary.sourceMessageTokenCount > 0 &&
    params.rawSpan.tokenCount > 0 &&
    Math.abs(params.summary.sourceMessageTokenCount - params.rawSpan.tokenCount) > params.rawSpan.tokenCount
  ) {
    issues.push("summary_source_token_count_diverges_from_raw_span");
  }
  if (params.summary.kind === "condensed" && params.childSummaryIds.length === 0) {
    issues.push("condensed_summary_has_no_dependents");
  }
  return issues;
}

function explainRebuildBoundary(params: {
  summary: SummaryRecord;
  rawSpan: SummaryRawSpanDiagnostic;
  parentSummaryIds: string[];
  childSummaryIds: string[];
}): string {
  if (params.summary.kind === "leaf") {
    if (params.rawSpan.messageCount > 0) {
      return "Rebuild this leaf summary from its linked raw messages, then mark dependent summaries stale if the content changes.";
    }
    return "This leaf has no linked raw messages; rebuild is blocked until source message links are restored.";
  }
  if (params.parentSummaryIds.length > 0) {
    return "Rebuild this condensed summary from its direct parent summaries, then mark newer dependent summaries stale if the content changes.";
  }
  return "This condensed summary has no parent links; rebuild is blocked until parent summary links are restored.";
}

/**
 * Build a read-only diagnostic report for one persisted summary.
 *
 * This deliberately reuses the existing summary_messages and summary_parents
 * links instead of adding schema. That makes it a safe v1 diagnostic surface:
 * it exposes span, lineage, suspected issues, and rebuild boundary without DB
 * migration or live-data mutation.
 */
export async function describeSummaryDiagnostic(params: {
  summaryId: string;
  conversationStore: ConversationStore;
  summaryStore: SummaryStore;
}): Promise<SummaryDiagnosticReport> {
  const summaryId = params.summaryId.trim();
  const summary = await params.summaryStore.getSummary(summaryId);
  if (!summary) {
    return { found: false, summaryId };
  }

  const [messageIds, parents, children] = await Promise.all([
    params.summaryStore.getSummaryMessages(summaryId),
    params.summaryStore.getSummaryParents(summaryId),
    params.summaryStore.getSummaryChildren(summaryId),
  ]);
  const messages = await Promise.all(
    messageIds.map((messageId) => params.conversationStore.getMessageById(messageId)),
  );
  const presentMessages = messages.filter((message): message is MessageRecord => message !== null);
  const rawSpan = buildRawSpanDiagnostic({ messageIds, messages: presentMessages });
  const parentSummaryIds = parents.map((parent) => parent.summaryId);
  const childSummaryIds = children.map((child) => child.summaryId);
  const suspectedIssues = collectSuspectedIssues({
    summary,
    parentSummaryIds,
    childSummaryIds,
    rawSpan,
  });

  return {
    found: true,
    summaryId,
    conversationId: summary.conversationId,
    node: {
      summaryId,
      kind: summary.kind,
      depth: summary.depth,
      tokenCount: summary.tokenCount,
      descendantCount: summary.descendantCount,
      descendantTokenCount: summary.descendantTokenCount,
      sourceMessageTokenCount: summary.sourceMessageTokenCount,
      earliestAt: summary.earliestAt,
      latestAt: summary.latestAt,
      parentSummaryIds,
      childSummaryIds,
      rawSpan,
      suspectedIssues,
    },
    rebuildBoundary: {
      rebuildRootSummaryId: summaryId,
      sourceMessageIds: messageIds,
      parentSummaryIds,
      dependentSummaryIds: childSummaryIds,
      reason: explainRebuildBoundary({
        summary,
        rawSpan,
        parentSummaryIds,
        childSummaryIds,
      }),
    },
  };
}
