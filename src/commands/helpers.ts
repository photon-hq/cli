import type { PhotonCommandServices } from '../app/services.ts'
import { CliError } from '../core/errors.ts'
import {
  type CommandRun,
  type CommandScope,
  inert,
  rerunCommand
} from '../core/presenter.ts'

/**
 * What a command asks about before doing it: something that costs money,
 * can't be undone, or adds to what is already there.
 */
export interface RiskyAction {
  /** What it does, as a phrase in lower case: `delete project prj_…`. */
  action: string
  /** What follows from it, said after the question. */
  consequence?: string
  /** The organization or project it acts on, written into the rerun. */
  scope?: CommandScope
  /** What a person types to go ahead, such as the project's name; y/N without. */
  typed?: string
}

/** A command that asks before a risky action, and its `--yes`. */
export interface ConfirmingCommand extends CommandRun {
  readonly extensions: { readonly photon: PhotonCommandServices }
  readonly values: Readonly<Record<string, unknown>> & {
    readonly yes: boolean | undefined
  }
}

const capitalized = (text: string): string =>
  `${text.charAt(0).toUpperCase()}${text.slice(1)}`

const question = (risky: RiskyAction): string =>
  inert(
    [`${capitalized(risky.action)}?`, risky.consequence]
      .filter((part) => part !== undefined)
      .join(' ')
  )

const confirmationRequired = (
  command: ConfirmingCommand,
  risky: RiskyAction,
  reason: string
): CliError =>
  new CliError(
    'CONFIRMATION_REQUIRED',
    `This would ${risky.action}. Confirm it with --yes.`,
    {
      detail: [risky.consequence, `Photon can't ask because ${reason}.`]
        .filter((part) => part !== undefined)
        .join(' '),
      exitCode: 2,
      next: [
        {
          description: 'Run it again with --yes',
          run: rerunCommand(command, {
            append: ['--yes'],
            scope: risky.scope,
            without: ['yes']
          })
        }
      ]
    }
  )

/**
 * Whether to go ahead with a risky action: `--yes` says so; at a terminal
 * the person answers y/N, or types what `typed` names. Where Photon can't
 * ask, it fails with `CONFIRMATION_REQUIRED`, whose next step is the same
 * command with `--yes`.
 */
export const confirmRiskyAction = async (
  command: ConfirmingCommand,
  risky: RiskyAction
): Promise<boolean> => {
  if (command.values.yes === true) {
    return true
  }
  const { input } = command.extensions.photon
  const blocked = (reason: string): CliError =>
    confirmationRequired(command, risky, reason)
  if (risky.typed !== undefined) {
    return await input.confirmExact(risky.typed, {
      blocked,
      question: question(risky)
    })
  }
  return await input.confirm(question(risky), blocked)
}

/**
 * A declined confirmation: nothing changed, `Cancelled.` on stderr, exit 1.
 * Only a person at a terminal answers, so JSON mode never gets here.
 */
export const cancelled = (photon: PhotonCommandServices): void => {
  photon.output.notice('Cancelled.')
  photon.setExitCode(1)
}
