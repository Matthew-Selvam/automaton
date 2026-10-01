/**
 * Sandbox Cleanup
 *
 * Cleans up sandbox resources for stopped/failed children.
 * Transitions children to cleaned_up state after destruction.
 */

import type { Database as DatabaseType } from "better-sqlite3";
import type { ConwayClient } from "../types.js";
import type { ChildLifecycle } from "./lifecycle.js";
import { createLogger } from "../observability/logger.js";
const logger = createLogger("replication.cleanup");

export class SandboxCleanup {
  constructor(
    private conway: ConwayClient,
    private lifecycle: ChildLifecycle,
    private db: DatabaseType,
  ) {}

  /**
   * Clean up a single child's sandbox.
   * Only works for children in stopped or failed state.
   */
  async cleanup(childId: string): Promise<void> {
    const state = this.lifecycle.getCurrentState(childId);
    if (state !== "stopped" && state !== "failed") {
      throw new Error(`Cannot clean up child in state: ${state}`);
    }

    // Look up sandbox ID
    const childRow = this.db
      .prepare("SELECT sandbox_id FROM children WHERE id = ?")
      .get(childId) as { sandbox_id: string } | undefined;

    // Sandbox deletion is disabled by the Conway API (prepaid, non-refundable).
    // Transition to cleaned_up so the child slot is freed for reuse.
    const sandboxNote = childRow?.sandbox_id
      ? `sandbox ${childRow.sandbox_id} released (deletion disabled)`
      : "no sandbox to clean up";
    this.lifecycle.transition(childId, "cleaned_up", sandboxNote);
  }

  /**
   * Clean up all stopped and failed children.
   */
  async cleanupAll(): Promise<number> {
    const stopped = this.lifecycle.getChildrenInState("stopped");
    const failed = this.lifecycle.getChildrenInState("failed");
    let cleaned = 0;

    for (const child of [...stopped, ...failed]) {
      try {
        await this.cleanup(child.id);
        cleaned++;
      } catch (error) {
        logger.error(`Failed to clean up child ${child.id}`, error instanceof Error ? error : undefined);
      }
    }

    return cleaned;
  }

  /**
   * Clean up children that have been in stopped/failed state for too long.
   */
  async cleanupStale(maxAgeHours: number): Promise<number> {
    // Compute the cutoff as an SQLite datetime modifier rather than a JS
    // string. `children.last_checked` is written by `datetime('now')`
    // ("YYYY-MM-DD HH:MM:SS"), and a bound ISO string
    // ("YYYY-MM-DDTHH:MM:SS.sssZ") compares lexicographically with 'T' > ' ',
    // so it matched every child checked later on the cutoff's own date - not
    // just the genuinely stale ones. Letting SQLite do the arithmetic keeps
    // both sides in the same format.
    const stale = this.db
      .prepare(
        `SELECT id FROM children
          WHERE status IN ('failed', 'stopped')
            AND last_checked < datetime('now', ?)`,
      )
      .all(`-${maxAgeHours} hours`) as Array<{ id: string }>;

    let cleaned = 0;
    for (const child of stale) {
      try {
        await this.cleanup(child.id);
        cleaned++;
      } catch (error) {
        logger.error(`Failed to clean up stale child ${child.id}`, error instanceof Error ? error : undefined);
      }
    }

    return cleaned;
  }
}
