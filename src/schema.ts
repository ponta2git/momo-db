// Public @momo/db and Drizzle entrypoint. Keep internal imports directed at
// the defining module so domain dependencies do not cycle through this facade.

export {
  LOGIN_ACCOUNT_ROLES,
  members,
  momoLoginAccounts,
  appSessions,
  idempotencyKeys
} from "./schema/identity.js";
export type { LoginAccountRole } from "./schema/identity.js";

export {
  SESSION_STATUSES,
  RESPONSE_CHOICES,
  sessions,
  responses,
  heldEvents,
  heldEventParticipants
} from "./schema/attendance.js";
export type { SessionStatus, ResponseChoice } from "./schema/attendance.js";

export {
  gameTitles,
  mapMasters,
  seasonMasters,
  incidentMasters,
  memberAliases
} from "./schema/catalog.js";

export {
  ocrDrafts,
  SOURCE_IMAGE_STATUSES,
  sourceImages,
  ocrJobs,
  OCR_SUBMISSION_STATUSES,
  ocrSubmissions,
  OCR_SUBMISSION_MEMBER_STATUSES,
  ocrSubmissionMembers
} from "./schema/ocr.js";
export type {
  SourceImageStatus,
  OcrSubmissionStatus,
  OcrSubmissionMemberStatus
} from "./schema/ocr.js";

export {
  OUTBOX_KINDS,
  OUTBOX_STATUSES,
  DISCORD_NOTIFICATION_FAMILIES,
  RESULT_NOTIFICATION_KINDS,
  discordNotifications,
  discordNotificationAttendance,
  discordNotificationSettings,
  discordNotificationResults,
  discordNotificationTargets,
  discordNotificationParts
} from "./schema/discord-notifications.js";
export type {
  OutboxKind,
  OutboxStatus,
  ResultNotificationKind
} from "./schema/discord-notifications.js";

export {
  MATCH_DRAFT_STATUSES,
  matchDrafts,
  matches,
  matchPlayers,
  matchIncidents
} from "./schema/matches.js";
export type { MatchDraftStatus } from "./schema/matches.js";

export {
  seriesRadarBases,
  seriesRadarCandidates,
  seriesRadarPreviews,
  seriesRadarPreviewScopes,
  seriesRadarOperations,
  seriesRadarRevisions,
  seriesRadarTitleStates,
  seriesRadarAcknowledgements
} from "./schema/radar.js";

export {
  seriesAnalysisReleaseState,
  seriesAnalysisTitleStates
} from "./schema/analysis/publication.js";

export {
  seriesAnalysisOperationRequests,
  seriesAnalysisCampaigns,
  seriesAnalysisCampaignTargets
} from "./schema/analysis/operations.js";

export {
  seriesAnalysisJobs,
  seriesAnalysisJobRequests,
  seriesAnalysisJobAttempts,
  seriesAnalysisWorkerCapabilities,
  seriesAnalysisReaderCapabilities,
  workerExecutionSlots
} from "./schema/analysis/jobs.js";

export {
  seriesAnalysisArtifacts,
  seriesAnalysisScopeAggregateArtifacts,
  seriesAnalysisOutlookSummaryArtifacts,
  seriesAnalysisOutlookReferenceArtifacts,
  seriesAnalysisScopeReviewArtifacts,
  seriesAnalysisDrilldownArtifacts,
  seriesAnalysisMatchContextArtifacts
} from "./schema/analysis/artifacts.js";
