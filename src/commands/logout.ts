import type { Command } from "@commander-js/extra-typings";
import { getAuthClient } from "~/lib/auth-client.ts";
import { resolveEnv } from "~/lib/config.ts";
import { clearCredentials, loadCredentials } from "~/lib/credentials.ts";
import { c } from "~/lib/output.ts";

export function registerLogoutCommand(program: Command): void {
  program
    .command("logout")
    .description("clear stored credentials for an environment")
    .option("-e, --env <name>", "environment to log out of (defaults to current)")
    .action(async (opts) => {
      const env = await resolveEnv(opts.env);
      const creds = await loadCredentials(env.name);

      if (!creds) {
        console.log(
          c.dim(`Not logged in to ${c.bold(env.name)} — nothing to do.`)
        );
        return;
      }

      // Best-effort revoke server-side. If the server is down or the
      // session is already invalid, we still want to clear local state.
      try {
        const auth = getAuthClient(creds.apiUrl);
        await auth.signOut({
          fetchOptions: {
            headers: { Authorization: `Bearer ${creds.accessToken}` },
          },
        });
      } catch {
        // Ignore — we'll clear locally regardless.
      }

      await clearCredentials(env.name);
      console.log(c.success(`Logged out of ${c.bold(env.name)}`));
    });
}
