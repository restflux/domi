import { describe, expect, test } from 'bun:test'
import {
  formatModelTokenInput,
  parseModelTokenInput,
  prepareModelTokenInputForEdit,
} from './model-adaptation-input'

describe('模型适配 token 数值输入', () => {
  test('keeps continuous typing raw and formats only when editing finishes', () => {
    let editingValue = ''
    for (const digit of '1000000') editingValue += digit

    expect(editingValue).toBe('1000000')
    expect(formatModelTokenInput(editingValue)).toBe('1,000,000')
    expect(prepareModelTokenInputForEdit('1,000,000')).toBe('1000000')
  })

  test('formats valid digits and separators while preserving invalid text for inline validation', () => {
    expect(formatModelTokenInput('131,072')).toBe('131,072')
    expect(formatModelTokenInput('1,000000')).toBe('1,000,000')
    expect(formatModelTokenInput('1000,000')).toBe('1,000,000')
    expect(formatModelTokenInput(' 00131072 ')).toBe('131,072')
    expect(formatModelTokenInput('-1')).toBe('-1')
    expect(formatModelTokenInput('1.5')).toBe('1.5')
    expect(formatModelTokenInput('abc')).toBe('abc')
    expect(formatModelTokenInput('')).toBe('')
  })

  test('parses only safe positive integers', () => {
    expect(parseModelTokenInput('1,000,000')).toBe(1_000_000)
    expect(parseModelTokenInput('131072')).toBe(131_072)
    expect(parseModelTokenInput('')).toBeUndefined()
    expect(parseModelTokenInput('0')).toBeUndefined()
    expect(parseModelTokenInput('-1')).toBeUndefined()
    expect(parseModelTokenInput('1.5')).toBeUndefined()
    expect(parseModelTokenInput('1,2')).toBe(12)
    expect(parseModelTokenInput('abc')).toBeUndefined()
    expect(parseModelTokenInput('9,007,199,254,740,992')).toBeUndefined()
  })
})
