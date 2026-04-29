import open from "open";
import { c } from "~/lib/output.ts";

/**
 * Open a URL in the user's default browser. Returns true on success,
 * false if the open call threw — the caller can decide whether to
 * surface a fallback message.
 *
 * Always logs the URL so users on `--no-browser` (or in environments
 * where `open()` silently fails) can still copy and paste.
 */
export async function openInBrowser(
  url: string,
  opts: { noBrowser?: boolean; label?: string } = {}
): Promise<boolean> {
  const label = opts.label ?? "Open";
  console.log(`${c.dim(label + ":")} ${c.underline(c.cyan(url))}`);
  if (opts.noBrowser) return false;
  try {
    await open(url);
    return true;
  } catch {
    return false;
  }
}
