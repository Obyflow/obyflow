import { Command } from "commander";
import chalk from "chalk";
import { SqliteStore } from "@obyflow/core";
import { parseSince } from "../render/time.js";

interface PruneCommandOptions {
  db: string;
  olderThan: string;
  yes?: boolean;
  dryRun?: boolean;
}

export function registerPruneCommand(program: Command): void {
  program
    .command("prune")
    .description("Delete stored events older than a given age, freeing up database space")
    .option("--db <path>", "path to the obyflow SQLite database", "obyflow.db")
    .option("--older-than <window>", "age threshold, e.g. 30d, 12h, 45m", "30d")
    .option("--yes", "skip the confirmation prompt and delete immediately")
    .option("--dry-run", "show what would be deleted without deleting")
    .action((options: PruneCommandOptions) => {
      const beforeIso = parseSince(options.olderThan);
      if (!beforeIso) {
        console.log(
          chalk.red(
            `Invalid --older-than value "${options.olderThan}". Use formats like 30d, 12h, 45m.`,
          ),
        );
        return;
      }

      const store = new SqliteStore(options.db);
      try {
        const totalToDelete = store.countOlderThan(beforeIso);

        if (options.dryRun) {
          console.log(
            chalk.green(`${totalToDelete} event(s) would be deleted.`),
          );
          return;
        }

        if (!options.yes) {
          console.log(
            chalk.yellow(
              `This will permanently delete events older than ${beforeIso} from ${options.db} ` +
                `(${totalToDelete} event(s) would be deleted).`,
            ),
          );
          console.log(chalk.dim("Re-run with --yes to confirm."));
          return;
        }

        const deleted = store.prune(beforeIso);
        console.log(chalk.green(`Deleted ${deleted} event(s) older than ${beforeIso}.`));
        console.log(chalk.dim(`${store.countAll()} event(s) remain in ${options.db}.`));
      } finally {
        store.close();
      }
    });
}
