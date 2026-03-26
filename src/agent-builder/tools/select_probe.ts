/**
 * Select Probe — Recommends a probe configuration for the domain
 *
 * Checks if the domain matches existing trained probes, recommends
 * built-in vs custom, and estimates expected accuracy.
 *
 * @purpose Select or recommend probe configuration for a domain
 * @spec AGENT_FACTORY_SPEC.md#c14-select_probe-tool
 */

import type { DomainAnalysis } from "./analyze_domain.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SelectProbeInput {
  /** Domain analysis */
  analysis: DomainAnalysis;
  /** Available probes in the system */
  availableProbes?: ProbeInfo[];
  /** Whether custom probe training is an option */
  allowCustomTraining?: boolean;
}

export interface ProbeInfo {
  /** Probe identifier */
  id: string;
  /** Human-readable name */
  name: string;
  /** What domains this probe was trained on */
  trainedDomains: string[];
  /** Probe type */
  type: "built_in" | "custom" | "general";
  /** Number of actions it's seen in training */
  actionVocabularySize: number;
  /** Accuracy on its training domains */
  trainAccuracy: number;
}

export interface ProbeRecommendation {
  /** Recommended primary probe ID */
  primaryProbe: string;
  /** Why this probe was chosen */
  reasoning: string;
  /** Expected accuracy estimate (0-1) */
  expectedAccuracy: number;
  /** Confidence in this recommendation (0-1) */
  confidence: number;
  /** Whether to use probe cascade */
  useCascade: boolean;
  /** Cascade configuration (if useCascade) */
  cascade?: {
    /** Custom probe (if available) */
    primary: string;
    /** General fallback */
    fallback: string;
  };
  /** Whether custom training is recommended */
  customTrainingRecommended: boolean;
  /** If custom training recommended, what data is needed */
  trainingDataNeeds?: string;
  /** Risk factors for the recommendation */
  risks: string[];
}

// ---------------------------------------------------------------------------
// Built-in Probes
// ---------------------------------------------------------------------------

const BUILT_IN_PROBES: ProbeInfo[] = [
  {
    id: "planning-v1",
    name: "General Planning v1",
    trainedDomains: ["general"],
    type: "general",
    actionVocabularySize: 200,
    trainAccuracy: 0.72,
  },
  {
    id: "planning-v2",
    name: "General Planning v2",
    trainedDomains: ["general"],
    type: "general",
    actionVocabularySize: 488,
    trainAccuracy: 0.78,
  },
  {
    id: "tool-use-v1",
    name: "Tool Use v1",
    trainedDomains: ["general", "devops", "api_management"],
    type: "built_in",
    actionVocabularySize: 350,
    trainAccuracy: 0.75,
  },
  {
    id: "error-recovery-v1",
    name: "Error Recovery v1",
    trainedDomains: ["general", "incident_response", "devops"],
    type: "built_in",
    actionVocabularySize: 150,
    trainAccuracy: 0.70,
  },
  {
    id: "goal-decomposition-v1",
    name: "Goal Decomposition v1",
    trainedDomains: ["general", "project_management"],
    type: "built_in",
    actionVocabularySize: 200,
    trainAccuracy: 0.73,
  },
];

// ---------------------------------------------------------------------------
// Tool Implementation
// ---------------------------------------------------------------------------

export class SelectProbeTool {
  async execute(input: SelectProbeInput): Promise<ProbeRecommendation> {
    const allProbes = [...BUILT_IN_PROBES, ...(input.availableProbes ?? [])];
    const allowCustom = input.allowCustomTraining ?? true;

    // Score each probe against the domain
    const scored = allProbes.map((probe) => ({
      probe,
      score: this.scoreProbe(probe, input.analysis),
    }));

    scored.sort((a, b) => b.score - a.score);

    const best = scored[0];
    const second = scored[1];

    // Check for custom probes trained on this domain
    const exactMatch = scored.find(
      (s) => s.probe.type === "custom" &&
        s.probe.trainedDomains.includes(input.analysis.domainName),
    );

    if (exactMatch && exactMatch.score > 0.7) {
      return this.buildRecommendation(exactMatch, scored, allowCustom, input.analysis);
    }

    return this.buildRecommendation(best, scored, allowCustom, input.analysis);
  }

  // -----------------------------------------------------------------------
  // Scoring
  // -----------------------------------------------------------------------

  private scoreProbe(probe: ProbeInfo, analysis: DomainAnalysis): number {
    let score = 0;

    // Direct domain match
    if (probe.trainedDomains.includes(analysis.domainName)) {
      score += 0.5;
    }

    // Partial domain match (check training coverage)
    const coveredDomains = analysis.trainingCoverage
      .filter((tc) => tc.similarity > 0.3)
      .map((tc) => tc.domain);

    for (const domain of coveredDomains) {
      if (probe.trainedDomains.includes(domain)) {
        score += 0.2;
      }
    }

    // General probes get a base score
    if (probe.type === "general") {
      score += 0.3;
    }

    // Action vocabulary coverage
    const domainActions = analysis.actions.length;
    const vocabRatio = Math.min(probe.actionVocabularySize / Math.max(domainActions * 5, 1), 1);
    score += vocabRatio * 0.1;

    // Training accuracy bonus
    score += probe.trainAccuracy * 0.1;

    return Math.min(score, 1.0);
  }

  // -----------------------------------------------------------------------
  // Recommendation Building
  // -----------------------------------------------------------------------

  private buildRecommendation(
    best: { probe: ProbeInfo; score: number },
    all: Array<{ probe: ProbeInfo; score: number }>,
    allowCustom: boolean,
    analysis: DomainAnalysis,
  ): ProbeRecommendation {
    const risks: string[] = [];
    const gapRatio = analysis.actions.length > 0
      ? analysis.gaps.length / analysis.actions.length
      : 0;

    // Determine if custom training is needed
    const customRecommended = allowCustom && (
      best.score < 0.5 ||
      gapRatio > 0.3 ||
      analysis.customProbeRecommended
    );

    // Estimate accuracy
    let expectedAccuracy = best.probe.trainAccuracy * best.score;
    if (gapRatio > 0.3) {
      expectedAccuracy *= 0.8;
      risks.push(`${(gapRatio * 100).toFixed(0)}% of domain actions are not in training data.`);
    }

    if (best.probe.type === "general" && analysis.actions.length > 20) {
      risks.push("General probe with large action space — custom probe would improve precision.");
      expectedAccuracy *= 0.9;
    }

    expectedAccuracy = Math.max(expectedAccuracy, 0.3); // Floor

    // Determine cascade
    const generalProbe = all.find((s) => s.probe.type === "general");
    const useCascade = best.probe.type !== "general" && generalProbe != null;

    const recommendation: ProbeRecommendation = {
      primaryProbe: best.probe.id,
      reasoning: this.buildReasoning(best, analysis, customRecommended),
      expectedAccuracy,
      confidence: best.score,
      useCascade,
      customTrainingRecommended: customRecommended,
      risks,
    };

    if (useCascade && generalProbe) {
      recommendation.cascade = {
        primary: best.probe.id,
        fallback: generalProbe.probe.id,
      };
    }

    if (customRecommended) {
      recommendation.trainingDataNeeds = this.describeTrainingNeeds(analysis);
    }

    return recommendation;
  }

  private buildReasoning(
    best: { probe: ProbeInfo; score: number },
    analysis: DomainAnalysis,
    customRecommended: boolean,
  ): string {
    const parts: string[] = [];

    if (best.probe.trainedDomains.includes(analysis.domainName)) {
      parts.push(`Probe "${best.probe.id}" was trained directly on the "${analysis.domainName}" domain.`);
    } else if (best.score > 0.5) {
      parts.push(`Probe "${best.probe.id}" has good coverage of related domains (score: ${best.score.toFixed(2)}).`);
    } else {
      parts.push(`Best available probe "${best.probe.id}" is a general-purpose match (score: ${best.score.toFixed(2)}).`);
    }

    if (customRecommended) {
      parts.push("A custom probe trained on domain-specific trajectories would significantly improve accuracy.");
    }

    return parts.join(" ");
  }

  private describeTrainingNeeds(analysis: DomainAnalysis): string {
    const actionCount = analysis.actions.length;
    const minTrajectories = Math.max(actionCount * 10, 100);

    return [
      `Minimum ${minTrajectories} trajectories covering ${actionCount} actions.`,
      `Focus on: ${analysis.gaps.slice(0, 3).join(", ") || "all actions"}.`,
      "Can be synthetic (generated from domain spec) or real (from production logs).",
    ].join(" ");
  }
}
