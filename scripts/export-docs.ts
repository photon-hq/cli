import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Argument, Option } from 'commander';
import { buildProgram } from '../src/program.ts';
import pkg from '../package.json' with { type: 'json' };

interface MetadataCommand { name(): string; description(): string; aliases(): string[]; registeredArguments: readonly Argument[]; options: readonly Option[]; commands: readonly MetadataCommand[]; }

export function commandMetadata(root: MetadataCommand) {
  const commands: object[] = [];
  const option = (value: Option, global: boolean) => ({
    name: value.name(), flags: value.flags, description: value.description,
    required: value.required, optional: value.optional, mandatory: value.mandatory,
    variadic: value.variadic, negatable: value.negate, default: value.defaultValue,
    choices: value.argChoices, env: value.envVar, global,
  });
  const visit = (command: MetadataCommand, path: string[], inherited: Option[]) => {
    const own = command.options.filter((value) => !value.hidden);
    commands.push({
      path, description: command.description(), aliases: command.aliases(),
      arguments: command.registeredArguments.map((arg) => ({ name: arg.name(), description: arg.description, required: arg.required, variadic: arg.variadic, default: arg.defaultValue, choices: arg.argChoices })),
      options: [...own.map((value) => option(value, false)), ...inherited.filter((value) => !own.some((o) => o.name() === value.name())).map((value) => option(value, true)),
        { name: 'help', flags: '-h, --help', description: 'Display help for command', global: true }],
    });
    for (const child of [...command.commands].sort((a, b) => a.name().localeCompare(b.name(), 'en'))) {
      visit(child, [...path, child.name()], [...inherited, ...own]);
    }
  };
  visit(root, [root.name()], []);
  return commands;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const revision = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  // buildProgram registers handlers, but never parses arguments or calls them.
  const artifact = { schemaVersion: 1, family: 'cli-stable', source: { repository: 'photon-hq/cli', revision, package: pkg.name, version: pkg.version }, commands: commandMetadata(buildProgram()) };
  await mkdir('artifacts', { recursive: true });
  await writeFile('artifacts/docs-reference.json', `${JSON.stringify(artifact, null, 2)}\n`);
}
