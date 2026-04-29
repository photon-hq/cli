#!/usr/bin/env bun
import { Command } from '@commander-js/extra-typings';
import { registerBillingCommands } from '~/commands/billing.ts';
import { registerEnvCommand } from '~/commands/env.ts';
import { registerLinkCommands } from '~/commands/link.ts';
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
  UnknownEnvError,
} from '~/lib/errors.ts';
import { die } from '~/lib/output.ts';
import pkg from '../package.json' with { type: 'json' };

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
registerLinkCommands(program);
registerSpectrumCommands(program);
registerBillingCommands(program);

program.parseAsync(process.argv).catch(handleTopLevelError);

/**
 * Central error formatter. Commands throw typed errors; this function
 * maps them to a friendly message + actionable hint and exits non-zero.
 *
 * Generic Error / unknown values fall through to a one-liner.
 */
function handleTopLevelError(err: unknown): never {
  if (err instanceof NotAuthenticatedError || err instanceof SessionExpiredError) {
    const flag = err.envName === 'production' ? '' : ` --env ${err.envName}`;
    die(err.message, {
      hint: `Run \`photon login${flag}\``,
    });
  }
  if (err instanceof UnknownEnvError) {
    die(err.message, {
      hint: 'List envs: `photon env list`. Add a custom one: `photon env add <name> <url>`.',
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
        hint: 'Check your connection or pass --env / --url to target a reachable host.',
      });
    }
    die(err.message);
  }
  die(String(err));
}
