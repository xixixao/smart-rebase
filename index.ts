import { createCli } from "./cli";

const argv = await createCli().parseAsync();

if (argv.verbose) {
  console.log("Verbose mode enabled");
}

console.log("Hello from gitlab-rebase!");
