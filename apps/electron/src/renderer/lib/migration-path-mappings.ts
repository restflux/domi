export interface MigrationPathCheck {
  path: string
  exists: boolean
}

export function initialMigrationPathMappings(paths: MigrationPathCheck[]): Record<string, string | null> {
  const mappings: Record<string, string | null> = {}
  for (const path of paths) {
    mappings[path.path] = null
  }
  return mappings
}
