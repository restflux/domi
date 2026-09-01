---
name: tool-builder
description: 交互式创建和管理 Chat 模式的自定义 HTTP 工具。当用户明确要创建、配置、调试或删除一个 Chat HTTP API 工具时使用。真实凭据不得写入 URL、headers 或 bodyTemplate；配置中只能使用 `{{credential.<key>}}` 引用，真实值单独存入该工具的 `toolCredentials`，由主进程运行时注入。
version: "1.0.3"
---
# Tool Builder

帮助用户创建 Chat 模式的自定义 HTTP API 工具。工具定义与凭据必须分离：模型和普通模板只看到 credential reference，真实值只在运行时由 main process 注入。

## 1. 收集最少需求

确认：

- 工具用途和触发描述；
- API endpoint、GET/POST、公开文档来源；
- 参数名称、类型、必填与 enum；
- 认证放在 header 还是 POST body；
- 响应中需要提取的点号路径。

用户没提供真实凭据时，不要索要或猜测；先创建仅含 reference 的工具定义，再让用户到「设置 → 工具 → 自定义工具 → 配置凭据」自行填写。Agent 不读取或代填真实值。

## 2. 安全配置契约

`~/.domi/chat-tools.json` 的相关结构：

```json
{
  "toolStates": {
    "custom-example": { "enabled": false }
  },
  "toolCredentials": {
    "custom-example": {
      "apiKey": "<由用户在受控凭据入口配置的真实值>"
    }
  },
  "customTools": [
    {
      "id": "custom-example",
      "name": "示例工具",
      "description": "查询示例数据",
      "params": [],
      "category": "custom",
      "executorType": "http",
      "httpConfig": {
        "urlTemplate": "https://api.example.com/data",
        "method": "GET",
        "headers": {
          "Authorization": "Bearer {{credential.apiKey}}"
        }
      }
    }
  ]
}
```

### `httpConfig`

| 字段 | 规则 |
|---|---|
| `urlTemplate` | 支持 `{{paramName}}`；**禁止** `{{credential.*}}`、API key query、URL username/password |
| `method` | `GET` 或 `POST` |
| `headers` | 普通 header 可写静态值；Authorization、Cookie、X-API-Key 等敏感 header 必须使用 `{{credential.<key>}}` |
| `bodyTemplate` | 支持 `{{paramName}}` 与 `{{credential.<key>}}`；不得出现真实 secret |
| `resultPath` | 可选点号路径，如 `data.results` |

`params[].type` 支持 `string` / `number` / `boolean`，可用 `enum` 限定字符串值。

## 3. 凭据处理硬边界

- 不得把真实 API key、token、cookie、password 写入 `urlTemplate`、`headers`、`bodyTemplate`、Skill 正文、日志或对话示例。
- URL 不支持凭据注入；如果 API 只接受 query credential，说明当前自定义 HTTP 工具安全模型不支持，不要绕过。
- header/body 只写 `{{credential.<key>}}`。key 应是短标识，如 `apiKey`、`accessToken`、`clientSecret`。
- 真实值必须位于 `toolCredentials[toolId][key]`，由 HTTP executor 在网络请求前解析；缺失时工具应保持不可用并在网络调用前失败。
- Managed Web Access 会继续拒绝明文敏感配置、明显 secret、私网/本机目标和不安全 redirect；不要建议关闭或绕过。
- 不读取、展示或回显已有真实 credential。用户要更新时，只整体替换指定 key。

## 4. 创建与更新

优先通过 Domi 提供的 Chat 工具配置/凭据接口写入；只有当前运行环境没有该接口、且用户明确授权编辑本地配置时，才修改 `chat-tools.json`。

步骤：

1. 读取现有配置并按 `id` 去重；
2. 验证自定义 id、参数和 HTTP 模板；
3. 写入仅含 credential reference 的 `customTools` 元数据；
4. 告知用户到「设置 → 工具 → 自定义工具 → 配置凭据」填写真实值；不要通过对话或文件编辑代填；
5. 新工具默认关闭，凭据齐全且用户确认测试后再启用；
6. 保存后重新读取，确认没有真实凭据落入 `customTools`。

不要覆盖其他工具状态或凭据。

## 5. 测试与调试

先验证：

- public endpoint 与 URL 参数映射；
- credential keys 是否齐全，但不打印值；
- POST body 是否为合法 JSON（如 API 要求 JSON）；
- `resultPath` 是否匹配响应；
- 认证失败时只报告状态/缺失 key，不记录 secret。

常见问题：

- `缺少凭据: apiKey` → 补 `toolCredentials[toolId].apiKey`；
- `secret_in_request` → 配置仍含明文敏感 header/body 或模型参数携带 secret，改成 credential reference；
- URL credential 被拒绝 → API 认证方式不受支持，改用 header/body endpoint；
- HTTP 401/403 → 检查 credential key 与认证前缀，不回显值；
- 路径为空 → 调整 `resultPath`。

## 6. 删除

删除工具时同时移除：

- `customTools` 中对应 id；
- `toolStates[toolId]`；
- `toolCredentials[toolId]`。

删除是用户数据操作，只有用户明确要求删除时执行。
