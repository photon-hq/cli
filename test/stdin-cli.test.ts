import { Readable } from 'node:stream'
import { describe, expect, test } from 'vitest'
import type { ReadableInput } from '../src/core/input.ts'
import {
  asProjectScope,
  cliInvoker,
  createAuthenticatedConfig,
  terminalInvoker
} from './project-test-support.ts'
import { stagingTarget } from './target-support.ts'

const brandId = 'pho_brd_01h455vb4pex5vsknk084sn02q'
const campaignId = 'pho_cmp_01h455vb4pex5vsknk084sn02q'

const INTERNAL_READERS: [string[], string][] = [
  [['account', '10dlc', 'brand', 'create'], '--profile-file'],
  [['account', '10dlc', 'brand', 'edit', brandId], '--profile-file'],
  [['account', '10dlc', 'brand', 'otp', 'verify', brandId], '--code'],
  [['account', '10dlc', 'campaign', 'create', brandId], '--campaign-file'],
  [['account', '10dlc', 'campaign', 'resubmit', campaignId], '--resubmit-file'],
  [
    [
      'project',
      'compliance',
      'call-registry',
      'profile',
      'set',
      '--project',
      'pho_prj_00000000000000000000000001'
    ],
    '--profile-file'
  ],
  [
    [
      'project',
      'compliance',
      'call-registry',
      'profile',
      'edit',
      '--project',
      'pho_prj_00000000000000000000000001'
    ],
    '--profile-file'
  ],
  [
    [
      'project',
      'telemetry',
      'sql',
      '--project',
      'pho_prj_00000000000000000000000001'
    ],
    '--query-file'
  ]
]

// Every command that read piped standard input without being asked, before
// standard input was read only for `-` and `login --service-key`.
const READERS: [string[], string][] = [
  [['org', 'invitation', 'preview'], '--token-file'],
  [['org', 'invitation', 'accept'], '--token-file'],
  ...(stagingTarget ? INTERNAL_READERS : [])
]

const MODES = [
  ['at a terminal', terminalInvoker],
  ['with --json', cliInvoker]
] as const

const CASES = READERS.flatMap(([args, option]) =>
  MODES.map(([mode, invoker]) => [args, mode, option, invoker] as const)
)

describe('piped standard input', () => {
  test.each(CASES)(
    '%j %s leaves it unread and names %s',
    async (args, _mode, option, invoker) => {
      const authenticated = await createAuthenticatedConfig()
      const stdin = Readable.from(['SENTINEL-PIPED-INPUT\n']) as Readable &
        ReadableInput
      stdin.isTTY = false
      const invoke = invoker(
        authenticated.configDirectory,
        asProjectScope({}),
        { stdin }
      )

      const result = await invoke(args)
      const [error, other] =
        invoker === cliInvoker
          ? [result.stdout, result.stderr]
          : [result.stderr, result.stdout]

      expect(result.exitCodes).toEqual([2])
      expect(other).toBe('')
      expect(error).toContain('ARGUMENT_VALIDATION')
      expect(error).toContain(option)
      expect(error).not.toContain('SENTINEL-PIPED-INPUT')
      expect(stdin.readableFlowing).toBeNull()
      await authenticated.remove()
    }
  )
})
