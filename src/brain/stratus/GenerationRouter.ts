/**
 * Generation Router — Determines if selected action needs LLM generation
 *
 * After the world model selects an action (tool), this router checks whether
 * the tool's parameters need LLM generation (free-text, code, etc.) or are
 * fully specified by the brain (API calls with known params).
 *
 * @purpose Route selected actions to LLM generation or direct execution
 * @spec AGENT_FACTORY_SPEC.md#b33-build-generation-router
 */

import type { BrainToolDefinition } from "../IBrain.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Callback to generate parameters via LLM. Caller provides the LLM. */
export type GenerateFn = (prompt: string) => Promise<string>;

export interface GenerationResult {
  /** Filled tool parameters ready for execution */
  parameters: Record<string, unknown>;
  /** Whether LLM generation was used */
  usedGeneration: boolean;
  /** Generation latency in ms (0 if no generation) */
  generationMs: number;
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export class GenerationRouter {
  private generateFn: GenerateFn | null;

  constructor(generateFn?: GenerateFn) {
    this.generateFn = generateFn ?? null;
  }

  /**
   * Route a selected action to either direct execution or LLM generation.
   *
   * @param tool - The selected tool definition
   * @param context - Current context (goal, state summary) for generation prompt
   * @param knownParams - Any parameters already known (from prior steps, config, etc.)
   */
  async route(
    tool: BrainToolDefinition,
    context: string,
    knownParams: Record<string, unknown> = {},
  ): Promise<GenerationResult> {
    // If tool doesn't need generation, return known params directly
    if (!tool.requires_generation) {
      return {
        parameters: knownParams,
        usedGeneration: false,
        generationMs: 0,
      };
    }

    // Tool needs generation — check if we have a generator
    if (!this.generateFn) {
      // No LLM available; return what we have
      return {
        parameters: knownParams,
        usedGeneration: false,
        generationMs: 0,
      };
    }

    const start = Date.now();

    // Build generation prompt from tool template + context
    const prompt = this.buildPrompt(tool, context, knownParams);
    const generated = await this.generateFn(prompt);

    // Parse generated output into parameters
    const parameters = this.parseGenerated(tool, generated, knownParams);

    return {
      parameters,
      usedGeneration: true,
      generationMs: Date.now() - start,
    };
  }

  // -----------------------------------------------------------------------
  // Prompt Building
  // -----------------------------------------------------------------------

  private buildPrompt(
    tool: BrainToolDefinition,
    context: string,
    knownParams: Record<string, unknown>,
  ): string {
    const parts: string[] = [];

    // Use tool's generation template if available
    if (tool.generation_template) {
      parts.push(tool.generation_template);
    } else {
      parts.push(`Generate parameters for tool "${tool.name}".`);
      parts.push(`Description: ${tool.description}`);
    }

    parts.push("");
    parts.push("Context:");
    parts.push(context);

    if (Object.keys(knownParams).length > 0) {
      parts.push("");
      parts.push("Already known parameters:");
      parts.push(JSON.stringify(knownParams, null, 2));
      parts.push("Generate ONLY the missing parameters.");
    }

    parts.push("");
    parts.push("Return ONLY valid JSON with the parameter values. No explanation.");

    return parts.join("\n");
  }

  // -----------------------------------------------------------------------
  // Response Parsing
  // -----------------------------------------------------------------------

  private parseGenerated(
    tool: BrainToolDefinition,
    generated: string,
    knownParams: Record<string, unknown>,
  ): Record<string, unknown> {
    // Try to extract JSON from LLM response
    const jsonStr = this.extractJson(generated);
    let parsed: Record<string, unknown> = {};

    try {
      parsed = JSON.parse(jsonStr);
    } catch {
      // If JSON parsing fails, try to use the raw text as a single parameter
      const schema = tool.parameters;
      const props = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
      const stringParams = Object.entries(props)
        .filter(([, v]) => v.type === "string")
        .map(([k]) => k);

      if (stringParams.length === 1) {
        parsed = { [stringParams[0]]: generated.trim() };
      }
    }

    // Merge with known params (known takes precedence)
    return { ...parsed, ...knownParams };
  }

  private extractJson(text: string): string {
    // Try to find JSON in code block
    const codeBlock = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
    if (codeBlock) return codeBlock[1].trim();

    // Try to find JSON object directly
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) return jsonMatch[0];

    return text.trim();
  }
}
