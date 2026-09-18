import { rmSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { Command } from "commander";
import { registerErrorsCommand } from "./errors.js";
import { registerExportCommand } from "./export.js";
import { registerLogsCommand } from "./logs.js";
import { registerMetricsCommand } from "./metrics.js";
import { registerTracesCommand } from "./traces.js";
import { registerUsageCommand } from "./usage.js";

type RegisterCommand = (program: Command) => void;

function buildProgram(register: RegisterCommand): Command {
  const program = new Command();
  program.exitOverride();
  register(program);
  return program;
}

const commands: Array<[string, RegisterCommand]> = [
  ["traces", registerTracesCommand],
  ["logs", registerLogsCommand],
  ["metrics", registerMetricsCommand],
  ["errors", registerErrorsCommand],
  ["usage", registerUsageCommand],
  ["export", registerExportCommand],
];

describe("CLI time window options", () => {
  const dbPath = "invalid-time-window-test.db";

  afterEach(() => {
    rmSync(dbPath, { force: true });
  });

  it.each(commands)("rejects an invalid --since value for %s", async (name, register) => {
    const program = buildProgram(register);

    await expect(
      program.parseAsync([name, "--db", dbPath, "--since", "1hr"], { from: "user" }),
    ).rejects.toMatchObject({ code: "commander.invalidArgument" });
  });

  it("rejects an invalid --until value for export", async () => {
    const program = buildProgram(registerExportCommand);

    await expect(
      program.parseAsync(["export", "--db", dbPath, "--until", "yesterday"], { from: "user" }),
    ).rejects.toMatchObject({ code: "commander.invalidArgument" });
  });
});
