import type { CommandRunner } from 'gunshi'
import { CLI_NAME } from '../../meta.ts'
import type { UpdateResult } from '../../update/service.ts'
import type { UpdateParams } from './definition.ts'

const summary = (result: UpdateResult): string[] => {
  if (result.status === 'up-to-date') {
    return [`${CLI_NAME} ${result.currentVersion} is the newest version.`]
  }
  if (result.status === 'update-available') {
    return [
      `${CLI_NAME} ${result.latestVersion} is available; this is ${result.currentVersion}.`,
      `To update, run: ${CLI_NAME} update`
    ]
  }
  const updated = `Updated ${CLI_NAME} from ${result.currentVersion} to ${result.latestVersion}`
  return [
    result.installer === 'standalone' || result.installer === null
      ? `${updated}.`
      : `${updated} with ${result.installer}.`
  ]
}

export const run: CommandRunner<UpdateParams> = async (context) => {
  const { output, update } = context.extensions.photon
  const result =
    context.values.check === true
      ? await output.withLoading(
          'Checking for a newer version…',
          async () => await update.check()
        )
      : await update.update(context.values.installer)
  output.success(result, summary(result))
}
