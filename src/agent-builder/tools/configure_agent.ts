/**
 * Configure Agent — Generates a complete agent configuration directory
 *
 * Takes all outputs from prior tools (domain analysis, tool registry,
 * probe selection) and generates the full agent configuration:
 * openclaw.json, skill manifests, AGENTS.md, SOUL.md, memory templates.
 *
 * @purpose Generate complete agent configuration directory
 * @spec AGENT_FACTORY_SPEC.md#c16-configure_agent-tool
 */

import type { DomainAnalysis } from "./analyze_domain.js";
import type { ToolDefinition, ToolRegistryOutput } from "./generate_tool_registry.js";
import type { ProbeRecommendation } from "./select_probe.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ConfigureAgentInput {
  /** Agent name (human-readable) */
  agentName: string;
  /** Agent identifier (snake_case) */
  agentId: string;
  /** Domain analysis */
  analysis: DomainAnalysis;
  /** Tool registry output */
  toolRegistry: ToolRegistryOutput;
  /** Probe recommendation */
  probe: ProbeRecommendation;
  /** LLM preferences */
  llm: {
    provider: string;
    model: string;
  };
  /** Communication channels to configure */
  channels?: ChannelConfig[];
  /** Agent persona description (optional — generated if missing) */
  personaDescription?: string;
  /** Custom instructions to include in AGENTS.md */
  customInstructions?: string;
  /** Max steps per turn (default: from probe recommendation) */
  maxSteps?: number;
}

export interface ChannelConfig {
  type: "slack" | "discord" | "telegram" | "web" | "api";
  /** Channel-specific settings */
  settings: Record<string, string>;
}

export interface AgentConfigOutput {
  /** Base directory for the agent config */
  agentDir: string;
  /** All files that were generated */
  files: GeneratedFile[];
  /** The openclaw.json content */
  openclawConfig: Record<string, unknown>;
  /** Validation notes */
  notes: string[];
}

export interface GeneratedFile {
  /** Path relative to agent directory */
  path: string;
  /** File content */
  content: string;
  /** What this file does */
  purpose: string;
}

// ---------------------------------------------------------------------------
// LLM Callback
// ---------------------------------------------------------------------------

export type ConfigureLlmFn = (prompt: string, signal?: AbortSignal) => Promise<string>;

// ---------------------------------------------------------------------------
// Tool Implementation
// ---------------------------------------------------------------------------

export class ConfigureAgentTool {
  private llm: ConfigureLlmFn;

  constructor(llm: ConfigureLlmFn) {
    this.llm = llm;
  }

  async execute(
    input: ConfigureAgentInput,
    signal?: AbortSignal,
  ): Promise<AgentConfigOutput> {
    const files: GeneratedFile[] = [];
    const notes: string[] = [];
    const agentDir = `agents/${input.agentId}`;

    // 1. Generate openclaw.json
    const openclawConfig = this.buildOpenClawConfig(input);
    files.push({
      path: "openclaw.json",
      content: JSON.stringify(openclawConfig, null, 2),
      purpose: "Main agent configuration with Stratus extensions",
    });

    // 2. Add tool registry YAML
    files.push({
      path: "agent.tools.yaml",
      content: input.toolRegistry.yaml,
      purpose: "Tool definitions with rich descriptions for embedding",
    });

    // 3. Generate AGENTS.md
    const agentsMd = await this.generateAgentsMd(input, signal);
    files.push({
      path: "AGENTS.md",
      content: agentsMd,
      purpose: "Agent instructions and behavior guidelines",
    });

    // 4. Generate SOUL.md
    const soulMd = await this.generateSoulMd(input, signal);
    files.push({
      path: "SOUL.md",
      content: soulMd,
      purpose: "Agent persona and communication style",
    });

    // 5. Generate memory templates
    const memoryTemplate = this.buildMemoryTemplate(input.analysis);
    files.push({
      path: "memory/templates.yaml",
      content: memoryTemplate,
      purpose: "Domain-relevant memory categories for context retention",
    });

    // 6. Generate skill manifests for each tool
    for (const tool of input.toolRegistry.tools) {
      const manifest = this.buildSkillManifest(tool, input.agentId);
      files.push({
        path: `skills/${tool.id}/openclaw.plugin.json`,
        content: JSON.stringify(manifest, null, 2),
        purpose: `Skill manifest for ${tool.id}`,
      });
    }

    // 7. Channel configs
    if (input.channels?.length) {
      for (const channel of input.channels) {
        files.push({
          path: `channels/${channel.type}.json`,
          content: JSON.stringify(channel.settings, null, 2),
          purpose: `${channel.type} channel configuration`,
        });
      }
    }

    // 8. Probe config
    const probeConfig = this.buildProbeConfig(input.probe);
    files.push({
      path: "probe_config.yaml",
      content: probeConfig,
      purpose: "Probe selection and cascade configuration",
    });

    // Validation notes
    if (input.toolRegistry.similarityWarnings.length > 0) {
      notes.push(`Warning: ${input.toolRegistry.similarityWarnings.length} tool pairs are too similar in embedding space.`);
    }

    if (input.probe.customTrainingRecommended) {
      notes.push("Custom probe training recommended for optimal performance.");
    }

    if (!input.channels?.length) {
      notes.push("No channels configured — agent will only be accessible via API.");
    }

    return {
      agentDir,
      files,
      openclawConfig,
      notes,
    };
  }

  // -----------------------------------------------------------------------
  // OpenClaw Config
  // -----------------------------------------------------------------------

  private buildOpenClawConfig(input: ConfigureAgentInput): Record<string, unknown> {
    return {
      id: input.agentId,
      name: input.agentName,
      brain: "stratus",
      provider: input.llm.provider,
      model: input.llm.model,
      stratus: {
        probe: input.probe.primaryProbe,
        customProbePath: input.probe.customTrainingRecommended
          ? `.stratus/probes/${input.agentId}-probe/weights.pt`
          : undefined,
        maxSteps: input.maxSteps ?? 20,
        goalProximityThreshold: 0.85,
        observationEncoder: "llm_bridge",
        toolEmbeddingCache: true,
        treeSearch: {
          enabled: true,
          maxDepth: 3,
          beamWidth: 5,
          ambiguityThreshold: 0.15,
          timeBudgetMs: 500,
        },
        recovery: {
          maxRollbackDepth: 3,
          maxRecoveryAttempts: 5,
          detectFailures: true,
        },
        observability: {
          traceEnabled: true,
          profileEnabled: true,
          trajectoryEnabled: true,
        },
      },
      channels: input.channels?.map((c) => ({
        type: c.type,
        config: `channels/${c.type}.json`,
      })),
    };
  }

  // -----------------------------------------------------------------------
  // AGENTS.md Generation
  // -----------------------------------------------------------------------

  private async generateAgentsMd(
    input: ConfigureAgentInput,
    signal?: AbortSignal,
  ): Promise<string> {
    const toolList = input.toolRegistry.tools
      .map((t) => `- **${t.id}**: ${t.description}`)
      .join("\n");

    const workflowList = input.analysis.workflows
      .map((w) => `### ${w.name}\n${w.steps.map((s, i) => `${i + 1}. ${s}`).join("\n")}`)
      .join("\n\n");

    const prompt = [
      `Generate an AGENTS.md file for an AI agent with these details:`,
      `Name: ${input.agentName}`,
      `Domain: ${input.analysis.domainName}`,
      `Summary: ${input.analysis.summary}`,
      ``,
      `## Available Tools`,
      toolList,
      ``,
      `## Key Workflows`,
      workflowList,
      ``,
      input.customInstructions ? `## Custom Instructions\n${input.customInstructions}` : "",
      ``,
      `Generate a clear, concise AGENTS.md that:`,
      `1. Describes the agent's purpose and domain`,
      `2. Lists capabilities and limitations`,
      `3. Provides guidelines for tool selection`,
      `4. Includes workflow patterns to follow`,
      `5. Specifies error handling behavior`,
      `Return markdown directly (no code blocks).`,
    ].filter(Boolean).join("\n");

    return this.llm(prompt, signal);
  }

  // -----------------------------------------------------------------------
  // SOUL.md Generation
  // -----------------------------------------------------------------------

  private async generateSoulMd(
    input: ConfigureAgentInput,
    signal?: AbortSignal,
  ): Promise<string> {
    const persona = input.personaDescription ??
      `A helpful, efficient ${input.analysis.domainName} assistant.`;

    const prompt = [
      `Generate a SOUL.md persona file for an AI agent:`,
      `Name: ${input.agentName}`,
      `Domain: ${input.analysis.domainName}`,
      `Persona: ${persona}`,
      ``,
      `The SOUL.md should define:`,
      `1. Communication style (tone, formality, verbosity)`,
      `2. Core personality traits (3-5 traits)`,
      `3. How the agent handles uncertainty`,
      `4. How the agent handles errors or failures`,
      `5. Domain-specific communication norms`,
      `Return markdown directly (no code blocks).`,
    ].join("\n");

    return this.llm(prompt, signal);
  }

  // -----------------------------------------------------------------------
  // Memory Template
  // -----------------------------------------------------------------------

  private buildMemoryTemplate(analysis: DomainAnalysis): string {
    const lines: string[] = [];

    lines.push(`# Memory Templates — ${analysis.domainName}`);
    lines.push("categories:");

    // Entity-based categories
    for (const entity of analysis.entities) {
      lines.push(`  - name: ${entity.name.toLowerCase()}_context`);
      lines.push(`    description: "Information about ${entity.name} entities"`);
      lines.push(`    retention: session`);
    }

    // Workflow-based categories
    for (const workflow of analysis.workflows) {
      lines.push(`  - name: ${workflow.name.toLowerCase().replace(/\s+/g, "_")}_state`);
      lines.push(`    description: "Progress tracking for ${workflow.name}"`);
      lines.push(`    retention: session`);
    }

    // Standard categories
    lines.push(`  - name: user_preferences`);
    lines.push(`    description: "User-specific preferences and context"`);
    lines.push(`    retention: persistent`);
    lines.push(`  - name: error_history`);
    lines.push(`    description: "Recent errors and recovery actions"`);
    lines.push(`    retention: session`);

    return lines.join("\n");
  }

  // -----------------------------------------------------------------------
  // Skill Manifest
  // -----------------------------------------------------------------------

  private buildSkillManifest(
    tool: ToolDefinition,
    agentId: string,
  ): Record<string, unknown> {
    return {
      id: `${agentId}-${tool.id}`,
      name: tool.description,
      version: "1.0.0",
      openclaw: {
        actions: [
          {
            action_type: tool.actionType,
            domain: tool.domain,
            description: tool.richDescription,
            effects: tool.effects,
            preconditions: tool.preconditions,
            requires_generation: tool.requiresGeneration,
            ...(tool.generationTemplate
              ? { generation_template: tool.generationTemplate }
              : {}),
          },
        ],
      },
    };
  }

  // -----------------------------------------------------------------------
  // Probe Config
  // -----------------------------------------------------------------------

  private buildProbeConfig(probe: ProbeRecommendation): string {
    const lines: string[] = [];

    lines.push("# Probe Configuration");
    lines.push(`primary: ${probe.primaryProbe}`);

    if (probe.useCascade && probe.cascade) {
      lines.push("cascade:");
      lines.push(`  primary: ${probe.cascade.primary}`);
      lines.push(`  fallback: ${probe.cascade.fallback}`);
    }

    lines.push(`expected_accuracy: ${probe.expectedAccuracy.toFixed(2)}`);
    lines.push(`custom_training_recommended: ${probe.customTrainingRecommended}`);

    if (probe.risks.length > 0) {
      lines.push("risks:");
      for (const risk of probe.risks) {
        lines.push(`  - "${risk}"`);
      }
    }

    return lines.join("\n");
  }
}
