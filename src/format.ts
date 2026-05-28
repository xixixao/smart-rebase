import chalk from "chalk";

export function q(name: string): string {
  if (process.stdout.isTTY) {
    return chalk.blueBright(name);
  }
  return `\`${name}\``;
}

export function plc(n: number, verb: string, plural?: string): string {
  return `${n} ` + (n === 1 ? `${verb}` : (plural ?? `${verb}s`));
}

export function pl(n: number, noun: string, plural?: string): string {
  return n === 1 ? `${noun}` : (plural ?? (noun === "has" ? "have" : `${noun}s`));
}
