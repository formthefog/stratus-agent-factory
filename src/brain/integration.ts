/**
 * Brain Integration — Bridges IBrain interface with OpenClaw agent runtime
 *
 * This module provides the wiring between the BrainRegistry and the existing
 * pi-embedded-runner infrastructure. It does NOT modify the runner — it wraps it.
 *
 * For ReAct brain: delegates directly to runEmbeddedPiAgent (identical behavior)
 * For Stratus brain: creates a StratusBrain, processes turns, and translates
 *   the response into EmbeddedPiRunResult format for the caller
 *
 * The caller (runtime-embedded-pi.runtime.ts or any channel handler) calls
 * runAgentWithBrain() instead of runEmbeddedPiAgent() directly.
 *
 * @purpose Bridge between IBrain interface and OpenClaw agent runtime
 * @spec AGENT_FACTORY_SPEC.md#a25-wire-brain-registry-into-agent-runtime
 */

import type {
  IBrain,
  BrainConfig,
  BrainResponse,
  BrainToolDefinition,
  BrainTurnEvent,
  ToolResult,
} from "./IBrain.js";
import { createBrain, hasBrain } from "./BrainRegistry.js";
import type { ReActBrainAdapter, RunnerDelegateResult } from "./ReActBrainAdapter.js";
import { convertToolRegistrations, type OpenClawToolRegistration } from "./tools/index.js";

// Re-export for convenience
export { createBrain, hasBrain } from "./BrainRegistry.js";

// ---------------------------------------------------------------------------
// Types matching OpenClaw's existing interfaces (imported at runtime)
// ---------------------------------------------------------------------------

/**
 * Minimal subset of RunEmbeddedPiAgentParams needed by the brain integration.
 * We use a structural type to avoid importing the full params type (which pulls
 * in 50+ transitive dependencies).
 */
export interface BrainAgentParams {
  sessionId: string;
  prompt: string;
  provider: string;
  model: string;
  sessionFile: string;
  workspaceDir: string;
  images?: Array<{ data: string; media_type: string }>;
  abortSignal?: AbortSignal;
  config?: Record<string, unknown>;

  // Streaming callbacks (passed through to brain events)
  onPartialReply?: (payload: { text: string }) => void;
  onToolResult?: (payload: { toolName: string; result: string }) => void;
  onBlockReply?: (payload: { text: string }) => void;

  // All other params are passed through to the original runner
  [key: string]: unknown;
}

/**
 * Result type that matches EmbeddedPiRunResult structure.
 * Used to translate BrainResponse back into the format the harness expects.
 */
export interface BrainRunResult {
  payloads: Array<{
    text?: string;
    mediaUrl?: string;
    mediaUrls?: string[];
    isError?: boolean;
    isReasoning?: boolean;
  }>;
  meta: {
    durationMs: number;
    stopReason?: string;
    agentMeta?: {
      sessionId: string;
      provider: string;
      model: string;
      usage?: {
        input: number;
        output: number;
        total: number;
      };
    };
    brainMeta?: {
      type: string;
      goalProximity: number;
      stepsTaken: number;
      actionsCount: number;
      generationsCount: number;
    };
    error?: {
      kind: string;
      message: string;
    };
  };
}

// ---------------------------------------------------------------------------
// Brain Configuration Resolution
// ---------------------------------------------------------------------------

/**
 * Extract brain configuration from an agent's config.
 * Returns null if no brain config is present (use default ReAct).
 *
 * Brain config lives at `config.brain` in the agent's openclaw.json:
 * ```json
 * {
 *   "brain": {
 *     "type": "stratus",
 *     "llm_provider": "anthropic",
 *     "llm_model": "claude-sonnet-4-20250514",
 *     "max_steps_per_turn": 20,
 *     "stratus": {
 *       "sidecar_url": "http://localhost:8100",
 *       "probe_id": "planning-v2",
 *       "goal_threshold": 0.85,
 *       "tree_search_depth": 3,
 *       "tree_search_width": 5,
 *       "ambiguity_threshold": 0.2
 *     }
 *   }
 * }
 * ```
 */
export function resolveBrainConfig(
  agentConfig: Record<string, unknown> | undefined,
): BrainConfig | null {
  if (!agentConfig) return null;

  const brainRaw = agentConfig.brain;
  if (!brainRaw || typeof brainRaw !== "object") return null;

  const brain = brainRaw as Record<string, unknown>;
  const type = brain.type as string;

  if (!type || type === "react") {
    // Explicit "react" or missing type — use default behavior
    return null;
  }

  return {
    type: type as "react" | "stratus",
    llm_provider: (brain.llm_provider as string) ?? "anthropic",
    llm_model: (brain.llm_model as string) ?? "claude-sonnet-4-20250514",
    max_steps_per_turn: (brain.max_steps_per_turn as number) ?? 20,
    stratus: brain.stratus
      ? {
          sidecar_url: ((brain.stratus as Record<string, unknown>).sidecar_url as string) ?? "http://localhost:8100",
          probe_id: ((brain.stratus as Record<string, unknown>).probe_id as string) ?? "planning-v2",
          goal_threshold: ((brain.stratus as Record<string, unknown>).goal_threshold as number) ?? 0.85,
          tree_search_depth: ((brain.stratus as Record<string, unknown>).tree_search_depth as number) ?? 3,
          tree_search_width: ((brain.stratus as Record<string, unknown>).tree_search_width as number) ?? 5,
          ambiguity_threshold: ((brain.stratus as Record<string, unknown>).ambiguity_threshold as number) ?? 0.2,
        }
      : undefined,
  };
}

// ---------------------------------------------------------------------------
// Brain Instance Cache
// ---------------------------------------------------------------------------

const brainCache = new Map<string, IBrain>();

/**
 * Get or create a brain instance for the given config.
 * Caches by brain type to avoid re-initialization.
 */
async function getOrCreateBrain(config: BrainConfig): Promise<IBrain> {
  const key = `${config.type}:${config.stratus?.sidecar_url ?? "default"}`;
  let brain = brainCache.get(key);
  if (!brain) {
    brain = await createBrain(config);
    brainCache.set(key, brain);
  }
  return brain;
}

// ---------------------------------------------------------------------------
// Event Translation
// ---------------------------------------------------------------------------

/**
 * Translates BrainTurnEvents into OpenClaw streaming callbacks.
 */
function createEventBridge(params: BrainAgentParams): (event: BrainTurnEvent) => void {
  return (event: BrainTurnEvent) => {
    switch (event.type) {
      case "thinking":
        params.onPartialReply?.({ text: event.text });
        break;
      case "action_complete":
        params.onToolResult?.({ toolName: event.tool, result: event.result });
        break;
      case "generation_complete":
        params.onBlockReply?.({ text: event.text });
        break;
      case "progress":
        params.onPartialReply?.({ text: event.message });
        break;
      case "error":
        params.onPartialReply?.({ text: `Error: ${event.error.message}` });
        break;
    }
  };
}

// ---------------------------------------------------------------------------
// Response Translation
// ---------------------------------------------------------------------------

/**
 * Translate a BrainResponse into the EmbeddedPiRunResult-compatible format.
 */
function translateResponse(
  sessionId: string,
  brainResponse: BrainResponse,
  config: BrainConfig,
): BrainRunResult {
  return {
    payloads: [
      {
        text: brainResponse.final_response,
        isError: brainResponse.stop_reason === "error",
      },
    ],
    meta: {
      durationMs: brainResponse.duration_ms,
      stopReason:
        brainResponse.stop_reason === "goal_reached" || brainResponse.stop_reason === "end_turn"
          ? "end_turn"
          : brainResponse.stop_reason,
      agentMeta: {
        sessionId,
        provider: config.llm_provider,
        model: config.llm_model,
        usage: {
          input: brainResponse.total_usage.input_tokens,
          output: brainResponse.total_usage.output_tokens,
          total: brainResponse.total_usage.total_tokens,
        },
      },
      brainMeta: {
        type: config.type,
        goalProximity: brainResponse.goal_proximity,
        stepsTaken: brainResponse.steps_taken,
        actionsCount: brainResponse.actions_taken.length,
        generationsCount: brainResponse.generation_calls.length,
      },
      error: brainResponse.error
        ? { kind: brainResponse.error.kind, message: brainResponse.error.message }
        : undefined,
    },
  };
}

// ---------------------------------------------------------------------------
// Tool Extraction
// ---------------------------------------------------------------------------

/**
 * Extract BrainToolDefinitions from the agent's config.
 *
 * If the config contains `toolRegistrations` (OpenClaw's PluginToolRegistration[]),
 * converts them through the Tool Registry Bridge. Otherwise returns empty —
 * the brain will use its own tool discovery or sidecar-registered tools.
 */
export function extractToolDefinitions(
  agentConfig: Record<string, unknown> | undefined,
): BrainToolDefinition[] {
  if (!agentConfig) return [];

  const registrations = agentConfig.toolRegistrations;
  if (!registrations || !Array.isArray(registrations)) return [];

  try {
    return convertToolRegistrations(registrations as OpenClawToolRegistration[],
      (agentConfig.toolContext as Record<string, unknown>) ?? {},
    );
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Main Entry Point
// ---------------------------------------------------------------------------

/**
 * Run an agent turn with brain-aware routing.
 *
 * If the agent's config specifies a Stratus brain, this function:
 * 1. Creates/retrieves the Stratus brain instance
 * 2. Processes the turn through IBrain.processTurn()
 * 3. Translates the response to EmbeddedPiRunResult format
 *
 * If no brain config or brain type is "react", this function returns null,
 * signaling the caller to use the standard runEmbeddedPiAgent path.
 *
 * @returns BrainRunResult if brain handled the turn, null if caller should use default path
 */
export async function runWithBrain(
  params: BrainAgentParams,
): Promise<BrainRunResult | null> {
  const brainConfig = resolveBrainConfig(params.config as Record<string, unknown> | undefined);

  // No brain config or react type — fall through to standard runner
  if (!brainConfig) return null;

  // Check if the brain type is actually registered
  if (!hasBrain(brainConfig.type)) {
    console.warn(
      `[brain/integration] Brain type "${brainConfig.type}" not registered, using default runner`,
    );
    return null;
  }

  const brain = await getOrCreateBrain(brainConfig);

  // Register tools (A.3 placeholder)
  const tools = extractToolDefinitions(params.config as Record<string, unknown> | undefined);
  if (tools.length > 0) {
    await brain.registerTools(tools);
  }

  // Create tool executor that bridges to OpenClaw's tool execution
  const executor = async (
    toolId: string,
    parameters: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<ToolResult> => {
    // TODO: Bridge to OpenClaw's actual tool execution infrastructure
    // For now, this is a stub that will be completed when the StratusBrain
    // is implemented (B.4). The ReActBrainAdapter uses the RunnerDelegate
    // pattern instead, which already bridges to the existing runner.
    return {
      content: `Tool execution not yet bridged: ${toolId}`,
      is_error: true,
      duration_ms: 0,
    };
  };

  // Process the turn
  const eventBridge = createEventBridge(params);
  const response = await brain.processTurn(
    params.sessionId,
    params.prompt,
    executor,
    {
      images: params.images,
      signal: params.abortSignal,
    },
    eventBridge,
  );

  return translateResponse(params.sessionId, response, brainConfig);
}

// ---------------------------------------------------------------------------
// Runner Wrapper
// ---------------------------------------------------------------------------

/**
 * Wraps the existing runEmbeddedPiAgent to add brain-awareness.
 *
 * Usage in the runtime plugin:
 * ```typescript
 * // Before (existing code):
 * const result = await runEmbeddedPiAgent(params);
 *
 * // After (brain-aware):
 * const result = await runAgentWithBrain(params, runEmbeddedPiAgent);
 * ```
 *
 * This preserves 100% backward compatibility: if no brain config is present,
 * the original runEmbeddedPiAgent is called unchanged.
 */
export async function runAgentWithBrain<TParams extends BrainAgentParams, TResult>(
  params: TParams,
  fallbackRunner: (params: TParams) => Promise<TResult>,
): Promise<TResult | BrainRunResult> {
  // Try brain-aware path first
  const brainResult = await runWithBrain(params);
  if (brainResult) return brainResult;

  // Fall through to standard runner
  return fallbackRunner(params);
}
