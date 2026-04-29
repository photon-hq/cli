import type { Command } from "@commander-js/extra-typings";
import { registerSpectrumAvatar } from "~/commands/spectrum/avatar.ts";
import { registerSpectrumLines } from "~/commands/spectrum/lines.ts";
import { registerSpectrumPlatforms } from "~/commands/spectrum/platforms.ts";
import { registerSpectrumProfile } from "~/commands/spectrum/profile.ts";
import { registerSpectrumUsers } from "~/commands/spectrum/users.ts";

export function registerSpectrumCommands(program: Command): void {
  const spectrum = program
    .command("spectrum")
    .description("manage Spectrum users, lines, platforms, and profile");

  registerSpectrumProfile(spectrum);
  registerSpectrumUsers(spectrum);
  registerSpectrumLines(spectrum);
  registerSpectrumPlatforms(spectrum);
  registerSpectrumAvatar(spectrum);
}
