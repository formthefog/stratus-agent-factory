/**
 * State Trajectory Store — Append-only log of state embeddings per session
 *
 * Records the full trajectory of state embeddings, actions, and proximity
 * values for each session. Stored as binary files for compact storage.
 *
 * Used by: trajectory analysis, session replay, Agent Builder debugging
 *
 * @purpose Append-only state trajectory storage for Stratus sessions
 * @spec AGENT_FACTORY_SPEC.md#a41-design-state-trajectory-store
 */

import {
  writeFileSync,
  readFileSync,
  appendFileSync,
  existsSync,
  mkdirSync,
} from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface StateSnapshot {
  step: number;
  timestamp: string;
  /** 1024-d state embedding */
  stateEmbedding: Float32Array;
  /** Tool/action that was taken */
  actionTaken: string;
  /** Goal proximity at this step */
  goalProximity: number;
  /** Probe confidence for the selected action */
  probeConfidence: number;
}

export interface TrajectoryMeta {
  sessionId: string;
  startedAt: string;
  endedAt?: string;
  goal: string;
  totalSteps: number;
  finalProximity: number;
  embeddingDim: number;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export class StateTrajectoryStore {
  private storeDir: string;

  constructor(storeDir = ".stratus/trajectories") {
    this.storeDir = storeDir;
    if (!existsSync(storeDir)) {
      mkdirSync(storeDir, { recursive: true });
    }
  }

  /**
   * Start a new trajectory session.
   */
  startSession(sessionId: string, goal: string, embeddingDim = 1024): void {
    const meta: TrajectoryMeta = {
      sessionId,
      startedAt: new Date().toISOString(),
      goal,
      totalSteps: 0,
      finalProximity: 0,
      embeddingDim,
    };

    const metaPath = this.metaPath(sessionId);
    writeFileSync(metaPath, JSON.stringify(meta), "utf-8");
  }

  /**
   * Append a state snapshot to the trajectory.
   */
  appendSnapshot(sessionId: string, snapshot: StateSnapshot): void {
    const binPath = this.binPath(sessionId);

    // Serialize: [step(4)] [timestamp_len(2)] [timestamp] [action_len(2)] [action]
    //            [proximity(4)] [confidence(4)] [embedding(dim*4)]
    const timestampBuf = Buffer.from(snapshot.timestamp, "utf-8");
    const actionBuf = Buffer.from(snapshot.actionTaken, "utf-8");
    const embeddingBuf = Buffer.from(snapshot.stateEmbedding.buffer);

    const headerSize = 4 + 2 + timestampBuf.length + 2 + actionBuf.length + 4 + 4;
    const buf = Buffer.alloc(headerSize + embeddingBuf.length);
    let offset = 0;

    buf.writeUInt32LE(snapshot.step, offset); offset += 4;
    buf.writeUInt16LE(timestampBuf.length, offset); offset += 2;
    timestampBuf.copy(buf, offset); offset += timestampBuf.length;
    buf.writeUInt16LE(actionBuf.length, offset); offset += 2;
    actionBuf.copy(buf, offset); offset += actionBuf.length;
    buf.writeFloatLE(snapshot.goalProximity, offset); offset += 4;
    buf.writeFloatLE(snapshot.probeConfidence, offset); offset += 4;
    embeddingBuf.copy(buf, offset);

    appendFileSync(binPath, buf);

    // Update meta
    this.updateMeta(sessionId, (meta) => {
      meta.totalSteps = snapshot.step;
      meta.finalProximity = snapshot.goalProximity;
    });
  }

  /**
   * End a session trajectory.
   */
  endSession(sessionId: string): void {
    this.updateMeta(sessionId, (meta) => {
      meta.endedAt = new Date().toISOString();
    });
  }

  /**
   * Load trajectory metadata.
   */
  loadMeta(sessionId: string): TrajectoryMeta | null {
    const metaPath = this.metaPath(sessionId);
    if (!existsSync(metaPath)) return null;
    try {
      return JSON.parse(readFileSync(metaPath, "utf-8")) as TrajectoryMeta;
    } catch {
      return null;
    }
  }

  /**
   * Load all snapshots from a trajectory.
   */
  loadSnapshots(sessionId: string): StateSnapshot[] {
    const meta = this.loadMeta(sessionId);
    if (!meta) return [];

    const binPath = this.binPath(sessionId);
    if (!existsSync(binPath)) return [];

    const data = readFileSync(binPath);
    const snapshots: StateSnapshot[] = [];
    let offset = 0;

    while (offset < data.length) {
      const step = data.readUInt32LE(offset); offset += 4;

      const tsLen = data.readUInt16LE(offset); offset += 2;
      const timestamp = data.subarray(offset, offset + tsLen).toString("utf-8"); offset += tsLen;

      const actLen = data.readUInt16LE(offset); offset += 2;
      const actionTaken = data.subarray(offset, offset + actLen).toString("utf-8"); offset += actLen;

      const goalProximity = data.readFloatLE(offset); offset += 4;
      const probeConfidence = data.readFloatLE(offset); offset += 4;

      const embSize = meta.embeddingDim * 4;
      const embBuf = data.subarray(offset, offset + embSize);
      const stateEmbedding = new Float32Array(embBuf.buffer, embBuf.byteOffset, meta.embeddingDim);
      offset += embSize;

      snapshots.push({ step, timestamp, stateEmbedding, actionTaken, goalProximity, probeConfidence });
    }

    return snapshots;
  }

  /**
   * Check if a session trajectory exists.
   */
  hasSession(sessionId: string): boolean {
    return existsSync(this.metaPath(sessionId));
  }

  // -----------------------------------------------------------------------
  // Paths
  // -----------------------------------------------------------------------

  private metaPath(sessionId: string): string {
    return join(this.storeDir, `${sessionId}.meta.json`);
  }

  private binPath(sessionId: string): string {
    return join(this.storeDir, `${sessionId}.bin`);
  }

  private updateMeta(sessionId: string, fn: (meta: TrajectoryMeta) => void): void {
    const meta = this.loadMeta(sessionId);
    if (!meta) return;
    fn(meta);
    writeFileSync(this.metaPath(sessionId), JSON.stringify(meta), "utf-8");
  }
}
