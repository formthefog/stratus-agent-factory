/**
 * Memory Module — State trajectory storage and analysis
 *
 * @purpose Public API for Stratus session trajectory management
 */

export { StateTrajectoryStore } from "./StateTrajectoryStore.js";
export type { StateSnapshot, TrajectoryMeta } from "./StateTrajectoryStore.js";

export { TrajectoryMemoryBridge } from "./TrajectoryMemoryBridge.js";
export type { TrajectorySummary, KeyDecision } from "./TrajectoryMemoryBridge.js";

export { TrajectoryReplay } from "./TrajectoryReplay.js";
export type { ReplayStep, ReplayResult } from "./TrajectoryReplay.js";
