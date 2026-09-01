import { Buffer } from 'node:buffer'

export const BROWSER_SNAPSHOT_MAX_NODES = 500
export const BROWSER_SNAPSHOT_MAX_TEXT_BYTES = 64 * 1024

export interface BrowserAxValue {
  value?: unknown
}

export interface BrowserAxNameSource {
  attribute?: string
  superseded?: boolean
  value?: BrowserAxValue
}

export interface BrowserAxName extends BrowserAxValue {
  sources?: BrowserAxNameSource[]
}

export interface BrowserAxProperty {
  name: string
  value?: BrowserAxValue
}

export interface BrowserDomNode {
  backendNodeId?: number
  nodeName?: string
  attributes?: string[]
}

export interface BrowserAxNode {
  nodeId?: string
  parentId?: string
  childIds?: string[]
  ignored?: boolean
  role?: BrowserAxValue
  name?: BrowserAxName
  description?: BrowserAxValue
  value?: BrowserAxValue
  properties?: BrowserAxProperty[]
  backendDOMNodeId?: number
  dom?: BrowserDomNode
}

export interface BrowserSemanticNode {
  ref: string
  role: string
  name?: string
  description?: string
  placeholder?: string
  disabled?: boolean
  checked?: boolean | 'mixed'
  selected?: boolean
  expanded?: boolean
  required?: boolean
  readonly?: boolean
  multiline?: boolean
  password?: boolean
  empty?: boolean
  depth: number
}

export interface BrowserSemanticSnapshotBody {
  rootBackendDOMNodeId?: number
  nodes: BrowserSemanticNode[]
  truncated: boolean
  textBytes: number
}

export interface BuildBrowserSemanticSnapshotInput {
  nodes: BrowserAxNode[]
  allocateRef: (backendDOMNodeId: number) => string
  maxNodes?: number
  maxTextBytes?: number
}

const INTERACTIVE_ROLES = new Set([
  'button',
  'checkbox',
  'combobox',
  'link',
  'listbox',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'option',
  'radio',
  'scrollbar',
  'searchbox',
  'slider',
  'spinbutton',
  'switch',
  'tab',
  'textbox',
  'treeitem',
])

const CONTENT_ROLES = new Set([
  'article',
  'blockquote',
  'caption',
  'cell',
  'code',
  'columnheader',
  'contentinfo',
  'definition',
  'figure',
  'heading',
  'img',
  'list',
  'listitem',
  'main',
  'mark',
  'math',
  'navigation',
  'note',
  'paragraph',
  'region',
  'row',
  'rowheader',
  'statictext',
  'table',
  'term',
  'time',
])

const INPUT_ROLES = new Set(['combobox', 'searchbox', 'spinbutton', 'textbox'])
const ROOT_ROLES = new Set(['rootwebarea', 'webarea'])

export function buildBrowserSemanticSnapshot(input: BuildBrowserSemanticSnapshotInput): BrowserSemanticSnapshotBody {
  const maxNodes = normalizeLimit(input.maxNodes, BROWSER_SNAPSHOT_MAX_NODES)
  const maxTextBytes = normalizeLimit(input.maxTextBytes, BROWSER_SNAPSHOT_MAX_TEXT_BYTES)
  const nodeById = new Map(input.nodes.flatMap((node) => node.nodeId ? [[node.nodeId, node] as const] : []))
  const rootBackendDOMNodeId = input.nodes.find((node) => ROOT_ROLES.has(readRole(node)))?.backendDOMNodeId
  const nodes: BrowserSemanticNode[] = []
  let textBytes = 0
  let truncated = false

  for (const axNode of input.nodes) {
    if (nodes.length >= maxNodes) {
      truncated = hasRemainingSemanticNode(input.nodes, axNode, nodeById)
      break
    }

    const candidate = toSemanticNode(axNode, nodeById)
    if (!candidate || axNode.backendDOMNodeId === undefined) continue

    const limited = fitNodeWithinTextBudget(candidate, maxTextBytes - textBytes)
    if (!limited.node) {
      truncated = true
      break
    }

    nodes.push({
      ref: input.allocateRef(axNode.backendDOMNodeId),
      ...limited.node,
    })
    textBytes += limited.textBytes
    truncated ||= limited.truncated

    if (textBytes >= maxTextBytes) {
      truncated ||= hasSemanticNodeAfter(input.nodes, axNode, nodeById)
      break
    }
  }

  return {
    ...(rootBackendDOMNodeId === undefined ? {} : { rootBackendDOMNodeId }),
    nodes,
    truncated,
    textBytes,
  }
}

interface SemanticNodeCandidate extends Omit<BrowserSemanticNode, 'ref'> {}

function toSemanticNode(node: BrowserAxNode, nodeById: Map<string, BrowserAxNode>): SemanticNodeCandidate | null {
  const role = readRole(node)
  if (
    !role
    || ROOT_ROLES.has(role)
    || node.ignored
    || readBooleanProperty(node, 'hidden')
    || readBooleanProperty(node, 'invisible')
    || hasInputAncestor(node, nodeById)
  ) {
    return null
  }

  const rawValue = readText(node.value)
  const input = INPUT_ROLES.has(role)
  const password = input && isPasswordInput(node)
  const name = safeInputLabel(readText(node.name), rawValue, input)
  const description = cleanText(readText(node.description))
  const placeholder = readPlaceholder(node)
  if (
    !INTERACTIVE_ROLES.has(role)
    && (
      !CONTENT_ROLES.has(role)
      || (!name && !description)
      || hasAncestorWithSameName(node, name, nodeById)
    )
  ) return null

  const checked = readCheckedProperty(node)
  const disabled = readBooleanProperty(node, 'disabled') || readBooleanProperty(node, 'enabled') === false
  const selected = readBooleanProperty(node, 'selected')
  const expanded = readBooleanProperty(node, 'expanded')
  const required = readBooleanProperty(node, 'required')
  const readonly = readBooleanProperty(node, 'readonly')
  const multiline = readBooleanProperty(node, 'multiline')

  return {
    role,
    ...(name ? { name } : {}),
    ...(description ? { description } : {}),
    ...(placeholder ? { placeholder } : {}),
    ...(disabled ? { disabled: true } : {}),
    ...(checked === undefined ? {} : { checked }),
    ...(selected === undefined ? {} : { selected }),
    ...(expanded === undefined ? {} : { expanded }),
    ...(required ? { required: true } : {}),
    ...(readonly ? { readonly: true } : {}),
    ...(multiline ? { multiline: true } : {}),
    ...(password ? { password: true } : {}),
    ...(input ? { empty: rawValue.length === 0 } : {}),
    depth: computeDepth(node, nodeById),
  }
}

function fitNodeWithinTextBudget(
  candidate: SemanticNodeCandidate,
  remainingBytes: number,
): { node: SemanticNodeCandidate | null; textBytes: number; truncated: boolean } {
  if (remainingBytes <= 0) return { node: null, textBytes: 0, truncated: true }

  const roleResult = takeUtf8Prefix(candidate.role, remainingBytes)
  if (!roleResult.text) return { node: null, textBytes: 0, truncated: true }

  const node: SemanticNodeCandidate = {
    role: roleResult.text,
    depth: candidate.depth,
  }
  let textBytes = roleResult.bytes
  let truncated = roleResult.truncated

  for (const key of ['name', 'description', 'placeholder'] as const) {
    const value = candidate[key]
    if (!value) continue
    const result = takeUtf8Prefix(value, remainingBytes - textBytes)
    if (result.text) node[key] = result.text
    textBytes += result.bytes
    truncated ||= result.truncated
  }

  for (const key of ['disabled', 'checked', 'selected', 'expanded', 'required', 'readonly', 'multiline', 'password', 'empty'] as const) {
    const value = candidate[key]
    if (value !== undefined) Object.assign(node, { [key]: value })
  }

  return { node, textBytes, truncated }
}

function takeUtf8Prefix(value: string, maxBytes: number): { text: string; bytes: number; truncated: boolean } {
  if (maxBytes <= 0) return { text: '', bytes: 0, truncated: value.length > 0 }
  const totalBytes = Buffer.byteLength(value, 'utf8')
  if (totalBytes <= maxBytes) return { text: value, bytes: totalBytes, truncated: false }

  let result = ''
  let bytes = 0
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, 'utf8')
    if (bytes + characterBytes > maxBytes) break
    result += character
    bytes += characterBytes
  }
  return { text: result.trimEnd(), bytes, truncated: true }
}

function computeDepth(node: BrowserAxNode, nodeById: Map<string, BrowserAxNode>): number {
  let depth = 0
  let parentId = node.parentId
  const visited = new Set<string>()
  while (parentId && depth < 64 && !visited.has(parentId)) {
    visited.add(parentId)
    depth += 1
    parentId = nodeById.get(parentId)?.parentId
  }
  return depth
}

function readRole(node: BrowserAxNode): string {
  return cleanText(readText(node.role)).toLowerCase()
}

function readPlaceholder(node: BrowserAxNode): string {
  const attributeValue = readDomAttribute(node, 'placeholder')
  if (attributeValue) return cleanText(attributeValue)
  const source = node.name?.sources?.find((candidate) => !candidate.superseded && candidate.attribute === 'placeholder')
  return cleanText(readText(source?.value))
}

function safeInputLabel(name: string, rawValue: string, input: boolean): string {
  const cleanedName = cleanText(name)
  if (input && rawValue && cleanedName === cleanText(rawValue)) return ''
  return cleanedName
}

function isPasswordInput(node: BrowserAxNode): boolean {
  if (readBooleanProperty(node, 'protected')) return true
  return node.dom?.nodeName?.toLowerCase() === 'input' && readDomAttribute(node, 'type').toLowerCase() === 'password'
}

function readDomAttribute(node: BrowserAxNode, name: string): string {
  const attributes = node.dom?.attributes ?? []
  for (let index = 0; index < attributes.length - 1; index += 2) {
    if (attributes[index]?.toLowerCase() === name) return attributes[index + 1] ?? ''
  }
  return ''
}

function hasInputAncestor(node: BrowserAxNode, nodeById: Map<string, BrowserAxNode>): boolean {
  let parentId = node.parentId
  const visited = new Set<string>()
  while (parentId && !visited.has(parentId)) {
    visited.add(parentId)
    const parent = nodeById.get(parentId)
    if (!parent) return false
    if (INPUT_ROLES.has(readRole(parent))) return true
    parentId = parent.parentId
  }
  return false
}

function hasAncestorWithSameName(node: BrowserAxNode, name: string, nodeById: Map<string, BrowserAxNode>): boolean {
  if (!name) return false
  let parentId = node.parentId
  const visited = new Set<string>()
  while (parentId && !visited.has(parentId)) {
    visited.add(parentId)
    const parent = nodeById.get(parentId)
    if (!parent) return false
    if (cleanText(readText(parent.name)) === name) return true
    parentId = parent.parentId
  }
  return false
}

function cleanText(value: string): string {
  return value
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function readText(value: BrowserAxValue | undefined): string {
  return typeof value?.value === 'string' ? value.value : ''
}

function readProperty(node: BrowserAxNode, name: string): BrowserAxProperty | undefined {
  return node.properties?.find((property) => property.name === name)
}

function readBooleanProperty(node: BrowserAxNode, name: string): boolean | undefined {
  const value = readProperty(node, name)?.value?.value
  return typeof value === 'boolean' ? value : undefined
}

function readCheckedProperty(node: BrowserAxNode): boolean | 'mixed' | undefined {
  const value = readProperty(node, 'checked')?.value?.value
  return value === 'mixed' || typeof value === 'boolean' ? value : undefined
}

function hasSemanticNodeAfter(nodes: BrowserAxNode[], current: BrowserAxNode, nodeById: Map<string, BrowserAxNode>): boolean {
  const index = nodes.indexOf(current)
  return nodes.slice(index + 1).some((node) => toSemanticNode(node, nodeById) !== null && node.backendDOMNodeId !== undefined)
}

function hasRemainingSemanticNode(nodes: BrowserAxNode[], current: BrowserAxNode, nodeById: Map<string, BrowserAxNode>): boolean {
  const index = nodes.indexOf(current)
  return nodes.slice(index).some((node) => toSemanticNode(node, nodeById) !== null && node.backendDOMNodeId !== undefined)
}

function normalizeLimit(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value) || value === undefined || value < 1) return fallback
  return Math.floor(value)
}
