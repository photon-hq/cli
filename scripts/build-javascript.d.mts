import type { CliBuildConfig } from '../src/config-validation.mjs'

export function buildJavaScript(options: {
  config: CliBuildConfig
  outputDirectory: string
}): Promise<{ noticeCount: number; outputFile: string }>
