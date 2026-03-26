/**
 * Stratus Brain — Turn Orchestrator
 *
 * The main IBrain implementation that ties the entire Stratus pipeline together:
 *   message → goal → state → rank → search → generate → execute → observe → check → loop
 *
 * This is the top-level coordinator. Each step delegates to a focused module:
 * - GoalExtractor: message → goal embedding
 * - StateAssembler + StateEncoderBridge: context → state embedding
 * - ActionRanker: state + goal + tools → ranked candidates
 * - TreeSearchOrchestrator: disambiguate close candidates
 * - GenerationRouter: fill parameters via LLM if needed
 * - ActionExecutor: execute through harness ToolExecutor
 * - ObservationEncoderV1: tool output → state embedding
 * - GoalMonitor: check termination conditions
 * - RecoveryManager: handle failures and stagnation
 * - DynamicStateTracker: track knowledge accumulation
 *
 * @purpose Main IBrain implementation orchestrating the Stratus agent loop
 * @spec AGENT_FACTORY_SPEC.md#b45-build-turn-orchestrator
 */

import { registerBrain } from "../BrainRegistry.js";
import type {
  IBrain,
  BrainConfig,
  BrainResponse,
  BrainState,
  BrainToolDefinition,
  BrainTurnEvent,
  ToolExecutor,
  ProcessTurnOptions,
  ActionRecord,
  BrainStopReason,
} from "../IBrain.js";

import { StratusClient } from "./StratusClient.js";
import { SidecarManager } from "./SidecarManager.js";
import { StateAssembler, type StateAssemblyInput } from "./StateAssembler.js";
import { GoalExtractor, type ConversationTurn } from "./GoalExtractor.js";
import { DynamicStateTracker } from "./DynamicStateTracker.js";
import { StateEncoderBridge } from "./StateEncoderBridge.js";
import { ActionRanker } from "./ActionRanker.js";
import { TreeSearchOrchestrator } from "./TreeSearch.js";
import { GenerationRouter, type GenerateFn } from "./GenerationRouter.js";
import { ActionExecutor } from "./ActionExecutor.js";
import { ObservationEncoderV1, type SummarizeFn } from "./ObservationEncoderV1.js";
import { GoalMonitor } from "./GoalMonitor.js";
import { RecoveryManager } from "./RecoveryManager.js";
import { ToolRegistryManager } from "../tools/index.js";

// ---------------------------------------------------------------------------
// Brain Implementation
// ---------------------------------------------------------------------------

export class StratusBrain implements IBrain {
  // Infrastructure
  private client!: StratusClient;
  private sidecar!: SidecarManager;

  // Pipeline modules
  private goalExtractor!: GoalExtractor;
  private stateAssembler!: StateAssembler;
  private stateEncoder!: StateEncoderBridge;
  private dynamicTracker!: DynamicStateTracker;
  private actionRanker!: ActionRanker;
  private treeSearch!: TreeSearchOrchestrator;
  private generationRouter!: GenerationRouter;
  private observationEncoder!: ObservationEncoderV1;
  private goalMonitor!: GoalMonitor;
  private recoveryManager!: RecoveryManager;
  private toolRegistry!: ToolRegistryManager;

  // State
  private tools: BrainToolDefinition[] = [];
  private toolEmbeddings = new Map<string, number[]>();
  private configured = false;

  // LLM callbacks (injected by harness)
  private generateFn?: GenerateFn;
  private summarizeFn?: SummarizeFn;

  // -----------------------------------------------------------------------
  // IBrain Lifecycle
  // -----------------------------------------------------------------------

  async configure(config: BrainConfig): Promise<void> {
    const stratusConfig = config.stratusConfig;
    if (!stratusConfig) {
      throw new Error("StratusBrain requires stratusConfig in BrainConfig");
    }

    // Initialize infrastructure
    this.client = new StratusClient({
      baseUrl: `http://${stratusConfig.sidecarHost ?? "localhost"}:${stratusConfig.sidecarPort ?? 8100}`,
      timeoutMs: stratusConfig.timeoutMs ?? 30_000,
    });

    this.sidecar = new SidecarManager(
      {
        host: stratusConfig.sidecarHost ?? "127.0.0.1",
        port: stratusConfig.sidecarPort ?? 8100,
        checkpointPath: stratusConfig.checkpointPath,
      },
      this.client,
    );

    // Start sidecar
    await this.sidecar.start();

    // Initialize pipeline modules
    this.goalExtractor = new GoalExtractor(this.generateFn);
    this.stateAssembler = new StateAssembler();
    this.stateEncoder = new StateEncoderBridge(this.stateAssembler, this.client);
    this.dynamicTracker = new DynamicStateTracker();
    this.actionRanker = new ActionRanker(this.client, {
      customProbe: stratusConfig.probeId,
      ambiguityThreshold: stratusConfig.ambiguityThreshold ?? 0.15,
    });
    this.treeSearch = new TreeSearchOrchestrator(this.client, {
      depth: stratusConfig.treeSearchDepth ?? 3,
      width: stratusConfig.treeSearchWidth ?? 5,
      timeBudgetMs: stratusConfig.treeSearchBudgetMs ?? 500,
    });
    this.generationRouter = new GenerationRouter(this.generateFn);
    this.observationEncoder = new ObservationEncoderV1(this.client, this.summarizeFn);
    this.goalMonitor = new GoalMonitor(this.client, {
      goalReachedThreshold: stratusConfig.goalThreshold ?? 0.85,
      maxSteps: stratusConfig.maxSteps ?? 20,
    });
    this.recoveryManager = new RecoveryManager();
    this.toolRegistry = new ToolRegistryManager();

    this.configured = true;
  }

  async registerTools(tools: BrainToolDefinition[]): Promise<void> {
    this.tools = tools;

    // Register with tool registry and pre-compute embeddings
    for (const tool of tools) {
      this.toolRegistry.registerTool(tool);
    }

    if (this.configured) {
      await this.toolRegistry.computeEmbeddings(this.client);
      this.toolEmbeddings = this.toolRegistry.getEmbeddings();
    }
  }

  // -----------------------------------------------------------------------
  // IBrain.processTurn — The Main Loop
  // -----------------------------------------------------------------------

  async processTurn(
    sessionId: string,
    message: string,
    executor: ToolExecutor,
    options?: ProcessTurnOptions,
    onEvent?: (event: BrainTurnEvent) => void,
  ): Promise<BrainResponse> {
    const signal = options?.signal;
    const startTime = Date.now();
    const actions: ActionRecord[] = [];

    // Reset per-turn state
    this.dynamicTracker.reset();
    this.goalMonitor.reset();
    this.recoveryManager.reset();
    this.goalExtractor.reset();

    // Step 1: Extract goal
    const turns: ConversationTurn[] = [{ role: "user", content: message }];
    const goal = await this.goalExtractor.extract(turns);
    const goalEmbedding = await this.goalExtractor.encode(goal, this.client, signal);

    onEvent?.({
      type: "planning",
      data: { goal: goal.text, confidence: goal.confidence },
    });

    // Step 2: Build tool embedding arrays
    const toolLabels = this.tools.map((t) => t.id);
    const toolEmbeddingArrays = toolLabels.map(
      (id) => this.toolEmbeddings.get(id) ?? [],
    );

    // Step 3: Action-Observation Loop
    const actionExecutor = new ActionExecutor(executor);
    let previousStateEmbedding: number[] | undefined;
    let stopReason: BrainStopReason = "complete";
    let finalResponse = "";

    while (true) {
      const stepNum = this.dynamicTracker.getStepNumber() + 1;

      // Assemble state
      const stateInput: StateAssemblyInput = {
        primaryGoal: goal.text,
        tools: this.tools,
        knowledge: this.dynamicTracker.getKnowledge(),
        lastAction: this.dynamicTracker.getLastAction(),
        changed: this.dynamicTracker.getLastChanged(),
        stepNumber: stepNum,
        goalProximity: this.dynamicTracker.getGoalProximity(),
      };

      const encodedState = await this.stateEncoder.encode(stateInput, signal);

      // Rank actions
      const excludedActions = this.recoveryManager.getExcludedActions();
      const filteredLabels = toolLabels.filter((l) => !excludedActions.includes(l));
      const filteredEmbeddings = filteredLabels.map(
        (id) => this.toolEmbeddings.get(id) ?? [],
      );

      const ranking = await this.actionRanker.rank(
        {
          stateEmbedding: encodedState.embedding,
          goalEmbedding,
          actionEmbeddings: filteredEmbeddings,
          actionLabels: filteredLabels,
        },
        signal,
      );

      // If ambiguous, use tree search
      let selectedAction: string;
      if (ranking.isAmbiguous && filteredLabels.length >= 2) {
        const searchResult = await this.treeSearch.search(
          encodedState.embedding,
          goalEmbedding,
          filteredEmbeddings,
          filteredLabels,
          signal,
        );
        selectedAction = searchResult.bestAction;

        onEvent?.({
          type: "planning",
          data: {
            step: stepNum,
            treeSearch: true,
            pathsEvaluated: searchResult.pathsEvaluated,
          },
        });
      } else {
        const best = this.actionRanker.selectBest(ranking);
        selectedAction = best?.action ?? filteredLabels[0];
      }

      // Find tool definition
      const tool = this.tools.find((t) => t.id === selectedAction);
      if (!tool) {
        stopReason = "error";
        break;
      }

      // Generate parameters if needed
      const stateText = this.stateAssembler.assemble(stateInput);
      const generation = await this.generationRouter.route(tool, stateText);

      onEvent?.({
        type: "action",
        data: {
          step: stepNum,
          toolId: tool.id,
          toolName: tool.name,
          parameters: generation.parameters,
          usedGeneration: generation.usedGeneration,
        },
      });

      // Execute
      const execution = await actionExecutor.execute({
        toolId: tool.id,
        toolName: tool.name,
        parameters: generation.parameters,
      }, { signal });

      const actionResult = {
        toolId: tool.id,
        toolName: tool.name,
        params: Object.keys(generation.parameters).join(", "),
        result: execution.summary,
        success: execution.result.success,
      };

      // Record action
      actions.push({
        toolId: tool.id,
        parameters: generation.parameters,
        result: execution.result,
        durationMs: execution.executionMs,
      });

      onEvent?.({
        type: "observation",
        data: {
          step: stepNum,
          toolId: tool.id,
          success: execution.result.success,
          summary: execution.summary,
        },
      });

      // Encode observation
      const observation = await this.observationEncoder.encode({
        toolId: tool.id,
        toolName: tool.name,
        success: execution.result.success,
        output: execution.result.output,
        executionMs: execution.executionMs,
      }, signal);

      // Extract knowledge from observation
      const knowledgeGained = execution.hasOutput
        ? [observation.summary]
        : [];

      // Check goal proximity
      const proximityCheck = await this.goalMonitor.check(
        encodedState.embedding,
        goalEmbedding,
        previousStateEmbedding,
        selectedAction,
        signal,
      );

      const monitorState = this.goalMonitor.getState();

      // Track state
      this.dynamicTracker.recordStep(
        actionResult,
        knowledgeGained,
        monitorState.currentProximity * 100,
      );

      this.recoveryManager.recordState({
        embedding: encodedState.embedding,
        stepNumber: stepNum,
        goalProximity: monitorState.currentProximity,
        timestamp: new Date().toISOString(),
      });

      previousStateEmbedding = encodedState.embedding;

      // Check termination
      if (proximityCheck === "goal_reached") {
        stopReason = "complete";
        break;
      }
      if (proximityCheck === "max_steps") {
        stopReason = "max_steps";
        break;
      }
      if (proximityCheck === "failure_detected") {
        const plan = this.recoveryManager.handleFailure(
          selectedAction,
          {
            embedding: encodedState.embedding,
            stepNumber: stepNum,
            goalProximity: monitorState.currentProximity,
            timestamp: new Date().toISOString(),
          },
        );
        if (plan.strategy === "give_up") {
          stopReason = "error";
          break;
        }
        if (plan.probeId) this.actionRanker.setCustomProbe(plan.probeId);
        continue;
      }
      if (proximityCheck === "stagnant") {
        const plan = this.recoveryManager.handleStagnation();
        if (plan.strategy === "give_up") {
          stopReason = "max_steps";
          break;
        }
        if (plan.probeId) this.actionRanker.setCustomProbe(plan.probeId);
        continue;
      }

      // Check abort signal
      if (signal?.aborted) {
        stopReason = "cancelled";
        break;
      }
    }

    // Generate final response summary via LLM
    if (this.generateFn) {
      const knowledge = this.dynamicTracker.getKnowledge();
      const summaryPrompt = [
        `You are an AI agent. Summarize what you accomplished for the user.`,
        `Goal: ${goal.text}`,
        `Steps taken: ${actions.length}`,
        `Knowledge gained:`,
        ...knowledge.map((k) => `- ${k}`),
        "",
        "Write a concise response to the user. 2-4 sentences max.",
      ].join("\n");
      finalResponse = await this.generateFn(summaryPrompt);
    } else {
      finalResponse = `Completed ${actions.length} steps. ${this.dynamicTracker.getKnowledge().join(". ")}`;
    }

    return {
      message: finalResponse,
      actions,
      stopReason,
      tokenUsage: {
        inputTokens: 0,  // TODO: track from LLM calls
        outputTokens: 0,
        totalTokens: 0,
      },
      metadata: {
        stepsCompleted: this.dynamicTracker.getStepNumber(),
        finalProximity: this.dynamicTracker.getGoalProximity(),
        proximityCurve: this.goalMonitor.getState().proximityCurve,
      },
    };
  }

  // -----------------------------------------------------------------------
  // IBrain State Management
  // -----------------------------------------------------------------------

  async getState(_sessionId: string): Promise<BrainState> {
    return {
      turnCount: 0,
      totalActions: 0,
      totalTokens: 0,
    };
  }

  async reset(_sessionId: string): Promise<void> {
    this.dynamicTracker.reset();
    this.goalMonitor.reset();
    this.recoveryManager.reset();
    this.goalExtractor.reset();
    this.stateEncoder.invalidateCache();
  }

  // -----------------------------------------------------------------------
  // LLM Injection
  // -----------------------------------------------------------------------

  /** Set the LLM generation callback (for parameter filling + response generation). */
  setGenerateFn(fn: GenerateFn): void {
    this.generateFn = fn;
  }

  /** Set the LLM summarization callback (for observation encoding). */
  setSummarizeFn(fn: SummarizeFn): void {
    this.summarizeFn = fn;
  }

  /** Gracefully shut down the sidecar. */
  async shutdown(): Promise<void> {
    await this.sidecar?.stop();
  }
}

// ---------------------------------------------------------------------------
// Self-Registration
// ---------------------------------------------------------------------------

registerBrain("stratus", async (config) => {
  const brain = new StratusBrain();
  await brain.configure(config);
  return brain;
});
