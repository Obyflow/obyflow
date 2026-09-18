import { Command } from "commander";
import { writeFileSync } from "node:fs";
import chalk from "chalk";
import { SqliteStore, rowToEvent } from "@obyflow/core";
import type { Event, EventRow } from "@obyflow/core";
import { parseSince, parseTimeWindowOption } from "../render/time.js";

interface ExportCommandOptions {
  db: string;
  service?: string;
  type?: string;
  since?: string;
  until?: string;
  limit?: string;
  format: string;
  out?: string;
}

function toCsvValue(value: unknown): string {
  const str =
    value === null || value === undefined
      ? ""
      : typeof value === "object"
        ? JSON.stringify(value)
        : String(value);
  if (/[",\n]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
  return str;
}

const CSV_HEADERS = [
  "id",
  "type",
  "trace_id",
  "request_id",
  "service",
  "host",
  "container",
  "deployment_id",
  "timestamp",
  "duration_ms",
  "severity",
  "attributes",
] as const;

function toCsv(events: Event[]): string {
  const lines = [CSV_HEADERS.join(",")];
  for (const event of events) {
    const record = event as unknown as Record<string, unknown>;
    lines.push(CSV_HEADERS.map((header) => toCsvValue(record[header])).join(","));
  }
  return lines.join("\n");
}

function toOtlp(events: Event[]): unknown {
  const byService = new Map<string, Event[]>();
  for (const event of events) {
    const list = byService.get(event.service) ?? [];
    list.push(event);
    byService.set(event.service, list);
  }

  return {
    resourceSpans: Array.from(byService.entries()).map(([service, serviceEvents]) => ({
      resource: {
        attributes: [{ key: "service.name", value: { stringValue: service } }],
      },
      scopeSpans: [
        {
          scope: { name: "obyflow" },
          spans: serviceEvents.map((event) => ({
            traceId: event.trace_id ?? undefined,
            spanId: event.request_id ?? event.id,
            name: event.type,
            startTimeUnixNano: event.timestamp
              ? String(Date.parse(event.timestamp) * 1e6)
              : undefined,
            attributes: Object.entries(event.attributes ?? {}).map(([key, value]) => ({
              key,
              value: {
                stringValue: typeof value === "string" ? value : JSON.stringify(value),
              },
            })),
            status:
              event.severity === "error" || event.severity === "critical"
                ? { code: 2 }
                : { code: 1 },
          })),
        },
      ],
    })),
  };
}

export function registerExportCommand(program: Command): void {
  program
    .command("export")
    .description("Export stored events as JSON, CSV, or OTLP")
    .option("--db <path>", "path to the obyflow SQLite database", "obyflow.db")
    .option("--service <name>", "filter by service name")
    .option("--type <type>", "filter by event type")
    .option("--since <window>", "time window, e.g. 15m, 2h, 1d", parseTimeWindowOption)
    .option("--until <window>", "upper bound time window, e.g. 1h", parseTimeWindowOption)
    .option("--limit <n>", "max number of events to export")
    .option("--format <format>", "json | csv | otlp", "json")
    .option("--out <file>", "write output to a file instead of stdout")
    .action((options: ExportCommandOptions) => {
      const store = new SqliteStore(options.db);
      try {
        const rows: EventRow[] = store.exportEvents({
          type: options.type,
          service: options.service,
          sinceIso: parseSince(options.since),
          untilIso: parseSince(options.until),
          limit: options.limit ? Number(options.limit) : undefined,
        });
        const events = rows.map(rowToEvent);

        let output: string;
        if (options.format === "csv") {
          output = toCsv(events);
        } else if (options.format === "otlp") {
          output = JSON.stringify(toOtlp(events), null, 2);
        } else {
          output = JSON.stringify(events, null, 2);
        }

        if (options.out) {
          writeFileSync(options.out, output, "utf-8");
          console.log(chalk.green(`Exported ${events.length} event(s) to ${options.out}`));
        } else {
          console.log(output);
        }
      } finally {
        store.close();
      }
    });
}
