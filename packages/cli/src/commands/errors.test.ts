import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { SqliteStore } from "@obyflow/core";
import { registerErrorsCommand } from "./errors.js";

function buildProgram(): Command {
  const program = new Command();
  program.exitOverride();
  registerErrorsCommand(program);
  return program;
}

function seedEvents(dbPath: string): void {
  const store = new SqliteStore(dbPath);
  const now = Date.now();
  store.insert({
    id: "evt-1",
    type: "log",
    trace_id: "trace-1",
    request_id: null,
    service: "checkout-service",
    host: null,
    container: null,
    deployment_id: null,
    timestamp: new Date(now).toISOString(),
    duration_ms: null,
    attributes: {},
    severity: "info",
  });
  store.insert({
    id: "evt-2",
    type: "error",
    trace_id: "trace-2",
    request_id: null,
    service: "checkout-service",
    host: null,
    container: null,
    deployment_id: null,
    timestamp: new Date(now + 1000).toISOString(),
    duration_ms: null,
    attributes: {},
    severity: "error",
  });
  store.insert({
    id: "evt-3",
    type: "error",
    trace_id: "trace-3",
    request_id: null,
    service: "billing-service",
    host: null,
    container: null,
    deployment_id: null,
    timestamp: new Date(now + 2000).toISOString(),
    duration_ms: null,
    attributes: {},
    severity: "critical",
  });
  store.close();
}

describe("obyflow errors", () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("lists only error and critical severity events", async () => {
    dir = mkdtempSync(join(tmpdir(), "obyflow-cli-errors-"));
    const dbPath = join(dir, "test.db");
    seedEvents(dbPath);

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = buildProgram();

    await program.parseAsync(["errors", "--db", dbPath], { from: "user" });

    const output = logSpy.mock.calls.map((call) => call.join(" ")).join("\n");
    expect(output).toContain("checkout-service");
    expect(output).toContain("billing-service");
    expect(output).toContain("2 error(s)");
    logSpy.mockRestore();
  });

  it("filters by service", async () => {
    dir = mkdtempSync(join(tmpdir(), "obyflow-cli-errors-"));
    const dbPath = join(dir, "test.db");
    seedEvents(dbPath);

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = buildProgram();

    await program.parseAsync(
      ["errors", "--db", dbPath, "--service", "billing-service"],
      { from: "user" },
    );

    const output = logSpy.mock.calls.map((call) => call.join(" ")).join("\n");
    expect(output).toContain("billing-service");
    expect(output).not.toContain("checkout-service");
    logSpy.mockRestore();
  });

  it("renders detail cards when --detail is passed", async () => {
    dir = mkdtempSync(join(tmpdir(), "obyflow-cli-errors-"));
    const dbPath = join(dir, "test.db");
    seedEvents(dbPath);

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = buildProgram();

    await program.parseAsync(["errors", "--db", dbPath, "--detail"], { from: "user" });

    const output = logSpy.mock.calls.map((call) => call.join(" ")).join("\n");
    expect(output).toContain("trace-2");
    expect(output).toContain("trace-3");
    logSpy.mockRestore();
  });
});
