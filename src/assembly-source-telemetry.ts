export type AssemblySourceTelemetryLabel = "raw_only" | "dag_summary" | "focus_brief";

type AssemblySourceTelemetryCounters = Record<AssemblySourceTelemetryLabel, number>;

export type AssemblySourceTelemetrySnapshot = {
  conversationId: number;
  lastSelectedSource: AssemblySourceTelemetryLabel;
  lastReason: string | null;
  counters: AssemblySourceTelemetryCounters;
  skippedReasons: Partial<Record<string, number>>;
};

export type AssemblySourceTelemetrySelection = {
  selectedSource: AssemblySourceTelemetryLabel;
  reason?: string;
};

export function selectAssemblySourceTelemetryLabel(params: {
  hasSummaryItems: boolean;
  hasActiveFocus: boolean;
}): AssemblySourceTelemetrySelection {
  if (params.hasActiveFocus) {
    return { selectedSource: "focus_brief" };
  }
  if (params.hasSummaryItems) {
    return { selectedSource: "dag_summary" };
  }
  return { selectedSource: "raw_only", reason: "no_summaries" };
}

class AssemblySourceTelemetry {
  private readonly snapshots = new Map<number, AssemblySourceTelemetrySnapshot>();

  record(params: {
    conversationId: number;
    selectedSource: AssemblySourceTelemetryLabel;
    reason?: string | null;
    hasSummaries: boolean;
    hasActiveFocus: boolean;
  }): AssemblySourceTelemetrySnapshot {
    const current = this.snapshots.get(params.conversationId) ?? {
      conversationId: params.conversationId,
      lastSelectedSource: params.selectedSource,
      lastReason: null,
      counters: { raw_only: 0, dag_summary: 0, focus_brief: 0 },
      skippedReasons: {},
    };

    current.lastSelectedSource = params.selectedSource;
    current.lastReason = params.reason ?? null;
    current.counters[params.selectedSource] += 1;
    if (params.reason) {
      current.skippedReasons[params.reason] = (current.skippedReasons[params.reason] ?? 0) + 1;
    }
    this.snapshots.set(params.conversationId, current);
    return current;
  }

  get(conversationId: number): AssemblySourceTelemetrySnapshot | null {
    return this.snapshots.get(conversationId) ?? null;
  }

  reset(): void {
    this.snapshots.clear();
  }
}

export const assemblySourceTelemetry = new AssemblySourceTelemetry();
