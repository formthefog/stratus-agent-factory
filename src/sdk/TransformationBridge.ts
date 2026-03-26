/**
 * Transformation Bridge — Connect AI Transformation consultant to Agent Factory
 *
 * This is the handoff layer between Dale's transformation consultant frontend
 * and the Agent Factory backend. The consultant gathers structured customer
 * context; this bridge converts it into StratusAgent.build() input.
 *
 * Flow:
 * 1. Frontend sends TransformationOutput (customer context from consultant)
 * 2. Bridge converts to AgentConfig
 * 3. StratusAgent.build() → test → deploy
 * 4. Bridge returns status updates back to frontend
 *
 * @purpose Bridge between AI Transformation consultant and Agent Factory
 */

import { StratusAgent } from "./StratusAgent.js";
import type { AgentConfig, AgentBuildResult, AgentDeployResult, ToolInput } from "./StratusAgent.js";

// ---------------------------------------------------------------------------
// Types — Transformation Consultant Output
// ---------------------------------------------------------------------------

/** What the transformation consultant produces */
export interface TransformationOutput {
  /** Customer's business name */
  businessName: string;
  /** What the business does */
  businessDescription: string;
  /** Identified pain points */
  painPoints: string[];
  /** Workflows that could be automated */
  workflows: WorkflowSpec[];
  /** Tools/APIs the customer already uses */
  existingTools: ExistingToolSpec[];
  /** Desired agent capabilities */
  desiredCapabilities: string[];
  /** Preferred LLM provider */
  llmPreference?: "anthropic" | "openai";
  /** Deployment preference */
  deploymentPreference?: "cloud" | "self-hosted" | "local";
  /** Customer's technical level (affects agent persona) */
  technicalLevel?: "non-technical" | "technical" | "developer";
}

export interface WorkflowSpec {
  name: string;
  description: string;
  steps: string[];
  frequency: "daily" | "weekly" | "on-demand" | "event-driven";
  currentlyManual: boolean;
}

export interface ExistingToolSpec {
  name: string;
  description: string;
  type: "api" | "saas" | "database" | "internal-tool" | "other";
  apiEndpoint?: string;
  parameters?: Record<string, string>;
}

/** Status updates sent back to the frontend */
export interface BuildStatusUpdate {
  phase: BuildPhase;
  status: "started" | "completed" | "failed";
  message: string;
  progress: number; // 0-100
  timestamp: string;
}

export type BuildPhase =
  | "analyzing"
  | "designing_tools"
  | "selecting_probe"
  | "configuring"
  | "testing"
  | "fixing"
  | "packaging"
  | "deploying"
  | "monitoring";

// ---------------------------------------------------------------------------
// Bridge
// ---------------------------------------------------------------------------

export class TransformationBridge {
  private sidecarUrl: string;

  constructor(sidecarUrl = "http://127.0.0.1:7900") {
    this.sidecarUrl = sidecarUrl;
  }

  /**
   * Full pipeline: transformation output → built, tested, deployed agent.
   *
   * This is the method Dale's frontend calls. It takes the consultant's
   * output and returns a running agent.
   */
  async buildAndDeploy(
    input: TransformationOutput,
    onStatus: (update: BuildStatusUpdate) => void,
  ): Promise<{
    build: AgentBuildResult;
    deploy: AgentDeployResult | null;
  }> {
    let progress = 0;

    const emit = (phase: BuildPhase, status: BuildStatusUpdate["status"], message: string) => {
      if (status === "completed") progress += 12;
      onStatus({
        phase,
        status,
        message,
        progress: Math.min(progress, 100),
        timestamp: new Date().toISOString(),
      });
    };

    // Convert transformation output to agent config
    const agentConfig = this.toAgentConfig(input);

    // Override the progress callback to emit structured status
    agentConfig.onProgress = (phase, message) => {
      const buildPhase = this.mapPhase(phase);
      emit(buildPhase, "started", message);
    };

    // Build
    emit("analyzing", "started", "Starting agent build...");
    const agent = new StratusAgent(agentConfig);
    const buildResult = await agent.build();

    if (!buildResult.success) {
      emit("testing", "failed", buildResult.error ?? "Build failed");
      return { build: buildResult, deploy: null };
    }

    emit("packaging", "completed", "Agent built and packaged");

    // Deploy
    if (buildResult.package) {
      emit("deploying", "started", `Deploying to ${agentConfig.deployTarget ?? "local"}...`);
      const deployResult = await agent.deploy(buildResult.package);

      if (deployResult.success) {
        emit("deploying", "completed", "Agent deployed");

        // Start monitoring
        emit("monitoring", "started", "Setting up monitoring and probe retraining...");
        await agent.startMonitoring(
          buildResult.agentId,
          buildResult.package.rootDir,
        );
        emit("monitoring", "completed", "Monitoring active");

        return { build: buildResult, deploy: deployResult };
      } else {
        emit("deploying", "failed", deployResult.error ?? "Deployment failed");
        return { build: buildResult, deploy: deployResult };
      }
    }

    return { build: buildResult, deploy: null };
  }

  /**
   * Convert transformation consultant output to StratusAgent config.
   */
  toAgentConfig(input: TransformationOutput): AgentConfig {
    // Build domain description from business context
    const domainDescription = [
      input.businessDescription,
      `Pain points: ${input.painPoints.join("; ")}`,
      `Capabilities needed: ${input.desiredCapabilities.join("; ")}`,
      `Workflows: ${input.workflows.map((w) => w.name).join(", ")}`,
    ].join("\n");

    // Convert existing tools to ToolInput
    const tools: ToolInput[] = input.existingTools.map((t) => ({
      name: t.name.replace(/\s+/g, "_").toLowerCase(),
      description: t.description,
      effects: `Executes ${t.name} operation`,
      preconditions: t.type === "api" ? "API credentials configured" : undefined,
      apiEndpoint: t.apiEndpoint,
      parameters: t.parameters,
    }));

    // Determine deploy target
    let deployTarget: "local" | "docker" | "fly" = "local";
    switch (input.deploymentPreference) {
      case "cloud": deployTarget = "fly"; break;
      case "self-hosted": deployTarget = "docker"; break;
      case "local": deployTarget = "local"; break;
    }

    return {
      name: `${input.businessName.replace(/\s+/g, "-").toLowerCase()}-agent`,
      domainDescription,
      tools,
      llm: {
        provider: input.llmPreference ?? "anthropic",
      },
      deployTarget,
      sidecarUrl: this.sidecarUrl,
    };
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  private mapPhase(phase: string): BuildPhase {
    const map: Record<string, BuildPhase> = {
      analyze: "analyzing",
      domain_analysis: "analyzing",
      tool_registry: "designing_tools",
      generate_tools: "designing_tools",
      select_probe: "selecting_probe",
      train_probe: "selecting_probe",
      configure: "configuring",
      configure_agent: "configuring",
      test: "testing",
      test_agent: "testing",
      fix: "fixing",
      iterate: "fixing",
      package: "packaging",
      deploy: "deploying",
    };

    return map[phase] ?? "analyzing";
  }
}
