import { confirm, isCancel } from "@clack/prompts";
import { die } from "~/lib/output.ts";
import { isInteractive } from "~/lib/tty.ts";

export interface ConfirmDestructiveOptions {
  /** Prompt text shown to the user in TTY. */
  message: string;
  /** Set true when the caller already saw `--yes` / `-y`. */
  yes: boolean;
  /**
   * Hint to print in non-TTY when `--yes` wasn't passed.
   * Defaults to a generic "Pass --yes to confirm." nudge.
   */
  fallbackHint?: string;
}

/**
 * Gate destructive operations behind explicit confirmation.
 *
 * - `--yes` flag passed → no prompt, proceed.
 * - TTY + no `--yes` → @clack/prompts confirm. Aborts on cancel/no.
 * - non-TTY + no `--yes` → die with a helpful message.
 *
 * Use for delete, regenerate-secret, unlink, and any other op the user
 * can't easily undo.
 */
export async function confirmDestructive(
  opts: ConfirmDestructiveOptions
): Promise<void> {
  if (opts.yes) return;
  if (!isInteractive()) {
    die("Confirmation required for this destructive action.", {
      hint: opts.fallbackHint ?? "Pass --yes to confirm.",
    });
  }
  const answer = await confirm({
    message: opts.message,
    initialValue: false,
  });
  if (isCancel(answer) || !answer) {
    die("Aborted.");
  }
}
