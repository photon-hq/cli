import type { Command } from "@commander-js/extra-typings";
import { getApi } from "~/lib/api.ts";
import { NotAuthenticatedError, SessionExpiredError } from "~/lib/errors.ts";
import { c, die, formatApiError } from "~/lib/output.ts";

export function registerWhoamiCommand(program: Command): void {
  program
    .command("whoami")
    .description("show the user authenticated for an environment")
    .option("-e, --env <name>", "environment (defaults to current)")
    .action(async (opts) => {
      try {
        const { api, env, creds } = await getApi({
          envName: opts.env,
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

        // creds is non-null here because requireAuth was true.
        const user = creds!.user;
        console.log(c.bold(user.name) + c.dim(` <${user.email}>`));
        console.log(c.dim(`environment: ${env.name} (${env.url})`));
        console.log(
          c.dim(
            `signed in: ${new Date(creds!.issuedAt).toLocaleString()}`
          )
        );

        // Show any extra info the profile endpoint returned (developer / org).
        if (data && typeof data === "object") {
          const summary = summarizeProfile(data);
          if (summary) {
            console.log(c.dim(`profile: ${summary}`));
          }
        }
      } catch (err) {
        if (err instanceof NotAuthenticatedError || err instanceof SessionExpiredError) {
          die(err.message);
        }
        throw err;
      }
    });
}

function summarizeProfile(profile: unknown): string | null {
  if (!profile || typeof profile !== "object") return null;
  const p = profile as Record<string, unknown>;
  const parts: string[] = [];
  if (p.developer) parts.push("developer");
  if (p.organization) parts.push("organization");
  return parts.length ? parts.join(" + ") : null;
}
