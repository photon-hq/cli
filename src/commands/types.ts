import type { Args } from 'gunshi'
import type { PhotonExtensions } from '../app/services.ts'

export interface PhotonCommandParams<
  CommandArgs extends Args = Record<never, never>
> {
  args: CommandArgs
  extensions: PhotonExtensions
}
