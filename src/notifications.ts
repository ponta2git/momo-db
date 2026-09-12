import type { ResultNotificationKind } from "./schema.js";

export const DISCORD_NOTIFICATION_SCHEMA_VERSION = 1 as const;
export const DISCORD_NOTIFICATION_HASH_VERSION = "jsonb-numeric-sha256-v1" as const;

export function buildDiscordNotificationId(kind: ResultNotificationKind, sourceJobId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(sourceJobId)) {
    throw new Error("Invalid notification source job ID");
  }
  return `result:${kind}:${sourceJobId}`;
}

export interface NotificationContext {
  readonly gameTitleName: string | null;
  readonly heldDateIso: string | null;
  readonly matchNoInEvent: number | null;
}

export interface OcrCompletedData {
  readonly matchDraftId: string;
  readonly ocrDraftId: string;
  readonly imageId: string;
  readonly screenType: "total_assets" | "revenue" | "incident_log";
  readonly outcome: "succeeded" | "needs_review";
  readonly summary: string;
  readonly context: NotificationContext;
}

export interface AnalysisIdentity {
  // Stable even after the producing job/attempt is removed by history cleanup.
  readonly artifactId: string;
  // Decimal strings preserve PostgreSQL bigint precision across JSON consumers.
  readonly inputRevision: string;
  readonly algorithmVersion: string;
  readonly artifactSchemaVersion: number;
  readonly validationContractId: string | null;
}

export interface RankSample {
  readonly matchCount: number;
  readonly averageRank: number | null;
}

export interface RankComparison {
  readonly memberId: string;
  readonly displayName: string;
  readonly before: RankSample | null;
  readonly after: RankSample;
  // Keep the unrounded value; renderers must distinguish a small change from zero.
  readonly delta: number | null;
  readonly comparison: "comparable" | "initial" | "empty" | "incomparable" | "reused";
}

export type Four<T> = readonly [T, T, T, T];

export interface AnalysisMatchPlayer {
  readonly memberId: string;
  readonly displayName: string;
  readonly rank: 1 | 2 | 3 | 4;
  readonly ginjiCount: number;
}

export interface AnalysisNotificationMatch {
  readonly matchId: string;
  readonly sourceRevision: string;
  readonly heldEventId: string;
  readonly heldDateIso: string;
  readonly matchNoInEvent: number;
  readonly playedAt: string;
  readonly mapName: string;
  readonly seasonId: string;
  readonly seasonName: string;
  readonly ownerName: string;
  readonly players: Four<AnalysisMatchPlayer>;
  readonly ginjiTotal: number;
  readonly note: string | null;
}

export interface AnalysisCompletedData {
  readonly gameTitleId: string;
  readonly gameTitleName: string;
  readonly disposition: "published" | "reused";
  readonly previousAnalysis: AnalysisIdentity | null;
  readonly currentAnalysis: AnalysisIdentity;
  // Only added/changed matches represented by this publication, never a live query.
  readonly matches: readonly AnalysisNotificationMatch[];
  readonly overall: Four<RankComparison>;
  // Affected old/new seasons; all current seasons only when the match set is unchanged.
  readonly seasons: readonly {
    readonly seasonId: string;
    readonly seasonName: string;
    readonly ranks: Four<RankComparison>;
  }[];
}

interface NotificationEnvelope<K extends ResultNotificationKind, D> {
  readonly notificationId: string;
  readonly kind: K;
  readonly schemaVersion: typeof DISCORD_NOTIFICATION_SCHEMA_VERSION;
  readonly sourceJobId: string;
  // RFC3339 UTC with milliseconds, e.g. YYYY-MM-DDTHH:mm:ss.sssZ.
  readonly occurredAt: string;
  readonly settingsGeneration: string;
  readonly data: D;
}

export type OcrCompletedNotification = NotificationEnvelope<"ocr_completed", OcrCompletedData>;
export type AnalysisCompletedNotification = NotificationEnvelope<"analysis_completed", AnalysisCompletedData>;
export type DiscordResultNotification = OcrCompletedNotification | AnalysisCompletedNotification;

export interface DiscordNotificationReceipt {
  readonly notificationId: string;
  readonly disposition: "accepted" | "duplicate" | "cancelled";
  readonly status: "PENDING" | "IN_FLIGHT" | "DELIVERED" | "FAILED" | "CANCELLED";
}
