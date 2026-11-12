import type { CommandRunner } from 'gunshi'
import type { PhotonCommandServices } from '../../app/services.ts'
import { contextSourceLabel } from '../../app/target-notice.ts'
import type { UnlinkParams } from './definition.ts'

export const unlinkProject = async (
  photon: PhotonCommandServices
): Promise<void> => {
  const removed = await photon.projectContext.clear()
  const active = await photon.projectContext
    .resolveOptional()
    .catch(() => undefined)
  const remaining = active?.source === 'flag' ? undefined : active
  if (remaining !== undefined) {
    photon.output.warning(
      `${contextSourceLabel({ kind: 'project', ...remaining })} still selects project ${remaining.projectId}.`
    )
  }
  photon.output.success(
    {
      cleared: removed !== undefined,
      ...(removed === undefined ? {} : { path: removed }),
      ...(remaining === undefined ? {} : { active: remaining })
    },
    removed === undefined
      ? 'No project was saved for this folder.'
      : `Removed ${removed}.`
  )
}

export const run: CommandRunner<UnlinkParams> = async (context) => {
  await unlinkProject(context.extensions.photon)
}
