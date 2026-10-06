const KEY = 'credential.https://github.com.helper'
const HELPER = '!gh auth git-credential'

/**
 * Lets the factory's git commands sign in to GitHub over HTTPS with the user's
 * gh login. It is added through git's environment config, after any helper the
 * user already has, so their git configuration is never changed or overridden.
 */
export function signInToGitHubWithCli(env: NodeJS.ProcessEnv = process.env) {
  const count = Number(env['GIT_CONFIG_COUNT'] ?? 0)
  if (!Number.isSafeInteger(count) || count < 0) return
  for (let i = 0; i < count; i++)
    if (
      env[`GIT_CONFIG_KEY_${i}`] === KEY &&
      env[`GIT_CONFIG_VALUE_${i}`] === HELPER
    )
      return
  env[`GIT_CONFIG_KEY_${count}`] = KEY
  env[`GIT_CONFIG_VALUE_${count}`] = HELPER
  env['GIT_CONFIG_COUNT'] = String(count + 1)
}
