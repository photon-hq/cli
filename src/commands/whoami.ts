import type { Command } from "@commander-js/extra-typings";
import { getApi } from "~/lib/api.ts";
import { SessionExpiredError } from "~/lib/errors.ts";
import { c, die, formatApiError } from "~/lib/output.ts";

export function registerWhoamiCommand(program: Command): void {
  program
    .command("whoami")
    .description("show the user authenticated for the active backend")
    .option("--api-host <url>", "API host URL (defaults to PHOTON_API_HOST or built-in production)")
    .option("-t, --token <token>", "API token (overrides stored creds)")
    .action(async (opts) => {
      const { api, env, creds } = await getApi({
        apiHost: opts.apiHost,
        token: opts.token,
        requireAuth: true,
      });

      // Validate the token is still good by hitting an authenticated endpoint.
      const { data, error, status } = await api.api.profile.get();
      if (status === 401) {
        throw new SessionExpiredError(env.name);
      }
      if (error) {
        die(`Failed to fetch profile: ${formatApiError(error)}`);
      }

      // creds may be null when --token / PHOTON_TOKEN was used. Use the
      // token-bearing path: print env + a note that we have no cached identity.
      if (!creds) {
        console.log(c.dim(`authenticated via token on backend ${env.name} (${env.url})`));
        if (data && typeof data === "object") {
          const summary = summarizeProfile(data);
          if (summary) console.log(c.dim(`profile: ${summary}`));
        }
        return;
      }

      const user = creds.user;
      console.log(c.bold(user.name) + c.dim(` <${user.email}>`));
      console.log(c.dim(`backend: ${env.name} (${env.url})`));
      console.log(
        c.dim(`signed in: ${new Date(creds.issuedAt).toLocaleString()}`)
      );

      if (data && typeof data === "object") {
        const summary = summarizeProfile(data);
        if (summary) console.log(c.dim(`profile: ${summary}`));
      }
    });
}

/**
 * The /api/profile endpoint returns either:
 *   - `null` (no profile yet)
 *   - A flat onboarding-profile row with a top-level `type` discriminator
 *     of `"developer"` or `"organization"`.
 */
function summarizeProfile(profile: unknown): string | null {
  if (!profile || typeof profile !== "object") return null;
  const p = profile as { type?: unknown };
  if (p.type === "developer" || p.type === "organization") {
    return p.type;
  }
  return null;
}
