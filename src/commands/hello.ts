import type { Command } from '@commander-js/extra-typings';

export function registerHelloCommand(program: Command): void {
  program
    .command('hello')
    .description('print a greeting')
    .argument('[name]', 'who to greet', 'world')
    .option('-u, --uppercase', 'shout the greeting')
    .action((name, opts) => {
      const message = `Hello, ${name}!`;
      console.log(opts.uppercase ? message.toUpperCase() : message);
    });
}
