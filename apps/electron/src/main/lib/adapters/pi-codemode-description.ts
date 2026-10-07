import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { renderToolSignature } from '@earendil-works/pi-codemode'

interface ReadonlyCodemodeBudgets {
  timeoutMs: number
  memoryLimitBytes: number
  scriptChars: number
  calls: number
  concurrency: number
  toolResultBytes: number
  deliveredBytes: number
}

/** 声明只依据宿主持有的实际定义；返回值是脚本桥接后的文本，而非原生toolResult对象。 */
export function describeReadonlyCodemode(owned: readonly ToolDefinition[], renderSignature: typeof renderToolSignature, limits: ReadonlyCodemodeBudgets): string {
  const signatures = owned.map(tool => renderSignature({ name: tool.name,
    inputSchema: Object.fromEntries<unknown>(Object.entries(tool.parameters)), outputSchema: { type: 'string' } })).join('\n')
  return [
    '在受限VM中用JavaScript批量读取、搜索、筛选、去重并汇总本地内容。适合多文件同类处理；单个读取或需要原文时优先直接调用普通工具。',
    '只能调用下列本轮宿主持有的只读工具；每个子调用独立授权。没有models、写入、Shell、网络、MCP或交付能力。',
    `实际API声明（仅供理解参数；code必须是JavaScript，不写TypeScript类型）：\ndeclare const tools: {\n${signatures}\n};`,
    'tools返回Promise<string>，不是content数组或JSON对象：read返回文本正文，grep/find返回搜索文本；需要JSON时自己JSON.parse。子调用错误会reject，可用Promise.allSettled保留部分成功结果。',
    '用return交付简短JSON可序列化汇总，可用text()追加短文本；父结果为{ok,value,output,calls}，失败时为{ok:false,error,output,calls}。不持久化store、不交付图片。',
    `固定预算：${limits.timeoutMs / 1000} 秒总时限（含工具等待）、${limits.memoryLimitBytes / (1024 * 1024)} MiB VM、${limits.scriptChars}字符代码、最多 ${limits.calls} 次子调用、同时在途最多 ${limits.concurrency} 项；单子结果 ${limits.toolResultBytes} / 最终输出 ${limits.deliveredBytes} UTF-8字节。VM内存限制不是整个host I/O的内存限制，不能用注释提高预算。`,
    `分批并发，每批最多${limits.concurrency}项，await本批完成再处理下一批；只对失败的项决定后续处理，不重放已成功调用。若取消/拒绝/超预算则停止或改用普通工具，不反复重试同一超额脚本。`,
    owned.some(tool => tool.name === 'read') ? '示例（请替换为已知路径）：const paths=["已知文件.json"]; const summary=[]; for(let i=0;i<paths.length;i+=4){ const batch=paths.slice(i,i+4); const results=await Promise.allSettled(batch.map(path=>tools.read({path}))); summary.push(...results.map((r,j)=>({path:batch[j],ok:r.status==="fulfilled",chars:r.status==="fulfilled"?r.value.length:0}))); } return summary;' : '',
  ].filter(Boolean).join('\n\n')
}
