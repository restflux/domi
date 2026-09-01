import { app } from 'electron'
import { homedir } from 'node:os'
import {
  resolveDomiProductIdentity,
  resolveFallbackAppDataPath,
} from './product-identity.ts'

/** 获取系统 appData 根目录；app.getPath 失败时按平台回退到环境变量/用户主目录。 */
function resolveSystemAppDataPath(): string {
  try {
    return app.getPath('appData')
  } catch (err) {
    console.warn('[身份] app.getPath("appData") 失败，回退到环境变量解析:', err)
    return resolveFallbackAppDataPath(process.env, process.platform, homedir())
  }
}

// 此模块必须作为主进程入口的第一个 import 求值，确保其它模块无法先读取旧身份路径。
const identity = resolveDomiProductIdentity({
  isPackaged: app.isPackaged,
  appDataPath: resolveSystemAppDataPath(),
  environment: process.env,
})

app.setName(identity.applicationName)
app.setPath('userData', identity.userDataPath)
app.setAppUserModelId(identity.applicationId)
