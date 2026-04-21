export async function openBrowser(url: string): Promise<void> {
  const cmd =
    process.env.BROWSER ??
    (process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open");
  try {
    await Bun.$`${cmd} ${url}`.quiet();
  } catch {}
}
