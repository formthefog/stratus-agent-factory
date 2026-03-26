/**
 * Generate Tool Registry — Creates tool definitions from domain analysis
 *
 * Takes a domain analysis and list of available APIs, generates complete
 * tool definitions with rich descriptions matching the training format.
 * Validates embedding-space separation between tool descriptions.
 *
 * @purpose Generate complete tool registry (agent.tools.yaml) from domain analysis
 * @spec AGENT_FACTORY_SPEC.md#c12-generate_tool_registry-tool
 */

import type { DomainAnalysis, DomainAction } from "./analyze_domain.js";
import type { StratusClient } from "../../brain/stratus/index.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GenerateToolRegistryInput {
  /** Domain analysis from analyze_domain */
  analysis: DomainAnalysis;
  /** Available API endpoints with descriptions */
  apis: ApiEndpoint[];
  /** Minimum cosine distance between tool embeddings (default: 0.15) */
  minEmbeddingDistance?: number;
}

export interface ApiEndpoint {
  /** API endpoint path or identifier */
  endpoint: string;
  /** HTTP method or RPC type */
  method?: string;
  /** Description of what this endpoint does */
  description: string;
  /** Parameters accepted */
  parameters?: Array<{
    name: string;
    type: string;
    required: boolean;
    description: string;
  }>;
  /** Example response shape */
  responseShape?: string;
}

export interface ToolDefinition {
  /** Tool identifier (snake_case) */
  id: string;
  /** Action type matching training vocabulary */
  actionType: string;
  /** Domain this tool belongs to */
  domain: string;
  /** Human-readable description */
  description: string;
  /** Rich description for embedding (format: "{type} ({domain}). {desc}. effects: {effects}") */
  richDescription: string;
  /** What this tool changes in the world */
  effects: string;
  /** What must be true before using this tool */
  preconditions: string;
  /** Whether the tool needs LLM-generated parameters */
  requiresGeneration: boolean;
  /** Template for parameter generation (if requiresGeneration) */
  generationTemplate?: string;
  /** API endpoint this tool maps to */
  apiEndpoint?: string;
  /** Parameter schema */
  parameters: ToolParameter[];
}

export interface ToolParameter {
  name: string;
  type: string;
  required: boolean;
  description: string;
  /** Default value if not provided */
  defaultValue?: string;
}

export interface ToolRegistryOutput {
  /** Domain name */
  domain: string;
  /** Generated tool definitions */
  tools: ToolDefinition[];
  /** Tools that are too similar in embedding space */
  similarityWarnings: SimilarityWarning[];
  /** Common domain actions that have no tool mapping */
  missingCapabilities: string[];
  /** YAML content for agent.tools.yaml */
  yaml: string;
}

export interface SimilarityWarning {
  toolA: string;
  toolB: string;
  cosineSimilarity: number;
  suggestion: string;
}

// ---------------------------------------------------------------------------
// LLM Callback
// ---------------------------------------------------------------------------

export type GenerateLlmFn = (prompt: string, signal?: AbortSignal) => Promise<string>;

// ---------------------------------------------------------------------------
// Tool Implementation
// ---------------------------------------------------------------------------

export class GenerateToolRegistryTool {
  private llm: GenerateLlmFn;
  private client: StratusClient | null;

  constructor(llm: GenerateLlmFn, client?: StratusClient) {
    this.llm = llm;
    this.client = client ?? null;
  }

  /**
   * Generate a complete tool registry from domain analysis + APIs.
   */
  async execute(
    input: GenerateToolRegistryInput,
    signal?: AbortSignal,
  ): Promise<ToolRegistryOutput> {
    const { analysis, apis } = input;
    const minDist = input.minEmbeddingDistance ?? 0.15;

    // Step 1: Generate tool definitions
    const tools = await this.generateTools(analysis, apis, signal);

    // Step 2: Validate embedding separation (if sidecar available)
    const similarityWarnings = this.client
      ? await this.validateEmbeddings(tools, minDist, signal)
      : [];

    // Step 3: Find missing capabilities
    const missingCapabilities = this.findMissingCapabilities(analysis, tools);

    // Step 4: Generate YAML output
    const yaml = this.renderYaml(analysis.domainName, tools);

    return {
      domain: analysis.domainName,
      tools,
      similarityWarnings,
      missingCapabilities,
      yaml,
    };
  }

  // -----------------------------------------------------------------------
  // Tool Generation
  // -----------------------------------------------------------------------

  private async generateTools(
    analysis: DomainAnalysis,
    apis: ApiEndpoint[],
    signal?: AbortSignal,
  ): Promise<ToolDefinition[]> {
    const tools: ToolDefinition[] = [];

    // Map domain actions to API endpoints
    for (const action of analysis.actions) {
      const matchedApi = this.matchApiToAction(action, apis);
      const tool = await this.buildToolDefinition(
        analysis.domainName,
        action,
        matchedApi,
        signal,
      );
      tools.push(tool);
    }

    // Check for APIs that don't map to any domain action
    const mappedEndpoints = new Set(tools.map((t) => t.apiEndpoint).filter(Boolean));
    for (const api of apis) {
      if (!mappedEndpoints.has(api.endpoint)) {
        const tool = this.buildToolFromApi(analysis.domainName, api);
        tools.push(tool);
      }
    }

    return tools;
  }

  private matchApiToAction(
    action: DomainAction,
    apis: ApiEndpoint[],
  ): ApiEndpoint | undefined {
    // Simple keyword matching between action type and API endpoints
    const actionWords = action.actionType.toLowerCase().split("_");

    let bestMatch: ApiEndpoint | undefined;
    let bestScore = 0;

    for (const api of apis) {
      const endpointWords = api.endpoint.toLowerCase().split(/[/_-]/);
      const descWords = api.description.toLowerCase().split(/\s+/);
      const allWords = [...endpointWords, ...descWords];

      let score = 0;
      for (const word of actionWords) {
        if (allWords.includes(word)) score += 1;
      }

      if (score > bestScore) {
        bestScore = score;
        bestMatch = api;
      }
    }

    return bestScore > 0 ? bestMatch : undefined;
  }

  private async buildToolDefinition(
    domain: string,
    action: DomainAction,
    api: ApiEndpoint | undefined,
    signal?: AbortSignal,
  ): Promise<ToolDefinition> {
    const richDescription = `${action.actionType} (${domain}). ${action.description}. effects: ${action.effects}`;

    const parameters: ToolParameter[] = api?.parameters?.map((p) => ({
      name: p.name,
      type: p.type,
      required: p.required,
      description: p.description,
    })) ?? [];

    let generationTemplate: string | undefined;
    if (action.requiresGeneration) {
      generationTemplate = await this.generateTemplate(action, api, signal);
    }

    return {
      id: action.actionType,
      actionType: action.actionType,
      domain,
      description: action.description,
      richDescription,
      effects: action.effects,
      preconditions: action.preconditions,
      requiresGeneration: action.requiresGeneration,
      generationTemplate,
      apiEndpoint: api?.endpoint,
      parameters,
    };
  }

  private buildToolFromApi(domain: string, api: ApiEndpoint): ToolDefinition {
    // Infer action type from endpoint
    const actionType = api.endpoint
      .replace(/^\//, "")
      .replace(/[/-]/g, "_")
      .toLowerCase();

    return {
      id: actionType,
      actionType,
      domain,
      description: api.description,
      richDescription: `${actionType} (${domain}). ${api.description}. effects: API call to ${api.endpoint}`,
      effects: `Calls ${api.method ?? "POST"} ${api.endpoint}`,
      preconditions: "API endpoint must be reachable",
      requiresGeneration: (api.parameters?.length ?? 0) > 2,
      apiEndpoint: api.endpoint,
      parameters: api.parameters?.map((p) => ({
        name: p.name,
        type: p.type,
        required: p.required,
        description: p.description,
      })) ?? [],
    };
  }

  private async generateTemplate(
    action: DomainAction,
    api: ApiEndpoint | undefined,
    signal?: AbortSignal,
  ): Promise<string> {
    const paramList = api?.parameters
      ?.map((p) => `  ${p.name}: ${p.type} — ${p.description}`)
      .join("\n") ?? "  (no parameters defined)";

    const prompt = [
      `Generate a concise parameter generation template for this tool:`,
      `Action: ${action.actionType}`,
      `Description: ${action.description}`,
      `Parameters:\n${paramList}`,
      ``,
      `The template should be a short instruction the LLM can follow to generate`,
      `the correct parameters from conversation context. Include placeholders like`,
      `{context}, {user_request}, {entity_name} that will be filled at runtime.`,
      `Return just the template text, no code blocks.`,
    ].join("\n");

    return this.llm(prompt, signal);
  }

  // -----------------------------------------------------------------------
  // Embedding Validation
  // -----------------------------------------------------------------------

  private async validateEmbeddings(
    tools: ToolDefinition[],
    minDist: number,
    signal?: AbortSignal,
  ): Promise<SimilarityWarning[]> {
    if (!this.client || tools.length < 2) return [];

    const descriptions = tools.map((t) => t.richDescription);
    const labels = tools.map((t) => t.id);

    try {
      const response = await this.client.encodeActions(descriptions, labels, signal);
      const embeddings = response.embeddings.map((e) => e.embedding);

      const warnings: SimilarityWarning[] = [];

      for (let i = 0; i < embeddings.length; i++) {
        for (let j = i + 1; j < embeddings.length; j++) {
          const sim = this.cosineSimilarity(embeddings[i], embeddings[j]);
          const dist = 1 - sim;

          if (dist < minDist) {
            warnings.push({
              toolA: labels[i],
              toolB: labels[j],
              cosineSimilarity: sim,
              suggestion: `Tools "${labels[i]}" and "${labels[j]}" are too similar (cos=${sim.toFixed(3)}). Differentiate their descriptions — focus on distinct effects and preconditions.`,
            });
          }
        }
      }

      return warnings;
    } catch {
      return [];
    }
  }

  private cosineSimilarity(a: number[], b: number[]): number {
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    return dot / (Math.sqrt(normA) * Math.sqrt(normB) || 1);
  }

  // -----------------------------------------------------------------------
  // Gap Analysis
  // -----------------------------------------------------------------------

  private findMissingCapabilities(
    analysis: DomainAnalysis,
    tools: ToolDefinition[],
  ): string[] {
    // Common action patterns that most domains need
    const commonPatterns = [
      "list", "get", "create", "update", "delete",
      "search", "notify", "export", "import",
    ];

    const toolActions = new Set(tools.map((t) => t.actionType.toLowerCase()));
    const missing: string[] = [];

    for (const pattern of commonPatterns) {
      const hasPattern = [...toolActions].some((a) => a.includes(pattern));
      // Check if any workflow references this pattern
      const workflowNeeds = analysis.workflows.some((w) =>
        w.steps.some((s) => s.toLowerCase().includes(pattern)),
      );

      if (!hasPattern && workflowNeeds) {
        missing.push(`No "${pattern}" tool found, but workflows reference this capability.`);
      }
    }

    return missing;
  }

  // -----------------------------------------------------------------------
  // YAML Rendering
  // -----------------------------------------------------------------------

  private renderYaml(domain: string, tools: ToolDefinition[]): string {
    const lines: string[] = [];

    lines.push(`# Agent Tool Registry — ${domain}`);
    lines.push(`# Generated by Agent Builder`);
    lines.push(`# ${new Date().toISOString()}`);
    lines.push("");
    lines.push(`domain: ${domain}`);
    lines.push("tools:");

    for (const tool of tools) {
      lines.push(`  - id: ${tool.id}`);
      lines.push(`    action_type: ${tool.actionType}`);
      lines.push(`    description: "${this.escapeYaml(tool.description)}"`);
      lines.push(`    rich_description: "${this.escapeYaml(tool.richDescription)}"`);
      lines.push(`    effects: "${this.escapeYaml(tool.effects)}"`);
      lines.push(`    preconditions: "${this.escapeYaml(tool.preconditions)}"`);
      lines.push(`    requires_generation: ${tool.requiresGeneration}`);

      if (tool.generationTemplate) {
        lines.push(`    generation_template: |`);
        for (const tLine of tool.generationTemplate.split("\n")) {
          lines.push(`      ${tLine}`);
        }
      }

      if (tool.apiEndpoint) {
        lines.push(`    api_endpoint: ${tool.apiEndpoint}`);
      }

      if (tool.parameters.length > 0) {
        lines.push(`    parameters:`);
        for (const p of tool.parameters) {
          lines.push(`      - name: ${p.name}`);
          lines.push(`        type: ${p.type}`);
          lines.push(`        required: ${p.required}`);
          lines.push(`        description: "${this.escapeYaml(p.description)}"`);
        }
      }

      lines.push("");
    }

    return lines.join("\n");
  }

  private escapeYaml(s: string): string {
    return s.replace(/"/g, '\\"').replace(/\n/g, " ");
  }
}
