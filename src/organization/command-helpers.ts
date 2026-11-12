import type { PhotonCommandServices } from '../app/services.ts'

export const resolveOrganizationId = async (
  photon: PhotonCommandServices
): Promise<string> =>
  (await photon.organizationContext.resolve()).organizationId
