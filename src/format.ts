import chalk from "chalk";

export function q(name: string): string {
  if (process.stdout.isTTY) {
    return chalk.blueBright(name);
  }
  return `\`${name}\``;
}
