import type { PublicCommand } from './commands.ts'
import { undeclaredCommands } from './commands.ts'
import {
  argvProblems,
  commandOf,
  dryRunExecutor,
  type Invocation,
  type Pass,
  runScenarios,
  type Scenario
} from './runner.ts'

export const PLAN_ORGANIZATION = '<organization>'

export const planPass = async (
  commands: readonly PublicCommand[],
  scenarios: readonly Scenario[],
  pass: Pass
): Promise<Invocation[]> =>
  await runScenarios({
    commands,
    executor: dryRunExecutor,
    namePrefix: 'photon-cli-test-plan',
    organizationId: PLAN_ORGANIZATION,
    pass,
    scenarios,
    serviceKey: '<key>'
  })

// What the static check refuses: a command with no declaration, a step that
// doesn't fit its command's options, a skipped command a scenario runs, and a
// command that declares run or expect-error but that no scenario reaches.
export const planProblems = async (
  commands: readonly PublicCommand[],
  scenarios: readonly Scenario[]
): Promise<string[]> => {
  const problems = undeclaredCommands(commands).map(
    (path) => `${path} declares no production test`
  )
  for (const pass of ['first', 'second'] as const) {
    for (const invocation of await planPass(commands, scenarios, pass)) {
      const command = commandOf(commands, invocation.argv)
      if (command === undefined || invocation.outcome === 'failed') {
        problems.push(
          `${invocation.scenario}: ${invocation.note ?? 'failed'}: ${invocation.argv.join(' ')}`
        )
        continue
      }
      problems.push(
        ...argvProblems(command, invocation.argv).map(
          (problem) => `${invocation.scenario}: ${problem}`
        )
      )
      if (command.productionTest?.kind === 'skip') {
        problems.push(
          `${invocation.scenario}: runs ${command.path}, which declares skip`
        )
      }
      if (
        command.productionTest?.kind === 'expect-error' &&
        invocation.outcome !== 'expected error'
      ) {
        problems.push(
          `${invocation.scenario}: runs ${command.path} without expecting its error`
        )
      }
    }
  }
  const reached = new Set(
    (await planPass(commands, scenarios, 'first')).map(({ command }) => command)
  )
  for (const { path, productionTest } of commands) {
    if (
      productionTest !== undefined &&
      productionTest.kind !== 'skip' &&
      !reached.has(path)
    ) {
      problems.push(
        `${path} declares ${productionTest.kind}, but no scenario runs it`
      )
    }
  }
  return problems
}
