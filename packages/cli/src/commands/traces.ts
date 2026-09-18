import { Command } from "commander";
import chalk from "chalk";
import { SqliteStore, rowToEvent } from "@obyflow/core";
import { renderTable, type TableColumn } from "../render/table.js";
import { renderDetailCards } from "../render/detail.js";
import { parseSince, parseTimeWindowOption } from "../render/time.js";
import { loadRedactionConfig } from "../render/redaction.js";
import { runWatchLoop } from "../render/watch.js";
import type { Event } from "@obyflow/core";

interface TracesCommandOptions {
  db: string;
  service?: string;
  since?: string;
  limit: string;
  detail?: boolean;
  watch?: string;
}

const columns: TableColumn<Event>[] = [
  { header: "TRACE ID", width: 14, get: (e) => (e.trace_id ?? "—").slice(0, 12) },
  { header: "SERVICE", width: 20, get: (e) => e.service },
  { header: "TYPE", width: 10, get: (e) => e.type },
  {
    header: "DURATION",
    width: 10,
    get: (e) => (e.duration_ms !== null ? `${e.duration_ms}ms` : "—"),
  },
  {
    header: "SEVERITY",
    width: 8,
    get: (e) => e.severity ?? "—",
    color: (value, e) => {
      if (e.severity === "error" || e.severity === "critical") return chalk.red(value);
      if (e.severity === "warn") return chalk.yellow(value);
      return value;
    },
  },
  { header: "TIMESTAMP", width: 24, get: (e) => e.timestamp },
];

export function registerTracesCommand(program: Command): void {
  program
    .command("traces")
    .description("List or inspect traces")
    .option("--db <path>", "path to the obyflow SQLite database", "obyflow.db")
    .option("--service <name>", "filter by service name")
    .option("--since <window>", "time window, e.g. 15m, 2h, 1d", parseTimeWindowOption)
    .option("--limit <n>", "max number of results", "50")
    .option("--detail", "show full detail cards instead of a table")
    .option("--watch [seconds]", "poll and re-render every N seconds (default 2)")
    .action((options: TracesCommandOptions) => {
      const redaction = loadRedactionConfig();

      const runOnce = (): void => {
        const store = new SqliteStore(options.db);
        try {
          const rows = store.getRecent({
            type: "trace",
            service: options.service,
            sinceIso: parseSince(options.since),
            limit: Number(options.limit) || 50,
          });
          const events = rows.map(rowToEvent);

          if (options.detail) {
            console.log(renderDetailCards(events, redaction));
          } else {
            console.log(renderTable(events, columns));
          }

          if (!options.detail && events.length > 0) {
            console.log(chalk.dim(`\n${events.length} trace(s). Use --detail for full attributes.`));
          }
        } finally {
          store.close();
        }
      };

      if (options.watch !== undefined) {
        const intervalSeconds = Number(options.watch) || 2;
        runWatchLoop({ intervalSeconds, onTick: runOnce });
      } else {
        runOnce();
      }
    });
}
