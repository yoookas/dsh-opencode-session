/**
 * 设置页的宿主侧 API：读取/保存本插件的行配置。
 *
 * 保存走 `configEditor.edit()` —— 它把新配置写进 profile 的 cordis.patch.yml
 * 并让 Loader 重新装载该行，因此配置改动**不需要重启 dsh** 就会生效。
 *
 * 路由挂在 `webServer` 上，浏览器端（client.js）用同源 fetch 读写。
 *
 * @module dsh-opencode-session/settings-api
 */

/** 读写本插件配置的端点。 */
export const SETTINGS_ROUTE = '/dsh-opencode-session/config'

/** 返回 JSON 响应。 */
function json(res, status, payload) {
  res.writeHead(status, { 'cache-control': 'no-store', 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(payload))
}

/** 读取并解析请求体（限制大小，避免异常请求占满内存）。 */
async function readBody(req, limit = 64 * 1024) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > limit) throw new Error('请求体过大')
    chunks.push(buffer)
  }
  if (chunks.length === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

/**
 * 挂载设置页 API；服务缺失或插件卸载时随上下文一起释放。
 * @param {import('@deepseek-ai/cordis').Context} ctx - 已注入 configEditor 与 webServer 的子上下文。
 * @param {object} options
 * @param {string} options.entryId - 插件行 id。
 * @param {Record<string, unknown>} options.defaults - 默认配置。
 * @param {(raw: unknown) => Record<string, unknown>} options.normalize - 行配置 → 生效配置。
 * @param {(raw: unknown) => {config?: Record<string, unknown>, error?: string}} options.sanitize - 表单输入校验。
 * @param {(level: string, message: string) => void} [options.log]
 * @returns {() => void} 释放函数（同时由上下文的 effect 持有）。
 */
export function mountSettingsApi(ctx, { entryId, defaults, normalize, sanitize, log = () => {} }) {
  // 依赖服务未就绪（例如 headless profile 没有 webServer）时安静跳过。
  if (typeof ctx.configEditor?.entries !== 'function' || typeof ctx.webServer?.register !== 'function') {
    return () => {}
  }
  // 先捕获服务引用：保存会触发本行重新装载，闭包里的 ctx 之后可能已失效。
  const configEditor = ctx.configEditor
  const webServer = ctx.webServer

  const findEntry = () => configEditor.entries().find((entry) => entry.options.id === entryId)

  const snapshot = () => {
    const entry = findEntry()
    return {
      ok: true,
      available: entry !== undefined,
      entryId,
      documentPath: typeof configEditor.documentPath === 'string' ? configEditor.documentPath : undefined,
      defaults: structuredClone(defaults),
      config: structuredClone(entry?.options.config ?? defaults),
      effective: normalize(entry?.options.config),
    }
  }

  const handler = async (req, res) => {
    if (req.method === 'GET') {
      try {
        json(res, 200, snapshot())
      } catch (error) {
        json(res, 500, { ok: false, error: String(error?.message ?? error) })
      }
      return
    }
    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'GET, POST' })
      res.end()
      return
    }
    try {
      const body = await readBody(req)
      const result = sanitize(body?.config)
      if (result.error !== undefined) {
        json(res, 400, { ok: false, error: result.error })
        return
      }
      const entry = findEntry()
      if (entry === undefined) {
        json(res, 409, { ok: false, error: `找不到配置行 "${entryId}"，无法保存` })
        return
      }
      await configEditor.edit(entry, () => result.config)
      log('info', `配置已保存并重新装载：${JSON.stringify(result.config)}`)
      json(res, 200, snapshot())
    } catch (error) {
      log('warn', `保存配置失败：${error?.message ?? error}`)
      json(res, 500, { ok: false, error: String(error?.message ?? error) })
    }
  }

  return ctx.effect(
    () => webServer.register({ kind: 'exact', path: SETTINGS_ROUTE, handler }),
    'x-opencode-session: settings api',
  )
}
