import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { SqliteStore } from "@obyflow/core";
import { registerPruneCommand } from "./prune.js";

function buildProgram(): Command {
  const program = new Command();
  program.exitOverride();
  registerPruneCommand(program);
  return program;
}

function seedEvents(dbPath: string, timestamps: string[]): void {
  const store = new SqliteStore(dbPath);
  timestamps.forEach((timestamp, i) => {
    store.insert({
      id: `evt-${i}`,
      type: "log",
      trace_id: `trace-${i}`,
      request_id: null,
      service: "checkout-service",
      host: null,
      container: null,
      deployment_id: null,
      timestamp,
      duration_ms: null,
      attributes: {},
      severity: "info",
    });
  });
  store.close();
}

describe("obyflow prune", () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("rejects an invalid --older-than value", async () => {
    dir = mkdtempSync(join(tmpdir(), "obyflow-cli-prune-"));
    const dbPath = join(dir, "test.db");
    seedEvents(dbPath, [new Date().toISOString()]);

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = buildProgram();

    await program.parseAsync(["prune", "--db", dbPath, "--older-than", "nonsense"], {
      from: "user",
    });

    const output = logSpy.mock.calls.map((call) => call.join(" ")).join("\n");
    expect(output).toContain('Invalid --older-than value "nonsense"');
    logSpy.mockRestore();

    const store = new SqliteStore(dbPath);
    expect(store.countAll()).toBe(1);
    store.close();
  });

  it("does not delete anything without --yes", async () => {
    dir = mkdtempSync(join(tmpdir(), "obyflow-cli-prune-"));
    const dbPath = join(dir, "test.db");
    const old = new Date(Date.now() - 40 * 86_400_000).toISOString();
    seedEvents(dbPath, [old]);

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = buildProgram();

    await program.parseAsync(["prune", "--db", dbPath, "--older-than", "30d"], {
      from: "user",
    });

    const output = logSpy.mock.calls.map((call) => call.join(" ")).join("\n");
    expect(output).toContain("This will permanently delete events older than");
    expect(output).toContain("Re-run with --yes to confirm.");
    logSpy.mockRestore();

    const store = new SqliteStore(dbPath);
    expect(store.countAll()).toBe(1);
    store.close();
  });

  it("deletes only events older than the threshold when --yes is passed", async () => {
    dir = mkdtempSync(join(tmpdir(), "obyflow-cli-prune-"));
    const dbPath = join(dir, "test.db");
    const old = new Date(Date.now() - 40 * 86_400_000).toISOString();
    const recent = new Date().toISOString();
    seedEvents(dbPath, [old, recent]);

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = buildProgram();

    await program.parseAsync(
      ["prune", "--db", dbPath, "--older-than", "30d", "--yes"],
      { from: "user" },
    );

    const output = logSpy.mock.calls.map((call) => call.join(" ")).join("\n");
    expect(output).toContain("Deleted 1 event(s) older than");
    logSpy.mockRestore();

    const store = new SqliteStore(dbPath);
    expect(store.countAll()).toBe(1);
    store.close();
  });
});
