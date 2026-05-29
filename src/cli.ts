import yargs from "yargs";
import { hideBin } from "yargs/helpers";

export function createCli(argv = hideBin(process.argv)) {
  return yargs(argv)
    .scriptName("smart-rebase")
    .usage("$0 [target] [options]")
    .command("$0 [target]", false, (yargs) =>
      yargs.positional("target", { type: "string", description: "Target branch to rebase onto" }),
    )
    .version("0.1.0")
    .alias("version", "V")
    .help()
    .alias("help", "h")
    .option("verbose", { alias: "v", type: "boolean", description: "Enable verbose output", default: false })
    .strict()
    .wrap(null)
    .exitProcess(false);
}

export type Argv = Awaited<ReturnType<ReturnType<typeof createCli>["parseAsync"]>> & { target: string };
