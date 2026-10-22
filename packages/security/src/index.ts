export * from "./types";
export { defaultDeps } from "./deps";
export {
  PASSIVE_CHECKS,
  runChecks,
  contextFor,
  hostOf,
  type ScanResult,
  type Outcome,
} from "./run";
export { fingerprint } from "./fingerprint";
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
  loadEpss,
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
