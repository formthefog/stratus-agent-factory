/**
 * Action Executor Bridge — Maps Stratus actions to OpenClaw tool execution
 *
 * Takes a selected + parameterized action from the Stratus brain and routes it
 * through the harness-provided ToolExecutor callback. Captures the result for
 * observation encoding.
 *
 * This is the bridge between Stratus's action selection (embedding space) and
 * OpenClaw's tool execution (runtime). The brain decides WHICH tool and WITH
 * WHAT parameters; this bridge handles the actual execution.
 *
 * @purpose Bridge between Stratus action selection and OpenClaw tool execution
 * @spec AGENT_FACTORY_SPEC.md#b34-build-action-executor-bridge
 */

import type { ToolExecutor, ToolResult } from "../IBrain.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ExecutionRequest {
  /** Tool ID to execute */
  toolId: string;
  /** Tool name (for logging) */
  toolName: string;
  /** Generated/specified parameters */
  parameters: Record<string, unknown>;
}

export interface ExecutionResult {
  /** The raw tool result */
  result: ToolResult;
  /** Execution time in ms */
  executionMs: number;
  /** Summary suitable for state tracking */
  summary: string;
  /** Whether any knowledge was gained (non-empty output) */
  hasOutput: boolean;
}

export interface ExecutionOptions {
  /** Timeout for this specific execution (ms) */
  timeoutMs?: number;
  /** Abort signal */
  signal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

export class ActionExecutor {
  private executor: ToolExecutor;

  constructor(executor: ToolExecutor) {
    this.executor = executor;
  }

  /**
   * Execute a selected action through the harness.
   */
  async execute(
    request: ExecutionRequest,
    options?: ExecutionOptions,
  ): Promise<ExecutionResult> {
    const start = Date.now();

    // Create abort signal with timeout if specified
    let signal = options?.signal;
    if (options?.timeoutMs && !signal) {
      signal = AbortSignal.timeout(options.timeoutMs);
    }

    // Execute through the harness callback
    const result = await this.executor(
      request.toolId,
      request.parameters,
      signal,
    );

    const executionMs = Date.now() - start;

    // Build summary for state tracking
    const summary = this.buildSummary(request, result);
    const hasOutput = result.output !== undefined && result.output !== null && result.output !== "";

    return {
      result,
      executionMs,
      summary,
      hasOutput,
    };
  }

  // -----------------------------------------------------------------------
  // Summary Building
  // -----------------------------------------------------------------------

  private buildSummary(request: ExecutionRequest, result: ToolResult): string {
    const status = result.success ? "OK" : "FAILED";
    const output = this.truncateOutput(result.output);
    const params = this.summarizeParams(request.parameters);

    return `${request.toolName}(${params}) → ${status}: ${output}`;
  }

  private truncateOutput(output: unknown): string {
    if (output === undefined || output === null) return "(no output)";
    const str = typeof output === "string" ? output : JSON.stringify(output);
    return str.length > 200 ? str.slice(0, 197) + "..." : str;
  }

  private summarizeParams(params: Record<string, unknown>): string {
    const entries = Object.entries(params);
    if (entries.length === 0) return "";
    if (entries.length === 1) {
      const [key, val] = entries[0];
      const valStr = typeof val === "string" ? val : JSON.stringify(val);
      return `${key}=${valStr.length > 50 ? valStr.slice(0, 47) + "..." : valStr}`;
    }
    return entries.map(([k]) => k).join(", ");
  }
}
