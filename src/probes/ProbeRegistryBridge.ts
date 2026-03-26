/**
 * Probe Registry Bridge — Connect TS layer to Python ProbeRegistry
 *
 * Wraps v4_models/probes/registry.py and customer_store.py via sidecar.
 * Handles probe registration, assignment to agents, and A/B testing
 * configuration.
 *
 * Backend: v4_models/probes/registry.py + customer_store.py
 *
 * @purpose Bridge between TS Agent Factory and Python ProbeRegistry
 * @spec AGENT_FACTORY_SPEC.md#e23-build-probe-registry-integration
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RegistryBridgeConfig {
  /** Sidecar URL */
  sidecarUrl: string;
}

export interface RegisteredProbe {
  probeId: string;
  domain: string;
  version: string;
  weightsPath: string;
  accuracy: number;
  registeredAt: string;
  status: "active" | "testing" | "deprecated";
}

export interface ABTestConfig {
  /** New probe being tested */
  candidateProbeId: string;
  /** Current probe serving traffic */
  controlProbeId: string;
  /** Fraction of traffic to send to candidate (0-1) */
  candidateTrafficShare: number;
  /** Minimum requests before evaluating */
  minRequests: number;
  /** Metric to compare (default: "top1_accuracy") */
  metric: string;
  /** Minimum improvement to promote candidate */
  minImprovement: number;
}

export interface ABTestResult {
  candidateProbeId: string;
  controlProbeId: string;
  candidateMetric: number;
  controlMetric: number;
  improvement: number;
  totalRequests: number;
  shouldPromote: boolean;
}

// ---------------------------------------------------------------------------
// Bridge
// ---------------------------------------------------------------------------

export class ProbeRegistryBridge {
  private config: RegistryBridgeConfig;

  constructor(config: RegistryBridgeConfig) {
    this.config = config;
  }

  /**
   * Register a trained probe in the ProbeRegistry.
   */
  async register(
    probeId: string,
    weightsPath: string,
    metadata: {
      domain: string;
      accuracy: number;
      version?: string;
    },
  ): Promise<RegisteredProbe> {
    const response = await fetch(`${this.config.sidecarUrl}/probes/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        probe_id: probeId,
        weights_path: weightsPath,
        domain: metadata.domain,
        accuracy: metadata.accuracy,
        version: metadata.version ?? "1.0",
      }),
    });

    if (!response.ok) {
      throw new Error(`Probe registration failed: ${await response.text()}`);
    }

    const result = await response.json();
    return {
      probeId: result.probe_id ?? probeId,
      domain: result.domain ?? metadata.domain,
      version: result.version ?? "1.0",
      weightsPath: result.weights_path ?? weightsPath,
      accuracy: result.accuracy ?? metadata.accuracy,
      registeredAt: result.registered_at ?? new Date().toISOString(),
      status: "active",
    };
  }

  /**
   * List all registered probes.
   */
  async list(): Promise<RegisteredProbe[]> {
    const response = await fetch(`${this.config.sidecarUrl}/probes/list`);

    if (!response.ok) {
      throw new Error(`Failed to list probes: ${await response.text()}`);
    }

    const result = await response.json();
    return (result.probes ?? []).map((p: any) => ({
      probeId: p.probe_id,
      domain: p.domain,
      version: p.version,
      weightsPath: p.weights_path,
      accuracy: p.accuracy ?? 0,
      registeredAt: p.registered_at,
      status: p.status ?? "active",
    }));
  }

  /**
   * Assign a probe to an agent.
   */
  async assignToAgent(probeId: string, agentId: string): Promise<void> {
    const response = await fetch(`${this.config.sidecarUrl}/probes/assign`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        probe_id: probeId,
        agent_id: agentId,
      }),
    });

    if (!response.ok) {
      throw new Error(`Probe assignment failed: ${await response.text()}`);
    }
  }

  /**
   * Start an A/B test between two probes.
   */
  async startABTest(config: ABTestConfig): Promise<{ testId: string }> {
    const response = await fetch(`${this.config.sidecarUrl}/probes/ab_test`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        candidate_probe_id: config.candidateProbeId,
        control_probe_id: config.controlProbeId,
        candidate_traffic_share: config.candidateTrafficShare,
        min_requests: config.minRequests,
        metric: config.metric,
        min_improvement: config.minImprovement,
      }),
    });

    if (!response.ok) {
      throw new Error(`A/B test start failed: ${await response.text()}`);
    }

    const result = await response.json();
    return { testId: result.test_id };
  }

  /**
   * Get A/B test results.
   */
  async getABTestResult(testId: string): Promise<ABTestResult> {
    const response = await fetch(
      `${this.config.sidecarUrl}/probes/ab_test/${testId}`,
    );

    if (!response.ok) {
      throw new Error(`Failed to get A/B test: ${await response.text()}`);
    }

    const result = await response.json();
    return {
      candidateProbeId: result.candidate_probe_id,
      controlProbeId: result.control_probe_id,
      candidateMetric: result.candidate_metric ?? 0,
      controlMetric: result.control_metric ?? 0,
      improvement: result.improvement ?? 0,
      totalRequests: result.total_requests ?? 0,
      shouldPromote: result.should_promote ?? false,
    };
  }

  /**
   * Promote a candidate probe (replaces control).
   */
  async promote(testId: string): Promise<void> {
    const response = await fetch(
      `${this.config.sidecarUrl}/probes/ab_test/${testId}/promote`,
      { method: "POST" },
    );

    if (!response.ok) {
      throw new Error(`Probe promotion failed: ${await response.text()}`);
    }
  }
}
