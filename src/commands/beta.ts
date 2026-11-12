export const BETA_LABEL = '(beta)'

export const beta = <Command extends { description?: string | undefined }>(
  command: Command
): Command & { beta: true } =>
  Object.assign(command, {
    beta: true as const,
    description: `${command.description ?? ''} ${BETA_LABEL}`.trim()
  })

export const isBeta = (command: object): boolean =>
  'beta' in command && command.beta === true
