import { createCli } from "./cli";
import { getAuth } from "./auth";

const argv = await createCli().parseAsync();

if (argv.verbose) {
  console.log("Verbose mode enabled");
}

await getAuth();

const headSha = await Bun.$`git rev-parse --short HEAD`.text();
console.log(headSha.trim());
