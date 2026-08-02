/**
 * Centralised string-literal unions for Locopilot's capability / state-machine
 * discriminators. Each type was previously declared once (often inline at a
 * single site) and then re-typed by hand at every consumer. Centralising the
 * union means a typo at a call site is a compile-time error.
 */

/**
 * Centralised string-literal unions for Locopilot's capability / state-machine
 * discriminators. Each type was previously declared once (often inline at a
 * single site) and then re-typed by hand at every consumer. Centralising the
 * union means a typo at a call site is a compile-time error.
 *
 * Provider-name constants live in `providerConstants.ts` (they're imported
 * across the tree separately) and are not re-exported here.
 */

// ── Vision-support state ───────────────────────────────────────────────────

/** Outcome of `resolveVisionSupport` for a given `(baseUrl, model)` pair. */
export type VisionSupportState = 'supported' | 'unsupported' | 'unknown';

export const VISION_SUPPORT_STATES: readonly VisionSupportState[] = [
  'supported',
  'unsupported',
  'unknown',
];

// ── numCtx resolution source ──────────────────────────────────────────────

/** Provenance of the context-window limit returned by the resolver. */
export type CapResolverSource = 'static-show' | 'runtime-ps' | 'cache' | 'unknown';

export const CAP_RESOLVER_SOURCES: readonly CapResolverSource[] = [
  'static-show',
  'runtime-ps',
  'cache',
  'unknown',
];

// ── MCP connection status ──────────────────────────────────────────────────

export type MCPConnectionStatus =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'error'
  | 'auth_required'
  | 'not_loaded';

export const MCP_CONNECTION_STATUSES: readonly MCPConnectionStatus[] = [
  'disconnected',
  'connecting',
  'connected',
  'error',
  'auth_required',
  'not_loaded',
];

// ── MCP event kinds ────────────────────────────────────────────────────────

export type MCPEventKind = 'state' | 'tools' | 'config' | 'auth-required' | 'snapshot';

export const MCP_EVENT_KINDS: readonly MCPEventKind[] = [
  'state',
  'tools',
  'config',
  'auth-required',
  'snapshot',
];

// ── Race-result kind ──────────────────────────────────────────────────────

/** Outcome of an MCP `racePromises` call. */
export type RaceResultKind = 'ok' | 'aborted' | 'timeout';

export const RACE_RESULT_KINDS: readonly RaceResultKind[] = ['ok', 'aborted', 'timeout'];

// ── Skill location ─────────────────────────────────────────────────────────

export type SkillLocation = 'project' | 'user-profile';

export const SKILL_LOCATIONS: readonly SkillLocation[] = ['project', 'user-profile'];

// ── Tool target (main vs sub-agent) ───────────────────────────────────────

export type ToolTarget = 'main' | 'subagent';

export const TOOL_TARGETS: readonly ToolTarget[] = ['main', 'subagent'];

// ── Approval risk category ────────────────────────────────────────────────

export type ApprovalRiskCategory = 'command' | 'network' | 'file' | 'mcp' | 'other';

export const APPROVAL_RISK_CATEGORIES: readonly ApprovalRiskCategory[] = [
  'command',
  'network',
  'file',
  'mcp',
  'other',
];

// ── Image MIME types ──────────────────────────────────────────────────────

/** Image MIME types that can be attached to chat messages. */
export const SUPPORTED_IMAGE_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/bmp',
] as const;

export type SupportedImageMimeType = (typeof SUPPORTED_IMAGE_MIME_TYPES)[number];

/** Map from a base64 data-URI's leading bytes to the detected MIME type. */
export const IMAGE_MAGIC_BYTE_TABLE: ReadonlyArray<{
  prefix: readonly number[];
  mime: SupportedImageMimeType;
}> = [
  { prefix: [0xff, 0xd8, 0xff], mime: 'image/jpeg' },
  { prefix: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], mime: 'image/png' },
  { prefix: [0x47, 0x49, 0x46, 0x38], mime: 'image/gif' },
  { prefix: [0x52, 0x49, 0x46, 0x46], mime: 'image/webp' },
  { prefix: [0x42, 0x4d], mime: 'image/bmp' },
];
