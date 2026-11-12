import { parse } from 'node:path'

export const PACKAGE_MANAGERS = ['npm', 'pnpm', 'yarn', 'bun'] as const

export type PackageManager = (typeof PACKAGE_MANAGERS)[number]

// A package manager reads the project in the folder it runs in: its
// packageManager field can switch pnpm or Yarn to another version, and its
// .npmrc can move npm's global folder. Global commands run from the root of
// the file system, which belongs to no project.
export const GLOBAL_COMMAND_DIRECTORY = parse(process.execPath).root
