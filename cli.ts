import { Command } from "commander";

export type Options = {
  verbose: boolean;
};

export function createCli(): Command {
  const program = new Command()
    .name("gitlab-rebase")
    .description(
      "Placeholder: automates rebasing of GitLab merge requests onto a target branch.",
    )
    .version("0.1.0", "-V, --version", "Output the version number")
    .option("-v, --verbose", "Enable verbose output", false)
    .action((opts: Options) => {
      if (opts.verbose) {
        console.log("Verbose mode enabled");
      }
      console.log("Hello from gitlab-rebase!");
    });

  return program;
}
