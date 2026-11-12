import { defineWithTypes } from 'gunshi'
import { idArgument } from '../../core/photon-id.ts'
import type { PhotonCommandParams } from '../types.ts'

// The global --project selects a project for one command; here it names the
// project to save, so it is required and PHOTON_PROJECT_ID doesn't stand in.
const linkArgs = {
  project: {
    description: 'Project ID to save for this folder',
    parse: idArgument('project', 'Project ID'),
    required: true,
    type: 'string'
  }
} as const

export type LinkParams = PhotonCommandParams<typeof linkArgs>

export const linkDefinition = defineWithTypes<LinkParams>()({
  args: linkArgs,
  description: 'Save a project for this folder in .photon/project.json',
  name: 'link'
})
