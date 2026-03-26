/**
 * Probe Trainer — TS wrapper over ProbeFactory Python backend
 *
 * Calls v4_models/probes/factory.py via the sidecar to train LoRA
 * probe adapters. Handles spec generation, training invocation,
 * and result parsing.
 *
 * Backend: v4_models/probes/factory.py (ProbeFactory.train())
 *
 * @purpose Train LoRA probe adapters via Python backend
 * @spec AGENT_FACTORY_SPEC.md#e21-build-lora-probe-trainer
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ProbeTrainerConfig {
  /** Sidecar URL */
  sidecarUrl: string;
}

export interface TrainProbeInput {
  /** Probe identifier (e.g. "acme/customer-support") */
  probeId: string;
  /** Domain this probe is for */
  domain: string;
  /** Path to training data directory (JSONL files) */
  dataDir: string;
  /** Training hyperparameters */
  hyperparams?: ProbeHyperparams;
  /** Path to write trained weights */
  outputPath?: string;
}

export interface ProbeHyperparams {
  /** LoRA rank (default: 16) */
  loraRank?: number;
  /** Learning rate (default: 1e-4) */
  learningRate?: number;
  /** Training epochs (default: 10) */
  epochs?: number;
  /** Batch size (default: 32) */
  batchSize?: number;
  /** Max training steps (overrides epochs if set) */
  maxSteps?: number;
  /** Early stopping patience (default: 3) */
  patience?: number;
  /** Validation split ratio (default: 0.2) */
  validationSplit?: number;
}

export interface TrainResult {
  /** Whether training succeeded */
  success: boolean;
  /** Path to trained weights */
  weightsPath: string | null;
  /** Training metrics */
  metrics: TrainMetrics;
  /** Error message if failed */
  error?: string;
}

export interface TrainMetrics {
  /** Final training loss */
  trainLoss: number;
  /** Final validation loss */
  valLoss: number;
  /** Mean cosine similarity (predicted vs actual action) */
  cosineSimilarity: number;
  /** Top-1 action selection accuracy */
  top1Accuracy: number;
  /** Top-3 action selection accuracy */
  top3Accuracy: number;
  /** Number of training steps completed */
  stepsCompleted: number;
  /** Training duration in seconds */
  durationSeconds: number;
  /** Whether early stopping was triggered */
  earlyStopped: boolean;
}

// ---------------------------------------------------------------------------
// Trainer
// ---------------------------------------------------------------------------

export class ProbeTrainer {
  private config: ProbeTrainerConfig;

  constructor(config: ProbeTrainerConfig) {
    this.config = config;
  }

  /**
   * Train a LoRA probe by calling the Python ProbeFactory via sidecar.
   */
  async train(input: TrainProbeInput): Promise<TrainResult> {
    const hyperparams = input.hyperparams ?? {};

    const payload = {
      probe_id: input.probeId,
      domain: input.domain,
      data_dir: input.dataDir,
      output_path: input.outputPath,
      hyperparams: {
        lora_rank: hyperparams.loraRank ?? 16,
        learning_rate: hyperparams.learningRate ?? 1e-4,
        epochs: hyperparams.epochs ?? 10,
        batch_size: hyperparams.batchSize ?? 32,
        max_steps: hyperparams.maxSteps,
        patience: hyperparams.patience ?? 3,
        validation_split: hyperparams.validationSplit ?? 0.2,
      },
    };

    const response = await fetch(`${this.config.sidecarUrl}/train_probe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(600_000), // 10 min — training can be slow
    });

    if (!response.ok) {
      const err = await response.text();
      return {
        success: false,
        weightsPath: null,
        metrics: emptyMetrics(),
        error: `Training failed: ${err}`,
      };
    }

    const result = await response.json();

    return {
      success: result.success ?? true,
      weightsPath: result.weights_path ?? null,
      metrics: {
        trainLoss: result.train_loss ?? 0,
        valLoss: result.val_loss ?? 0,
        cosineSimilarity: result.cosine_similarity ?? 0,
        top1Accuracy: result.top1_accuracy ?? 0,
        top3Accuracy: result.top3_accuracy ?? 0,
        stepsCompleted: result.steps_completed ?? 0,
        durationSeconds: result.duration_seconds ?? 0,
        earlyStopped: result.early_stopped ?? false,
      },
      error: result.error,
    };
  }
}

function emptyMetrics(): TrainMetrics {
  return {
    trainLoss: 0,
    valLoss: 0,
    cosineSimilarity: 0,
    top1Accuracy: 0,
    top3Accuracy: 0,
    stepsCompleted: 0,
    durationSeconds: 0,
    earlyStopped: false,
  };
}
