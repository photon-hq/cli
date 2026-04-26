import type { Command } from "@commander-js/extra-typings";
import { getApi } from "~/lib/api.ts";

export function registerPingCommand(program: Command): void {
  program
    .command("ping")
    .description("hit the dashboard /api/health endpoint")
    .option("-u, --url <url>", "API base URL", process.env.DASHBOARD_API_URL)
    .action(async (opts) => {
      const api = getApi(opts.url);
      const start = performance.now();
      const { data, error, status } = await api.api.health.get();
      const elapsed = Math.round(performance.now() - start);

      if (error) {
        console.error(`✗ ${status} (${elapsed}ms): ${error.value ?? "request failed"}`);
        process.exit(1);
      }

      console.log(`✓ ${status} (${elapsed}ms): ${JSON.stringify(data)}`);
    });
}
