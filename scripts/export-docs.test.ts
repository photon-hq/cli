import { describe, expect, test } from 'bun:test';
import { Command } from 'commander';
import { buildProgram } from '../src/program.ts';
import { commandMetadata } from './export-docs.ts';

describe('documentation metadata', () => {
  test('extracts inherited flags and arguments without executing handlers', () => {
    const root = new Command('photon').option('--debug');
    root.command('sample <file>').option('--no-color').action(() => { throw new Error('must not execute'); });
    const text = JSON.stringify(commandMetadata(root));
    expect(text).toContain('"global":true');
    expect(text).toContain('"negatable":true');
    expect(text).toContain('"name":"file"');
  });
  test('covers the runtime tree deterministically', () => {
    const first = commandMetadata(buildProgram());
    expect(first).toEqual(commandMetadata(buildProgram()));
    expect(first.length).toBeGreaterThan(30);
  });
});
