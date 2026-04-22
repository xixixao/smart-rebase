export function q(name: string): string {
  if (process.stdout.isTTY) {
    return `\x1b[94m${name}\x1b[0m`;
  }
  return `\`${name}\``;
}
