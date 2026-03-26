/**
 * Stratus RPC Type Definitions
 *
 * TypeScript types matching the Pydantic models in stratus_sidecar/server.py.
 * These are the wire types for HTTP communication between TS harness and Python sidecar.
 *
 * @purpose RPC request/response types for Stratus sidecar communication
 * @spec AGENT_FACTORY_SPEC.md#b12-define-rpc-interface
 */

// ---------------------------------------------------------------------------
// Encode State
// ---------------------------------------------------------------------------

export interface EncodeStateRequest {
  text: string;
}

export interface EncodeStateResponse {
  embedding: number[];
  dim: number;
  encoding_ms: number;
}

// ---------------------------------------------------------------------------
// Encode Goal
// ---------------------------------------------------------------------------

export interface EncodeGoalRequest {
  text: string;
}

export interface EncodeGoalResponse {
  embedding: number[];
  dim: number;
  encoding_ms: number;
}

// ---------------------------------------------------------------------------
// Encode Actions
// ---------------------------------------------------------------------------

export interface EncodeActionsRequest {
  texts: string[];
}

export interface ActionEmbedding {
  text: string;
  embedding: number[];
}

export interface EncodeActionsResponse {
  embeddings: ActionEmbedding[];
  dim: number;
  count: number;
  encoding_ms: number;
}

// ---------------------------------------------------------------------------
// Probe Rank
// ---------------------------------------------------------------------------

export interface ProbeRankRequest {
  state_embedding: number[];
  goal_embedding: number[];
  action_embeddings: number[][];
  action_labels: string[];
  top_k?: number;
  probe_id?: string;
}

export interface RankedAction {
  action: string;
  score: number;
  rank: number;
}

export interface ProbeRankResponse {
  ranked_actions: RankedAction[];
  probe_id: string;
  inference_ms: number;
}

// ---------------------------------------------------------------------------
// Predict
// ---------------------------------------------------------------------------

export interface PredictRequest {
  state_embedding: number[];
  action_embedding: number[];
}

export interface PredictResponse {
  predicted_embedding: number[];
  dim: number;
  inference_ms: number;
}

// ---------------------------------------------------------------------------
// Tree Search
// ---------------------------------------------------------------------------

export interface TreeSearchRequest {
  state_embedding: number[];
  goal_embedding: number[];
  action_embeddings: number[][];
  action_labels: string[];
  depth?: number;
  width?: number;
  probe_id?: string;
}

export interface TreeSearchStep {
  action: string;
  score: number;
  goal_proximity: number;
}

export interface TreeSearchResponse {
  best_path: TreeSearchStep[];
  best_terminal_proximity: number;
  paths_evaluated: number;
  search_ms: number;
}

// ---------------------------------------------------------------------------
// Goal Proximity
// ---------------------------------------------------------------------------

export interface GoalProximityRequest {
  state_embedding: number[];
  goal_embedding: number[];
}

export interface GoalProximityResponse {
  proximity: number;
  inference_ms: number;
}

// ---------------------------------------------------------------------------
// Detect Failure
// ---------------------------------------------------------------------------

export interface DetectFailureRequest {
  state_embedding: number[];
  previous_state_embedding?: number[];
  action_taken?: string;
}

export interface DetectFailureResponse {
  is_failure: boolean;
  confidence: number;
  failure_type?: string;
  inference_ms: number;
}

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

export interface HealthResponse {
  status: string;
  model_loaded: boolean;
  model_version: string;
  device: string;
  uptime_seconds: number;
}

// ---------------------------------------------------------------------------
// Reload
// ---------------------------------------------------------------------------

export interface ReloadRequest {
  checkpoint_path?: string;
}

export interface ReloadResponse {
  success: boolean;
  model_version: string;
  reload_ms: number;
}
