/**
 * Each test decides the terminal it runs in, passing any terminal variable it
 * needs in `env`. The shell or CI sets some of these otherwise (GitHub Actions
 * sets `CI=true`, and an AI agent running the tests sets its markers), so they
 * are cleared before every test file.
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
  'FORCE_COLOR',
  'GEMINI_CLI',
  'NODE_DISABLE_COLORS',
  'NO_COLOR',
  'NO_COLORS',
  'OPENCODE',
  'PHOTON_AGENT',
  'PHOTON_NO_INPUT',
  'ROO_ACTIVE',
  'TERM'
]) {
  Reflect.deleteProperty(process.env, name)
}
