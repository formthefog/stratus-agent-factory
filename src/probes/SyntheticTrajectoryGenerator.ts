/**
 * Synthetic Trajectory Generator — TS wrapper over Python backend
 *
 * Calls v4_training/synthetic/generate_trajectories_v2.py and
 * generate_domain_trajectories.py via the sidecar to produce synthetic
 * training data for probe training.
 *
 * Backend: v4_training/synthetic/generate_trajectories_v2.py
 *
 * @purpose Generate synthetic trajectories for probe training via Python backend
 * @spec AGENT_FACTORY_SPEC.md#e12-build-synthetic-trajectory-generator
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GeneratorConfig {
  /** Sidecar URL */
  sidecarUrl: string;
  /** Output directory for generated trajectories */
  outputDir: string;
}

export interface GenerateInput {
  /** Domain identifier */
  domain: string;
  /** Domain description for context */
  domainDescription: string;
  /** Tool definitions (from agent.tools.yaml) */
  tools: ToolDef[];
  /** Sample goals for this domain */
  goals: string[];
  /** Number of trajectories to generate (default: 1000) */
  count?: number;
  /** Include failure/recovery trajectories (default: true) */
  includeFailures?: boolean;
  /** Include alternative paths (default: true) */
  includeAlternatives?: boolean;
}

export interface ToolDef {
  id: string;
  actionType: string;
  description: string;
  effects: string;
  preconditions: string;
}

export interface GenerateResult {
  /** Number of trajectories generated */
  count: number;
  /** Output file path */
  outputPath: string;
  /** Unique actions seen */
  uniqueActions: number;
  /** Unique goals seen */
  uniqueGoals: number;
  /** Average trajectory length */
  avgLength: number;
  /** Whether failures were included */
  hasFailures: boolean;
}

// ---------------------------------------------------------------------------
// Generator
// ---------------------------------------------------------------------------

export class SyntheticTrajectoryGenerator {
  private config: GeneratorConfig;

  constructor(config: GeneratorConfig) {
    this.config = config;
  }

  /**
   * Generate synthetic trajectories by calling the Python backend
   * through the sidecar's /generate_trajectories endpoint.
   */
  async generate(input: GenerateInput): Promise<GenerateResult> {
    const count = input.count ?? 1000;

    const payload = {
      domain: input.domain,
      domain_description: input.domainDescription,
      tools: input.tools.map((t) => ({
        id: t.id,
        action_type: t.actionType,
        description: t.description,
        effects: t.effects,
        preconditions: t.preconditions,
      })),
      goals: input.goals,
      count,
      include_failures: input.includeFailures ?? true,
      include_alternatives: input.includeAlternatives ?? true,
      output_dir: this.config.outputDir,
    };

    const response = await fetch(
      `${this.config.sidecarUrl}/generate_trajectories`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(300_000), // 5 min — generation can be slow
      },
    );

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Trajectory generation failed: ${err}`);
    }

    const result = await response.json();

    return {
      count: result.count ?? count,
      outputPath: result.output_path ?? this.config.outputDir,
      uniqueActions: result.unique_actions ?? 0,
      uniqueGoals: result.unique_goals ?? 0,
      avgLength: result.avg_length ?? 0,
      hasFailures: result.has_failures ?? false,
    };
  }

  /**
   * Generate domain-specific trajectories using the domain trajectory
   * generator (generate_domain_trajectories.py).
   */
  async generateForDomain(
    domain: string,
    schemaPath: string,
    count?: number,
  ): Promise<GenerateResult> {
    const payload = {
      domain,
      schema_path: schemaPath,
      count: count ?? 1000,
      output_dir: this.config.outputDir,
    };

    const response = await fetch(
      `${this.config.sidecarUrl}/generate_domain_trajectories`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(300_000),
      },
    );

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Domain trajectory generation failed: ${err}`);
    }

    const result = await response.json();

    return {
      count: result.count ?? 0,
      outputPath: result.output_path ?? this.config.outputDir,
      uniqueActions: result.unique_actions ?? 0,
      uniqueGoals: result.unique_goals ?? 0,
      avgLength: result.avg_length ?? 0,
      hasFailures: result.has_failures ?? false,
    };
  }
}
