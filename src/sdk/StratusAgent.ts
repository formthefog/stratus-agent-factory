/**
 * Stratus Agent SDK — Programmatic interface to the Agent Factory
 *
 * This is the integration surface that the AI Transformation product
 * uses to build, configure, test, deploy, and manage agents. Dale's
 * frontend calls this API to orchestrate the full agent lifecycle
 * from transformation consultant output.
 *
 * Primary consumer: AI Transformation product (not external developers)
 *
 * @purpose Programmatic API for the AI Transformation product to manage agents
 * @spec AGENT_FACTORY_SPEC.md#f21-build-stratus-agent-sdk
 */

import type { DomainAnalysis, ToolRegistryOutput, TestReport } from "../agent-builder/tools/index.js";
import type { BuildResult } from "../agent-builder/workflows/index.js";
import type { AgentPackage } from "../packaging/AgentPackage.js";
import type { LocalDeployResult } from "../deploy/LocalDeployer.js";
import type { DockerDeployResult } from "../deploy/DockerDeployer.js";
import type { FlyDeployResult } from "../deploy/FlyDeployer.js";
import type { MetricSnapshot, HealthAlert } from "../lifecycle/HealthMonitor.js";
import type { RetrainResult } from "../probes/RetrainScheduler.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AgentConfig {
  /** Agent name */
  name: string;
  /** Domain description (from transformation consultant) */
  domainDescription: string;
  /** Customer's tools/APIs */
  tools?: ToolInput[];
  /** LLM provider config */
  llm?: LLMConfig;
  /** Deployment target */
  deployTarget?: "local" | "docker" | "fly";
  /** Stratus sidecar URL */
  sidecarUrl?: string;
  /** Callback for build progress */
  onProgress?: (phase: string, message: string) => void;
  /** Callback for health alerts */
  onAlert?: (alert: HealthAlert) => void;
  /** Callback for retrain events */
  onRetrain?: (result: RetrainResult) => void;
}

export interface ToolInput {
  name: string;
  description: string;
  effects: string;
  preconditions?: string;
  apiEndpoint?: string;
  parameters?: Record<string, string>;
}

export interface LLMConfig {
  provider: "anthropic" | "openai" | "local";
  model?: string;
}

export interface AgentBuildResult {
  success: boolean;
  agentId: string;
  /** Domain analysis from the factory */
  domainAnalysis: DomainAnalysis | null;
  /** Generated tool registry */
  toolRegistry: ToolRegistryOutput | null;
  /** Test results */
  testReport: TestReport | null;
  /** Full build result */
  buildResult: BuildResult | null;
  /** Package (if build succeeded) */
  package: AgentPackage | null;
  /** Error (if build failed) */
  error?: string;
}

export interface AgentDeployResult {
  success: boolean;
  agentId: string;
  target: "local" | "docker" | "fly";
  /** Target-specific result */
  deployment: LocalDeployResult | DockerDeployResult | FlyDeployResult | null;
  /** Agent URL (if deployed to cloud) */
  agentUrl?: string;
  error?: string;
}

export interface AgentStatus {
  agentId: string;
  deployed: boolean;
  target: string | null;
  health: MetricSnapshot | null;
  probeAccuracy: number | null;
  version: string | null;
}

// ---------------------------------------------------------------------------
// Main API
// ---------------------------------------------------------------------------

/**
 * StratusAgent is the primary integration point for the AI Transformation
 * product. It wraps the entire Agent Factory pipeline into a clean API
 * that Dale's frontend can call.
 *
 * Typical flow (from transformation consultant):
 *
 * 1. Consultant gathers customer context → produces AgentConfig
 * 2. StratusAgent.build(config) → builds, tests, packages the agent
 * 3. StratusAgent.deploy(agentId) → deploys to target
 * 4. StratusAgent.monitor(agentId) → tracks health, triggers retrains
 *
 * All three operations can be triggered from the frontend.
 */
export class StratusAgent {
  private config: AgentConfig;
  private sidecarUrl: string;

  // Lazy-loaded components (initialized on first use)
  private _buildWorkflow: any = null;
  private _packager: any = null;
  private _deployer: any = null;
  private _monitor: any = null;
  private _retrainScheduler: any = null;

  constructor(config: AgentConfig) {
    this.config = config;
    this.sidecarUrl = config.sidecarUrl ?? "http://127.0.0.1:7900";
  }

  /**
   * Build an agent from transformation consultant output.
   *
   * This is the main entry point. Takes the customer context gathered
   * by the transformation consultant and produces a tested, packaged agent.
   */
  async build(): Promise<AgentBuildResult> {
    const agentId = this.toAgentId(this.config.name);

    try {
      this.emit("analyze", "Analyzing domain...");

      // Import and run build workflow
      const { BuildFromScratchWorkflow } = await import("../agent-builder/workflows/index.js");
      const { AnalyzeDomainTool } = await import("../agent-builder/tools/index.js");

      // Domain analysis
      const analyzeTool = new AnalyzeDomainTool(this.sidecarUrl);
      const domainAnalysis = await analyzeTool.execute({
        domainDescription: this.config.domainDescription,
        exampleGoals: [],
        existingTools: this.config.tools?.map((t) => t.name) ?? [],
      });

      this.emit("build", "Building agent...");

      // Full build pipeline
      const workflow = new BuildFromScratchWorkflow({
        sidecarUrl: this.sidecarUrl,
        llmProvider: this.config.llm?.provider ?? "anthropic",
        llmModel: this.config.llm?.model,
      });

      const buildResult = await workflow.build({
        agentName: this.config.name,
        domainDescription: this.config.domainDescription,
        goals: domainAnalysis.workflows.map((w) => w.description),
        apiEndpoints: this.config.tools?.filter((t) => t.apiEndpoint).map((t) => ({
          url: t.apiEndpoint!,
          method: "POST",
          description: t.description,
          parameters: t.parameters,
        })) ?? [],
        existingTools: this.config.tools?.map((t) => ({
          name: t.name,
          description: t.description,
          effects: t.effects,
          preconditions: t.preconditions ?? "",
        })),
        persona: `Professional ${domainAnalysis.domain} agent`,
      }, (progress) => {
        this.emit(progress.phase, progress.message);
      });

      if (!buildResult.success) {
        return {
          success: false,
          agentId,
          domainAnalysis,
          toolRegistry: null,
          testReport: buildResult.testReport ?? null,
          buildResult,
          package: null,
          error: buildResult.error,
        };
      }

      // Package the built agent
      this.emit("package", "Packaging agent...");
      const { AgentPackager } = await import("../packaging/AgentPackager.js");
      const packager = new AgentPackager({
        stratusModelVersion: "v6",
        cacheEmbeddings: true,
        sidecarUrl: this.sidecarUrl,
      });

      const pkg = await packager.package(buildResult.outputDir!);

      return {
        success: true,
        agentId,
        domainAnalysis,
        toolRegistry: buildResult.toolRegistry ?? null,
        testReport: buildResult.testReport ?? null,
        buildResult,
        package: pkg,
      };
    } catch (err) {
      return {
        success: false,
        agentId,
        domainAnalysis: null,
        toolRegistry: null,
        testReport: null,
        buildResult: null,
        package: null,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Deploy a built agent to the specified target.
   */
  async deploy(pkg: AgentPackage): Promise<AgentDeployResult> {
    const agentId = pkg.manifest.agentId;
    const target = this.config.deployTarget ?? "local";

    try {
      this.emit("deploy", `Deploying to ${target}...`);

      switch (target) {
        case "local": {
          const { LocalDeployer } = await import("../deploy/LocalDeployer.js");
          const deployer = new LocalDeployer({ ensureSidecar: true });
          const result = await deployer.deploy(pkg);
          return { success: true, agentId, target, deployment: result };
        }

        case "docker": {
          const { DockerDeployer } = await import("../deploy/DockerDeployer.js");
          const deployer = new DockerDeployer({
            outputDir: `${pkg.rootDir}/.deploy`,
            gpuSupport: true,
          });
          const result = deployer.generate(pkg);
          return { success: true, agentId, target, deployment: result };
        }

        case "fly": {
          const { FlyDeployer } = await import("../deploy/FlyDeployer.js");
          const deployer = new FlyDeployer({
            outputDir: `${pkg.rootDir}/.deploy`,
            gpu: true,
          });
          const result = await deployer.deploy(pkg);
          return {
            success: result.success,
            agentId,
            target,
            deployment: null,
            agentUrl: result.appUrl ?? undefined,
            error: result.error ?? undefined,
          };
        }
      }
    } catch (err) {
      return {
        success: false,
        agentId,
        target,
        deployment: null,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Start monitoring a deployed agent. Sets up health monitoring
   * and automated probe retraining.
   */
  async startMonitoring(agentId: string, agentDir: string): Promise<void> {
    // Health monitoring
    const { HealthMonitor } = await import("../lifecycle/HealthMonitor.js");
    this._monitor = new HealthMonitor({
      agentId,
      sidecarUrl: this.sidecarUrl,
      onAlert: (alert) => this.config.onAlert?.(alert),
    });
    this._monitor.start();

    // Probe retrain scheduler
    const { RetrainScheduler } = await import("../probes/RetrainScheduler.js");
    this._retrainScheduler = new RetrainScheduler({
      sidecarUrl: this.sidecarUrl,
      agentId,
      probeId: `${agentId}-probe`,
      traceDir: `${agentDir}/.stratus/traces`,
      onRetrainComplete: (result) => this.config.onRetrain?.(result),
    });
    this._retrainScheduler.start();
  }

  /**
   * Stop monitoring.
   */
  stopMonitoring(): void {
    this._monitor?.stop();
    this._retrainScheduler?.stop();
  }

  /**
   * Get current agent status.
   */
  async getStatus(agentId: string): Promise<AgentStatus> {
    const health = this._monitor?.snapshot() ?? null;

    return {
      agentId,
      deployed: health !== null,
      target: this.config.deployTarget ?? null,
      health,
      probeAccuracy: health?.probe.accuracy ?? null,
      version: null, // Would come from VersionManager
    };
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  private emit(phase: string, message: string): void {
    this.config.onProgress?.(phase, message);
  }

  private toAgentId(name: string): string {
    return name
      .replace(/([a-z])([A-Z])/g, "$1-$2")
      .replace(/[\s_]+/g, "-")
      .toLowerCase();
  }
}
