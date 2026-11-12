/**
 * Each test decides the terminal it runs in, passing any terminal variable it
 * needs in `env`. The shell or CI sets some of these otherwise (GitHub Actions
 * sets `CI=true`), so they are cleared before every test file.
 */
for (const name of [
  'CI',
  'FORCE_COLOR',
  'NODE_DISABLE_COLORS',
  'NO_COLOR',
  'NO_COLORS',
  'PHOTON_NO_INPUT',
  'TERM'
]) {
  Reflect.deleteProperty(process.env, name)
}
