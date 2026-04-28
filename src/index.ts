#!/usr/bin/env bun
import { Command } from '@commander-js/extra-typings';
import { registerEnvCommand } from '~/commands/env.ts';
import { registerHelloCommand } from '~/commands/hello.ts';
import { registerLoginCommand } from '~/commands/login.ts';
import { registerLogoutCommand } from '~/commands/logout.ts';
import { registerPingCommand } from '~/commands/ping.ts';
import { registerProfileCommand } from '~/commands/profile.ts';
import { registerProjectsCommand } from '~/commands/projects.ts';
import { registerWhoamiCommand } from '~/commands/whoami.ts';
import { c } from '~/lib/output.ts';
import pkg from '../package.json' with { type: 'json' };

const program = new Command()
  .name('dashboard')
  .description('Dashboard CLI')
  .version(pkg.version, '-v, --version', 'output the current version');

registerHelloCommand(program);
registerPingCommand(program);
registerEnvCommand(program);
registerLoginCommand(program);
registerLogoutCommand(program);
registerWhoamiCommand(program);
registerProfileCommand(program);
registerProjectsCommand(program);

program.parseAsync(process.argv).catch((err) => {
  console.error(c.error(err instanceof Error ? err.message : String(err)));
  process.exit(1);
});
