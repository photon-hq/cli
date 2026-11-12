import {
  type CommitAgentProfileAvatarOutput,
  CommitAgentProfileAvatarOutputSchema,
  type CountProjectsOutput,
  CountProjectsOutputSchema,
  type CreateAgentProfileAvatarUploadOutput,
  type CreateProjectApiKeyOutput,
  CreateProjectApiKeyOutputSchema,
  type CreateProjectOutput,
  CreateProjectOutputSchema,
  type DeleteProjectOutput,
  DeleteProjectOutputSchema,
  type GetAgentProfileOutput,
  GetAgentProfileOutputSchema,
  type GetProjectOutput,
  GetProjectOutputSchema,
  type ListProjectApiKeysOutput,
  ListProjectApiKeysOutputSchema,
  type ListProjectsOutput,
  ListProjectsOutputSchema,
  type ResetAgentProfileAvatarOutput,
  ResetAgentProfileAvatarOutputSchema,
  type RevokeProjectApiKeyOutput,
  RevokeProjectApiKeyOutputSchema,
  type UpdateAgentProfileOutput,
  UpdateAgentProfileOutputSchema,
  type UpdateProjectOutput,
  UpdateProjectOutputSchema
} from '@photon-ai/api-public'
import { z } from 'zod'
import { ID_FORMATS } from '../../src/core/photon-id.ts'
import { photonKey } from '../key-support.ts'
import {
  API,
  CWD,
  type Declared,
  type GoldenCase,
  printsResponse,
  STORAGE_ORIGIN,
  withNewField
} from './support.ts'

const ORGANIZATION_ID = 'pho_org_00000000000000000000000001'
const ORGANIZATION = ['--org', ORGANIZATION_ID]
const PROJECT_ID = 'pho_prj_00000000000000000000000001'
const PROJECT = ['--project', PROJECT_ID]
const PROJECTS = `/v1/organizations/${ORGANIZATION_ID}/projects`
const PROJECT_PATH = `/v1/projects/${PROJECT_ID}`
const AGENT_PROFILE = `${PROJECT_PATH}/agent-profile`
const API_KEYS = `${PROJECT_PATH}/api-keys`
const API_KEY_ID = photonKey('sk', '01h455vb4pex5vsknk084sn02q')
const SECRET = photonKey('sk', '01h455vb4pex5vsknk084sn02q_golden-secret')
const UPLOAD_ID = 'pho_upl_01h455vb4pex5vsknk084sn02q'
const LINK_FILE = `${CWD}/.photon/project.json`
const createdAt = '2026-07-31T18:00:00.000Z'
const updatedAt = '2026-08-01T18:00:00.000Z'

const agentProfile = {
  avatarUrl: 'https://images.example.test/agents/ada.png',
  firstName: 'Ada',
  lastName: 'Lovelace'
} satisfies Declared<GetAgentProfileOutput>

const project = {
  agentProfile: withNewField(agentProfile),
  billingInitialization: 'completed',
  createdAt,
  createdByAccountId: 'pho_acc_00000000000000000000000002',
  createdByActorId: 'pho_acc_00000000000000000000000002',
  createdByActorKind: 'account',
  deletedAt: null,
  name: 'Acme Support',
  organizationId: ORGANIZATION_ID,
  projectId: PROJECT_ID,
  slug: 'acme-support',
  updatedAt
} satisfies Declared<GetProjectOutput>

const viewedProject = withNewField(project)

const projects = {
  nextPageToken: 'projects_cursor_2',
  projects: [
    withNewField(project),
    {
      ...project,
      agentProfile,
      name: 'Acme Sales',
      projectId: 'pho_prj_00000000000000000000000002',
      slug: 'acme-sales'
    }
  ]
} satisfies Declared<ListProjectsOutput>

const createdProject = withNewField({
  ...project,
  createdAt: updatedAt
}) satisfies Declared<CreateProjectOutput>

const updatedProject = withNewField({
  ...project,
  name: 'Acme Helpdesk'
}) satisfies Declared<UpdateProjectOutput>

const deletedProject = withNewField({
  ...project,
  deletedAt: updatedAt
}) satisfies Declared<DeleteProjectOutput>

const editedProfile = withNewField({
  ...agentProfile,
  firstName: 'Grace',
  lastName: 'Hopper'
}) satisfies Declared<UpdateAgentProfileOutput>

const resetProfile = withNewField({
  ...agentProfile,
  avatarUrl: 'https://images.example.test/agents/default.png'
}) satisfies Declared<ResetAgentProfileAvatarOutput>

const uploadedProfile = withNewField({
  ...agentProfile,
  avatarUrl: 'https://images.example.test/agents/ada-2.png'
}) satisfies Declared<CommitAgentProfileAvatarOutput>

const avatarUpload = withNewField({
  expiresAt: updatedAt,
  formFields: { key: `avatars/${UPLOAD_ID}`, policy: 'golden-policy' },
  uploadId: UPLOAD_ID,
  uploadUrl: `${STORAGE_ORIGIN}/avatar-uploads`
}) satisfies Declared<CreateAgentProfileAvatarUploadOutput>

const apiKey = {
  apiKeyId: API_KEY_ID,
  createdAt,
  createdByAccountId: 'pho_acc_00000000000000000000000002',
  expiresAt: null,
  name: 'Deploy key',
  permissions: ['project:read'],
  permissionsUpdatedAt: null,
  projectId: PROJECT_ID,
  revokedAt: null
} satisfies Declared<RevokeProjectApiKeyOutput['apiKey']>

const apiKeys = {
  apiKeys: [
    withNewField(apiKey),
    {
      ...apiKey,
      apiKeyId: photonKey('sk', '01h455vb4pex5vsknk084sn02r'),
      expiresAt: '2027-08-01T18:00:00.000Z',
      name: 'Read-only key'
    }
  ]
} satisfies Declared<ListProjectApiKeysOutput>

const createdApiKey = {
  apiKey: withNewField(apiKey),
  secret: SECRET
} satisfies Declared<CreateProjectApiKeyOutput>

const revokedApiKey = {
  apiKey: withNewField({ ...apiKey, revokedAt: updatedAt })
} satisfies Declared<RevokeProjectApiKeyOutput>

// The first bytes of a PNG file, which are what the CLI checks before it
// uploads one.
const PNG = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d
])

// What project current prints: the project the API returns, and where the
// CLI found it.
const CurrentProjectSchema = z.strictObject({
  path: z.string().optional(),
  project: GetProjectOutputSchema,
  source: z.enum(['environment', 'flag', 'folder'])
})

// What unlink and project clear print: whether a folder file was removed and
// which, and the project something else still selects.
const UnlinkedSchema = z.strictObject({
  active: z
    .union([
      z.strictObject({
        path: z.string(),
        projectId: z.string(),
        source: z.literal('folder')
      }),
      z.strictObject({
        projectId: z.string(),
        source: z.literal('environment')
      })
    ])
    .optional(),
  cleared: z.boolean(),
  path: z.string().optional()
})

// The folder file link saves, for the API the CLI calls.
const FOLDER_FILE = `${JSON.stringify(
  {
    apiOrigin: API,
    organizationId: ORGANIZATION_ID,
    projectId: PROJECT_ID,
    schemaVersion: 1
  },
  null,
  2
)}\n`

// What project create --link prints, as link does: the project the API
// returns, and the folder file the CLI saved it in. The CLI saves only a
// canonical project and organization ID; with another, it warns and prints
// the project alone.
const LinkedProjectSchema = z.strictObject({
  gitignore: z.enum(['added', 'failed', 'listed']),
  path: z.string(),
  project: CreateProjectOutputSchema.extend({
    organizationId: z.string().regex(ID_FORMATS.organization.pattern),
    projectId: z.string().regex(ID_FORMATS.project.pattern)
  }),
  source: z.literal('folder')
})

/** Golden tests for the project, agent profile and API key commands. */
export const PROJECT_GOLDENS: readonly GoldenCase[] = [
  printsResponse({
    args: [...ORGANIZATION, '--limit', '2'],
    command: 'project list',
    route: {
      body: withNewField(projects),
      method: 'GET',
      path: `${PROJECTS}?pageSize=2`
    },
    schema: ListProjectsOutputSchema,
    shows: 'Acme Sales'
  }),
  printsResponse({
    args: ORGANIZATION,
    command: 'project count',
    route: {
      body: withNewField({ count: 2 }) satisfies Declared<CountProjectsOutput>,
      method: 'GET',
      path: `${PROJECTS}/count`
    },
    schema: CountProjectsOutputSchema,
    shows: '2 projects',
    showsNoApiText: true
  }),
  printsResponse({
    args: [
      '--name',
      project.name,
      '--slug',
      project.slug,
      ...ORGANIZATION,
      '--idempotency-key',
      'golden-project-create'
    ],
    command: 'project create',
    route: {
      body: createdProject,
      method: 'POST',
      path: PROJECTS,
      requestBody: { name: project.name, slug: project.slug },
      status: 201
    },
    schema: CreateProjectOutputSchema,
    shows: `Created project ${project.name}.`
  }),
  {
    args: [
      '--name',
      project.name,
      '--slug',
      project.slug,
      ...ORGANIZATION,
      '--link',
      '--idempotency-key',
      'golden-project-create-link'
    ],
    command: 'project create',
    document: {
      gitignore: 'added',
      path: LINK_FILE,
      project: createdProject,
      source: 'folder'
    },
    embeds: 'project',
    routes: [
      {
        body: createdProject,
        method: 'POST',
        path: PROJECTS,
        requestBody: { name: project.name, slug: project.slug },
        status: 201
      }
    ],
    schema: LinkedProjectSchema,
    shows: `Saved to ${LINK_FILE}.`
  },
  printsResponse({
    args: PROJECT,
    command: 'project view',
    route: { body: viewedProject, method: 'GET', path: PROJECT_PATH },
    schema: GetProjectOutputSchema,
    shows: project.name
  }),
  printsResponse({
    args: [
      '--name',
      updatedProject.name,
      ...PROJECT,
      '--idempotency-key',
      'golden-project-edit'
    ],
    command: 'project edit',
    route: {
      body: updatedProject,
      method: 'PATCH',
      path: PROJECT_PATH,
      requestBody: { name: updatedProject.name }
    },
    schema: UpdateProjectOutputSchema,
    shows: `Updated project ${updatedProject.name}.`
  }),
  {
    args: [PROJECT_ID, '--yes'],
    command: 'project delete',
    document: deletedProject,
    routes: [
      { body: viewedProject, method: 'GET', path: PROJECT_PATH },
      { body: deletedProject, method: 'DELETE', path: PROJECT_PATH }
    ],
    schema: DeleteProjectOutputSchema,
    shows: `Deleted project ${project.name}.`
  },
  {
    args: PROJECT,
    command: 'project current',
    document: { project: viewedProject, source: 'flag' },
    embeds: 'project',
    routes: [{ body: viewedProject, method: 'GET', path: PROJECT_PATH }],
    schema: CurrentProjectSchema,
    shows: project.name
  },
  {
    args: PROJECT,
    command: 'link',
    document: {
      gitignore: 'added',
      path: LINK_FILE,
      project: viewedProject,
      source: 'folder'
    },
    embeds: 'project',
    routes: [{ body: viewedProject, method: 'GET', path: PROJECT_PATH }],
    schema: LinkedProjectSchema,
    shows: `Linked this folder to project ${project.name} (${PROJECT_ID}).`
  },
  {
    args: [PROJECT_ID],
    command: 'project use',
    document: {
      gitignore: 'added',
      path: LINK_FILE,
      project: viewedProject,
      source: 'folder'
    },
    embeds: 'project',
    routes: [{ body: viewedProject, method: 'GET', path: PROJECT_PATH }],
    schema: LinkedProjectSchema,
    shows: `Linked this folder to project ${project.name} (${PROJECT_ID}).`
  },
  {
    args: [],
    command: 'unlink',
    document: { cleared: true, path: LINK_FILE },
    files: { '.photon/project.json': FOLDER_FILE },
    routes: [],
    schema: UnlinkedSchema,
    shows: `Removed ${LINK_FILE}.`,
    showsNoApiText: true
  },
  {
    args: [],
    command: 'project clear',
    document: { cleared: true, path: LINK_FILE },
    files: { '.photon/project.json': FOLDER_FILE },
    routes: [],
    schema: UnlinkedSchema,
    shows: `Removed ${LINK_FILE}.`,
    showsNoApiText: true
  },
  printsResponse({
    args: PROJECT,
    command: 'project agent-profile view',
    route: {
      body: withNewField(agentProfile),
      method: 'GET',
      path: AGENT_PROFILE
    },
    schema: GetAgentProfileOutputSchema,
    shows: agentProfile.lastName
  }),
  printsResponse({
    args: [
      '--first-name',
      editedProfile.firstName,
      '--last-name',
      editedProfile.lastName,
      ...PROJECT,
      '--idempotency-key',
      'golden-agent-profile-edit'
    ],
    command: 'project agent-profile edit',
    route: {
      body: editedProfile,
      method: 'PATCH',
      path: AGENT_PROFILE,
      requestBody: {
        firstName: editedProfile.firstName,
        lastName: editedProfile.lastName
      }
    },
    schema: UpdateAgentProfileOutputSchema,
    shows: editedProfile.lastName
  }),
  printsResponse({
    args: [
      ...PROJECT,
      '--yes',
      '--idempotency-key',
      'golden-agent-avatar-reset'
    ],
    command: 'project agent-profile avatar reset',
    route: {
      body: resetProfile,
      method: 'DELETE',
      path: `${AGENT_PROFILE}/avatar`
    },
    schema: ResetAgentProfileAvatarOutputSchema,
    shows: 'Reset the agent avatar.',
    showsNoApiText: true
  }),
  {
    args: [
      `${CWD}/avatar.png`,
      ...PROJECT,
      '--idempotency-key',
      'golden-agent-avatar-upload'
    ],
    command: 'project agent-profile avatar upload',
    document: uploadedProfile,
    files: { 'avatar.png': PNG },
    routes: [
      {
        body: avatarUpload,
        method: 'POST',
        path: `${AGENT_PROFILE}/avatar/uploads`,
        requestBody: { contentType: 'image/png' },
        status: 201
      },
      {
        method: 'POST',
        path: '/avatar-uploads',
        requestBody: { ...avatarUpload.formFields, file: 'avatar.png' },
        status: 204
      },
      {
        body: uploadedProfile,
        method: 'PUT',
        path: `${AGENT_PROFILE}/avatar`,
        requestBody: { uploadId: UPLOAD_ID }
      }
    ],
    schema: CommitAgentProfileAvatarOutputSchema,
    shows: uploadedProfile.avatarUrl
  },
  printsResponse({
    args: [
      '--permission',
      'project:read',
      '--name',
      apiKey.name,
      '--no-expiry',
      ...PROJECT,
      '--idempotency-key',
      'golden-api-key-create'
    ],
    checkedSecret: 'secret',
    command: 'project api-key create',
    route: {
      body: withNewField(createdApiKey),
      method: 'POST',
      path: API_KEYS,
      requestBody: { name: apiKey.name, permissions: apiKey.permissions },
      status: 201
    },
    schema: CreateProjectApiKeyOutputSchema,
    shows: SECRET
  }),
  printsResponse({
    args: PROJECT,
    command: 'project api-key list',
    route: { body: withNewField(apiKeys), method: 'GET', path: API_KEYS },
    schema: ListProjectApiKeysOutputSchema,
    shows: 'Read-only key'
  }),
  printsResponse({
    args: [
      API_KEY_ID,
      ...PROJECT,
      '--yes',
      '--idempotency-key',
      'golden-api-key-revoke'
    ],
    command: 'project api-key revoke',
    route: {
      body: withNewField(revokedApiKey),
      method: 'DELETE',
      path: `${API_KEYS}/${API_KEY_ID}`
    },
    schema: RevokeProjectApiKeyOutputSchema,
    shows: `Revoked API key ${API_KEY_ID}.`
  })
]
