import type { ArgSchema } from 'gunshi'
import { idArgument } from '../core/photon-id.ts'

// Options every command accepts. The plugin registers them, and the
// moved-command pointers use them to find the command words.
export const PHOTON_GLOBAL_OPTIONS = {
  color: {
    default: true,
    description: 'Use color in terminal output',
    negatable: true,
    type: 'boolean'
  },
  debug: {
    default: false,
    description: 'Include sanitized HTTP and error diagnostics',
    type: 'boolean'
  },
  json: {
    default: false,
    description: 'Emit stable JSON instead of human-readable output',
    type: 'boolean'
  },
  noInput: {
    default: false,
    description: 'Never ask a question; fail and name the flag instead',
    toKebab: true,
    type: 'boolean'
  },
  org: {
    description:
      'Organization ID for this command (or set PHOTON_ORGANIZATION_ID)',
    parse: idArgument('organization', 'Organization ID'),
    type: 'string'
  },
  project: {
    description: 'Project ID for this command (or set PHOTON_PROJECT_ID)',
    parse: idArgument('project', 'Project ID'),
    type: 'string'
  }
} as const satisfies Record<string, ArgSchema>
