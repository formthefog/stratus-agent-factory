/**
 * Stratus RPC Client
 *
 * Thin HTTP client wrapping the Stratus sidecar RPC endpoints.
 * Each method maps 1:1 to a sidecar endpoint — no business logic here.
 *
 * In v2 (Python-native), each method becomes a direct function call with
 * identical signatures. This is the single file that bridges TS↔Python.
 *
 * @purpose RPC client for Stratus sidecar communication
 * @spec AGENT_FACTORY_SPEC.md#b14-build-stratus-rpc-client
 */

import type {
  EncodeStateRequest,
  EncodeStateResponse,
  EncodeGoalRequest,
  EncodeGoalResponse,
  EncodeActionsRequest,
  EncodeActionsResponse,
  ProbeRankRequest,
  ProbeRankResponse,
  PredictRequest,
  PredictResponse,
  TreeSearchRequest,
  TreeSearchResponse,
  GoalProximityRequest,
  GoalProximityResponse,
  DetectFailureRequest,
  DetectFailureResponse,
  HealthResponse,
  ReloadRequest,
  ReloadResponse,
} from "./StratusRPC.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface StratusClientConfig {
  /** Sidecar base URL (default: http://localhost:8100) */
  baseUrl: string;
  /** Request timeout in ms (default: 30000) */
  timeoutMs: number;
  /** Max retries on transient failures (default: 2) */
  maxRetries: number;
  /** Retry delay base in ms, doubled each attempt (default: 200) */
  retryDelayMs: number;
  /** Enable embedding cache for action embeddings (default: true) */
  cacheActionEmbeddings: boolean;
}

const DEFAULT_CONFIG: StratusClientConfig = {
  baseUrl: "http://localhost:8100",
  timeoutMs: 30_000,
  maxRetries: 2,
  retryDelayMs: 200,
  cacheActionEmbeddings: true,
};

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class StratusClientError extends Error {
  constructor(
    message: string,
    public readonly endpoint: string,
    public readonly statusCode?: number,
    public readonly responseBody?: string,
  ) {
    super(message);
    this.name = "StratusClientError";
  }
}

// ---------------------------------------------------------------------------
// Embedding Cache
// ---------------------------------------------------------------------------

/** Simple LRU-ish cache for action embeddings within a session. */
class EmbeddingCache {
  private cache = new Map<string, number[]>();
  private maxSize: number;

  constructor(maxSize = 500) {
    this.maxSize = maxSize;
  }

  get(key: string): number[] | undefined {
    return this.cache.get(key);
  }

  set(key: string, value: number[]): void {
    if (this.cache.size >= this.maxSize) {
      // Evict oldest entry
      const first = this.cache.keys().next().value;
      if (first !== undefined) this.cache.delete(first);
    }
    this.cache.set(key, value);
  }

  clear(): void {
    this.cache.clear();
  }
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class StratusClient {
  private config: StratusClientConfig;
  private actionCache: EmbeddingCache;

  constructor(config?: Partial<StratusClientConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.actionCache = new EmbeddingCache();
  }

  // -----------------------------------------------------------------------
  // Encoding
  // -----------------------------------------------------------------------

  async encodeState(text: string, signal?: AbortSignal): Promise<EncodeStateResponse> {
    return this.post<EncodeStateRequest, EncodeStateResponse>(
      "/encode_state",
      { text },
      signal,
    );
  }

  async encodeGoal(text: string, signal?: AbortSignal): Promise<EncodeGoalResponse> {
    return this.post<EncodeGoalRequest, EncodeGoalResponse>(
      "/encode_goal",
      { text },
      signal,
    );
  }

  async encodeActions(
    texts: string[],
    signal?: AbortSignal,
  ): Promise<EncodeActionsResponse> {
    if (!this.config.cacheActionEmbeddings) {
      return this.post<EncodeActionsRequest, EncodeActionsResponse>(
        "/encode_actions",
        { texts },
        signal,
      );
    }

    // Check cache for each action, only encode uncached ones
    const uncached: string[] = [];
    const cachedMap = new Map<string, number[]>();

    for (const text of texts) {
      const cached = this.actionCache.get(text);
      if (cached) {
        cachedMap.set(text, cached);
      } else {
        uncached.push(text);
      }
    }

    // If all cached, build response from cache
    if (uncached.length === 0) {
      const dim = cachedMap.values().next().value?.length ?? 0;
      return {
        embeddings: texts.map((t) => ({
          text: t,
          embedding: cachedMap.get(t)!,
        })),
        dim,
        count: texts.length,
        encoding_ms: 0,
      };
    }

    // Encode uncached actions
    const response = await this.post<EncodeActionsRequest, EncodeActionsResponse>(
      "/encode_actions",
      { texts: uncached },
      signal,
    );

    // Populate cache with new embeddings
    for (const emb of response.embeddings) {
      this.actionCache.set(emb.text, emb.embedding);
    }

    // Build combined response preserving original order
    return {
      embeddings: texts.map((t) => ({
        text: t,
        embedding: cachedMap.get(t) ?? this.actionCache.get(t)!,
      })),
      dim: response.dim,
      count: texts.length,
      encoding_ms: response.encoding_ms,
    };
  }

  // -----------------------------------------------------------------------
  // Inference
  // -----------------------------------------------------------------------

  async probeRank(
    stateEmbedding: number[],
    goalEmbedding: number[],
    actionEmbeddings: number[][],
    actionLabels: string[],
    topK = 10,
    probeId = "planning-v2",
    signal?: AbortSignal,
  ): Promise<ProbeRankResponse> {
    return this.post<ProbeRankRequest, ProbeRankResponse>(
      "/probe_rank",
      {
        state_embedding: stateEmbedding,
        goal_embedding: goalEmbedding,
        action_embeddings: actionEmbeddings,
        action_labels: actionLabels,
        top_k: topK,
        probe_id: probeId,
      },
      signal,
    );
  }

  async predict(
    stateEmbedding: number[],
    actionEmbedding: number[],
    signal?: AbortSignal,
  ): Promise<PredictResponse> {
    return this.post<PredictRequest, PredictResponse>(
      "/predict",
      {
        state_embedding: stateEmbedding,
        action_embedding: actionEmbedding,
      },
      signal,
    );
  }

  async treeSearch(
    stateEmbedding: number[],
    goalEmbedding: number[],
    actionEmbeddings: number[][],
    actionLabels: string[],
    depth = 3,
    width = 5,
    probeId = "planning-v2",
    signal?: AbortSignal,
  ): Promise<TreeSearchResponse> {
    return this.post<TreeSearchRequest, TreeSearchResponse>(
      "/tree_search",
      {
        state_embedding: stateEmbedding,
        goal_embedding: goalEmbedding,
        action_embeddings: actionEmbeddings,
        action_labels: actionLabels,
        depth,
        width,
        probe_id: probeId,
      },
      signal,
    );
  }

  // -----------------------------------------------------------------------
  // Monitoring
  // -----------------------------------------------------------------------

  async goalProximity(
    stateEmbedding: number[],
    goalEmbedding: number[],
    signal?: AbortSignal,
  ): Promise<GoalProximityResponse> {
    return this.post<GoalProximityRequest, GoalProximityResponse>(
      "/goal_proximity",
      {
        state_embedding: stateEmbedding,
        goal_embedding: goalEmbedding,
      },
      signal,
    );
  }

  async detectFailure(
    stateEmbedding: number[],
    previousStateEmbedding?: number[],
    actionTaken?: string,
    signal?: AbortSignal,
  ): Promise<DetectFailureResponse> {
    return this.post<DetectFailureRequest, DetectFailureResponse>(
      "/detect_failure",
      {
        state_embedding: stateEmbedding,
        previous_state_embedding: previousStateEmbedding,
        action_taken: actionTaken,
      },
      signal,
    );
  }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  async health(signal?: AbortSignal): Promise<HealthResponse> {
    const url = `${this.config.baseUrl}/health`;
    const res = await fetch(url, {
      method: "GET",
      headers: { "Content-Type": "application/json" },
      signal: signal ?? AbortSignal.timeout(5_000),
    });
    if (!res.ok) {
      throw new StratusClientError(
        `Health check failed: ${res.status}`,
        "/health",
        res.status,
      );
    }
    return (await res.json()) as HealthResponse;
  }

  async reload(
    checkpointPath?: string,
    signal?: AbortSignal,
  ): Promise<ReloadResponse> {
    return this.post<ReloadRequest, ReloadResponse>(
      "/reload",
      { checkpoint_path: checkpointPath },
      signal,
    );
  }

  /** Clear the action embedding cache (e.g., on session reset). */
  clearCache(): void {
    this.actionCache.clear();
  }

  // -----------------------------------------------------------------------
  // HTTP Transport
  // -----------------------------------------------------------------------

  private async post<TReq, TRes>(
    endpoint: string,
    body: TReq,
    signal?: AbortSignal,
  ): Promise<TRes> {
    const url = `${this.config.baseUrl}${endpoint}`;
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: signal ?? AbortSignal.timeout(this.config.timeoutMs),
        });

        if (!res.ok) {
          const responseBody = await res.text().catch(() => "");
          // Don't retry client errors (4xx)
          if (res.status >= 400 && res.status < 500) {
            throw new StratusClientError(
              `Sidecar ${endpoint} returned ${res.status}: ${responseBody}`,
              endpoint,
              res.status,
              responseBody,
            );
          }
          // Server errors (5xx) are retryable
          lastError = new StratusClientError(
            `Sidecar ${endpoint} returned ${res.status}`,
            endpoint,
            res.status,
            responseBody,
          );
        } else {
          return (await res.json()) as TRes;
        }
      } catch (err) {
        if (err instanceof StratusClientError && err.statusCode && err.statusCode < 500) {
          throw err; // Don't retry client errors
        }
        lastError = err instanceof Error ? err : new Error(String(err));
        if (signal?.aborted) throw lastError; // Don't retry if aborted
      }

      // Wait before retry with exponential backoff
      if (attempt < this.config.maxRetries) {
        const delay = this.config.retryDelayMs * 2 ** attempt;
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }

    throw lastError ?? new StratusClientError(`Failed after retries`, endpoint);
  }
}
