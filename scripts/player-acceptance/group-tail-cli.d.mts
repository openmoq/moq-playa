export interface TailCampaignOptions { originalRef: string; artifacts?: string; nativeDonor?: string; expectedManifest?: string }
export type TailManifestRow = { path: string; sha256: string } | { path: string; deleted: true };
export function parseTailCampaignArgs(argv: readonly string[]): TailCampaignOptions;
export function validateTailManifest(value: unknown): TailManifestRow[];
export function assertTailManifest(expected: unknown, actual: unknown): void;
export function isTailHarnessFile(path: string): boolean;
export function isTailSupportFile(path: string): boolean;
export function copyTailTestFiles(source: string, target: string, rows: readonly TailManifestRow[]): Promise<TailManifestRow[]>;
export interface TailTestGraph { pageLinked: boolean; runnerLinked: boolean; helperModulesLoaded: string[];
  publicEntries: Record<string, { path: string; sha256: string }>; inputs: string[]; instrumentation: string }
export function checkTailTestGraph(directory: string, rows: readonly TailManifestRow[]): Promise<TailTestGraph>;
