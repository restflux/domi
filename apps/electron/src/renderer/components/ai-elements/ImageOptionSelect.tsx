import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'

interface ImageOptionSelectProps {
  label: string
  value: string
  options: ReadonlyArray<{ value: string; label: string; description?: string }>
  onChange: (value: string) => void
  placeholder?: string
}

/** 生图配置共用的紧凑选择项；辅助描述只出现在菜单里。 */
export function ImageOptionSelect({ label, value, options, onChange, placeholder }: ImageOptionSelectProps): React.ReactElement {
  return (
    <div className="min-w-0 space-y-1.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger aria-label={label} className="h-9 w-full min-w-0 bg-background/60 text-xs [&>span]:truncate">
          <SelectValue placeholder={placeholder ?? '请选择'}>{options.find((option) => option.value === value)?.label}</SelectValue>
        </SelectTrigger>
        <SelectContent className="max-w-[min(24rem,calc(100vw-2rem))]">
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value} textValue={option.label}>
              <div className="min-w-0 text-xs">
                <span className="block truncate">{option.label}</span>
                {option.description && <span className="block truncate text-[11px] text-muted-foreground">{option.description}</span>}
              </div>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}
