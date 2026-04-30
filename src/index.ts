#!/usr/bin/env bun
import { Command } from '@commander-js/extra-typings';
import { registerAuthCommands } from '~/commands/auth.ts';
import { registerBillingCommands } from '~/commands/billing.ts';
import { registerConfigCommands } from '~/commands/config.ts';
import { registerEnvCommand } from '~/commands/env.ts';
import { registerLoginCommand } from '~/commands/login.ts';
import { registerLogoutCommand } from '~/commands/logout.ts';
import { registerPingCommand } from '~/commands/ping.ts';
import { registerProfileCommand } from '~/commands/profile.ts';
import { registerProjectsCommand } from '~/commands/projects.ts';
import { registerSpectrumCommands } from '~/commands/spectrum/index.ts';
import { registerWhoamiCommand } from '~/commands/whoami.ts';
import { setDebug } from '~/lib/debug.ts';
import {
  DeviceFlowDenied,
  DeviceFlowExpired,
  NotAuthenticatedError,
  SessionExpiredError,
} from '~/lib/errors.ts';
import { die } from '~/lib/output.ts';
import { ensurePhoAlias } from '~/lib/pho-alias.ts';
import { startUpdateNotifier } from '~/lib/update-check.ts';
import pkg from '../package.json' with { type: 'json' };

ensurePhoAlias();
startUpdateNotifier();

const program = new Command()
  .name('photon')
  .description('Photon CLI — replaces the dashboard web UI for end-user interaction')
  .version(pkg.version, '-v, --version', 'output the current version')
  .option('--debug', 'verbose output incl. HTTP request/response')
  .hook('preAction', (thisCommand) => {
    // Honor the global --debug flag for any subcommand. Reading
    // process.env.PHOTON_DEBUG is also handled inside debug.ts so the
    // env var path doesn't need this hook.
    const opts = thisCommand.opts() as { debug?: boolean };
    if (opts.debug) setDebug(true);
  });

registerPingCommand(program);
registerEnvCommand(program);
registerLoginCommand(program);
registerLogoutCommand(program);
registerWhoamiCommand(program);
registerProfileCommand(program);
registerProjectsCommand(program);
registerSpectrumCommands(program);
registerBillingCommands(program);
registerAuthCommands(program);
registerConfigCommands(program);

program.parseAsync(process.argv).catch(handleTopLevelError);

/**
 * Central error formatter. Commands throw typed errors; this function
 * maps them to a friendly message + actionable hint and exits non-zero.
 *
 * Generic Error / unknown values fall through to a one-liner.
 */
function handleTopLevelError(err: unknown): never {
  if (err instanceof NotAuthenticatedError || err instanceof SessionExpiredError) {
    // Hint mentions the API host as a flag only if the user wasn't on the
    // default production backend. For production, `photon login` is enough.
    const flag =
      err.envName === 'production' ? '' : ` --api-host <url> # for "${err.envName}"`;
    die(err.message, {
      hint: `Run \`photon login${flag}\`.`,
    });
  }
  if (err instanceof DeviceFlowDenied) {
    die(err.message, { hint: 'Re-run `photon login` if this was unintentional.' });
  }
  if (err instanceof DeviceFlowExpired) {
    die(err.message, { hint: 'Re-run `photon login` and approve more quickly.' });
  }
  if (err instanceof Error) {
    // Heuristic: better-auth / fetch surface "Unable to connect" for
    // network failures. Surface a network-specific hint.
    if (/Unable to connect|fetch failed|ECONNREFUSED/i.test(err.message)) {
      die(err.message, {
        hint: 'Check your connection, or set PHOTON_API_HOST / pass --api-host <url> to target a reachable backend.',
      });
    }
    die(err.message);
  }
  die(String(err));
}
