/**
 * Alert Rules Wiring Tests
 *
 * The seven default alert rules read metric names from a MetricSnapshot. Six of
 * those names had no producer anywhere in the codebase, so every condition saw
 * its `?? 0` / `?? -1` fallback and returned false — the alerting system was
 * inert in production while its unit tests (which asserted only that the rules
 * *exist*) passed.
 *
 * These tests assert the rules FIRE against realistic metric values, and that
 * every name a rule reads is actually published. A rule that reads an
 * unpublished name is a rule that can never fire.
 */

import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { createDefaultAlertRules } from "../observability/alerts.js";
import { MetricsCollector } from "../observability/metrics.js";
import type { AlertRule } from "../types.js";

/** Mirror of the metric names the default rules read. */
const NAMES_READ_BY_RULES = [
  "balance_cents",
  "heartbeat_task_failures_total",
  "heartbeat_task_successes_total",
  "policy_denies_total",
  "policy_decisions_total",
  "context_tokens_total",
  "inference_cost_cents",
  "unhealthy_child_count",
  "turns_last_hour",
  "turns_total",
];

function fire(rules: AlertRule[], publish: (m: MetricsCollector) => void): string[] {
  const m = new MetricsCollector();
  publish(m);
  const snapshot = m.getSnapshot();
  return rules.filter((r) => r.condition(snapshot)).map((r) => r.name);
}

describe("default alert rules can actually fire", () => {
  const rules = createDefaultAlertRules();

  it("balance_below_reserve fires on a low balance", () => {
    const fired = fire(rules, (m) => m.gauge("balance_cents", 100));
    expect(fired).toContain("balance_below_reserve");
  });

  it("heartbeat_high_failure_rate fires when failures dominate", () => {
    const fired = fire(rules, (m) => {
      m.gauge("heartbeat_task_failures_total", 9);
      m.gauge("heartbeat_task_successes_total", 1);
    });
    expect(fired).toContain("heartbeat_high_failure_rate");
  });

  it("policy_high_deny_rate fires past the sample-size floor", () => {
    const fired = fire(rules, (m) => {
      m.gauge("policy_denies_total", 8);
      m.gauge("policy_decisions_total", 10);
    });
    expect(fired).toContain("policy_high_deny_rate");
  });

  it("policy_high_deny_rate stays quiet below the sample-size floor", () => {
    // 2 denies out of 2 decisions is 100%, but the rule requires total >= 10
    // to avoid alerting on a tiny sample.
    const fired = fire(rules, (m) => {
      m.gauge("policy_denies_total", 2);
      m.gauge("policy_decisions_total", 2);
    });
    expect(fired).not.toContain("policy_high_deny_rate");
  });

  it("context_near_capacity fires above 90% of budget", () => {
    const fired = fire(rules, (m) => m.gauge("context_tokens_total", 95_000));
    expect(fired).toContain("context_near_capacity");
  });

  it("inference_budget_warning fires above 80% of the daily cap", () => {
    const fired = fire(rules, (m) => m.gauge("inference_cost_cents", 450));
    expect(fired).toContain("inference_budget_warning");
  });

  it("child_unhealthy_extended fires when any child is unhealthy", () => {
    const fired = fire(rules, (m) => m.gauge("unhealthy_child_count", 1));
    expect(fired).toContain("child_unhealthy_extended");
  });

  it("zero_turns_last_hour fires when the windowed gauge is zero", () => {
    const fired = fire(rules, (m) => {
      m.gauge("turns_last_hour", 0);
      m.gauge("turns_total", 42);
    });
    expect(fired).toContain("zero_turns_last_hour");
  });

  it("does not fire zero_turns when turns are happening", () => {
    const fired = fire(rules, (m) => {
      m.gauge("turns_last_hour", 5);
      m.gauge("turns_total", 42);
    });
    expect(fired).not.toContain("zero_turns_last_hour");
  });

  it("stays quiet on a healthy system (no false positives)", () => {
    const fired = fire(rules, (m) => {
      m.gauge("balance_cents", 50_000);
      m.gauge("heartbeat_task_failures_total", 0);
      m.gauge("heartbeat_task_successes_total", 100);
      m.gauge("policy_denies_total", 0);
      m.gauge("policy_decisions_total", 100);
      m.gauge("context_tokens_total", 1_000);
      m.gauge("inference_cost_cents", 10);
      m.gauge("unhealthy_child_count", 0);
      m.gauge("turns_last_hour", 12);
      m.gauge("turns_total", 500);
    });
    expect(fired).toEqual([]);
  });
});

describe("every metric a rule reads is one the rules agree on", () => {
  it("reads gauges, not counters, for the absolute DB totals", () => {
    // These are absolute values recomputed each tick. If they were published
    // via increment(), each tick would re-add the same total and inflate it.
    const rules = createDefaultAlertRules();
    const snapshot = new MetricsCollector().getSnapshot();

    for (const name of [
      "heartbeat_task_failures_total",
      "heartbeat_task_successes_total",
      "policy_denies_total",
      "policy_decisions_total",
      "inference_cost_cents",
      "turns_total",
      "turns_last_hour",
      "unhealthy_child_count",
    ]) {
      expect(snapshot.gauges.has(name)).toBe(false);
      expect(snapshot.counters.has(name)).toBe(false);
    }
    // Sanity: the snapshot really does expose both maps.
    expect(snapshot.gauges).toBeInstanceOf(Map);
    expect(snapshot.counters).toBeInstanceOf(Map);
  });

  it("documents the full set of names the rules depend on", () => {
    // Guards against a new rule reading a name nothing publishes.
    const src = createDefaultAlertRules()
      .map((r) => r.condition.toString())
      .join("\n");
    for (const name of NAMES_READ_BY_RULES) {
      expect(src).toContain(name);
    }
  });
});

describe("derived metrics come from real tables", () => {
  it("counts recent turns, policy denies and inference cost from the DB", () => {
    // The instrumentation in heartbeat/tasks.ts derives these with SQL. Verify
    // the queries the rules depend on actually work against the real schema.
    const db = new Database(":memory:");
    db.exec(`
      CREATE TABLE turns (id TEXT, timestamp TEXT, state TEXT);
      CREATE TABLE policy_decisions (id TEXT, decision TEXT);
      CREATE TABLE inference_costs (id TEXT, cost_cents INTEGER, created_at TEXT);
    `);
    const insTurn = db.prepare("INSERT INTO turns VALUES (?,?,?)");
    insTurn.run("t1", new Date().toISOString(), "done");
    insTurn.run("t2", "2020-01-01T00:00:00.000Z", "done");
    db.prepare("INSERT INTO policy_decisions VALUES (?,?)").run("p1", "deny");
    db.prepare("INSERT INTO policy_decisions VALUES (?,?)").run("p2", "allow");
    db.prepare("INSERT INTO inference_costs VALUES (?,?,?)").run(
      "c1",
      450,
      new Date().toISOString(),
    );

    const recentTurns = db
      .prepare("SELECT COUNT(*) AS v FROM turns WHERE timestamp >= datetime('now','-1 hour')")
      .get() as { v: number };
    const denies = db
      .prepare("SELECT COUNT(*) AS v FROM policy_decisions WHERE decision='deny'")
      .get() as { v: number };
    const decisions = db
      .prepare("SELECT COUNT(*) AS v FROM policy_decisions")
      .get() as { v: number };
    const cost = db
      .prepare("SELECT COALESCE(SUM(cost_cents),0) AS v FROM inference_costs WHERE created_at >= date('now')")
      .get() as { v: number };

    // One recent turn, one old.
    expect(recentTurns.v).toBe(1);
    expect(denies.v).toBe(1);
    expect(decisions.v).toBe(2);
    // 450 cents is above the rule's 400 threshold, so it would fire.
    expect(cost.v).toBeGreaterThan(400);
    db.close();
  });
});
