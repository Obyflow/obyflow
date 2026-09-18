import { Command } from "commander";
import chalk from "chalk";
import { SqliteStore, rowToEvent } from "@obyflow/core";
import { estimateCostUsd } from "@obyflow/llm-core";
import { renderTable, type TableColumn } from "../render/table.js";
import { parseSince, parseTimeWindowOption } from "../render/time.js";

interface UsageCommandOptions {
  db: string;
  service?: string;
  since?: string;
  limit: string;
}

interface UsageRow {
  service: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
  hasUnknownCost: boolean;
}

function formatTokens(n: number): string {
  return n.toLocaleString("en-US");
}

function formatCost(row: UsageRow): string {
  if (row.costUsd === 0 && row.hasUnknownCost) return "—";
  const suffix = row.hasUnknownCost ? "+" : "";
  return `$${row.costUsd.toFixed(4)}${suffix}`;
}

const columns: TableColumn<UsageRow>[] = [
  { header: "SERVICE", width: 22, get: (r) => r.service },
  { header: "CALLS", width: 8, get: (r) => String(r.calls) },
  { header: "INPUT", width: 12, get: (r) => formatTokens(r.inputTokens) },
  { header: "OUTPUT", width: 12, get: (r) => formatTokens(r.outputTokens) },
  { header: "TOTAL", width: 12, get: (r) => formatTokens(r.totalTokens) },
  { header: "EST. COST", width: 12, get: formatCost },
];

export function registerUsageCommand(program: Command): void {
  program
    .command("usage")
    .description("Summarize LLM token consumption and estimated cost from llm_call events, grouped by service")
    .option("--db <path>", "path to the obyflow SQLite database", "obyflow.db")
    .option("--service <name>", "filter by service name")
    .option("--since <window>", "time window, e.g. 15m, 2h, 1d", parseTimeWindowOption)
    .option("--limit <n>", "max number of llm_call events to scan", "1000")
    .action((options: UsageCommandOptions) => {
      const store = new SqliteStore(options.db);
      try {
        const rows = store.getRecent({
          type: "llm_call",
          service: options.service,
          sinceIso: parseSince(options.since),
          limit: Number(options.limit) || 1000,
        });
        const events = rows.map(rowToEvent);

        const byService = new Map<string, UsageRow>();

        for (const event of events) {
          const attrs = event.attributes as Record<string, unknown>;
          const model = typeof attrs["model"] === "string" ? (attrs["model"] as string) : "unknown";
          const inputTokens =
            typeof attrs["prompt_tokens"] === "number" ? (attrs["prompt_tokens"] as number) : 0;
          const outputTokens =
            typeof attrs["completion_tokens"] === "number" ? (attrs["completion_tokens"] as number) : 0;
          const cost = estimateCostUsd(
            {
              input_tokens: inputTokens,
              output_tokens: outputTokens,
              total_tokens: inputTokens + outputTokens,
            },
            model,
          );

          const existing = byService.get(event.service) ?? {
            service: event.service,
            calls: 0,
            inputTokens: 0,
            outputTokens: 0,
            totalTokens: 0,
            costUsd: 0,
            hasUnknownCost: false,
          };

          existing.calls += 1;
          existing.inputTokens += inputTokens;
          existing.outputTokens += outputTokens;
          existing.totalTokens += inputTokens + outputTokens;
          if (cost === null) {
            existing.hasUnknownCost = true;
          } else {
            existing.costUsd += cost;
          }

          byService.set(event.service, existing);
        }

        const usageRows = Array.from(byService.values()).sort(
          (a, b) => b.totalTokens - a.totalTokens,
        );

        console.log(renderTable(usageRows, columns));

        if (usageRows.length > 0) {
          const totals = usageRows.reduce(
            (acc, r) => {
              acc.calls += r.calls;
              acc.inputTokens += r.inputTokens;
              acc.outputTokens += r.outputTokens;
              acc.totalTokens += r.totalTokens;
              acc.costUsd += r.costUsd;
              acc.hasUnknownCost = acc.hasUnknownCost || r.hasUnknownCost;
              return acc;
            },
            {
              service: "",
              calls: 0,
              inputTokens: 0,
              outputTokens: 0,
              totalTokens: 0,
              costUsd: 0,
              hasUnknownCost: false,
            } as UsageRow,
          );

          console.log(
            chalk.dim(
              `\n${totals.calls} llm_call event(s) across ${usageRows.length} service(s)  ·  ${formatTokens(totals.totalTokens)} tokens  ·  est. cost ${formatCost(totals)}`,
            ),
          );
          if (totals.hasUnknownCost) {
            console.log(
              chalk.dim(
                "Some calls used a model with no known pricing; cost is a partial estimate (marked with +).",
              ),
            );
          }
        }
      } finally {
        store.close();
      }
    });
}
