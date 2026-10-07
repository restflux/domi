import { join } from 'node:path'
import { getConfigDir } from '../config-paths'
import { WorktreeLocalFilesService } from './service'

let service: WorktreeLocalFilesService | undefined

export function getWorktreeLocalFilesService(): WorktreeLocalFilesService {
  service ??= new WorktreeLocalFilesService({ storagePath: join(getConfigDir(), 'worktree-local-files.json') })
  return service
}
