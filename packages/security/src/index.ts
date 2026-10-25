export * from "./types";
export { defaultDeps } from "./deps";
export {
  PASSIVE_CHECKS,
  ACTIVE_CHECKS,
  ALL_CHECKS,
  runChecks,
  contextFor,
  hostOf,
  type ScanResult,
  type RunOptions,
  type Outcome,
} from "./run";
export { cookieShape, type Proof, type ProofRequest } from "./proof";
export { fingerprint } from "./fingerprint";
export { componentFinding } from "./checks/cve";
export { riskScore } from "./score";
export {
  newVerificationToken,
  verifyOwnership,
  dnsRecordValue,
  wellKnownPath,
  parentDomains,
  type VerifyResult,
} from "./verify";
export { TAKEOVER_SIGNATURES, matchProvider } from "./takeover-signatures";
export {
  discoverSubdomains,
  extractSubdomains,
  checkResolves,
  httpJson,
  SOURCES,
  MAX_HOSTS,
  type DiscoveryResult,
  type DiscoverySource,
  type JsonFetcher,
} from "./discovery";
export {
  detectComponents,
  assessComponents,
  memoryCache,
  loadKev,
  fetchKevEntries,
  loadEpss,
  type KevEntry,
  type Assessment,
  type Component,
  type Vuln,
  type VulnDeps,
  type Cache,
} from "./vuln";
export {
  detectStack,
  describeStack,
  STACK_LABEL,
  UNKNOWN_STACK,
  type Stack,
  type Platform,
  type Server,
  type Framework,
} from "./stack";
export {
  computeHealth,
  availabilityScore,
  categoryOf,
  gradeOf,
  type Health,
  type Grade,
  type Category,
  type HealthFinding,
} from "./health";
export {
  fixFor,
  headersBundle,
  targetFor,
  HEADER_SPECS,
  type Fix,
  type FixInput,
  type Snippet,
} from "./fixes";
export { healthFor, recordHealth, healthHistory, hostOfTarget } from "./health-db";
export {
  runTool,
  normalizeHost,
  scoreOf,
  isToolId,
  TOOL_IDS,
  ToolInputError,
  ToolUnreachableError,
  type ToolId,
  type ToolResult,
  type ToolFinding,
  type ToolFact,
} from "./tools";
