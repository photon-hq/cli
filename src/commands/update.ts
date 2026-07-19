import type { Command } from "@commander-js/extra-typings";
import { c, printJson } from "~/lib/output.ts";
import { parsePackageInstaller, updatePhoton } from "~/lib/self-update.ts";

export function registerUpdateCommand(program: Command): void {
  program
    .command("update")
    .description("update Photon to the latest release")
    .option("--check", "check for an update without installing it")
    .option("--force", "reinstall even when this version is current")
    .option(
      "--installer <name>",
      "override package-manager detection (npm, pnpm, yarn Classic, bun)"
    )
    .option("--json", "output machine-readable JSON")
    .action(async (opts) => {
      if (opts.check && opts.force) {
        throw new Error("--check and --force cannot be used together.");
      }
      const installer = opts.installer
        ? parsePackageInstaller(opts.installer)
        : undefined;
      if (!opts.json) {
        console.log(
          c.info(opts.check ? "Checking for Photon updates…" : "Updating Photon…")
        );
      }

      const result = await updatePhoton({
        check: opts.check,
        force: opts.force,
        installer,
        quiet: opts.json,
      });
      if (opts.json) {
        printJson(result);
        return;
      }

      if (result.status === "up-to-date") {
        console.log(c.success(`Photon ${result.currentVersion} is up to date.`));
        return;
      }
      if (result.status === "update-available") {
        console.log(
          c.warn(
            `Update available: ${result.currentVersion} → ${result.latestVersion}`
          )
        );
        console.log(c.hint("  Run `photon update` to install it."));
        return;
      }
      if (result.status === "reinstalled") {
        console.log(
          c.success(`Reinstalled Photon ${result.currentVersion} with ${result.installer}.`)
        );
        return;
      }
      console.log(
        c.success(
          `Updated Photon ${result.currentVersion} → ${result.latestVersion} with ${result.installer}.`
        )
      );
    });
}
