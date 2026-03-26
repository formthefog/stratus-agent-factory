/**
 * Tool Definition Helpers — Structured tool creation for the transformation product
 *
 * When the transformation consultant identifies customer tools/APIs,
 * these helpers convert them into properly formatted tool registry entries
 * with auto-generated rich descriptions matching the Stratus training format.
 *
 * @purpose Convert customer tool descriptions into Stratus-compatible tool definitions
 * @spec AGENT_FACTORY_SPEC.md#f22-build-tool-definition-helpers
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ToolDefinitionInput {
  /** Tool name (e.g., "check_deployment_status") */
  name: string;
  /** Domain this tool belongs to */
  domain: string;
  /** Plain English description */
  description: string;
  /** What this tool does when executed */
  effects: string[];
  /** What must be true before using this tool */
  preconditions?: string[];
  /** Whether the tool needs LLM-generated content (e.g., email body) */
  requiresGeneration?: boolean;
  /** Template for generation (if requiresGeneration) */
  generationTemplate?: string;
  /** API endpoint (if tool wraps an API) */
  apiEndpoint?: {
    url: string;
    method: string;
    parameters?: Record<string, string>;
  };
}

export interface ToolRegistryEntry {
  id: string;
  action_type: string;
  description: string;
  rich_description: string;
  effects: string;
  preconditions: string;
  requires_generation: boolean;
  generation_template?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Define a tool with structured input. Auto-generates the rich_description
 * in the format that Stratus's ActionEncoder was trained on.
 */
export function defineTool(input: ToolDefinitionInput): ToolRegistryEntry {
  const actionType = input.name.replace(/-/g, "_");
  const effectsStr = input.effects.join(", ");
  const precondStr = input.preconditions?.join(", ") ?? "None";

  // Auto-generate rich_description matching training format:
  // "{action_type} ({domain}). {description}. effects: {effects}"
  const richDescription =
    `${actionType} (${input.domain}). ${input.description}. effects: ${effectsStr}`;

  return {
    id: actionType,
    action_type: actionType,
    description: input.description,
    rich_description: richDescription,
    effects: effectsStr,
    preconditions: precondStr,
    requires_generation: input.requiresGeneration ?? false,
    generation_template: input.generationTemplate,
  };
}

/**
 * Convert an array of tool definitions into agent.tools.yaml format.
 */
export function toToolRegistryYaml(
  domain: string,
  tools: ToolRegistryEntry[],
): string {
  const lines: string[] = [`domain: ${domain}`, "", "tools:"];

  for (const tool of tools) {
    lines.push(`  - id: ${tool.id}`);
    lines.push(`    action_type: ${tool.action_type}`);
    lines.push(`    description: "${tool.description}"`);
    lines.push(`    rich_description: "${tool.rich_description}"`);
    lines.push(`    effects: "${tool.effects}"`);
    lines.push(`    preconditions: "${tool.preconditions}"`);
    lines.push(`    requires_generation: ${tool.requires_generation}`);

    if (tool.generation_template) {
      lines.push("    generation_template: |");
      for (const tmplLine of tool.generation_template.split("\n")) {
        lines.push(`      ${tmplLine}`);
      }
    }

    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Validate that tools are sufficiently distinct in description.
 * Uses simple heuristic (word overlap) — for embedding-space validation,
 * use GenerateToolRegistryTool which calls the sidecar.
 */
export function validateToolSeparation(
  tools: ToolRegistryEntry[],
): { valid: boolean; warnings: string[] } {
  const warnings: string[] = [];

  for (let i = 0; i < tools.length; i++) {
    for (let j = i + 1; j < tools.length; j++) {
      const overlap = wordOverlap(
        tools[i].rich_description,
        tools[j].rich_description,
      );

      if (overlap > 0.8) {
        warnings.push(
          `Tools "${tools[i].id}" and "${tools[j].id}" have ${(overlap * 100).toFixed(0)}% word overlap — may be confused in embedding space`,
        );
      }
    }
  }

  return { valid: warnings.length === 0, warnings };
}

/**
 * Convert API endpoint specs (from consultant discovery) into tool definitions.
 */
export function apiEndpointToTool(
  endpoint: {
    name: string;
    url: string;
    method: string;
    description: string;
    parameters?: Record<string, string>;
  },
  domain: string,
): ToolDefinitionInput {
  return {
    name: endpoint.name,
    domain,
    description: endpoint.description,
    effects: [`${endpoint.description} via ${endpoint.method} ${endpoint.url}`],
    preconditions: endpoint.parameters
      ? Object.keys(endpoint.parameters).map((p) => `${p} provided`)
      : undefined,
    apiEndpoint: {
      url: endpoint.url,
      method: endpoint.method,
      parameters: endpoint.parameters,
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function wordOverlap(a: string, b: string): number {
  const wordsA = new Set(a.toLowerCase().split(/\W+/).filter(Boolean));
  const wordsB = new Set(b.toLowerCase().split(/\W+/).filter(Boolean));

  let overlap = 0;
  for (const word of wordsA) {
    if (wordsB.has(word)) overlap++;
  }

  const union = new Set([...wordsA, ...wordsB]).size;
  return union > 0 ? overlap / union : 0;
}
