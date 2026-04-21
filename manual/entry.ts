/* c8 ignore start */
import { main } from "../index";

main(process.argv.slice(2)).catch((e: unknown) => {
  process.stderr.write((e instanceof Error ? e.message : String(e)) + "\n");
  process.exit(1);
});
