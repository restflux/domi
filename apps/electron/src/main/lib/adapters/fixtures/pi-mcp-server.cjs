// 仅供本地回归：通过真实 stdio 协议检查环境隔离与子进程关闭。
const readline = require('node:readline')
const lines = readline.createInterface({ input: process.stdin })
lines.on('line', line => {
  const request = JSON.parse(line)
  if (!('id' in request)) return
  let result
  if (request.method === 'initialize') {
    if (process.argv.includes('--hang-initialize')) return
    result = { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'stdio-test', version: '1' } }
  } else if (request.method === 'tools/list') {
    result = { tools: [{ name: 'inspect', inputSchema: { type: 'object', properties: {} } }] }
  } else {
    result = { content: [{ type: 'text', text: JSON.stringify({
      pid: process.pid, cwd: process.cwd(),
      privateCredential: process.env.DOMI_MCP_TEST_PRIVATE_KEY ?? null,
      explicit: process.env.DOMI_MCP_TEST_ALLOWED ?? null,
    }) }] }
  }
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n')
})
lines.on('close', () => process.exit(0))
