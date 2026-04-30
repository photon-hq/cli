import type { Command } from "@commander-js/extra-typings";
import { getApi } from "~/lib/api.ts";
import { c, formatApiError } from "~/lib/output.ts";

export function registerPingCommand(program: Command): void {
  program
    .command("ping")
    .description("hit the Photon Dashboard /api/health endpoint")
    .option("--api-host <url>", "API host URL (defaults to PHOTON_API_HOST or built-in production)")
    .option("-u, --url <url>", "raw API URL (bypasses env resolution)")
    .action(async (opts) => {
      const { api, env } = await getApi({
        apiHost: opts.apiHost,
        url: opts.url,
      });

      console.log(c.dim(`→ ${env.url}`));
      const start = performance.now();
      const { data, error, status } = await api.api.health.get();
      const elapsed = Math.round(performance.now() - start);

      if (error) {
        console.error(c.error(`${status} (${elapsed}ms): ${formatApiError(error)}`));
        process.exit(1);
      }
      console.log(c.success(`${status} (${elapsed}ms): ${JSON.stringify(data)}`));
    });
}
