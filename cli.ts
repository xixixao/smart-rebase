import yargs from "yargs";
import { hideBin } from "yargs/helpers";

export function createCli(argv = hideBin(process.argv)) {
  return yargs(argv)
    .scriptName("gitlab-rebase")
    .usage("$0 [options]")
    .version("0.1.0")
    .alias("version", "V")
    .help()
    .alias("help", "h")
    .option("verbose", {
      alias: "v",
      type: "boolean",
      description: "Enable verbose output",
      default: false,
    })
    .option("sha", {
      type: "boolean",
      description: "Print the HEAD short SHA",
      default: false,
    })
    .strict()
    .wrap(null)
    .exitProcess(false);
}

export type Argv = Awaited<ReturnType<ReturnType<typeof createCli>["parseAsync"]>>;
