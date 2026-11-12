import type { PhotonCommandServices } from '../app/services.ts'

export const resolveProjectId = async (
  photon: PhotonCommandServices
): Promise<string> => (await photon.projectContext.resolve()).projectId
