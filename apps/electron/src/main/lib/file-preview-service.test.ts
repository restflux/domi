/**
 * file-preview-service 测试 — Office 内联预览行为
 *
 * 覆盖 XLSX 预览（exceljs 渲染：公式计算结果、合并单元格、多工作表）
 * 与 convertOfficeToHtml 的边界行为（不存在文件、未知扩展名）。
 */

import { test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ExcelJS from 'exceljs'
import { convertOfficeToHtml } from './file-preview-service'

let workDir: string

beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), 'domi-office-preview-'))
})

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true })
})

/** 生成一个含公式、合并单元格、富文本与多工作表的 XLSX 测试文件 */
async function writeSampleXlsx(fileName: string): Promise<string> {
  const workbook = new ExcelJS.Workbook()
  const sheet = workbook.addWorksheet('汇总')
  sheet.getCell('A1').value = '季度'
  sheet.getCell('B1').value = '金额'
  sheet.getCell('A2').value = 'Q1'
  sheet.getCell('B2').value = 100
  sheet.getCell('A3').value = 'Q2'
  sheet.getCell('B3').value = 250
  // 公式：预览应显示计算结果而非公式文本
  sheet.getCell('A4').value = '合计'
  sheet.getCell('B4').value = { formula: 'SUM(B2:B3)', result: 350 }
  // 合并单元格：标题占 A6:B6
  sheet.getCell('A6').value = '合并标题'
  sheet.mergeCells('A6:B6')

  const second = workbook.addWorksheet('明细')
  second.getCell('A1').value = { richText: [{ text: '富文' }, { text: '本单元' }] }
  second.getCell('B1').value = true

  const filePath = join(workDir, fileName)
  await workbook.xlsx.writeFile(filePath)
  return filePath
}

test('XLSX 预览显示公式的计算结果而不是公式文本', async () => {
  const filePath = await writeSampleXlsx('formula.xlsx')
  const result = await convertOfficeToHtml(filePath)
  expect(result).not.toBeNull()
  expect(result!.kind).toBe('spreadsheet')
  expect(result!.html).toContain('350')
  expect(result!.html).not.toContain('SUM(B2:B3)')
  expect(result!.text).toContain('350')
})

test('XLSX 预览用 rowspan/colspan 渲染合并单元格且不重复渲染覆盖区', async () => {
  const filePath = await writeSampleXlsx('merge.xlsx')
  const result = await convertOfficeToHtml(filePath)
  expect(result).not.toBeNull()
  expect(result!.html).toContain('colspan="2"')
  expect(result!.html).toContain('合并标题')
})

test('XLSX 预览包含每个工作表的分区与富文本/布尔值', async () => {
  const filePath = await writeSampleXlsx('sheets.xlsx')
  const result = await convertOfficeToHtml(filePath)
  expect(result).not.toBeNull()
  expect(result!.html).toContain('<h3>汇总</h3>')
  expect(result!.html).toContain('<h3>明细</h3>')
  expect(result!.html).toContain('富文本单元')
  expect(result!.html).toContain('TRUE')
  expect(result!.text).toContain('[汇总]')
  expect(result!.text).toContain('[明细]')
})

test('不存在的文件返回 null', async () => {
  const result = await convertOfficeToHtml(join(workDir, 'missing.xlsx'))
  expect(result).toBeNull()
})

test('未知扩展名返回 null 而不是抛错', async () => {
  const result = await convertOfficeToHtml(join(workDir, 'unknown.txt'))
  expect(result).toBeNull()
})
