/**
 * Mirror of the JSON the harness writes (`src/report.ts` + `src/schema.ts`).
 * The dashboard is a separate Vite app, so these are hand-kept in sync with the
 * harness — the `/api/index` and `/data/.../scorecard.json` contracts.
 */

export interface ModelSummary {
  model: string;
  total: number;
  codeFixResolved: number;
  codeFixTotal: number;
  behavioralOk: number;
  behavioralTotal: number;
  avgInputTokens: number;
  avgCachedTokens: number;
  avgOutputTokens: number;
  totalCostUsd: number;
  p50DurationMs: number;
  errors: number;
}

export interface Check {
  name: string;
  ok: boolean;
  detail?: string;
}

export interface InstanceResult {
  instance_id: string;
  model: string;
  tier?: string;
  workflowSucceeded: boolean;
  resolved?: boolean;
  behavioral?: { ok: boolean; checks: Check[] };
  trials?: number;
  trialErrors?: number;
  behavioralPass?: number;
  resolvedPass?: number;
  githubMutations?: number;
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  costUsd: number;
  durationMs: number;
  error?: string;
}

export interface PendingCase {
  tier: string;
  model: string;
  instance_id: string;
  status: "running" | "pending";
}

export interface RunMeta {
  runId: string;
  generatedAt: string;
  tiers: string[];
  models: string[];
  runs: number;
  gitSha?: string;
  labels?: Record<string, string>;
  live?: boolean;
  progress?: string;
  pending?: PendingCase[];
}

export interface Scorecard {
  models: ModelSummary[];
  results: InstanceResult[];
  meta?: RunMeta;
}

export interface TierSummary {
  tier: string;
  models: ModelSummary[];
}

export interface IndexRun {
  id: string;
  scorecard: string;
  runId: string;
  generatedAt: string;
  gitSha?: string;
  tiers: string[];
  labels: Record<string, string>;
  byTier: TierSummary[];
  runs: number;
  live: boolean;
  progress?: string;
}

export interface IndexTier {
  key: string;
  runs: IndexRun[];
}

export interface DashboardIndex {
  generatedAt: string;
  tiers: IndexTier[];
}
