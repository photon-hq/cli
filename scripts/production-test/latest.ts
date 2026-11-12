// The test plan covers 3.x's commands. Until 3.0.0 ships, npm's latest
// @photon-ai/cli is 1.0's (2.x), which has other commands, so a run against
// the latest published release is skipped instead of failing every day. The
// gate is the major version, because that is what separates the two lines: a
// 3.x prerelease has 3.x's commands, so it runs.
export const FIRST_TESTED_MAJOR = 3

const MAJOR = /^(\d+)\.\d+\.\d+/u

// Why a run against the latest published release is skipped, or undefined
// when it runs.
export const latestReleaseSkip = (latest: string): string | undefined => {
  const major = MAJOR.exec(latest)?.[1]
  if (major === undefined) {
    throw new Error(`npm's latest version "${latest}" isn't a version.`)
  }
  return Number(major) < FIRST_TESTED_MAJOR
    ? `npm's latest @photon-ai/cli is ${latest}, a 1.0 release. The production test covers ${FIRST_TESTED_MAJOR.toString()}.x and later, so no command ran.`
    : undefined
}
