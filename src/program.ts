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
import pkg from '../package.json' with { type: 'json' };

/**
 * Pure Commander setup — no side effects. Returns a fully configured
 * program instance ready for `.parseAsync()`.
 */
export function buildProgram(): Command {
  const program = new Command()
    .name('photon')
    .description('Photon CLI — bring your agents to any interface')
    .version(pkg.version, '-v, --version', 'output the current version')
    .option('--debug', 'verbose output incl. HTTP request/response')
    .hook('preAction', (thisCommand) => {
      const opts = thisCommand.opts() as { debug?: boolean };
      setDebug(!!opts.debug);
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

  return program;
}
