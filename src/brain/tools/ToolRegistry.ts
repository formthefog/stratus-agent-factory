/**
 * Tool Registry — Bridges OpenClaw plugin tools to BrainToolDefinition
 *
 * Converts OpenClaw's TypeBox-based tool definitions into the JSON-serializable
 * BrainToolDefinition format that both ReAct and Stratus brains consume.
 *
 * OpenClaw tools are discovered at plugin load time via registerTool() calls.
 * This module reads those registrations and converts them into a format the
 * brain can use for action encoding (Stratus) or prompt injection (ReAct).
 *
 * @purpose Skill-to-tool registry bridge between OpenClaw plugins and IBrain
 * @spec AGENT_FACTORY_SPEC.md#a32-tool-registry-entry
 */

import type { BrainToolDefinition } from "../IBrain.js";

// ---------------------------------------------------------------------------
// OpenClaw Tool Shape (structural typing — no import dependency)
// ---------------------------------------------------------------------------

/**
 * Structural type matching OpenClaw's AnyAgentTool shape.
 * We use structural typing to avoid importing OpenClaw's full type tree.
 */
export interface OpenClawTool {
  name: string;
  label?: string;
  description?: string;
  parameters?: Record<string, unknown>;
  execute?: (id: string, params: Record<string, unknown>) => Promise<unknown>;
}

/**
 * Matches OpenClaw's PluginToolRegistration shape.
 */
export interface OpenClawToolRegistration {
  pluginId: string;
  pluginName?: string;
  names: string[];
  optional: boolean;
  factory?: (ctx: Record<string, unknown>) => OpenClawTool | OpenClawTool[] | null;
}

// ---------------------------------------------------------------------------
// Registry Entry (intermediate format)
// ---------------------------------------------------------------------------

/**
 * A tool entry in the registry. JSON-serializable.
 * This is the intermediate format between OpenClaw's runtime tool objects
 * and BrainToolDefinition's training-oriented format.
 */
export interface ToolRegistryEntry {
  /** Unique tool ID (from OpenClaw tool name) */
  id: string;
  /** Display name */
  name: string;
  /** Plugin that registered this tool */
  pluginId: string;
  /** Natural language description */
  description: string;
  /** JSON Schema for parameters (converted from TypeBox) */
  parametersSchema: Record<string, unknown>;
  /** Whether the tool is optional */
  optional: boolean;
  /** Domain/category (inferred from plugin or explicit) */
  domain: string;
  /** Inferred effects from description */
  effects: string[];
  /** Inferred preconditions */
  preconditions: string[];
  /** Action-based sub-commands if tool uses action pattern */
  actions?: ToolAction[];
}

/** Sub-action for tools that use the action dispatch pattern. */
export interface ToolAction {
  name: string;
  description: string;
  schema?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Converter: OpenClaw Tool → ToolRegistryEntry
// ---------------------------------------------------------------------------

/**
 * Convert an OpenClaw tool registration into a ToolRegistryEntry.
 */
export function openClawToolToEntry(
  tool: OpenClawTool,
  registration: { pluginId: string; optional: boolean },
): ToolRegistryEntry {
  const schema = extractJsonSchema(tool.parameters);
  const actions = extractActions(schema);
  const description = tool.description ?? `Tool: ${tool.name}`;

  return {
    id: tool.name,
    name: tool.label ?? tool.name,
    pluginId: registration.pluginId,
    description,
    parametersSchema: schema,
    optional: registration.optional,
    domain: inferDomain(registration.pluginId, tool.name),
    effects: inferEffects(description),
    preconditions: inferPreconditions(schema),
    actions: actions.length > 0 ? actions : undefined,
  };
}

// ---------------------------------------------------------------------------
// Converter: ToolRegistryEntry → BrainToolDefinition
// ---------------------------------------------------------------------------

/**
 * Convert a ToolRegistryEntry into a BrainToolDefinition for the brain.
 *
 * The rich_description field is formatted for the Stratus action encoder:
 * "{name}: {description}. Effects: {effects}. Requires: {preconditions}"
 */
export function entryToBrainTool(entry: ToolRegistryEntry): BrainToolDefinition {
  const effects = entry.effects.length > 0 ? entry.effects.join(", ") : "unknown";
  const preconditions =
    entry.preconditions.length > 0 ? entry.preconditions.join(", ") : "none";

  // Build rich description matching the action encoder's expected format
  const richDescription =
    `${entry.name}: ${entry.description}. Effects: ${effects}. Requires: ${preconditions}`;

  // Determine if this tool needs LLM generation for its parameters
  const requiresGeneration = hasComplexParameters(entry.parametersSchema);

  return {
    id: entry.id,
    name: entry.name,
    description: entry.description,
    rich_description: richDescription,
    parameters: entry.parametersSchema,
    requires_generation: requiresGeneration,
    generation_template: requiresGeneration
      ? buildGenerationTemplate(entry)
      : undefined,
    domain: entry.domain,
    effects: entry.effects,
    preconditions: entry.preconditions,
  };
}

// ---------------------------------------------------------------------------
// Batch Conversion
// ---------------------------------------------------------------------------

/**
 * Convert a set of OpenClaw tool registrations into BrainToolDefinitions.
 * This is the main entry point for the integration layer.
 */
export function convertToolRegistrations(
  registrations: OpenClawToolRegistration[],
  toolContext: Record<string, unknown> = {},
): BrainToolDefinition[] {
  const results: BrainToolDefinition[] = [];

  for (const reg of registrations) {
    if (!reg.factory) continue;

    try {
      const toolOrTools = reg.factory(toolContext);
      if (!toolOrTools) continue;

      const tools = Array.isArray(toolOrTools) ? toolOrTools : [toolOrTools];

      for (const tool of tools) {
        const entry = openClawToolToEntry(tool, {
          pluginId: reg.pluginId,
          optional: reg.optional,
        });
        results.push(entryToBrainTool(entry));
      }
    } catch {
      // Skip tools that fail to instantiate (missing config, etc.)
      continue;
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Schema Extraction
// ---------------------------------------------------------------------------

/**
 * Extract a plain JSON Schema from a TypeBox schema or pass through raw JSON Schema.
 *
 * TypeBox schemas are JSON Schema compatible — they have `type`, `properties`, etc.
 * We strip TypeBox-specific symbols and metadata to get clean JSON Schema.
 */
function extractJsonSchema(
  parameters: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!parameters) return { type: "object", properties: {} };

  // TypeBox schemas are already JSON Schema compatible at the structural level.
  // Strip Symbol keys and internal TypeBox metadata.
  return JSON.parse(JSON.stringify(parameters));
}

/**
 * Detect tools that use the action dispatch pattern:
 * parameters.properties.action with enum values.
 */
function extractActions(schema: Record<string, unknown>): ToolAction[] {
  const props = schema.properties as Record<string, unknown> | undefined;
  if (!props) return [];

  const actionProp = props.action as Record<string, unknown> | undefined;
  if (!actionProp) return [];

  const enumValues = actionProp.enum as string[] | undefined;
  if (!enumValues || !Array.isArray(enumValues)) return [];

  return enumValues.map((name) => ({
    name,
    description: `Action: ${name}`,
  }));
}

// ---------------------------------------------------------------------------
// Inference Helpers
// ---------------------------------------------------------------------------

/** Infer domain from plugin ID. */
function inferDomain(pluginId: string, toolName: string): string {
  // Known plugin → domain mappings
  const domainMap: Record<string, string> = {
    "feishu": "collaboration",
    "discord": "messaging",
    "msteams": "messaging",
    "slack": "messaging",
    "brave": "web-search",
    "exa": "web-search",
    "firecrawl": "web-search",
    "diffs": "development",
    "lobster": "workflow",
    "llm-task": "ai",
    "memory-core": "memory",
    "elevenlabs": "media",
    "deepgram": "media",
  };
  return domainMap[pluginId] ?? pluginId;
}

/** Infer effects from tool description using keyword matching. */
function inferEffects(description: string): string[] {
  const effects: string[] = [];
  const lower = description.toLowerCase();

  if (/creat|add|insert|write|post|send|publish/.test(lower)) {
    effects.push("creates_resource");
  }
  if (/updat|edit|modif|chang|set|configur/.test(lower)) {
    effects.push("modifies_resource");
  }
  if (/delet|remov|drop|clear|destroy/.test(lower)) {
    effects.push("deletes_resource");
  }
  if (/read|get|fetch|list|search|query|find|view/.test(lower)) {
    effects.push("reads_resource");
  }

  return effects.length > 0 ? effects : ["unknown"];
}

/** Infer preconditions from schema (required parameters). */
function inferPreconditions(schema: Record<string, unknown>): string[] {
  const required = schema.required as string[] | undefined;
  if (!required || required.length === 0) return [];
  return required.map((param) => `requires_${param}`);
}

/** Check if parameters require LLM generation (has string/object params beyond simple enums). */
function hasComplexParameters(schema: Record<string, unknown>): boolean {
  const props = schema.properties as Record<string, Record<string, unknown>> | undefined;
  if (!props) return false;

  for (const prop of Object.values(props)) {
    if (prop.type === "string" && !prop.enum) return true;
    if (prop.type === "object") return true;
    if (prop.type === "array") return true;
  }
  return false;
}

/** Build a generation template for tools that need LLM parameter filling. */
function buildGenerationTemplate(entry: ToolRegistryEntry): string {
  const props = entry.parametersSchema.properties as
    | Record<string, Record<string, unknown>>
    | undefined;
  if (!props) return `Generate parameters for ${entry.name}.`;

  const paramLines = Object.entries(props).map(([name, schema]) => {
    const desc = (schema.description as string) ?? name;
    const required = (
      (entry.parametersSchema.required as string[]) ?? []
    ).includes(name);
    return `- ${name}${required ? " (required)" : ""}: ${desc}`;
  });

  return [
    `Generate parameters for tool "${entry.name}":`,
    `Description: ${entry.description}`,
    `Parameters:`,
    ...paramLines,
  ].join("\n");
}
