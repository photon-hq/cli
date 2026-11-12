import type { CommandRunner } from 'gunshi'
import { lazyWithTypes } from 'gunshi'
import type { LinkParams } from './link/definition.ts'
import { linkDefinition } from './link/definition.ts'
import type { LoginParams } from './login/definition.ts'
import { loginDefinition } from './login/definition.ts'
import type { LogoutParams } from './logout/definition.ts'
import { logoutDefinition } from './logout/definition.ts'
import { runs, tested } from './production-test.ts'
import type { UnlinkParams } from './unlink/definition.ts'
import { unlinkDefinition } from './unlink/definition.ts'
import type { UpdateParams } from './update/definition.ts'
import { updateDefinition } from './update/definition.ts'
import type { WhoamiParams } from './whoami/definition.ts'
import { whoamiDefinition } from './whoami/definition.ts'

const loadLink = async (): Promise<CommandRunner<LinkParams>> => {
  const { run } = await import('./link/run.ts')
  return run
}

const loadLogin = async (): Promise<CommandRunner<LoginParams>> => {
  const { run } = await import('./login/run.ts')
  return run
}

const loadLogout = async (): Promise<CommandRunner<LogoutParams>> => {
  const { run } = await import('./logout/run.ts')
  return run
}

const loadUnlink = async (): Promise<CommandRunner<UnlinkParams>> => {
  const { run } = await import('./unlink/run.ts')
  return run
}

const loadUpdate = async (): Promise<CommandRunner<UpdateParams>> => {
  const { run } = await import('./update/run.ts')
  return run
}

const loadWhoami = async (): Promise<CommandRunner<WhoamiParams>> => {
  const { run } = await import('./whoami/run.ts')
  return run
}

export const linkCommand = tested(
  runs,
  lazyWithTypes<LinkParams>()(loadLink, linkDefinition)
)
export const loginCommand = tested(
  runs,
  lazyWithTypes<LoginParams>()(loadLogin, loginDefinition)
)
export const logoutCommand = tested(
  runs,
  lazyWithTypes<LogoutParams>()(loadLogout, logoutDefinition)
)
export const unlinkCommand = tested(
  runs,
  lazyWithTypes<UnlinkParams>()(loadUnlink, unlinkDefinition)
)
export const updateCommand = tested(
  runs,
  lazyWithTypes<UpdateParams>()(loadUpdate, updateDefinition)
)
export const whoamiCommand = tested(
  runs,
  lazyWithTypes<WhoamiParams>()(loadWhoami, whoamiDefinition)
)
