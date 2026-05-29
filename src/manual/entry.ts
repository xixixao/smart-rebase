#!/usr/bin/env bun

/* c8 ignore start */
import { stderr } from "../format";
import { main } from "../index";
import chalk from "chalk";

main(process.argv.slice(2)).catch((e: unknown) => {
  const msg = e instanceof Error ? e.message : String(e);
  stderr(chalk.red(`Error: ${msg}`));
  process.exit(1);
});
