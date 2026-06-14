/**
 * Per-user token + per-model cost accounting (client-side).
 *
 * Every assistant completion reports token usage (and, when available, the
 * server-computed cost). This module accumulates that usage per model for the
 * current user and persists it in `localStorage`, so the chat UI can show:
 *   - a per-message footer (model · tokens · cost), and
 *   - a "Usage & cost" dashboard (per-user totals + a per-model breakdown).
 *
 * Cost is taken from the server when reported; otherwise it is computed from the
 * model catalog's per-1k input/output prices (`ModelInfo.cost`), so the figure
 * is always populated and consistent with the model picker.
 */

import type { ModelInfo, TokenUsage } from '@auxify/types';

/** Accumulated usage for a single model. */
export interface ModelUsage {
  /** The platform model id. */
  modelId: string;
  /** Human-readable model name (last seen). */
  displayName: string;
  /** Number of completed requests attributed to this model. */
  requests: number;
  /** Total input (prompt) tokens. */
  inputTokens: number;
  /** Total output (completion) tokens. */
  outputTokens: number;
  /** Total cost in the platform's accounting currency. */
  cost: number;
}

/** A roll-up across every model for the current user. */
export interface UsageTotals {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cost: number;
}

/** The `localStorage` key the usage map is persisted under. */
const STORAGE_KEY = 'auxify.usage.v1';

/** Whether we are running in a browser with `localStorage`. */
function hasStorage(): boolean {
  return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
}

/** Load the per-model usage map (keyed by model id). */
export function loadUsage(): Record<string, ModelUsage> {
  if (!hasStorage()) return {};
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null) return {};
    const parsed = JSON.parse(raw) as Record<string, ModelUsage>;
    return typeof parsed === 'object' && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

/** Persist the per-model usage map. */
export function saveUsage(map: Record<string, ModelUsage>): void {
  if (!hasStorage()) return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    /* quota / privacy mode — skip */
  }
}

/** Clear all recorded usage. */
export function resetUsage(): void {
  if (!hasStorage()) return;
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

/**
 * Compute the cost of a call from the model catalog's per-1k prices. Returns 0
 * when the model (or its cost) is unknown.
 */
export function costFor(
  model: ModelInfo | undefined,
  inputTokens: number,
  outputTokens: number,
): number {
  if (model === undefined) return 0;
  const inRate = model.cost?.per1kInputTokens ?? 0;
  const outRate = model.cost?.per1kOutputTokens ?? 0;
  return (inputTokens / 1000) * inRate + (outputTokens / 1000) * outRate;
}

/** Resolve the cost for a completion: prefer the server figure, else compute it. */
export function resolveCost(
  serverCost: number | undefined,
  model: ModelInfo | undefined,
  usage: TokenUsage | undefined,
): number {
  if (typeof serverCost === 'number' && Number.isFinite(serverCost) && serverCost > 0) {
    return serverCost;
  }
  return costFor(model, usage?.inputTokens ?? 0, usage?.outputTokens ?? 0);
}

/**
 * Record one completed call against a model and persist the updated map.
 *
 * @returns the updated usage map (so callers can update state in one step).
 */
export function recordUsage(args: {
  modelId: string;
  displayName: string;
  inputTokens: number;
  outputTokens: number;
  cost: number;
}): Record<string, ModelUsage> {
  const map = loadUsage();
  const prev = map[args.modelId] ?? {
    modelId: args.modelId,
    displayName: args.displayName,
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    cost: 0,
  };
  map[args.modelId] = {
    modelId: args.modelId,
    displayName: args.displayName || prev.displayName || args.modelId,
    requests: prev.requests + 1,
    inputTokens: prev.inputTokens + Math.max(0, args.inputTokens),
    outputTokens: prev.outputTokens + Math.max(0, args.outputTokens),
    cost: prev.cost + Math.max(0, args.cost),
  };
  saveUsage(map);
  return map;
}

/** Roll the per-model map up into per-user totals. */
export function usageTotals(map: Record<string, ModelUsage>): UsageTotals {
  return Object.values(map).reduce<UsageTotals>(
    (acc, m) => ({
      requests: acc.requests + m.requests,
      inputTokens: acc.inputTokens + m.inputTokens,
      outputTokens: acc.outputTokens + m.outputTokens,
      cost: acc.cost + m.cost,
    }),
    { requests: 0, inputTokens: 0, outputTokens: 0, cost: 0 },
  );
}

/** The per-model rows, sorted by cost (highest first). */
export function usageRows(map: Record<string, ModelUsage>): ModelUsage[] {
  return Object.values(map).sort((a, b) => b.cost - a.cost);
}

/** Format a token count with thousands separators. */
export function formatTokens(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

/**
 * Format a cost as a currency string with adaptive precision: tiny amounts keep
 * more decimals so a fraction of a cent is still visible.
 */
export function formatCost(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '$0.00';
  if (n < 0.01) return `$${n.toFixed(4)}`;
  if (n < 1) return `$${n.toFixed(3)}`;
  return `$${n.toFixed(2)}`;
}
