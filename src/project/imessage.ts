export const selectImessageHealthStatus = (
  detail: Record<string, unknown>
): string | undefined => {
  const health = detail.imessageHealth
  if (
    typeof health !== 'object' ||
    health === null ||
    !('overallStatus' in health)
  ) {
    return
  }
  const { overallStatus } = health
  return typeof overallStatus === 'string' && overallStatus.trim().length > 0
    ? overallStatus
    : undefined
}
