// How the production test runs each public command: `runs` runs it,
// `expectError` expects the API to refuse it with that problem code and
// reason, and `skip` says why it can't run unattended. A public command
// without one fails the test.

export type ProductionTest =
  | { readonly kind: 'run' }
  | {
      readonly code: string
      readonly kind: 'expect-error'
      readonly reason: string
    }
  | { readonly kind: 'skip'; readonly reason: string }

export const runs: ProductionTest = { kind: 'run' }

export const expectError = (code: string, reason: string): ProductionTest => ({
  code,
  kind: 'expect-error',
  reason
})

export const skip = (reason: string): ProductionTest => ({
  kind: 'skip',
  reason
})

export const tested = <Command extends object>(
  productionTest: ProductionTest,
  command: Command
): Command & { productionTest: ProductionTest } =>
  Object.assign(command, { productionTest })

export const productionTestOf = (
  command: object
): ProductionTest | undefined =>
  'productionTest' in command
    ? (command.productionTest as ProductionTest)
    : undefined

// Commands a Gunshi plugin adds have no definition here, so they are declared
// by name.
export const pluginCommandTests: Readonly<Record<string, ProductionTest>> = {
  complete: runs
}
