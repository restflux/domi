import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { filterSessionLocationOptions, SessionLocationPicker } from './SessionLocationPicker.tsx'

const projects = [
  { value: 'first-id', label: 'Domi' },
  { value: 'second-id', label: '文档项目' },
]

describe('new session searchable location picker', () => {
  test('Given multiple projects or branches When searching Then match labels without case sensitivity and preserve source order', () => {
    expect(filterSessionLocationOptions(projects, 'do')).toEqual([{ value: 'first-id', label: 'Domi' }])
    expect(filterSessionLocationOptions(projects, '  文档  ')).toEqual([{ value: 'second-id', label: '文档项目' }])
    expect(filterSessionLocationOptions(projects, 'not-found')).toEqual([])
    expect(filterSessionLocationOptions(projects, '')).toEqual(projects)
  })

  test('Given project and branch controls When rendered Then both are accessible, including loading state', () => {
    const project = renderToStaticMarkup(
      <SessionLocationPicker kind="project" currentLabel="Domi" selectedValue="first-id" options={projects} onSelect={() => undefined} onOpenLocalProject={() => undefined} />,
    )
    const branch = renderToStaticMarkup(
      <SessionLocationPicker kind="branch" currentLabel="main" selectedValue="main" options={[]} loading onSelect={() => undefined} />,
    )
    expect(project).toContain('aria-label="选择项目"')
    expect(branch).toContain('aria-label="选择分支"')
    expect(branch).toContain('main')
  })

  test('Given a picker When its menu is configured Then it opens upward and uses keyboard-navigable Command controls', () => {
    const source = readFileSync(new URL('./SessionLocationPicker.tsx', import.meta.url), 'utf8')
    expect(source).toContain('side="top"')
    expect(source).toContain('avoidCollisions={false}')
    expect(source).toContain('<CommandInput')
    expect(source).toContain('<CommandItem')
    expect(source).toContain('从本地打开项目…')
    expect(source).toContain('没有匹配的项目')
  })
})
