#!/usr/bin/env bun

/* c8 ignore start */
import { main } from "../index";
import chalk from "chalk";

main(process.argv.slice(2)).catch((e: unknown) => {
  const msg = e instanceof Error ? e.message : String(e);
  process.stderr.write(chalk.red(`Error: ${msg}`) + "\n");
  process.exit(1);
});
