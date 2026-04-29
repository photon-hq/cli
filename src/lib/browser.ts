import open from "open";
import { c } from "~/lib/output.ts";

/**
 * Open a URL in the user's default browser.
 *
 * Always logs the URL first so users on `--no-browser` (or in
 * environments where `open()` silently fails) can still copy and paste.
 *
 * Returns:
 * - `"opened"` if `open()` was called and didn't throw.
 * - `"skipped"` if `--no-browser` was set; printing the URL is the
 *   success criterion.
 * - `"failed"` if `open()` threw — caller may want to surface a
 *   fallback hint.
 */
export type OpenResult = "opened" | "skipped" | "failed";

export async function openInBrowser(
  url: string,
  opts: { noBrowser?: boolean; label?: string } = {}
): Promise<OpenResult> {
  const label = opts.label ?? "Open";
  console.log(`${c.dim(label + ":")} ${c.underline(c.cyan(url))}`);
  if (opts.noBrowser) return "skipped";
  try {
    await open(url);
    return "opened";
  } catch {
    return "failed";
  }
}
