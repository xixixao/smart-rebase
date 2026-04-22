#!/usr/bin/env bun

/* c8 ignore start */
import { main } from "../index";

main(process.argv.slice(2)).catch((e: unknown) => {
  const msg = e instanceof Error ? e.message : String(e);
  process.stderr.write(`\x1b[31mError: ${msg}\x1b[0m\n`);
  process.exit(1);
});
