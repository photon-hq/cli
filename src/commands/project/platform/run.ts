import type { CommandRunner } from 'gunshi'
import type { PhotonCommandServices } from '../../../app/services.ts'
import { CliError } from '../../../core/errors.ts'
import type { CliOutput, TextStyle } from '../../../core/output.ts'
import {
  type CommandRun,
  detail,
  inert,
  presentList,
  table
} from '../../../core/presenter.ts'
import { validateSmsPurchaseInput } from '../../../project/api-contract.ts'
import { resolveProjectId } from '../../../project/command-helpers.ts'
import type { EmailDomainAutomaticSetup } from '../../../project/email-domain.ts'
import {
  platformResourceDomain,
  platformResourceHealth,
  platformResourcePhoneNumber
} from '../../../project/presenter.ts'
import {
  isResourceOperationInProgress,
  type PlatformResource,
  type ProvisioningOperation,
  type ResourceOperation,
  type WhatsappBusinessNumber
} from '../../../project/service.ts'
import {
  validateAssignmentInput,
  validateEmailDomain,
  validatePagination
} from '../../../project/validation.ts'
import { cancelled, confirmRiskyAction } from '../../helpers.ts'
import type { PhotonCommandParams } from '../../types.ts'
import type {
  AssignmentCreateParams,
  AssignmentListParams,
  AssignmentReleaseParams,
  AssignmentViewParams,
  EmailConnectParams,
  EmailDisconnectParams,
  EmailDnsParams,
  EmailListParams,
  ImessageListParams,
  ImessagePurchaseParams,
  OperationCancelParams,
  SmsDeleteParams,
  SmsListParams,
  SmsPurchaseParams,
  WhatsappBusinessAccountListParams,
  WhatsappBusinessNumberAddParams,
  WhatsappBusinessNumberDeleteParams,
  WhatsappBusinessNumberListParams,
  WhatsappBusinessNumberViewParams
} from './definition.ts'
import type { VoiceListParams } from './voice/definition.ts'
import { runWhatsappNumberAdd } from './whatsapp-number-add.ts'

type PlatformListParams = PhotonCommandParams
type ImessageViewParams = PhotonCommandParams

const assignmentDetails = (
  output: PlatformListParams['extensions']['photon']['output'],
  assignment: Awaited<
    ReturnType<PhotonCommandServices['projects']['getSharedLineAssignment']>
  >
): string[] =>
  detail(output, 'iMessage assignment', [
    { label: 'ID', value: assignment.assignmentId },
    { label: 'User phone', value: assignment.handle },
    { label: 'Assigned phone', value: assignment.assignedPhoneNumber },
    { label: 'Email', value: assignment.email },
    { label: 'First name', value: assignment.firstName },
    { label: 'Last name', value: assignment.lastName },
    { label: 'Created', value: assignment.createdAt },
    { label: 'Updated', value: assignment.updatedAt },
    { label: 'Released', value: assignment.releasedAt }
  ])

const platformResourceDetails = (
  output: CliOutput,
  heading: string,
  resource: PlatformResource,
  hideType: boolean
): string[] =>
  detail(output, heading, [
    { label: 'Phone number', value: platformResourcePhoneNumber(resource) },
    { label: 'Resource ID', value: resource.resourceId },
    ...(hideType ? [] : [{ label: 'Type', value: resource.type }]),
    { label: 'State', value: resource.state },
    { label: 'Health', value: platformResourceHealth(resource) },
    { label: 'Abilities', value: resource.abilities },
    { label: 'Project', value: resource.projectId },
    { label: 'Created', value: resource.createdAt },
    { label: 'Updated', value: resource.updatedAt }
  ])

type PlatformResourceListResult = Awaited<
  ReturnType<PhotonCommandServices['projects']['listPlatformResources']>
>

interface PlatformResourceListPresentation {
  emptyMessage: string
  heading: string
  healthOf?: (resource: PlatformResource) => string | undefined
  hideResourceType?: boolean
  identityHeading?: string
  identityOf?: (resource: PlatformResource) => string | undefined
  includeHealth?: boolean
  provisioningHint?: string
}

const resourceTable = (
  output: CliOutput,
  resources: PlatformResource[],
  presentation: Omit<
    PlatformResourceListPresentation,
    'emptyMessage' | 'heading' | 'provisioningHint'
  >
): string[] => {
  const sharedHeadings = [
    presentation.identityHeading ?? 'PHONE NUMBER',
    'RESOURCE ID'
  ]
  const endingHeadings = ['STATE', 'ABILITIES', 'CREATED']
  const headings = [
    ...sharedHeadings,
    ...(presentation.hideResourceType === true ? [] : ['TYPE']),
    ...(presentation.includeHealth === true ? ['HEALTH'] : []),
    ...endingHeadings
  ]
  return table(
    output,
    headings,
    resources.map((resource) => [
      (presentation.identityOf ?? platformResourcePhoneNumber)(resource) ?? '—',
      { style: 'cyan', text: resource.resourceId },
      ...(presentation.hideResourceType === true ? [] : [resource.type]),
      ...(presentation.includeHealth === true
        ? [(presentation.healthOf ?? platformResourceHealth)(resource) ?? '—']
        : []),
      resource.state,
      resource.abilities.join(', '),
      { style: 'dim', text: resource.createdAt }
    ])
  )
}

const emailDomainResourceDetails = (
  output: CliOutput,
  resource: PlatformResource
): string[] =>
  detail(output, 'Email domain', [
    { label: 'Domain', value: platformResourceDomain(resource) },
    { label: 'Resource ID', value: resource.resourceId },
    { label: 'State', value: resource.state },
    { label: 'Health', value: platformResourceHealth(resource) },
    { label: 'Abilities', value: resource.abilities },
    { label: 'Project', value: resource.projectId },
    { label: 'Created', value: resource.createdAt },
    { label: 'Updated', value: resource.updatedAt }
  ])

const dnsRecordTypeStyle = (type: string): TextStyle => {
  if (type === 'CNAME') {
    return 'cyan'
  }
  if (type === 'MX') {
    return 'magenta'
  }
  return 'yellow'
}

const emailDomainDnsTable = (
  output: CliOutput,
  records: Awaited<
    ReturnType<PhotonCommandServices['projects']['connectEmailDomain']>
  >['dnsRecords']
): string[] =>
  table(
    output,
    ['TYPE', 'NAME', 'VALUE', 'PRIORITY'],
    records.map((record) => [
      {
        style: dnsRecordTypeStyle(record.type),
        text: record.type
      },
      { style: 'cyan', text: record.name },
      { style: 'green', text: record.value },
      record.type === 'MX'
        ? { style: 'yellow', text: record.priority.toString() }
        : { style: 'dim', text: '—' }
    ]),
    'No DNS records returned.',
    { bordered: true }
  )

const emailDomainVerificationDetails = (
  output: CliOutput,
  verification: NonNullable<
    Awaited<
      ReturnType<PhotonCommandServices['projects']['getEmailDomainDnsRecords']>
    >['verification']
  >
): string[] =>
  detail(output, 'Verification', [
    { label: 'DNS ready', value: verification.dnsReady },
    { label: 'Identity ready', value: verification.identityReady },
    { label: 'DKIM ready', value: verification.dkimReady },
    { label: 'MAIL FROM ready', value: verification.mailFromReady },
    { label: 'Last checked', value: verification.lastCheckedAt }
  ])

const emailDomainAutomaticSetupDetails = (
  output: CliOutput,
  automaticSetup: EmailDomainAutomaticSetup
): string[] =>
  detail(output, 'Automatic DNS setup', [
    { label: 'Provider', value: automaticSetup.providerDisplayName },
    { label: 'Provider ID', value: automaticSetup.dnsProviderId },
    { label: 'Setup URL', value: automaticSetup.applyUrl }
  ])

const launchEmailDomainAutomaticSetup = async (
  photon: PhotonCommandServices,
  automaticSetup: EmailDomainAutomaticSetup,
  noBrowser: boolean
): Promise<string[]> => {
  const setupDetails = emailDomainAutomaticSetupDetails(
    photon.output,
    automaticSetup
  )
  if (noBrowser) {
    return setupDetails
  }
  try {
    await photon.browser.open(new URL(automaticSetup.applyUrl).href)
    return [
      ...setupDetails,
      '',
      photon.output.style(
        'green',
        inert(
          `Opened automatic DNS setup with ${automaticSetup.providerDisplayName} in your browser.`
        )
      )
    ]
  } catch {
    photon.output.warning(
      'The browser could not be opened. Open the automatic DNS setup URL manually.'
    )
    return setupDetails
  }
}

export const operationStateStyle = (state: string): TextStyle => {
  const normalized = state.toLowerCase()
  if (normalized === 'succeeded') {
    return 'green'
  }
  if (normalized === 'failed' || normalized === 'cancelled') {
    return 'red'
  }
  return 'yellow'
}

const emailDomainConnectionTable = (
  output: CliOutput,
  domain: string,
  operation: ResourceOperation
): string[] =>
  table(
    output,
    ['DOMAIN', 'OPERATION ID', 'STATE'],
    [
      [
        { style: 'magenta', text: domain },
        { style: 'cyan', text: operation.operationId },
        { style: operationStateStyle(operation.state), text: operation.state }
      ]
    ],
    'No email-domain connection returned.',
    { bordered: true }
  )

const provisioningTable = (
  output: CliOutput,
  provisioning: ProvisioningOperation[],
  hideResourceType: boolean
): string[] =>
  table(
    output,
    [
      'OPERATION ID',
      ...(hideResourceType ? [] : ['RESOURCE TYPE']),
      'STATE',
      'STARTED',
      'UPDATED'
    ],
    provisioning.map((operation) => [
      { style: 'cyan', text: operation.operationId },
      ...(hideResourceType ? [] : [operation.resourceType]),
      operation.state,
      operation.startedAt ?? '—',
      { style: 'dim', text: operation.updatedAt }
    ]),
    'No resource provisioning operations found.'
  )

const platformOperationDetails = (
  output: CliOutput,
  operation: ResourceOperation
): string[] =>
  detail(output, 'Platform operation', [
    { label: 'Operation ID', value: operation.operationId },
    { label: 'Project', value: operation.projectId },
    { label: 'Type', value: operation.type },
    { label: 'Resource type', value: operation.resourceType },
    { label: 'Resource ID', value: operation.resourceId },
    { label: 'State', value: operation.state },
    { label: 'Started', value: operation.startedAt },
    { label: 'Ended', value: operation.endedAt },
    { label: 'Updated', value: operation.updatedAt }
  ])

const whatsappBusinessNumberDetails = (
  output: CliOutput,
  resource: WhatsappBusinessNumber
): string[] =>
  detail(output, 'WhatsApp Business number', [
    { label: 'Phone number', value: resource.detail.phoneNumber },
    { label: 'Phone number ID', value: resource.detail.phoneNumberId },
    { label: 'WABA ID', value: resource.detail.account.wabaId },
    { label: 'Display name', value: resource.detail.displayName },
    { label: 'Name status', value: resource.detail.displayNameStatus },
    { label: 'Quality', value: resource.detail.qualityRating },
    { label: 'Photon source', value: resource.detail.voipResourceId },
    { label: 'Resource ID', value: resource.resourceId },
    { label: 'State', value: resource.state },
    { label: 'Abilities', value: resource.abilities.join(', ') },
    { label: 'Project', value: resource.projectId },
    { label: 'Created', value: resource.createdAt },
    { label: 'Updated', value: resource.updatedAt },
    { label: 'Retired', value: resource.retiredAt }
  ])

export const presentPlatformResourceList = (
  photon: PhotonCommandServices,
  listed: { command: CommandRun; projectId: string },
  result: PlatformResourceListResult,
  presentation: PlatformResourceListPresentation
): void => {
  const { provisioning, resources } = result
  const sections: string[][] = []
  if (resources.length > 0) {
    sections.push([
      photon.output.style('bold', presentation.heading),
      ...resourceTable(photon.output, resources, presentation)
    ])
  }
  if (provisioning.length > 0) {
    sections.push([
      photon.output.style('bold', 'Provisioning'),
      ...provisioningTable(
        photon.output,
        provisioning,
        presentation.hideResourceType === true
      ),
      ...(presentation.provisioningHint === undefined
        ? []
        : ['', presentation.provisioningHint])
    ])
  }
  presentList(photon.output, {
    document: result,
    emptyMessage: presentation.emptyMessage,
    items: resources,
    lines: sections.flatMap((section, index) =>
      index === 0 ? section : ['', ...section]
    ),
    page: {
      command: listed.command,
      inDocument: true,
      scope: { project: listed.projectId },
      token: result.nextPageToken
    }
  })
}

export const runPlatformList: CommandRunner<PlatformListParams> = async (
  context
) => {
  const { photon } = context.extensions
  const result = await photon.projects.listProjectPlatforms(
    await resolveProjectId(photon)
  )
  presentList(photon.output, {
    document: result,
    emptyMessage: 'No platforms found.',
    items: result.platforms,
    lines: table(
      photon.output,
      ['TYPE', 'NAME', 'DESCRIPTION'],
      result.platforms.map((platform) => [
        { style: 'cyan', text: platform.type },
        platform.displayName,
        platform.description
      ])
    )
  })
}

export const runOperationCancel: CommandRunner<OperationCancelParams> = async (
  context
) => {
  const { photon } = context.extensions
  const operationId = context.values['operation-id']
  const projectId = await resolveProjectId(photon)
  const confirmed = await confirmRiskyAction(context, {
    action: `cancel platform operation ${operationId} for project ${projectId}`,
    scope: { project: projectId }
  })
  if (!confirmed) {
    cancelled(photon)
    return
  }
  const operation = await photon.projects.cancelOperation(
    projectId,
    operationId
  )
  photon.output.success(operation, [
    photon.output.style(
      'green',
      inert(`Cancelled platform operation ${operation.operationId}.`)
    ),
    ...platformOperationDetails(photon.output, operation)
  ])
}

export const runImessageView: CommandRunner<ImessageViewParams> = async (
  context
) => {
  const { photon } = context.extensions
  const platform = await photon.projects.getImessagePlatform(
    await resolveProjectId(photon)
  )
  photon.output.success(
    platform,
    detail(photon.output, 'iMessage', [
      { label: 'Mode', value: platform.mode },
      {
        label: 'Max assignments',
        value:
          platform.mode === 'shared' ? platform.maxUserAssignments : undefined
      }
    ])
  )
}

export const runAssignmentList: CommandRunner<AssignmentListParams> = async (
  context
) => {
  const { photon } = context.extensions
  const projectId = await resolveProjectId(photon)
  const result = await photon.projects.listSharedLineAssignments(
    projectId,
    validatePagination(context.values.limit, context.values.pageToken),
    context.values.includeReleased ?? false
  )
  presentList(photon.output, {
    document: result,
    emptyMessage: 'No iMessage assignments found.',
    items: result.assignments,
    lines: table(
      photon.output,
      ['ASSIGNMENT ID', 'USER PHONE', 'ASSIGNED PHONE', 'EMAIL', 'RELEASED'],
      result.assignments.map((assignment) => [
        { style: 'cyan', text: assignment.assignmentId },
        assignment.handle,
        assignment.assignedPhoneNumber,
        assignment.email ?? '—',
        assignment.releasedAt ?? '—'
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

export const runAssignmentCreate: CommandRunner<
  AssignmentCreateParams
> = async (context) => {
  const { photon } = context.extensions
  const input = validateAssignmentInput({
    ...(context.values.email === undefined
      ? {}
      : { email: context.values.email }),
    ...(context.values.firstName === undefined
      ? {}
      : { firstName: context.values.firstName }),
    ...(context.values.lastName === undefined
      ? {}
      : { lastName: context.values.lastName }),
    phoneNumber: context.values.phoneNumber
  })
  const projectId = await resolveProjectId(photon)
  const { result: assignment } = await photon.operations.execute(
    { input, kind: 'assignment.create', projectId },
    context.values.idempotencyKey,
    async ({ idempotencyKey }) =>
      await photon.projects.createSharedLineAssignment(
        projectId,
        input,
        idempotencyKey
      )
  )
  photon.output.success(assignment, [
    photon.output.style('green', 'Created the iMessage assignment.'),
    ...assignmentDetails(photon.output, assignment)
  ])
}

export const runAssignmentView: CommandRunner<AssignmentViewParams> = async (
  context
) => {
  const { photon } = context.extensions
  const assignment = await photon.projects.getSharedLineAssignment(
    await resolveProjectId(photon),
    context.values['assignment-id']
  )
  photon.output.success(
    assignment,
    assignmentDetails(photon.output, assignment)
  )
}

export const runAssignmentRelease: CommandRunner<
  AssignmentReleaseParams
> = async (context) => {
  const { photon } = context.extensions
  const projectId = await resolveProjectId(photon)
  const assignmentId = context.values['assignment-id']
  const confirmed = await confirmRiskyAction(context, {
    action: `release iMessage assignment ${assignmentId}`,
    scope: { project: projectId }
  })
  if (!confirmed) {
    cancelled(photon)
    return
  }
  const { result: assignment } = await photon.operations.execute(
    { assignmentId, kind: 'assignment.release', projectId },
    undefined,
    async () =>
      await photon.projects.releaseSharedLineAssignment(projectId, assignmentId)
  )
  photon.output.success(
    assignment,
    photon.output.style(
      'green',
      `Released iMessage assignment ${assignmentId}.`
    )
  )
}

export const runSmsList: CommandRunner<SmsListParams> = async (context) => {
  const { photon } = context.extensions
  const projectId = await resolveProjectId(photon)
  const result = await photon.projects.listPlatformResources(
    projectId,
    'sms',
    validatePagination(context.values.limit, context.values.pageToken)
  )
  presentPlatformResourceList(photon, { command: context, projectId }, result, {
    emptyMessage: 'No SMS resources found.',
    heading: 'SMS resources'
  })
}

export const runEmailList: CommandRunner<EmailListParams> = async (context) => {
  const { photon } = context.extensions
  const projectId = await resolveProjectId(photon)
  const result = await photon.projects.listPlatformResources(
    projectId,
    'email',
    validatePagination(context.values.limit, context.values.pageToken)
  )
  presentPlatformResourceList(photon, { command: context, projectId }, result, {
    emptyMessage: 'No email domains found.',
    heading: 'Email domains',
    hideResourceType: true,
    identityHeading: 'DOMAIN',
    identityOf: platformResourceDomain,
    includeHealth: true
  })
}

export const runEmailDns: CommandRunner<EmailDnsParams> = async (context) => {
  const { photon } = context.extensions
  const projectId = await resolveProjectId(photon)
  const operationId = context.values['operation-id']
  const { automaticSetup, dnsRecords, response, verification } =
    await photon.projects.getEmailDomainDnsRecords(projectId, operationId)
  photon.output.success(response, [
    ...platformOperationDetails(photon.output, response.operation),
    ...(verification === undefined
      ? []
      : ['', ...emailDomainVerificationDetails(photon.output, verification)]),
    ...(automaticSetup === undefined
      ? []
      : [
          '',
          ...emailDomainAutomaticSetupDetails(photon.output, automaticSetup)
        ]),
    '',
    photon.output.style('bold', 'DNS records'),
    ...emailDomainDnsTable(photon.output, dnsRecords)
  ])
}

export const runImessageList: CommandRunner<ImessageListParams> = async (
  context
) => {
  const { photon } = context.extensions
  const projectId = await resolveProjectId(photon)
  const result = await photon.projects.listPlatformResources(
    projectId,
    'imessage',
    validatePagination(context.values.limit, context.values.pageToken)
  )
  presentPlatformResourceList(photon, { command: context, projectId }, result, {
    emptyMessage: 'No iMessage resources found.',
    heading: 'iMessage resources',
    hideResourceType: true,
    includeHealth: true
  })
}

export const runVoiceList: CommandRunner<VoiceListParams> = async (context) => {
  const { photon } = context.extensions
  const projectId = await resolveProjectId(photon)
  const result = await photon.projects.listResources(
    projectId,
    'pstn_voice',
    validatePagination(context.values.limit, context.values.pageToken)
  )
  presentList(photon.output, {
    document: result,
    emptyMessage: 'No PSTN voice resources found.',
    items: result.resources,
    lines:
      result.resources.length === 0
        ? []
        : [
            photon.output.style('bold', 'PSTN voice resources'),
            ...resourceTable(photon.output, result.resources, {})
          ],
    page: {
      command: context,
      inDocument: true,
      scope: { project: projectId },
      token: result.nextPageToken
    }
  })
}

export const runSmsPurchase: CommandRunner<SmsPurchaseParams> = async (
  context
) => {
  const { photon } = context.extensions
  const input = validateSmsPurchaseInput({
    countryCode: context.values.country,
    ...(context.values.areaCode === undefined
      ? {}
      : { areaCode: context.values.areaCode })
  })
  const projectId = await resolveProjectId(photon)
  const confirmed = await confirmRiskyAction(context, {
    action: `purchase one US local SMS number for project ${projectId}`,
    consequence: 'The project will be charged once provisioning succeeds.',
    scope: { project: projectId }
  })
  if (!confirmed) {
    cancelled(photon)
    return
  }
  const execution = await photon.operations.execute(
    { input, kind: 'sms-number.purchase', projectId },
    context.values.idempotencyKey,
    async ({ idempotencyKey, updateRemoteOperationId }) =>
      await photon.output.withLoading(
        `Provisioning a US local SMS number for project ${projectId}`,
        async () =>
          await photon.projects.purchaseSmsNumber(
            projectId,
            input,
            idempotencyKey,
            updateRemoteOperationId
          ),
        { nonInteractive: 'silent' }
      )
  )
  const { resource } = execution.result
  const phoneNumber = platformResourcePhoneNumber(resource)
  photon.output.success(execution.result, [
    photon.output.style(
      'green',
      inert(
        phoneNumber === undefined
          ? `Provisioned SMS resource ${resource.resourceId}.`
          : `Provisioned SMS number ${phoneNumber}.`
      )
    ),
    ...platformResourceDetails(photon.output, 'SMS resource', resource, false)
  ])
}

export const runEmailConnect: CommandRunner<EmailConnectParams> = async (
  context
) => {
  const { photon } = context.extensions
  const projectId = await resolveProjectId(photon)
  const domain = validateEmailDomain(context.values.domain)
  const connection = (
    await photon.operations.execute(
      { domain, kind: 'email-domain.connect', projectId },
      context.values.idempotencyKey,
      async ({ idempotencyKey, updateRemoteOperationId }) =>
        await photon.output.withLoading(
          `Preparing DNS records for ${domain}`,
          async () =>
            await photon.projects.connectEmailDomain(
              projectId,
              domain,
              idempotencyKey,
              updateRemoteOperationId
            ),
          { nonInteractive: 'silent' }
        )
    )
  ).result
  const { operation } = connection.response
  const resource = isResourceOperationInProgress(operation.state)
    ? undefined
    : connection.response.resource
  const human = [
    photon.output.style(
      'green',
      resource === undefined
        ? `Started connecting ${domain}.`
        : `Connected ${domain}.`
    ),
    ...emailDomainConnectionTable(photon.output, domain, operation)
  ]
  if (resource === undefined) {
    const automaticSetupHuman =
      connection.automaticSetup === undefined
        ? []
        : await launchEmailDomainAutomaticSetup(
            photon,
            connection.automaticSetup,
            context.values.noBrowser ?? false
          )
    human.push(
      ...(automaticSetupHuman.length === 0 ? [] : ['', ...automaticSetupHuman]),
      '',
      connection.automaticSetup === undefined
        ? 'Publish these DNS records. Photon will verify them automatically:'
        : 'If automatic setup does not complete, publish these DNS records manually:',
      ...emailDomainDnsTable(photon.output, connection.dnsRecords)
    )
    if (context.values.wait === false) {
      photon.output.success(connection.response, human)
      return
    }
    human.push(
      '',
      'Waiting for Photon to verify the records. Press Ctrl-C to stop waiting; verification will continue in the background.'
    )
    await photon.output.beforeWait(human)
    const verified = (
      await photon.output.withLoading(
        `Waiting for DNS verification for ${domain}`,
        async () =>
          await photon.projects.waitForEmailDomainVerification(
            projectId,
            operation.operationId
          ),
        { nonInteractive: 'silent' }
      )
    ).response
    if (verified.resource === undefined) {
      throw new CliError(
        'PROJECT_PROTOCOL_ERROR',
        'Photon returned an invalid email-domain connection response.',
        {
          detail:
            'A verified email-domain operation did not include its resource.',
          next: [
            { description: 'Retry the command with the same idempotency key.' }
          ],
          remoteOperationId: operation.operationId
        }
      )
    }
    photon.output.success(verified, [
      photon.output.style('green', `Connected ${domain}.`),
      ...emailDomainResourceDetails(photon.output, verified.resource)
    ])
    return
  }
  human.push(...emailDomainResourceDetails(photon.output, resource))
  photon.output.success(connection.response, human)
}

export const runEmailDisconnect: CommandRunner<EmailDisconnectParams> = async (
  context
) => {
  const { photon } = context.extensions
  const projectId = await resolveProjectId(photon)
  const resourceId = context.values['resource-id']
  const confirmed = await confirmRiskyAction(context, {
    action: `disconnect email domain resource ${resourceId} from project ${projectId}`,
    consequence: 'This removes its provider identity and retires the resource.',
    scope: { project: projectId }
  })
  if (!confirmed) {
    cancelled(photon)
    return
  }
  const execution = await photon.output.withLoading(
    `Disconnecting email domain resource ${resourceId}`,
    async () =>
      await photon.operations.execute(
        { kind: 'email-domain.disconnect', projectId, resourceId },
        undefined,
        async ({ updateRemoteOperationId }) =>
          await photon.projects.disconnectEmailDomain(
            projectId,
            resourceId,
            updateRemoteOperationId
          )
      ),
    { nonInteractive: 'silent' }
  )
  photon.output.success(
    execution.result,
    photon.output.style(
      'green',
      `Disconnected email domain resource ${resourceId}.`
    )
  )
}

export const runImessagePurchase: CommandRunner<
  ImessagePurchaseParams
> = async (context) => {
  const { photon } = context.extensions
  const projectId = await resolveProjectId(photon)
  const confirmed = await confirmRiskyAction(context, {
    action: `purchase one dedicated iMessage line for project ${projectId}`,
    consequence: 'The project will be charged once provisioning succeeds.',
    scope: { project: projectId }
  })
  if (!confirmed) {
    cancelled(photon)
    return
  }
  const execution = await photon.operations.execute(
    { kind: 'imessage-dedicated-line.purchase', projectId },
    context.values.idempotencyKey,
    async ({ idempotencyKey, updateRemoteOperationId }) =>
      await photon.output.withLoading(
        `Provisioning a dedicated iMessage line for project ${projectId}`,
        async () =>
          await photon.projects.provisionImessageDedicatedLine(
            projectId,
            idempotencyKey,
            updateRemoteOperationId
          ),
        { nonInteractive: 'silent' }
      )
  )
  const { resource } = execution.result
  const phoneNumber = platformResourcePhoneNumber(resource)
  photon.output.success(execution.result, [
    photon.output.style(
      'green',
      inert(
        phoneNumber === undefined
          ? `Provisioned iMessage resource ${resource.resourceId}.`
          : `Provisioned iMessage line ${phoneNumber}.`
      )
    ),
    ...platformResourceDetails(
      photon.output,
      'iMessage resource',
      resource,
      true
    )
  ])
}

export const runSmsDelete: CommandRunner<SmsDeleteParams> = async (context) => {
  const { photon } = context.extensions
  const projectId = await resolveProjectId(photon)
  const resourceId = context.values['resource-id']
  const confirmed = await confirmRiskyAction(context, {
    action: `delete SMS number ${resourceId} from project ${projectId}`,
    consequence: 'This releases the number and removes its charge.',
    scope: { project: projectId }
  })
  if (!confirmed) {
    cancelled(photon)
    return
  }
  const execution = await photon.output.withLoading(
    `Releasing SMS number ${resourceId}`,
    async () =>
      await photon.operations.execute(
        { kind: 'sms-number.delete', projectId, resourceId },
        undefined,
        async ({ updateRemoteOperationId }) =>
          await photon.projects.releaseSmsNumber(
            projectId,
            resourceId,
            updateRemoteOperationId
          )
      ),
    { nonInteractive: 'silent' }
  )
  photon.output.success(execution.result, [
    photon.output.style('green', `Deleted SMS number ${resourceId}.`)
  ])
}

export const runWhatsappBusinessAccountList: CommandRunner<
  WhatsappBusinessAccountListParams
> = async (context) => {
  const { photon } = context.extensions
  const projectId = await resolveProjectId(photon)
  const result = await photon.projects.listWhatsappBusinessAccounts(
    projectId,
    validatePagination(context.values.limit, context.values.pageToken)
  )
  const { accounts } = result
  presentList(photon.output, {
    document: { accounts },
    emptyMessage: 'No WhatsApp Business accounts found.',
    items: accounts,
    lines:
      accounts.length === 0
        ? []
        : [
            photon.output.style('bold', 'WhatsApp Business accounts'),
            ...table(
              photon.output,
              ['WABA ID', 'BUSINESS ID', 'SENDERS', 'SUBSCRIBED', 'CONNECTED'],
              accounts.map((account) => [
                account.wabaId,
                account.businessId,
                account.senderCount.toString(),
                account.subscribedAt ?? '—',
                { style: 'dim', text: account.connectedAt }
              ])
            )
          ],
    page: {
      command: context,
      scope: { project: projectId },
      token: result.nextPageToken
    }
  })
}

export const runWhatsappBusinessNumberAdd: CommandRunner<
  WhatsappBusinessNumberAddParams
> = async (context) => {
  const { photon } = context.extensions
  const projectId = await resolveProjectId(photon)
  await runWhatsappNumberAdd(photon, projectId, context, {
    ...(context.values.displayName === undefined
      ? {}
      : { displayName: context.values.displayName }),
    ...(context.values.idempotencyKey === undefined
      ? {}
      : { idempotencyKey: context.values.idempotencyKey }),
    newWaba: context.values.newWaba,
    noBrowser: context.values.noBrowser,
    ...(context.values.source === undefined
      ? {}
      : { source: context.values.source }),
    ...(context.values.voipResourceId === undefined
      ? {}
      : { voipResourceId: context.values.voipResourceId }),
    ...(context.values.wabaId === undefined
      ? {}
      : { wabaId: context.values.wabaId })
  })
}

export const runWhatsappBusinessNumberList: CommandRunner<
  WhatsappBusinessNumberListParams
> = async (context) => {
  const { photon } = context.extensions
  const projectId = await resolveProjectId(photon)
  const result = await photon.projects.listWhatsappBusinessNumbers(
    projectId,
    validatePagination(context.values.limit, context.values.pageToken)
  )
  const resources = result.senders.map(({ sender }) => sender)
  presentList(photon.output, {
    document: result.response,
    emptyMessage: 'No active WhatsApp Business numbers found.',
    items: resources,
    lines:
      resources.length === 0
        ? []
        : [
            photon.output.style('bold', 'WhatsApp Business numbers'),
            ...table(
              photon.output,
              [
                'PHONE NUMBER',
                'DISPLAY NAME',
                'NAME STATUS',
                'QUALITY',
                'PHOTON SOURCE',
                'RESOURCE ID'
              ],
              resources.map((resource) => [
                resource.detail.phoneNumber,
                resource.detail.displayName ?? '—',
                resource.detail.displayNameStatus ?? '—',
                resource.detail.qualityRating,
                resource.detail.voipResourceId ?? '—',
                { style: 'cyan', text: resource.resourceId }
              ])
            )
          ],
    page: {
      command: context,
      inDocument: true,
      scope: { project: projectId },
      token: result.response.nextPageToken
    }
  })
}

export const runWhatsappBusinessNumberView: CommandRunner<
  WhatsappBusinessNumberViewParams
> = async (context) => {
  const { photon } = context.extensions
  const { resource, sender } = await photon.projects.getWhatsappBusinessNumber(
    await resolveProjectId(photon),
    context.values['resource-id']
  )
  photon.output.success(
    resource,
    whatsappBusinessNumberDetails(photon.output, sender)
  )
}

export const runWhatsappBusinessNumberDelete: CommandRunner<
  WhatsappBusinessNumberDeleteParams
> = async (context) => {
  const { photon } = context.extensions
  const projectId = await resolveProjectId(photon)
  const resourceId = context.values['resource-id']
  const resource = await photon.projects.getActiveWhatsappBusinessNumber(
    projectId,
    resourceId
  )
  const { phoneNumber } = resource.detail

  const confirmed = await confirmRiskyAction(context, {
    action: `delete WhatsApp Business number ${phoneNumber} (${resourceId}) from project ${projectId}`,
    consequence:
      'Deleting this number immediately stops it from sending through Photon. If it is the final active sender on its WABA, Photon will also disconnect that WABA.',
    scope: { project: projectId },
    typed: phoneNumber
  })
  if (!confirmed) {
    cancelled(photon)
    return
  }

  const execution = await photon.output.withLoading(
    `Releasing WhatsApp Business number ${phoneNumber}`,
    async () =>
      await photon.operations.execute(
        {
          kind: 'whatsapp-business-number.delete',
          projectId,
          resourceId
        },
        undefined,
        async ({ updateRemoteOperationId }) =>
          await photon.projects.releaseWhatsappBusinessNumber(
            projectId,
            resourceId,
            updateRemoteOperationId,
            resource
          )
      ),
    { nonInteractive: 'silent' }
  )
  photon.output.success(
    execution.result,
    photon.output.style(
      'green',
      inert(`Deleted WhatsApp Business number ${phoneNumber} (${resourceId}).`)
    )
  )
}
