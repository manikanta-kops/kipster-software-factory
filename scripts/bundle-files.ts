/** Repository paths the release app ships; the runtime reads nothing else from the checkout. */
export const APP_FILES = [
  'src',
  'workflows',
  'docs/kit.md',
  'dist/web',
  'package.json',
  'package-lock.json',
  'LICENSE',
  'README.md',
] as const

/** Paths bundle.ts builds into the app instead of copying. */
export const BUILT_APP_FILES = ['native'] as const
