import { createHash } from 'node:crypto';

// Frozen migration/structured-allocation contract. Never use this as authorization or a generic lookup fallback.
export const namespace = 'deabc659-a5ca-4dc0-9711-eae0614fa478';
export const algorithm = 'sha256-uuidv8-v1';
export const entityNamespaces = Object.freeze([
  'members', 'member_aliases', 'momo_login_accounts', 'sessions', 'responses', 'held_events',
  'game_titles', 'map_masters', 'season_masters', 'incident_masters', 'matches', 'match_drafts',
  'source_images', 'ocr_jobs', 'ocr_drafts', 'ocr_submissions',
  'series_analysis_operation_requests', 'series_analysis_campaigns', 'series_analysis_job_requests',
  'series_analysis_jobs', 'series_analysis_job_attempts', 'series_analysis_artifacts',
  'series_radar_bases', 'series_radar_candidates', 'series_radar_operations', 'series_radar_previews',
]);
const entities = new Set(entityNamespaces);
const hex = '[0-9a-fA-F]{4}(?:-?[0-9a-fA-F]{4}){7}';
const acceptedUuid = new RegExp(`^(?:${hex}|\\{${hex}\\})(?![\\s\\S])`, 'u');

function formatUuid(bytes) {
  const value = bytes.toString('hex');
  return `${value.slice(0,8)}-${value.slice(8,12)}-${value.slice(12,16)}-${value.slice(16,20)}-${value.slice(20,32)}`;
}

export function canonicalUuid(value) {
  if (typeof value !== 'string' || !acceptedUuid.test(value)) return null;
  return formatUuid(Buffer.from(value.replace(/[{}-]/gu, ''), 'hex'));
}

export function nameBasedUuid8(namespaceUuid, nameBytes) {
  const canonicalNamespace = canonicalUuid(namespaceUuid);
  if (!canonicalNamespace) throw new Error('INVALID_NAMESPACE');
  const bytes = createHash('sha256')
    .update(Buffer.from(canonicalNamespace.replaceAll('-', ''), 'hex'))
    .update(nameBytes)
    .digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x80;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  return formatUuid(bytes);
}

export function canonicalIdentity(entity, legacyId) {
  if (!entities.has(entity)) throw new Error('UNKNOWN_ENTITY_NAMESPACE');
  if (typeof legacyId !== 'string' || !legacyId.isWellFormed() || legacyId.includes('\0')) throw new Error('INVALID_LEGACY_ID');
  const existing = canonicalUuid(legacyId);
  if (existing) return existing;
  return nameBasedUuid8(namespace, Buffer.concat([
    Buffer.from(entity, 'utf8'), Buffer.from([0]), Buffer.from(legacyId, 'utf8'),
  ]));
}

// Call once per typed entity across the complete retained identity set. The
// exception deliberately omits source identifiers, which may be private data.
export function buildIdentityMapping(entity, legacyIds) {
  const mapping = new Map();
  const originals = new Map();
  for (const legacyId of legacyIds) {
    const canonical = canonicalIdentity(entity, legacyId);
    if (originals.has(canonical) && originals.get(canonical) !== legacyId) {
      throw new Error('CANONICAL_ID_COLLISION');
    }
    originals.set(canonical, legacyId);
    mapping.set(legacyId, canonical);
  }
  return mapping;
}
