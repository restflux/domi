const HIGH_NOISE_SEGMENTS = new Set([
  'node_modules', '.next', '.nuxt', '.git', 'dist', 'build',
  '.cache', '__pycache__', '.turbo', '.parcel-cache', '.svelte-kit',
  'target', 'coverage', '.venv', 'vendor',
])

export function normalizeWatchFilename(filename: string | Buffer | null | undefined): string | null {
  if (filename === null || filename === undefined) return null
  const value = Buffer.isBuffer(filename) ? filename.toString('utf8') : String(filename)
  const normalized = value.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '')
  return normalized || null
}

export function isHighNoisePath(normalizedPath: string): boolean {
  return normalizedPath
    .replace(/\\/g, '/')
    .split('/')
    .filter(Boolean)
    .some((segment) => HIGH_NOISE_SEGMENTS.has(segment))
}

export function shouldNotifyForWatchFilename(filename: string | Buffer | null | undefined): boolean {
  const normalized = normalizeWatchFilename(filename)
  return normalized !== null && !isHighNoisePath(normalized)
}
