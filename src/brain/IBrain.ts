/**
 * IBrain — Brain Interface Contract
 *
 * The single contract between the OpenClaw harness and any brain implementation.
 * All harness code communicates with the brain exclusively through this interface.
 *
 * v1: ReActBrainAdapter (wraps existing LLM-based ReAct loop)
 * v1: StratusBrain (world model-based planning via sidecar)
 * v2: This interface becomes a Python ABC with identical method signatures.
 *
 * @purpose Brain interface contract — the only coupling between harness and brain
 * @spec AGENT_FACTORY_SPEC.md#a22-define-the-brain-interface-contract
 * @decision v1-v2-language-migration
 */

// ---------------------------------------------------------------------------
// Core Types — language-agnostic, JSON-serializable where possible
// ---------------------------------------------------------------------------

/**
 * A single action taken by the brain during a turn.
 * Maps to a tool call dispatched by the harness.
 */
export interface ActionRecord {
  /** Unique ID for this action (correlates with tool call ID) */
  id: string;
  /** Tool/skill name that was invoked */
  tool_name: string;
  /** Parameters passed to the tool (JSON-serializable) */
  parameters: Record<string, unknown>;
  /** Tool execution result */
  result: string;
  /** Whether the tool returned an error */
  is_error: boolean;
  /** Execution duration in milliseconds */
  duration_ms: number;
}

/**
 * A record of an LLM generation call made during the turn.
 * Stratus Brain uses LLM only for content generation (email body, message text, etc.).
 * ReAct Brain uses LLM for everything (planning + generation).
 */
export interface GenerationRecord {
  /** What the LLM was asked to generate */
  purpose: string;
  /** The prompt/context sent to the LLM */
  prompt_summary: string;
  /** Provider used (anthropic, openai, etc.) */
  provider: string;
  /** Model ID used */
  model: string;
  /** Token usage */
  usage: TokenUsage;
  /** Duration in milliseconds */
  duration_ms: number;
}

/** Token usage for a single LLM call */
export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
  total_tokens: number;
}

/**
 * A snapshot of the brain's internal state at a point in time.
 * For Stratus: the state embedding + metadata.
 * For ReAct: the conversation messages at that point.
 */
export interface StateSnapshot {
  /** Step number in the current turn */
  step: number;
  /** Human-readable description of the state */
  description: string;
  /** State embedding (Stratus only — 1024-d float array) */
  embedding?: number[];
  /** Goal proximity score (Stratus only — cosine similarity 0..1) */
  goal_proximity?: number;
  /** Timestamp */
  timestamp: string;
}

/**
 * The response from a single brain turn.
 * This is the output contract — both ReAct and Stratus must produce this.
 */
export interface BrainResponse {
  /** All actions (tool calls) taken during this turn */
  actions_taken: ActionRecord[];
  /** All LLM generation calls made during this turn */
  generation_calls: GenerationRecord[];
  /** The final text response to return to the user */
  final_response: string;
  /** State trajectory — snapshots of brain state during the turn */
  state_trajectory: StateSnapshot[];
  /** How close the brain thinks it is to the goal (0..1, Stratus only) */
  goal_proximity: number;
  /** Number of planning steps taken */
  steps_taken: number;
  /** Total token usage across all LLM calls in this turn */
  total_usage: TokenUsage;
  /** Total duration of the turn in milliseconds */
  duration_ms: number;
  /** Why the turn ended */
  stop_reason: BrainStopReason;
  /** Structured error if the turn failed */
  error?: BrainError;
}

/** Why a brain turn ended */
export type BrainStopReason =
  | "goal_reached"       // Stratus: goal proximity exceeded threshold
  | "end_turn"           // ReAct: LLM said stop
  | "max_steps"          // Hit step limit
  | "error"              // Unrecoverable error
  | "user_cancelled";    // AbortSignal fired

/** Structured brain error */
export interface BrainError {
  kind: "context_overflow" | "model_error" | "tool_error" | "timeout" | "unknown";
  message: string;
  recoverable: boolean;
}

// ---------------------------------------------------------------------------
// Brain Configuration
// ---------------------------------------------------------------------------

/**
 * Configuration for a brain implementation.
 * Passed via IBrain.configure() at agent startup.
 */
export interface BrainConfig {
  /** Brain implementation type */
  type: "react" | "stratus";

  /** LLM provider for generation (both brains use this) */
  llm_provider: string;
  /** LLM model ID for generation */
  llm_model: string;

  /** Maximum steps per turn before forced stop */
  max_steps_per_turn: number;

  /** Stratus-specific config (ignored by ReAct) */
  stratus?: StratusBrainConfig;
}

/** Stratus-specific brain configuration */
export interface StratusBrainConfig {
  /** Sidecar URL (e.g., "http://localhost:8100") */
  sidecar_url: string;
  /** Probe to use for action ranking */
  probe_id: string;
  /** Goal proximity threshold for termination (0..1) */
  goal_threshold: number;
  /** Tree search depth (0 = probe only, no search) */
  tree_search_depth: number;
  /** Tree search beam width */
  tree_search_width: number;
  /** Score gap below which tree search activates */
  ambiguity_threshold: number;
}

// ---------------------------------------------------------------------------
// Brain State (for inspection/debugging)
// ---------------------------------------------------------------------------

/** Current state of the brain for a session */
export interface BrainState {
  /** Brain implementation type */
  type: "react" | "stratus";
  /** Whether the brain is currently processing a turn */
  is_active: boolean;
  /** Number of turns processed in this session */
  turns_completed: number;
  /** Current goal proximity (Stratus only) */
  goal_proximity?: number;
  /** Current state embedding (Stratus only) */
  state_embedding?: number[];
  /** Last action taken */
  last_action?: string;
  /** Cumulative token usage for this session */
  cumulative_usage: TokenUsage;
}

// ---------------------------------------------------------------------------
// Tool Definition (language-agnostic)
// ---------------------------------------------------------------------------

/**
 * A tool available to the brain.
 * JSON-serializable — no closures, no runtime objects.
 * The executor is provided separately by the harness.
 */
export interface BrainToolDefinition {
  /** Unique tool identifier */
  id: string;
  /** Human-readable name */
  name: string;
  /** Natural language description */
  description: string;
  /** Rich description in training format (for Stratus action encoder) */
  rich_description: string;
  /** JSON Schema for parameters */
  parameters: Record<string, unknown>;
  /** Whether this tool needs LLM to generate parameter values */
  requires_generation: boolean;
  /** Prompt template for LLM generation (if requires_generation) */
  generation_template?: string;
  /** Domain/category */
  domain: string;
  /** What this tool changes in the environment */
  effects: string[];
  /** When this tool is valid to use */
  preconditions: string[];
}

/**
 * Function that executes a tool call. Provided by the harness, not the brain.
 * The brain decides WHICH tool to call; the harness decides HOW to call it.
 */
export type ToolExecutor = (
  tool_id: string,
  parameters: Record<string, unknown>,
  signal?: AbortSignal,
) => Promise<ToolResult>;

/** Result of executing a tool */
export interface ToolResult {
  /** Text output from the tool */
  content: string;
  /** Whether the tool errored */
  is_error: boolean;
  /** Media URLs produced by the tool (if any) */
  media_urls?: string[];
  /** Execution duration in milliseconds */
  duration_ms: number;
}

// ---------------------------------------------------------------------------
// Turn Event (for streaming updates during a turn)
// ---------------------------------------------------------------------------

/**
 * Events emitted by the brain during a turn.
 * The harness subscribes to these for real-time updates to channels.
 */
export type BrainTurnEvent =
  | { type: "thinking"; text: string }         // Brain reasoning (display to user)
  | { type: "action_start"; tool: string; params: Record<string, unknown> }
  | { type: "action_complete"; tool: string; result: string; is_error: boolean }
  | { type: "generation_start"; purpose: string }
  | { type: "generation_complete"; text: string }
  | { type: "state_update"; snapshot: StateSnapshot }
  | { type: "progress"; message: string; goal_proximity?: number }
  | { type: "error"; error: BrainError };

// ---------------------------------------------------------------------------
// Process Turn Options
// ---------------------------------------------------------------------------

/** Additional options for processTurn() */
export interface ProcessTurnOptions {
  /** Images attached to the user message (vision input) */
  images?: Array<{ data: string; media_type: string }>;
  /** Abort signal for cancellation */
  signal?: AbortSignal;
  /** Conversation history (if brain doesn't manage its own) */
  history?: Array<{ role: string; content: string }>;
}

// ---------------------------------------------------------------------------
// IBrain — The Interface
// ---------------------------------------------------------------------------

/**
 * The Brain interface. The ONLY contract between the harness and any brain
 * implementation. No harness code may import from brain internals.
 *
 * Lifecycle:
 *   1. configure(config)       — Called once at agent startup
 *   2. registerTools(tools)    — Called once (or when tools change)
 *   3. processTurn(...)        — Called for each user message
 *   4. getState(session)       — Called anytime for inspection
 *   5. reset(session)          — Called to clear session state
 */
export interface IBrain {
  /**
   * Configure the brain implementation.
   * Called once at agent startup with the full brain config.
   */
  configure(config: BrainConfig): Promise<void>;

  /**
   * Register available tools with the brain.
   * For Stratus: triggers action embedding computation.
   * For ReAct: stores tool definitions for prompt injection.
   */
  registerTools(tools: BrainToolDefinition[]): Promise<void>;

  /**
   * Process a single turn: user message → actions → response.
   *
   * This is the core method. The brain:
   * 1. Plans what to do (world model or LLM)
   * 2. Requests tool executions via the executor callback
   * 3. Observes results
   * 4. Repeats until goal reached or max steps
   * 5. Returns the final response
   *
   * @param sessionId - Unique session identifier
   * @param message - User message text
   * @param executor - Harness-provided function to execute tool calls
   * @param options - Additional options (images, abort signal, etc.)
   * @param onEvent - Callback for streaming turn events
   * @returns The complete turn response
   */
  processTurn(
    sessionId: string,
    message: string,
    executor: ToolExecutor,
    options?: ProcessTurnOptions,
    onEvent?: (event: BrainTurnEvent) => void,
  ): Promise<BrainResponse>;

  /**
   * Get the current state of the brain for a session.
   * Used for inspection, debugging, and monitoring.
   */
  getState(sessionId: string): Promise<BrainState>;

  /**
   * Reset the brain state for a session.
   * Clears embeddings, trajectory, and any cached state.
   * Does NOT clear the conversation history (that's the harness's job).
   */
  reset(sessionId: string): Promise<void>;
}
