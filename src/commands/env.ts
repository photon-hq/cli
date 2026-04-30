import type { Command } from "@commander-js/extra-typings";
import { resolveEnv } from "~/lib/config.ts";
import { c } from "~/lib/output.ts";

export function registerEnvCommand(program: Command): void {
  const env = program
    .command("env")
    .description(
      "show the active backend (set via PHOTON_API_HOST or --api-host)"
    );

  env
    .command("current", { isDefault: true })
    .description("print the resolved API host")
    .option(
      "--api-host <url>",
      "API host URL (defaults to PHOTON_API_HOST or built-in production)"
    )
    .action(async (opts) => {
      const e = await resolveEnv(opts.apiHost);
      console.log(`${c.bold(e.name)} ${c.dim(`(${e.url})`)}`);
    });
}
