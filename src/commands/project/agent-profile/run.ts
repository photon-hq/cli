import type { GetAgentProfileOutput } from '@photon-ai/api'
import type { CommandRunner } from 'gunshi'
import { detail } from '../../../core/presenter.ts'
import { validateFilePath } from '../../../core/validation.ts'
import { resolveProjectId } from '../../../project/command-helpers.ts'
import { validateAgentProfileChanges } from '../../../project/validation.ts'
import { cancelled, confirmRiskyAction } from '../../helpers.ts'
import type { PhotonCommandParams } from '../../types.ts'
import type {
  AgentProfileEditParams,
  AvatarResetParams,
  AvatarUploadParams
} from './definition.ts'

type AgentProfileViewParams = PhotonCommandParams

const profileDetails = (
  output: AgentProfileViewParams['extensions']['photon']['output'],
  profile: GetAgentProfileOutput
): string[] =>
  detail(output, 'Agent profile', [
    { label: 'First name', value: profile.firstName },
    { label: 'Last name', value: profile.lastName },
    { label: 'Avatar', value: profile.avatarUrl }
  ])

export const runView: CommandRunner<AgentProfileViewParams> = async (
  context
) => {
  const { photon } = context.extensions
  const projectId = await resolveProjectId(photon)
  const agentProfile = await photon.projects.getAgentProfile(projectId)
  photon.output.success(
    agentProfile,
    profileDetails(photon.output, agentProfile)
  )
}

export const runEdit: CommandRunner<AgentProfileEditParams> = async (
  context
) => {
  const { photon } = context.extensions
  const changes = validateAgentProfileChanges({
    clearLastName: context.values.clearLastName ?? false,
    ...(context.values.firstName === undefined
      ? {}
      : { firstName: context.values.firstName }),
    ...(context.values.lastName === undefined
      ? {}
      : { lastName: context.values.lastName })
  })
  const projectId = await resolveProjectId(photon)
  const { result: agentProfile } = await photon.operations.execute(
    { changes, kind: 'agent-profile.update', projectId },
    context.values.idempotencyKey,
    async ({ idempotencyKey }) =>
      await photon.projects.updateAgentProfile(
        projectId,
        changes,
        idempotencyKey
      )
  )
  photon.output.success(agentProfile, [
    photon.output.style('green', 'Updated the agent profile.'),
    ...profileDetails(photon.output, agentProfile)
  ])
}

export const runAvatarUpload: CommandRunner<AvatarUploadParams> = async (
  context
) => {
  const { photon } = context.extensions
  const file = validateFilePath(context.values.file, 'Avatar file path')
  const projectId = await resolveProjectId(photon)
  const { result: agentProfile } = await photon.operations.executeAvatarUpload(
    projectId,
    file,
    context.values.idempotencyKey
  )
  photon.output.success(agentProfile, [
    photon.output.style('green', 'Uploaded the agent avatar.'),
    ...profileDetails(photon.output, agentProfile)
  ])
}

export const runAvatarReset: CommandRunner<AvatarResetParams> = async (
  context
) => {
  const { photon } = context.extensions
  const projectId = await resolveProjectId(photon)
  const confirmed = await confirmRiskyAction(context, {
    action: `reset the agent avatar for project ${projectId}`,
    scope: { project: projectId }
  })
  if (!confirmed) {
    cancelled(photon)
    return
  }
  const { result } = await photon.operations.execute(
    { kind: 'agent-avatar.reset', projectId },
    context.values.idempotencyKey,
    async ({ idempotencyKey }) =>
      await photon.projects.resetAgentAvatar(projectId, idempotencyKey)
  )
  photon.output.success(
    result,
    photon.output.style('green', 'Reset the agent avatar.')
  )
}
