/**
 * ReActBrainAdapter — Wraps OpenClaw's existing ReAct loop behind IBrain
 *
 * This adapter ensures the fork works identically to upstream OpenClaw while
 * we build the Stratus Brain. It translates the IBrain interface into calls
 * to the existing pi-embedded-runner infrastructure.
 *
 * The adapter does NOT re-implement the ReAct loop — it delegates to the
 * existing runEmbeddedPiAgent function and translates the result into
 * BrainResponse format.
 *
 * @purpose IBrain adapter wrapping existing OpenClaw ReAct agent loop
 * @spec AGENT_FACTORY_SPEC.md#a23-create-brain-adapter-for-existing-react
 */

import type {
  IBrain,
  BrainConfig,
  BrainResponse,
  BrainState,
  BrainToolDefinition,
  BrainTurnEvent,
  BrainStopReason,
  ToolExecutor,
  ActionRecord,
  GenerationRecord,
  StateSnapshot,
  TokenUsage,
  ProcessTurnOptions,
} from "./IBrain.js";
import { registerBrain } from "./BrainRegistry.js";

/**
 * Per-session state for the ReAct adapter.
 * Tracks cumulative metrics across turns.
 */
interface ReActSessionState {
  is_active: boolean;
  turns_completed: number;
  last_action?: string;
  cumulative_usage: TokenUsage;
}

/**
 * ReActBrainAdapter wraps the existing OpenClaw agent loop behind IBrain.
 *
 * Implementation strategy:
 * - configure() stores the LLM config for later use
 * - registerTools() is a no-op (ReAct gets tools from the harness directly)
 * - processTurn() delegates to the harness's existing runEmbeddedPiAgent
 * - The adapter translates EmbeddedPiRunResult → BrainResponse
 *
 * This is intentionally a thin translation layer. The ReAct loop's logic
 * stays exactly where it is — in pi-embedded-runner.
 */
export class ReActBrainAdapter implements IBrain {
  private config: BrainConfig | null = null;
  private tools: BrainToolDefinition[] = [];
  private sessions = new Map<string, ReActSessionState>();

  async configure(config: BrainConfig): Promise<void> {
    this.config = config;
  }

  async registerTools(tools: BrainToolDefinition[]): Promise<void> {
    // ReAct doesn't pre-process tools — they're injected into the LLM prompt
    // by the harness. We store them for getState() introspection only.
    this.tools = tools;
  }

  async processTurn(
    sessionId: string,
    message: string,
    executor: ToolExecutor,
    options?: ProcessTurnOptions,
    onEvent?: (event: BrainTurnEvent) => void,
  ): Promise<BrainResponse> {
    const startTime = Date.now();

    // Get or create session state
    let session = this.sessions.get(sessionId);
    if (!session) {
      session = {
        is_active: false,
        turns_completed: 0,
        cumulative_usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
      };
      this.sessions.set(sessionId, session);
    }

    session.is_active = true;

    // Track actions and generations during this turn
    const actions: ActionRecord[] = [];
    const generations: GenerationRecord[] = [];
    const trajectory: StateSnapshot[] = [];
    let finalResponse = "";
    let stopReason: BrainStopReason = "end_turn";
    let turnUsage: TokenUsage = { input_tokens: 0, output_tokens: 0, total_tokens: 0 };

    try {
      // Emit thinking event
      onEvent?.({ type: "thinking", text: "Processing with LLM..." });

      // In the ReAct adapter, the actual execution is handled by the existing
      // pi-embedded-runner infrastructure. The adapter's job is to:
      //
      // 1. Pass the message to the existing runner
      // 2. Intercept tool calls via the executor callback
      // 3. Collect results into BrainResponse format
      //
      // The harness calls processTurn() instead of runEmbeddedPiAgent() directly.
      // Inside, this adapter uses the SAME infrastructure — it's just wrapped
      // in the IBrain interface for forward compatibility with Stratus.
      //
      // IMPORTANT: The actual integration point is in the harness wiring
      // (A.2.5 — Wire BrainRegistry into agent runtime). This adapter
      // provides the interface; the harness provides the actual runner
      // delegation via a callback injected at construction time.

      if (!this._runnerDelegate) {
        throw new Error(
          "[ReActBrainAdapter] No runner delegate configured. " +
            "Call setRunnerDelegate() before processTurn().",
        );
      }

      const result = await this._runnerDelegate(sessionId, message, {
        provider: this.config?.llm_provider ?? "anthropic",
        model: this.config?.llm_model ?? "claude-sonnet-4-20250514",
        signal: options?.signal,
        onToolCall: (toolName, params, toolResult, durationMs) => {
          const action: ActionRecord = {
            id: `react-${actions.length}`,
            tool_name: toolName,
            parameters: params,
            result: toolResult.content,
            is_error: toolResult.is_error,
            duration_ms: durationMs,
          };
          actions.push(action);
          session!.last_action = toolName;

          onEvent?.({
            type: "action_complete",
            tool: toolName,
            result: toolResult.content,
            is_error: toolResult.is_error,
          });
        },
        onGeneration: (purpose, provider, model, usage, durationMs) => {
          generations.push({
            purpose,
            prompt_summary: "(ReAct — full context sent to LLM)",
            provider,
            model,
            usage,
            duration_ms: durationMs,
          });
        },
        onPartialText: (text) => {
          onEvent?.({ type: "thinking", text });
        },
      });

      finalResponse = result.finalResponse;
      stopReason = result.stopReason === "error" ? "error" : "end_turn";
      turnUsage = result.usage ?? turnUsage;

      // Build trajectory (ReAct has one step per tool call + final)
      for (let i = 0; i < actions.length; i++) {
        trajectory.push({
          step: i + 1,
          description: `${actions[i].tool_name}: ${actions[i].result.slice(0, 100)}`,
          timestamp: new Date().toISOString(),
        });
      }
      trajectory.push({
        step: actions.length + 1,
        description: "Final response generated",
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      stopReason = "error";
      finalResponse = err instanceof Error ? err.message : String(err);
    } finally {
      session.is_active = false;
      session.turns_completed += 1;
      session.cumulative_usage.input_tokens += turnUsage.input_tokens;
      session.cumulative_usage.output_tokens += turnUsage.output_tokens;
      session.cumulative_usage.total_tokens += turnUsage.total_tokens;
    }

    return {
      actions_taken: actions,
      generation_calls: generations,
      final_response: finalResponse,
      state_trajectory: trajectory,
      goal_proximity: stopReason === "end_turn" ? 1.0 : 0.0, // ReAct: binary
      steps_taken: actions.length + 1, // actions + final generation
      total_usage: turnUsage,
      duration_ms: Date.now() - startTime,
      stop_reason: stopReason,
    };
  }

  async getState(sessionId: string): Promise<BrainState> {
    const session = this.sessions.get(sessionId);
    return {
      type: "react",
      is_active: session?.is_active ?? false,
      turns_completed: session?.turns_completed ?? 0,
      last_action: session?.last_action,
      cumulative_usage: session?.cumulative_usage ?? {
        input_tokens: 0,
        output_tokens: 0,
        total_tokens: 0,
      },
    };
  }

  async reset(sessionId: string): Promise<void> {
    this.sessions.delete(sessionId);
  }

  // -----------------------------------------------------------------------
  // Runner Delegate — injected by the harness to bridge to existing runner
  // -----------------------------------------------------------------------

  private _runnerDelegate: RunnerDelegate | null = null;

  /**
   * Set the runner delegate that bridges to the existing pi-embedded-runner.
   * Called by the harness during agent initialization (A.2.5).
   *
   * This delegate is what makes the adapter work without re-implementing
   * the ReAct loop. The harness wraps runEmbeddedPiAgent into this callback.
   */
  setRunnerDelegate(delegate: RunnerDelegate): void {
    this._runnerDelegate = delegate;
  }
}

// ---------------------------------------------------------------------------
// Runner Delegate Types
// ---------------------------------------------------------------------------

/**
 * Callback that bridges IBrain.processTurn() to runEmbeddedPiAgent().
 * The harness creates this delegate, wrapping the existing runner.
 */
export type RunnerDelegate = (
  sessionId: string,
  message: string,
  options: RunnerDelegateOptions,
) => Promise<RunnerDelegateResult>;

export interface RunnerDelegateOptions {
  provider: string;
  model: string;
  signal?: AbortSignal;
  onToolCall?: (
    toolName: string,
    params: Record<string, unknown>,
    result: { content: string; is_error: boolean },
    durationMs: number,
  ) => void;
  onGeneration?: (
    purpose: string,
    provider: string,
    model: string,
    usage: TokenUsage,
    durationMs: number,
  ) => void;
  onPartialText?: (text: string) => void;
}

export interface RunnerDelegateResult {
  finalResponse: string;
  stopReason: string;
  usage?: TokenUsage;
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

registerBrain("react", async (config) => {
  const brain = new ReActBrainAdapter();
  await brain.configure(config);
  return brain;
});
