import { $ } from 'bun';
import { resolve } from 'node:path';

const targets = (value: unknown): string[] => typeof value === 'string'
  ? [value]
  : value && typeof value === 'object' ? Object.values(value).flatMap(targets) : [];

const { RELEASE_CHANNEL: channel, RELEASE_VERSION: base, RELEASE_SUFFIX: suffix, PACK_DESTINATION: output } = process.env;
if (!base || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(base)) {
  throw new Error('RELEASE_VERSION must be a stable X.Y.Z version');
}
if (!((channel === 'staging' && /^-staging\.\d+\.\d+$/.test(suffix ?? '')) || (channel === 'production' && suffix === '')) || !output) {
  throw new Error('Release channel, suffix and pack destination are required');
}
const version = `${base}${suffix}`;
const root = resolve(import.meta.dir, '..');
const destination = resolve(output);
const temporary = (await $`mktemp -d`.quiet().text()).trim();
try {
  // The CLI and updater import package.json at build time. Build each channel
  // from a version-stamped copy, leaving the source manifest and lock intact.
  for (const file of ['src', 'tsconfig.json', 'README.md', 'LICENSE']) {
    await $`cp -R ${resolve(root, file)} ${resolve(temporary, file)}`.quiet();
  }
  await $`ln -s ${resolve(root, 'node_modules')} ${resolve(temporary, 'node_modules')}`.quiet();
  const manifest = await Bun.file(resolve(root, 'package.json')).json();
  await Bun.write(resolve(temporary, 'package.json'), `${JSON.stringify({ ...manifest, version }, null, 2)}\n`);
  await $`bun run build`.cwd(temporary);
  await $`mkdir -p ${destination}`.quiet();
  const filename = (await $`bun pm pack --ignore-scripts --destination ${destination} --quiet`.cwd(temporary).text()).trim();
  const archive = resolve(destination, filename);
  const packed = JSON.parse(await $`tar -xOf ${archive} package/package.json`.quiet().text());
  const files = new Set((await $`tar -tzf ${archive}`.quiet().text()).trim().split('\n'));
  for (const target of [packed.exports, packed.main, packed.types, packed.bin].flatMap(targets)) {
    if (!files.has(`package/${target.replace(/^\.\//, '')}`)) throw new Error(`Missing packed target: ${target}`);
  }
  const unpacked = resolve(temporary, 'packed');
  await $`mkdir -p ${unpacked}`.quiet();
  await $`tar -xzf ${archive} -C ${unpacked}`.quiet();
  await $`ln -s ${resolve(root, 'node_modules')} ${resolve(unpacked, 'package/node_modules')}`.quiet();
  const actual = (await $`bun ${resolve(unpacked, 'package/dist/photon.js')} --version`.quiet().text()).trim();
  if (actual !== version) throw new Error(`Packed CLI reports ${actual}, expected ${version}`);
} finally {
  await $`rm -rf ${temporary}`.quiet();
}
