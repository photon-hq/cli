/**
 * Each test decides the terminal it runs in, passing any terminal variable it
 * needs in `env`. The shell or CI sets some of these otherwise (GitHub Actions
 * sets `CI=true`, and an AI agent running the tests sets its markers), so they
 * are cleared before every test file. Tests also clear the API version
 * override so each case can choose it explicitly.
 */
for (const name of [
  'AGENT',
  'AI_AGENT',
  'CI',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLINE_ACTIVE',
  'CODEX_CI',
  'CODEX_THREAD_ID',
  'COPILOT_AGENT',
  'CURSOR_AGENT',
  'GEMINI_CLI',
  'FORCE_COLOR',
  'NODE_DISABLE_COLORS',
  'NO_COLOR',
  'NO_COLORS',
  'OPENCODE',
  'PHOTON_API_VERSION',
  'PHOTON_AGENT',
  'PHOTON_NO_INPUT',
  'ROO_ACTIVE',
  'TERM'
]) {
  Reflect.deleteProperty(process.env, name)
}
