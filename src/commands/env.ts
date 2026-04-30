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
    .action(async () => {
      const e = await resolveEnv();
      console.log(`${c.bold(e.name)} ${c.dim(`(${e.url})`)}`);
    });
}
