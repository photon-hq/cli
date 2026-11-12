import { accountCommand } from './account/definition.ts'
import { authCommand } from './auth/definition.ts'
import {
  linkCommand,
  loginCommand,
  logoutCommand,
  unlinkCommand,
  updateCommand,
  whoamiCommand
} from './index.ts'
import { operationCommand } from './operation/definition.ts'
import { orgCommand } from './org/definition.ts'
import { projectCommand } from './project/definition.ts'

// The runtime and documentation exporter share these command definitions.
export const photonCommands = {
  account: accountCommand,
  auth: authCommand,
  link: linkCommand,
  login: loginCommand,
  logout: logoutCommand,
  operation: operationCommand,
  org: orgCommand,
  project: projectCommand,
  unlink: unlinkCommand,
  update: updateCommand,
  whoami: whoamiCommand
}
