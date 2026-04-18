import { createCli } from "./cli";

const argv = await createCli().parseAsync();

if (argv.verbose) {
  console.log("Verbose mode enabled");
}

const headSha = await Bun.$`git rev-parse --short HEAD`.text();
console.log(headSha.trim());
