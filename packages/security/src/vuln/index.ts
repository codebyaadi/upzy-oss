export { detectComponents } from "./tech";
export { assessComponents, loadKev, loadEpss, fetchKevEntries, byPriority } from "./enrich";
export type { KevEntry } from "./enrich";
export { queryOsv, compareVersions } from "./osv";
export { queryNvd } from "./nvd";
export { httpJson, memoryCache } from "./http";
export type { Assessment, Cache, Component, HttpInit, RawVuln, Vuln, VulnDeps } from "./types";
