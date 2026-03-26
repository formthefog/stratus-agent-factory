/**
 * Train Probe — Triggers probe training on customer data
 *
 * If traces are provided, trains a LoRA probe on customer data.
 * If no traces, generates synthetic trajectories from the domain spec
 * and trains on those. Returns probe ID and evaluation metrics.
 *
 * @purpose Train custom LoRA probe for a customer domain
 * @spec AGENT_FACTORY_SPEC.md#c15-train_probe-tool
 */

import type { DomainAnalysis } from "./analyze_domain.js";
import type { ToolDefinition } from "./generate_tool_registry.js";
import type { StratusClient } from "../../brain/stratus/index.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TrainProbeInput {
  /** Domain name */
  domain: string;
  /** Domain analysis */
  analysis: DomainAnalysis;
  /** Tool registry for this domain */
  tools: ToolDefinition[];
  /** Existing training traces (optional — synthetic if missing) */
  traces?: TrainingTrace[];
  /** Base probe to fine-tune from (default: "planning-v2") */
  baseProbe?: string;
  /** Training configuration overrides */
  trainingConfig?: Partial<ProbeTrainingConfig>;
}

export interface TrainingTrace {
  /** Session/episode identifier */
  sessionId: string;
  /** Goal text */
  goal: string;
  /** Sequence of steps */
  steps: TraceStep[];
  /** Whether the goal was achieved */
  success: boolean;
}

export interface TraceStep {
  /** State text at this step */
  stateText: string;
  /** Action taken */
  actionTaken: string;
  /** Goal proximity at this step */
  goalProximity: number;
}

export interface ProbeTrainingConfig {
  /** LoRA rank (default: 16) */
  loraRank: number;
  /** Learning rate (default: 1e-4) */
  learningRate: number;
  /** Training epochs (default: 10) */
  epochs: number;
  /** Batch size (default: 32) */
  batchSize: number;
  /** Train/validation split (default: 0.2) */
  validationSplit: number;
  /** Early stopping patience (default: 3) */
  earlyStoppingPatience: number;
}

export interface ProbeTrainingResult {
  /** Generated probe ID */
  probeId: string;
  /** Domain it was trained for */
  domain: string;
  /** Base probe it was fine-tuned from */
  baseProbe: string;
  /** Number of training trajectories used */
  trajectoryCount: number;
  /** Whether synthetic data was generated */
  usedSyntheticData: boolean;
  /** Training metrics */
  metrics: ProbeMetrics;
  /** Per-action accuracy breakdown */
  perActionAccuracy: Array<{ action: string; accuracy: number; count: number }>;
  /** Path to probe weights */
  weightsPath: string;
  /** Whether the probe meets quality thresholds */
  passedQualityCheck: boolean;
  /** Quality check details */
  qualityNotes: string[];
}

export interface ProbeMetrics {
  /** Top-1 accuracy on validation set */
  top1Accuracy: number;
  /** Top-3 accuracy on validation set */
  top3Accuracy: number;
  /** Mean reciprocal rank */
  mrr: number;
  /** Training loss (final epoch) */
  trainLoss: number;
  /** Validation loss (final epoch) */
  valLoss: number;
  /** Number of epochs trained (may be < max if early stopped) */
  epochsTrained: number;
}

// ---------------------------------------------------------------------------
// LLM Callback (for synthetic data generation)
// ---------------------------------------------------------------------------

export type SyntheticLlmFn = (prompt: string, signal?: AbortSignal) => Promise<string>;

// ---------------------------------------------------------------------------
// Default Config
// ---------------------------------------------------------------------------

const DEFAULT_TRAINING_CONFIG: ProbeTrainingConfig = {
  loraRank: 16,
  learningRate: 1e-4,
  epochs: 10,
  batchSize: 32,
  validationSplit: 0.2,
  earlyStoppingPatience: 3,
};

// ---------------------------------------------------------------------------
// Tool Implementation
// ---------------------------------------------------------------------------

export class TrainProbeTool {
  private llm: SyntheticLlmFn;
  private client: StratusClient;

  constructor(llm: SyntheticLlmFn, client: StratusClient) {
    this.llm = llm;
    this.client = client;
  }

  async execute(
    input: TrainProbeInput,
    signal?: AbortSignal,
  ): Promise<ProbeTrainingResult> {
    const config = { ...DEFAULT_TRAINING_CONFIG, ...input.trainingConfig };
    const baseProbe = input.baseProbe ?? "planning-v2";

    // Step 1: Prepare training data
    let traces = input.traces ?? [];
    let usedSynthetic = false;

    if (traces.length === 0) {
      traces = await this.generateSyntheticTraces(input, signal);
      usedSynthetic = true;
    }

    // Step 2: Encode training data through world model
    const encodedData = await this.encodeTraces(traces, input.tools, signal);

    // Step 3: Train the probe (calls sidecar training endpoint)
    const probeId = `${input.domain}-probe-${Date.now()}`;
    const trainingResult = await this.trainLoRA(
      probeId,
      baseProbe,
      encodedData,
      config,
      signal,
    );

    // Step 4: Evaluate on held-out data
    const metrics = await this.evaluate(
      probeId,
      encodedData.validation,
      input.tools,
      signal,
    );

    // Step 5: Per-action breakdown
    const perActionAccuracy = this.computePerActionAccuracy(
      encodedData.validation,
      metrics.predictions,
    );

    // Step 6: Quality check
    const { passed, notes } = this.qualityCheck(metrics.metrics, perActionAccuracy);

    return {
      probeId,
      domain: input.domain,
      baseProbe,
      trajectoryCount: traces.length,
      usedSyntheticData: usedSynthetic,
      metrics: metrics.metrics,
      perActionAccuracy,
      weightsPath: trainingResult.weightsPath,
      passedQualityCheck: passed,
      qualityNotes: notes,
    };
  }

  // -----------------------------------------------------------------------
  // Synthetic Data Generation
  // -----------------------------------------------------------------------

  private async generateSyntheticTraces(
    input: TrainProbeInput,
    signal?: AbortSignal,
  ): Promise<TrainingTrace[]> {
    const traces: TrainingTrace[] = [];
    const toolIds = input.tools.map((t) => t.id);

    for (const workflow of input.analysis.workflows) {
      // Generate 5 variations of each workflow
      for (let i = 0; i < 5; i++) {
        const trace = await this.generateTraceFromWorkflow(
          workflow.name,
          workflow.triggerGoal,
          workflow.actionsInvolved.filter((a) => toolIds.includes(a)),
          input.domain,
          signal,
        );
        if (trace) traces.push(trace);
      }
    }

    // Generate traces for goals without explicit workflows
    for (const goal of input.analysis.goals.slice(0, 10)) {
      const trace = await this.generateTraceFromGoal(
        goal,
        toolIds,
        input.domain,
        signal,
      );
      if (trace) traces.push(trace);
    }

    return traces;
  }

  private async generateTraceFromWorkflow(
    workflowName: string,
    goal: string,
    actions: string[],
    domain: string,
    signal?: AbortSignal,
  ): Promise<TrainingTrace | null> {
    const prompt = [
      `Generate a realistic training trace for a "${domain}" agent.`,
      `Workflow: ${workflowName}`,
      `Goal: ${goal}`,
      `Available actions: ${actions.join(", ")}`,
      ``,
      `Return JSON: { "steps": [ { "stateText": "...", "actionTaken": "...", "goalProximity": 0.0-1.0 } ] }`,
      `Goal proximity should increase toward 1.0 as the goal is reached.`,
      `Generate 3-8 steps.`,
    ].join("\n");

    const raw = await this.llm(prompt, signal);

    try {
      const jsonMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/) ?? [null, raw];
      const parsed = JSON.parse((jsonMatch[1] ?? raw).trim());

      return {
        sessionId: `synthetic-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        goal,
        steps: parsed.steps ?? [],
        success: true,
      };
    } catch {
      return null;
    }
  }

  private async generateTraceFromGoal(
    goal: string,
    toolIds: string[],
    domain: string,
    signal?: AbortSignal,
  ): Promise<TrainingTrace | null> {
    const prompt = [
      `Generate a training trace for a "${domain}" agent achieving this goal:`,
      `"${goal}"`,
      `Available tools: ${toolIds.join(", ")}`,
      `Return JSON: { "steps": [ { "stateText": "...", "actionTaken": "...", "goalProximity": 0.0-1.0 } ] }`,
    ].join("\n");

    const raw = await this.llm(prompt, signal);

    try {
      const jsonMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/) ?? [null, raw];
      const parsed = JSON.parse((jsonMatch[1] ?? raw).trim());

      return {
        sessionId: `synthetic-goal-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        goal,
        steps: parsed.steps ?? [],
        success: true,
      };
    } catch {
      return null;
    }
  }

  // -----------------------------------------------------------------------
  // Encoding
  // -----------------------------------------------------------------------

  private async encodeTraces(
    traces: TrainingTrace[],
    tools: ToolDefinition[],
    signal?: AbortSignal,
  ): Promise<EncodedTrainingData> {
    // Split into train/val
    const splitIdx = Math.floor(traces.length * 0.8);
    const trainTraces = traces.slice(0, splitIdx);
    const valTraces = traces.slice(splitIdx);

    // Encode tool embeddings once
    const descriptions = tools.map((t) => t.richDescription);
    const labels = tools.map((t) => t.id);
    const actionResponse = await this.client.encodeActions(descriptions, labels, signal);
    const actionEmbeddings = new Map<string, number[]>();
    for (const emb of actionResponse.embeddings) {
      actionEmbeddings.set(emb.action, emb.embedding);
    }

    // Encode each trace's states
    const train = await this.encodeTraceSet(trainTraces, actionEmbeddings, signal);
    const validation = await this.encodeTraceSet(valTraces, actionEmbeddings, signal);

    return { train, validation, actionEmbeddings };
  }

  private async encodeTraceSet(
    traces: TrainingTrace[],
    actionEmbeddings: Map<string, number[]>,
    signal?: AbortSignal,
  ): Promise<EncodedSample[]> {
    const samples: EncodedSample[] = [];

    for (const trace of traces) {
      const goalResponse = await this.client.encodeGoal(trace.goal, signal);
      const goalEmb = goalResponse.embedding;

      for (const step of trace.steps) {
        const stateResponse = await this.client.encodeState(step.stateText, signal);
        const actionEmb = actionEmbeddings.get(step.actionTaken);

        if (actionEmb) {
          samples.push({
            stateEmbedding: stateResponse.embedding,
            goalEmbedding: goalEmb,
            correctAction: step.actionTaken,
            correctActionEmbedding: actionEmb,
            goalProximity: step.goalProximity,
          });
        }
      }
    }

    return samples;
  }

  // -----------------------------------------------------------------------
  // Training (delegates to sidecar)
  // -----------------------------------------------------------------------

  private async trainLoRA(
    probeId: string,
    baseProbe: string,
    data: EncodedTrainingData,
    config: ProbeTrainingConfig,
    _signal?: AbortSignal,
  ): Promise<{ weightsPath: string }> {
    // In v1, training happens via sidecar RPC.
    // The sidecar exposes a /train_probe endpoint (not in current RPC types
    // — will be added when training pipeline is wired). For now, return
    // the expected path where weights would be saved.
    const weightsPath = `.stratus/probes/${probeId}/weights.pt`;

    // TODO: Wire to sidecar /train_probe RPC when endpoint exists
    // await this.client.trainProbe({
    //   probeId, baseProbe, trainSamples: data.train,
    //   config, signal
    // });

    void data;
    void config;
    void baseProbe;

    return { weightsPath };
  }

  // -----------------------------------------------------------------------
  // Evaluation
  // -----------------------------------------------------------------------

  private async evaluate(
    probeId: string,
    valData: EncodedSample[],
    tools: ToolDefinition[],
    signal?: AbortSignal,
  ): Promise<{ metrics: ProbeMetrics; predictions: PredictionResult[] }> {
    const predictions: PredictionResult[] = [];

    const actionEmbeddings = tools.map((t) => {
      // Use dummy embeddings for now — actual would come from encoded data
      return new Array(768).fill(0);
    });
    const actionLabels = tools.map((t) => t.id);

    for (const sample of valData) {
      try {
        const rankResult = await this.client.probeRank(
          sample.stateEmbedding,
          sample.goalEmbedding,
          actionEmbeddings,
          actionLabels,
          5,
          probeId,
          signal,
        );

        const ranked = rankResult.ranked_actions.map((r) => r.action);
        predictions.push({
          correct: sample.correctAction,
          predicted: ranked,
        });
      } catch {
        // Skip evaluation failures
      }
    }

    const metrics = this.computeMetrics(predictions);
    return { metrics, predictions };
  }

  private computeMetrics(predictions: PredictionResult[]): ProbeMetrics {
    if (predictions.length === 0) {
      return {
        top1Accuracy: 0,
        top3Accuracy: 0,
        mrr: 0,
        trainLoss: 0,
        valLoss: 0,
        epochsTrained: 0,
      };
    }

    let top1 = 0;
    let top3 = 0;
    let mrrSum = 0;

    for (const pred of predictions) {
      if (pred.predicted[0] === pred.correct) top1++;
      if (pred.predicted.slice(0, 3).includes(pred.correct)) top3++;

      const rank = pred.predicted.indexOf(pred.correct);
      if (rank >= 0) mrrSum += 1 / (rank + 1);
    }

    return {
      top1Accuracy: top1 / predictions.length,
      top3Accuracy: top3 / predictions.length,
      mrr: mrrSum / predictions.length,
      trainLoss: 0, // Populated by actual training
      valLoss: 0,
      epochsTrained: 0,
    };
  }

  // -----------------------------------------------------------------------
  // Per-Action Accuracy
  // -----------------------------------------------------------------------

  private computePerActionAccuracy(
    valData: EncodedSample[],
    predictions: PredictionResult[],
  ): Array<{ action: string; accuracy: number; count: number }> {
    const byAction = new Map<string, { correct: number; total: number }>();

    for (let i = 0; i < Math.min(valData.length, predictions.length); i++) {
      const action = valData[i].correctAction;
      const entry = byAction.get(action) ?? { correct: 0, total: 0 };
      entry.total++;
      if (predictions[i].predicted[0] === action) entry.correct++;
      byAction.set(action, entry);
    }

    return [...byAction.entries()]
      .map(([action, stats]) => ({
        action,
        accuracy: stats.total > 0 ? stats.correct / stats.total : 0,
        count: stats.total,
      }))
      .sort((a, b) => a.accuracy - b.accuracy);
  }

  // -----------------------------------------------------------------------
  // Quality Check
  // -----------------------------------------------------------------------

  private qualityCheck(
    metrics: ProbeMetrics,
    perAction: Array<{ action: string; accuracy: number; count: number }>,
  ): { passed: boolean; notes: string[] } {
    const notes: string[] = [];
    let passed = true;

    if (metrics.top1Accuracy < 0.5) {
      notes.push(`Top-1 accuracy ${(metrics.top1Accuracy * 100).toFixed(1)}% is below 50% threshold.`);
      passed = false;
    }

    if (metrics.top3Accuracy < 0.7) {
      notes.push(`Top-3 accuracy ${(metrics.top3Accuracy * 100).toFixed(1)}% is below 70% threshold.`);
      passed = false;
    }

    // Check for actions with zero accuracy
    const zeroActions = perAction.filter((a) => a.accuracy === 0 && a.count >= 3);
    if (zeroActions.length > 0) {
      notes.push(`${zeroActions.length} actions have 0% accuracy: ${zeroActions.map((a) => a.action).join(", ")}`);
      if (zeroActions.length > perAction.length * 0.3) {
        passed = false;
      }
    }

    if (passed && notes.length === 0) {
      notes.push("All quality checks passed.");
    }

    return { passed, notes };
  }
}

// ---------------------------------------------------------------------------
// Internal Types
// ---------------------------------------------------------------------------

interface EncodedTrainingData {
  train: EncodedSample[];
  validation: EncodedSample[];
  actionEmbeddings: Map<string, number[]>;
}

interface EncodedSample {
  stateEmbedding: number[];
  goalEmbedding: number[];
  correctAction: string;
  correctActionEmbedding: number[];
  goalProximity: number;
}

interface PredictionResult {
  correct: string;
  predicted: string[];
}
