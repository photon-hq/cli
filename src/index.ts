#!/usr/bin/env bun
import { Command } from '@commander-js/extra-typings';
import { registerHelloCommand } from './commands/hello.ts';
import pkg from '../package.json' with { type: 'json' };

const program = new Command()
  .name('dashboard')
  .description('Dashboard CLI')
  .version(pkg.version, '-v, --version', 'output the current version');

registerHelloCommand(program);

program.parseAsync(process.argv).catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
