// Types for scripts/eval-lib.mjs, so the TypeScript tests can import it.
export interface EvalCase {
  id: string;
  kind: string;
  locale: string;
  covers?: string[];
  endpoint: string;
  body: Record<string, unknown>;
  expectCode?: string;
  must?: { name: string; pattern: string; flags?: string }[];
  mustNot?: { name: string; pattern: string; flags?: string }[];
}
export interface LedgerView {
  kind: "sql" | "file" | "unknown";
  spentMicro: number | null;
  heldMicro: number | null;
  calls: number | null;
  inflight: number | null;
  [k: string]: unknown;
}
export type Outcome = "completed" | "replayed" | "handled" | "failed" | "refused" | "lost" | "pending" | "error" | "not_run";
export interface CaseResult {
  id: string;
  kind: string;
  endpoint: string;
  expectCode: string | null;
  requestId: string | null;
  outcome: Outcome;
  httpStatus: number;
  code: string;
  reason?: string;
  attempts: number;
  lostResponses: number;
  waits: number;
  inferredCalls: number | null;
  latencyMs: number | null;
  costUsd: number | null;
  ledgerCalls: number | null;
  costNote: string | null;
  text: string;
  checks: { name: string; pass: boolean }[];
  response: Record<string, unknown> | null;
  error: string | null;
}
export interface Client {
  base: string;
  jar: CookieJar;
  get(path: string): Promise<Response>;
  post(path: string, body?: unknown): Promise<Response>;
}
export interface RunOptions {
  measure?: (() => Promise<LedgerView | null>) | null;
  networkRetries?: number;
  maxWaitMs?: number;
  sleep: (ms: number) => Promise<void>;
  now?: () => number;
}
export const DEFAULTS: { maxWaitMs: number; requestTimeoutMs: number };
export const VISITOR_COOKIE: string;
export const OPS_COOKIE: string;
export const ACCESS_COOKIE: string;
export class CookieJar {
  absorb(res: Response): void;
  set(name: string, value: string): void;
  has(name: string): boolean;
  header(): string;
}
export function makeClient(o: { base: string; fetchImpl?: typeof fetch; jar?: CookieJar; requestTimeoutMs?: number }): Client;
export function signInOperator(client: Client, token: string | undefined): Promise<{ operator: boolean; reason: string | null }>;
export function readStatus(client: Client): Promise<Record<string, unknown>>;
export function ledgerView(status: unknown): LedgerView | null;
export function describeLedger(v: LedgerView | null): string;
export function prepareVisitor(client: Client): Promise<{ ok: true; visitor: string } | { ok: false; reason: string }>;
export function requestIdFor(runId: string, caseId: string): string;
export function outputText(kind: string, body: unknown): string;
export function attribute(before: LedgerView | null, after: LedgerView | null, expectedCalls: number | null): { costUsd: number | null; ledgerCalls: number | null; costNote: string | null };
export function runCase(client: Client, c: EvalCase, o: RunOptions & { requestId: string }): Promise<CaseResult>;
export function notRun(c: EvalCase, reason: string): CaseResult;
export function runEval(o: RunOptions & { client: Client; cases: EvalCase[]; runId: string; onResult?: (all: CaseResult[], last: CaseResult) => void | Promise<void> }): Promise<CaseResult[]>;
export function replayCheck(client: Client, results: CaseResult[], cases: EvalCase[], o: RunOptions): Promise<{ ran: boolean; reason?: string; caseId?: string; replayed?: boolean; sameText?: boolean; ledgerCalls?: number | null; costUsd?: number | null; pass?: boolean }>;
export function summarize(results: CaseResult[]): {
  cases: number;
  modelCases: number;
  ok: number;
  outcomes: Record<Outcome, number>;
  httpAttempts: number;
  modelCalls: { inferred: number; unknown: number; measured: number | null };
  byCode: Record<string, number>;
  flagged: string[];
  costUsd: number | null;
  costAttributed: { cases: number; of: number; usd: number };
  costNote: string;
  latencyMs: { p50: number | null; p90: number | null; max: number | null };
};
