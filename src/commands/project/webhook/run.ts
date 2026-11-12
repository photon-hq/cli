import type { CommandRunner } from 'gunshi'
import { presentList, table } from '../../../core/presenter.ts'
import { resolveProjectId } from '../../../project/command-helpers.ts'
import {
  WEBHOOK_SIGNING_SECRET_WARNING,
  webhookDestinationCreationDetails,
  webhookDestinationDetails,
  webhookSigningSecretRotationDetails,
  withSafeWebhookSigningSecret
} from '../../../project/presenter.ts'
import {
  validatePagination,
  validateWebhookApiVersion,
  validateWebhookDestinationChanges,
  validateWebhookDestinationCreateInput,
  validateWebhookOverlapSeconds
} from '../../../project/validation.ts'
import { cancelled, confirmRiskyAction } from '../../helpers.ts'
import type {
  WebhookApiVersionListParams,
  WebhookCreateParams,
  WebhookDeleteParams,
  WebhookEditParams,
  WebhookEventTypeListParams,
  WebhookListParams,
  WebhookRotateSecretParams,
  WebhookViewParams
} from './definition.ts'

export const runList: CommandRunner<WebhookListParams> = async (context) => {
  const { photon } = context.extensions
  const projectId = await resolveProjectId(photon)
  const result = await photon.projects.listWebhookDestinations(
    projectId,
    validatePagination(context.values.limit, context.values.pageToken)
  )
  presentList(photon.output, {
    document: result,
    emptyMessage: 'No webhook destinations found.',
    items: result.destinations,
    lines: table(
      photon.output,
      ['NAME', 'DESTINATION ID', 'STATUS', 'API VERSION', 'URL', 'UPDATED'],
      result.destinations.map((destination) => [
        destination.name,
        { style: 'cyan', text: destination.destinationId },
        destination.status,
        destination.apiVersion,
        destination.url,
        { style: 'dim', text: destination.updatedAt }
      ])
    ),
    page: {
      command: context,
      inDocument: true,
      scope: { project: projectId },
      token: result.nextPageToken
    }
  })
}

export const runView: CommandRunner<WebhookViewParams> = async (context) => {
  const { photon } = context.extensions
  const destination = await photon.projects.getWebhookDestination(
    await resolveProjectId(photon),
    context.values['destination-id']
  )
  photon.output.success(
    destination,
    webhookDestinationDetails(photon.output, destination)
  )
}

export const runCreate: CommandRunner<WebhookCreateParams> = async (
  context
) => {
  const { photon } = context.extensions
  const input = validateWebhookDestinationCreateInput({
    allEvents: context.values.allEvents ?? false,
    apiVersion: context.values.apiVersion,
    ...(context.values.description === undefined
      ? {}
      : { description: context.values.description }),
    ...(context.values.event === undefined
      ? {}
      : { events: context.values.event }),
    name: context.values.name,
    status: context.values.status ?? 'enabled',
    url: context.values.url
  })
  const projectId = await resolveProjectId(photon)
  const { operationId, result } = await photon.operations.executeAwaitingOutput(
    {
      apiVersion: input.apiVersion,
      ...(input.description === undefined
        ? {}
        : { description: input.description }),
      enabledEvents: input.enabledEvents,
      kind: 'webhook-destination.create',
      name: input.name,
      projectId,
      status: input.status,
      url: input.url
    },
    context.values.idempotencyKey,
    async ({ idempotencyKey }) =>
      withSafeWebhookSigningSecret(
        await photon.projects.createWebhookDestination(
          projectId,
          input,
          idempotencyKey
        )
      )
  )
  const human = webhookDestinationCreationDetails(photon.output, result)
  photon.output.warning(WEBHOOK_SIGNING_SECRET_WARNING)
  await photon.operations.deliverOutput(operationId, () =>
    photon.output.successAndFlush(result, human)
  )
}

export const runEdit: CommandRunner<WebhookEditParams> = async (context) => {
  const { photon } = context.extensions
  const destinationId = context.values['destination-id']
  const changes = validateWebhookDestinationChanges({
    allEvents: context.values.allEvents ?? false,
    clearDescription: context.values.clearDescription ?? false,
    ...(context.values.description === undefined
      ? {}
      : { description: context.values.description }),
    ...(context.values.event === undefined
      ? {}
      : { events: context.values.event }),
    ...(context.values.name === undefined ? {} : { name: context.values.name }),
    ...(context.values.status === undefined
      ? {}
      : { status: context.values.status }),
    ...(context.values.url === undefined ? {} : { url: context.values.url })
  })
  const projectId = await resolveProjectId(photon)
  const { result } = await photon.operations.execute(
    {
      changes,
      destinationId,
      kind: 'webhook-destination.update',
      projectId
    },
    context.values.idempotencyKey,
    async ({ idempotencyKey }) =>
      await photon.projects.updateWebhookDestination(
        projectId,
        destinationId,
        changes,
        idempotencyKey
      )
  )
  photon.output.success(
    result,
    webhookDestinationDetails(
      photon.output,
      result,
      'Updated webhook destination'
    )
  )
}

export const runDelete: CommandRunner<WebhookDeleteParams> = async (
  context
) => {
  const { photon } = context.extensions
  const destinationId = context.values['destination-id']
  const projectId = await resolveProjectId(photon)
  const confirmed = await confirmRiskyAction(context, {
    action: `delete webhook destination ${destinationId} from project ${projectId}`,
    scope: { project: projectId }
  })
  if (!confirmed) {
    cancelled(photon)
    return
  }
  const { result } = await photon.operations.execute(
    { destinationId, kind: 'webhook-destination.delete', projectId },
    undefined,
    async () =>
      await photon.projects.deleteWebhookDestination(projectId, destinationId)
  )
  photon.output.success(result, [
    photon.output.style(
      'green',
      `Deleted webhook destination ${destinationId}.`
    ),
    ...webhookDestinationDetails(
      photon.output,
      result,
      'Deleted webhook destination'
    )
  ])
}

export const runRotateSecret: CommandRunner<WebhookRotateSecretParams> = async (
  context
) => {
  const { photon } = context.extensions
  const destinationId = context.values['destination-id']
  const overlapSeconds = validateWebhookOverlapSeconds(
    context.values.overlapSeconds
  )
  const projectId = await resolveProjectId(photon)
  const confirmed = await confirmRiskyAction(context, {
    action: `rotate the signing secret for webhook destination ${destinationId}`,
    consequence: `The previous secret will remain valid for ${overlapSeconds.toString()} seconds.`,
    scope: { project: projectId }
  })
  if (!confirmed) {
    cancelled(photon)
    return
  }
  const { operationId, result } = await photon.operations.executeAwaitingOutput(
    {
      destinationId,
      kind: 'webhook-signing-secret.rotate',
      overlapSeconds,
      projectId
    },
    context.values.idempotencyKey,
    async ({ idempotencyKey }) =>
      withSafeWebhookSigningSecret(
        await photon.projects.rotateWebhookSigningSecret(
          projectId,
          destinationId,
          overlapSeconds,
          idempotencyKey
        )
      )
  )
  const human = webhookSigningSecretRotationDetails(
    photon.output,
    destinationId,
    result
  )
  photon.output.warning(WEBHOOK_SIGNING_SECRET_WARNING)
  await photon.operations.deliverOutput(operationId, () =>
    photon.output.successAndFlush(result, human)
  )
}

export const runApiVersionList: CommandRunner<
  WebhookApiVersionListParams
> = async (context) => {
  const { photon } = context.extensions
  const catalog = await photon.projects.listWebhookApiVersions(
    await resolveProjectId(photon)
  )
  presentList(photon.output, {
    document: catalog,
    emptyMessage: 'No webhook API versions found.',
    items: catalog.apiVersions,
    lines: table(
      photon.output,
      ['VERSION', 'STATUS', 'SELECTABLE'],
      catalog.apiVersions.map((apiVersion) => [
        { style: 'cyan', text: apiVersion.version },
        apiVersion.status,
        apiVersion.selectable ? 'yes' : 'no'
      ])
    )
  })
}

export const runEventTypeList: CommandRunner<
  WebhookEventTypeListParams
> = async (context) => {
  const { photon } = context.extensions
  const catalog = await photon.projects.listWebhookEventTypes(
    await resolveProjectId(photon),
    validateWebhookApiVersion(context.values.apiVersion)
  )
  presentList(photon.output, {
    document: catalog,
    emptyMessage: 'No webhook event types found.',
    items: catalog.events,
    lines: table(
      photon.output,
      ['TYPE', 'AUDIENCE', 'DESCRIPTION', 'SCHEMA'],
      catalog.events.map((event) => [
        { style: 'cyan', text: event.type },
        event.audience,
        event.description,
        event.schemaUrl
      ])
    )
  })
}
