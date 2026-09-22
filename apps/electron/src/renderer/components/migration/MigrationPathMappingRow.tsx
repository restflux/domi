import type { MigrationPathCheck } from '../../lib/migration-path-mappings'

interface MigrationPathMappingRowProps {
  entry: MigrationPathCheck
  mapping: string | null | undefined
  disabled: boolean
  onChange: (path: string, value: string | null) => void
}

export function MigrationPathMappingRow({ entry, mapping, disabled, onChange }: MigrationPathMappingRowProps): React.ReactElement {
  const value = mapping ?? ''
  return (
    <div className="px-4 py-3 space-y-2">
      <p className="text-xs font-mono text-muted-foreground break-all">原路径：{entry.path}</p>
      <label className="block space-y-1">
        <span className="text-xs text-foreground">当前电脑上的路径</span>
        <input
          value={value}
          disabled={disabled}
          onChange={(event) => onChange(entry.path, event.target.value || null)}
          placeholder="填写完整路径；留空则不关联此目录或文件"
          className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-xs font-mono disabled:opacity-50"
        />
      </label>
      <div className="flex flex-wrap items-center gap-3 text-xs">
        <button type="button" disabled={disabled} onClick={() => onChange(entry.path, null)} className="text-muted-foreground hover:underline disabled:opacity-50">
          不关联
        </button>
      </div>
      <p className="text-xs text-muted-foreground">{value ? '确认导入时会检查路径是否存在。' : '只移除此路径关联，不删除电脑上的文件。'}</p>
    </div>
  )
}
