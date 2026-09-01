import { describe, expect, test } from 'bun:test'
import type { GeneratedImageItem, SessionProjectArtifact } from '@domi/shared'
import {
  filterVisibleSessionProjectArtifacts,
  isVisibleSessionDeliverable,
  SESSION_ARTIFACTS_DEFAULT_EXPANDED,
  toggleSessionArtifactsExpanded,
} from './session-artifact-visibility.ts'

function artifact(relativePath: string): SessionProjectArtifact {
  return {
    relativePath,
    name: relativePath.split('/').pop() ?? relativePath,
    size: 1,
    mtime: 1,
  }
}

function generated(filename: string, source: GeneratedImageItem['source'] = 'agent-workspace'): GeneratedImageItem {
  return {
    localPath: `/generated/${filename}`,
    filename,
    mediaType: 'image/png',
    size: 1,
    mtime: 1,
    source,
  }
}

describe('会话产物可见性', () => {
  test('默认折叠，并可在点击标题后切换展开状态', () => {
    expect(SESSION_ARTIFACTS_DEFAULT_EXPANDED).toBeFalse()
    expect(toggleSessionArtifactsExpanded(false)).toBeTrue()
    expect(toggleSessionArtifactsExpanded(true)).toBeFalse()
  })

  test('只接受文档、网页、表格与图片等可直接交付格式', () => {
    for (const path of [
      'docs/report.md',
      'docs/prototype.HTML',
      'exports/result.pdf',
      'exports/data.xlsx',
      'exports/list.csv',
      'images/preview.svg',
      'notes/readme.txt',
    ]) {
      expect(isVisibleSessionDeliverable(path)).toBeTrue()
    }
  })

  test('隐藏源码、测试、样式、配置和无扩展名文件', () => {
    for (const path of [
      'src/index.ts',
      'src/view.tsx',
      'src/component.vue',
      'src/styles.css',
      'src/index.test.js',
      'package.json',
      'tsconfig.json',
      'Dockerfile',
    ]) {
      expect(isVisibleSessionDeliverable(path)).toBeFalse()
    }
  })

  test('过滤源码，并将工作区 generated-images 中已进入画廊的图片去重', () => {
    const result = filterVisibleSessionProjectArtifacts([
      artifact('src/index.ts'),
      artifact('docs/report.md'),
      artifact('docs/prototype.html'),
      artifact('generated-images/render.png'),
      artifact('exports/cover.jpg'),
    ], [generated('render.png')])

    expect(result.map((item) => item.relativePath)).toEqual([
      'docs/report.md',
      'docs/prototype.html',
      'exports/cover.jpg',
    ])
  })
})
