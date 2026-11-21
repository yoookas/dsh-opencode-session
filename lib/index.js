/**
 * dsh-opencode-session — 宿主插件。
 *
 * 目标：某个会话发出的模型请求，全部自动携带同一个 `x-opencode-session`
 * 请求头，供 OpenCode Go / Zen 网关按会话做路由与提示缓存亲和。
 *
 * 为什么是这三层：
 *  1. `llm/stream` 瀑布监听拿到请求自带的 `options.sessionId`（agent loop 每个
 *     请求都会带上会话的持久 id），用 AsyncLocalStorage 把它包进下游流的每次
 *     迭代 —— 该流内部后续所有 await（含真正发出 HTTP 的 fetch）都继承它。
 *     于是同一对话的所有请求（多轮、续聊、压缩、重试、会话标题、子代理各自的
 *     会话）拿到各自稳定且互不相同的值。
 *  2. 全局 `fetch` 补丁：pi-ai 适配器不在 `GenerateOptions.headers` 上暴露注入点，
 *     所以真正的落点是出站 HTTP 本身。补丁只对命中 `hosts` 的 URL 生效，且默认
 *     不覆盖已经存在的同名头（pi-ai 新版本在目录路由上自带注入时不重复、不冲突）。
 *  3. 环境兜底：没有 `sessionId` 的辅助请求（例如某些手写 `ctx.llm.stream` 调用）
 *     退回到 `ctx.agents.currentInitiator()` 的会话 id，让它们在会话上下文里也带上
 *     同一个值。
 *
 * 插件不导入任何 `@deepseek-ai/*` 运行时包：它作为 `link:` 依赖安装在 profile 里，
 * 只允许 Node 内建能力，避免解析路径差异导致加载失败。
 *
 * @module dsh-opencode-session
 */

import { AsyncLocalStorage } from 'node:async_hooks'

import { SETTINGS_ROUTE, mountSettingsApi } from './settings-api.js'

export { SETTINGS_ROUTE }

export const name = 'opencode-session'

/** profile 里的 Loader 行 id，与 cordis.patch.yml 的 insert id 一致；设置页用它定位配置行。 */
export const ROW_ID = 'x-opencode-session'

/** 需要 `llm` 服务（瀑布监听）才会激活。 */
export const inject = ['llm']

/** 默认配置；行配置里未写的键回落到这里。 */
export const DEFAULTS = Object.freeze({
  /** 命中这些主机（含其子域）的请求才附加请求头；`*` 表示所有主机。 */
  hosts: ['opencode.ai'],
  /** 请求头名。 */
  header: 'x-opencode-session',
  /** `session-id`：原样使用会话 id；`uuid`：去掉 `session-` 前缀后的裸 UUID。 */
  value: 'session-id',
  /** 为 true 时用会话值覆盖请求里已有的同名头。 */
  override: false,
  /** 为 true 时把每次注入打到 debug 日志。 */
  debug: false,
})

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const HEADER_NAME_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/
/** 合法主机名（或 `*`）：字母数字、点、连字符，`*` 单独表示全部。 */
const HOST_RE = /^(\*|[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*)$/
/** 请求头值的合法可见 ASCII（HTTP 头不能带 CR/LF 等控制字符）。 */
const HEADER_VALUE_RE = /^[\t\x20-\x7e]+$/
const MAX_VALUE_LENGTH = 4096

/** 每个模型流的会话上下文；由 `llm/stream` 监听器写入，fetch 补丁读取。 */
const sessionStorage = new AsyncLocalStorage()

// ── 配置 ─────────────────────────────────────────────────────────────────

/**
 * 把行配置规范成内部形态；任何非法或缺失的键回落到默认值，绝不因为配置写错
 * 让插件在请求路径上抛错。
 * @param {unknown} raw - 行配置（cordis 传入）。
 * @returns {{hosts: string[], header: string, value: 'session-id'|'uuid', override: boolean, debug: boolean}}
 */
export function normalizeConfig(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  const hosts = (Array.isArray(source.hosts) ? source.hosts : [source.hosts])
    .filter((host) => typeof host === 'string')
    .map((host) => host.trim().toLowerCase())
    .filter((host) => host !== '')
  const header = typeof source.header === 'string' && HEADER_NAME_RE.test(source.header.trim())
    ? source.header.trim()
    : DEFAULTS.header
  return {
    hosts: hosts.length > 0 ? hosts : [...DEFAULTS.hosts],
    header,
    value: source.value === 'uuid' ? 'uuid' : DEFAULTS.value,
    override: source.override === true,
    debug: source.debug === true,
  }
}

// ── 纯函数：主机匹配、取值、URL 提取 ─────────────────────────────────────

/**
 * 从 fetch 入参里提取 URL 字符串；取不到返回 undefined。
 * @param {RequestInfo|URL|string|undefined} input - fetch 的第一个参数。
 * @returns {string|undefined}
 */
export function requestUrl(input) {
  if (typeof input === 'string') return input
  if (typeof URL !== 'undefined' && input instanceof URL) return input.href
  if (input !== null && typeof input === 'object' && typeof input.url === 'string') return input.url
  return undefined
}

/**
 * 取 URL 的主机名（小写）；非法 URL 返回 undefined。
 * @param {string} url
 * @returns {string|undefined}
 */
export function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return undefined
  }
}

/**
 * 主机是否命中配置的模式：完全相等或子域后缀匹配；`*` 匹配一切。
 * 例如 `opencode.ai` 命中 `opencode.ai` 与 `go.opencode.ai`，但不命中
 * `notopencode.ai` 或 `opencode.ai.example.com`。
 * @param {string|undefined} hostname - 已小写的主机名。
 * @param {readonly string[]} patterns - 配置里的主机模式。
 * @returns {boolean}
 */
export function matchesHost(hostname, patterns) {
  if (typeof hostname !== 'string' || hostname === '') return false
  const host = hostname.toLowerCase()
  return patterns.some((pattern) => pattern === '*' || host === pattern || host.endsWith(`.${pattern}`))
}

/**
 * 由会话 id 得到请求头值。
 * @param {unknown} sessionId - 会话 id（`session-<uuid>`）。
 * @param {'session-id'|'uuid'} mode - 取值模式。
 * @returns {string}
 */
export function headerValue(sessionId, mode) {
  const raw = String(sessionId)
  if (mode !== 'uuid') return raw
  const bare = raw.startsWith('session-') ? raw.slice('session-'.length) : raw
  return UUID_RE.test(bare) ? bare : raw
}

/**
 * 请求头值是否可以安全地写进 HTTP 头。
 * @param {string} value
 * @returns {boolean}
 */
export function isHeaderValueSafe(value) {
  return value.length > 0 && value.length <= MAX_VALUE_LENGTH && HEADER_VALUE_RE.test(value)
}

/**
 * 计算一次请求的最终 Headers：`init.headers` 按 fetch 语义整体替换 Request 自带的头。
 * @param {RequestInfo|URL|string|undefined} input
 * @param {RequestInit|undefined} init
 * @returns {Headers}
 */
export function effectiveHeaders(input, init) {
  if (init !== undefined && init !== null && init.headers !== undefined) return new Headers(init.headers)
  if (input !== null && typeof input === 'object' && input.headers !== undefined) return new Headers(input.headers)
  return new Headers()
}

// ── fetch 补丁 ───────────────────────────────────────────────────────────

/**
 * 构造 fetch 补丁（不安装，便于单测）。
 * 只有「上下文里有会话 id」且「URL 主机命中 hosts」且「值合法」时才动请求；
 * 其余情况一律原样透传，任何异常也退回原始请求，绝不阻断模型调用。
 * @param {object} options
 * @param {() => string|undefined} options.getSession - 读取当前会话 id。
 * @param {ReturnType<typeof normalizeConfig>} options.config
 * @param {(level: string, message: string) => void} [options.log]
 * @param {typeof fetch} [options.fetchImpl] - 被包装的原始 fetch。
 * @returns {typeof fetch}
 */
export function createFetchShim({ getSession, config, log = () => {}, fetchImpl = globalThis.fetch }) {
  const original = fetchImpl
  const call = (input, init) => original.call(globalThis, input, init)
  return function opencodeSessionFetch(input, init) {
    let sessionId
    try {
      sessionId = getSession()
    } catch {
      sessionId = undefined
    }
    if (sessionId === undefined || sessionId === null || sessionId === '') return call(input, init)

    const url = requestUrl(input)
    if (url === undefined) return call(input, init)
    const host = hostOf(url)
    if (!matchesHost(host, config.hosts)) return call(input, init)

    try {
      const value = headerValue(sessionId, config.value)
      if (!isHeaderValueSafe(value)) return call(input, init)
      const headers = effectiveHeaders(input, init)
      if (!config.override && headers.has(config.header)) return call(input, init)
      headers.set(config.header, value)
      log('debug', `${config.header}: ${value} -> ${host}${new URL(url).pathname}`)
      const nextInit = init === undefined || init === null ? { headers } : { ...init, headers }
      return original.call(globalThis, input, nextInit)
    } catch (error) {
      log('warn', `无法附加 ${config.header}，请求按原样放行：${error?.message ?? error}`)
      return call(input, init)
    }
  }
}

/** 进程级安装状态：{ original, shim, count }。 */
let installed = null

/**
 * 幂等安装全局 fetch 补丁；返回的释放函数可安全重复调用。
 * 若全局 fetch 已是访问器或不是函数，则放弃安装（host 记录一条告警），不影响请求。
 * @param {object} options - 传给 {@link createFetchShim} 的参数。
 * @param {(level: string, message: string) => void} [options.log]
 * @returns {() => void} 释放函数。
 */
export function installFetchShim(options) {
  const log = options.log ?? (() => {})
  if (installed !== null) {
    installed.count += 1
    return () => releaseFetchShim()
  }
  const descriptor = typeof globalThis === 'object' ? Object.getOwnPropertyDescriptor(globalThis, 'fetch') : undefined
  if (typeof globalThis.fetch !== 'function' || (descriptor !== undefined && !('value' in descriptor))) {
    log('warn', '全局 fetch 不可用或为访问器，跳过补丁')
    return () => {}
  }
  const shim = createFetchShim({ ...options, log })
  installed = { original: globalThis.fetch, shim, count: 1 }
  globalThis.fetch = shim
  return () => releaseFetchShim()
}

/** 释放一次安装；计数归零且顶层仍是自己的补丁时才恢复原始 fetch。 */
function releaseFetchShim() {
  if (installed === null) return
  installed.count -= 1
  if (installed.count > 0) return
  if (globalThis.fetch === installed.shim) globalThis.fetch = installed.original
  installed = null
}

// ── 会话上下文与 llm/stream ─────────────────────────────────────────────

/**
 * 在指定会话上下文中执行 fn。
 * @template T
 * @param {string} sessionId
 * @param {() => T} fn
 * @returns {T}
 */
export function runWithSession(sessionId, fn) {
  return sessionStorage.run({ sessionId: String(sessionId) }, fn)
}

/**
 * 把下游 AsyncIterable 包成「每次迭代都在会话上下文中执行」的异步迭代器，
 * 这样流内部的 fetch 一定带着会话 id。
 * @param {AsyncIterable<any>} iterable - 下游 llm/stream 链返回的流。
 * @param {unknown} sessionId - 本请求的会话 id。
 * @returns {AsyncIterableIterator<any>}
 */
export function withSession(iterable, sessionId) {
  const id = String(sessionId)
  const iterator = runWithSession(id, () => iterable[Symbol.asyncIterator]())
  const step = (method, value) => runWithSession(id, () => {
    const next = iterator[method]
    return typeof next === 'function' ? next.call(iterator, value) : { done: true, value: undefined }
  })
  return {
    next: () => step('next'),
    return: (value) => step('return', value),
    throw: (error) => step('throw', error),
    [Symbol.asyncIterator]() {
      return this
    },
  }
}

/**
 * `llm/stream` 瀑布监听器：带会话 id 的请求把 id 装进本次流的上下文，其余原样放行。
 * @param {{sessionId?: unknown}|undefined} options - GenerateOptions。
 * @param {() => AsyncIterable<any>} next - 下游链。
 * @returns {AsyncIterable<any>}
 */
export function llmStreamListener(options, next) {
  const sessionId = options?.sessionId
  if (sessionId === undefined || sessionId === null || String(sessionId) === '') return next()
  return withSession(next(), sessionId)
}

/**
 * 读取当前异步链上的会话 id：先看 llm/stream 写入的上下文，再退回发起 Agent 的会话。
 * @param {() => string|undefined} [ambient] - 环境兜底。
 * @returns {string|undefined}
 */
export function currentSessionId(ambient) {
  const store = sessionStorage.getStore()
  if (store !== undefined && store.sessionId !== undefined) return store.sessionId
  if (ambient === undefined) return undefined
  try {
    return ambient()
  } catch {
    return undefined
  }
}

// ── 插件入口 ─────────────────────────────────────────────────────────────

/** 构造带前缀的日志函数；日志器异常不影响请求路径。 */
function makeLogger(ctx, debug) {
  const logger = ctx?.logger
  return (level, message) => {
    if (level === 'debug' && !debug) return
    try {
      const write = logger?.[level]
      if (typeof write === 'function') write.call(logger, `[x-opencode-session] ${message}`)
    } catch {
      // ignore
    }
  }
}

/**
 * 校验设置页提交的配置；非法值返回带说明的错误，绝不写入半成品配置。
 * @param {unknown} raw - 表单提交的配置对象。
 * @returns {{config?: {hosts: string[], header: string, value: 'session-id'|'uuid', override: boolean, debug: boolean}, error?: string}}
 */
export function sanitizeSettings(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  const input = Array.isArray(source.hosts)
    ? source.hosts
    : String(source.hosts ?? '').split(/[\n,]/)
  const hosts = []
  for (const candidate of input) {
    if (typeof candidate !== 'string') return { error: '主机列表必须是字符串' }
    const host = candidate.trim().toLowerCase()
    if (host === '') continue
    if (host.length > 253 || !HOST_RE.test(host)) return { error: `主机名不合法：${candidate}` }
    if (!hosts.includes(host)) hosts.push(host)
    if (hosts.length > 32) return { error: '主机最多 32 个' }
  }
  if (hosts.length === 0) return { error: '至少保留一个主机；要放行所有请求可填 *' }
  const header = String(source.header ?? '').trim()
  if (!HEADER_NAME_RE.test(header)) return { error: `请求头名不合法：${header || '(空)'}` }
  if (source.value !== undefined && source.value !== 'session-id' && source.value !== 'uuid') {
    return { error: '取值只能是 session-id 或 uuid' }
  }
  return {
    config: {
      hosts,
      header,
      value: source.value === 'uuid' ? 'uuid' : 'session-id',
      override: source.override === true,
      debug: source.debug === true,
    },
  }
}

/**
 * 插件入口。
 * @param {import('@deepseek-ai/cordis').Context} ctx - 宿主插件上下文。
 * @param {unknown} rawConfig - 行配置。
 */
export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig)
  const log = makeLogger(ctx, config.debug)
  /** 当前异步链上发起 Agent 的会话 id（可选服务，缺失时为 undefined）。 */
  let ambient

  ctx.effect(() => {
    const release = installFetchShim({
      getSession: () => currentSessionId(ambient),
      config,
      log,
    })
    const summary = `已启用：${config.header} @ ${config.hosts.join(', ')}（value=${config.value}，override=${config.override}）`
    log('info', summary)
    // 宿主默认不把 ctx.logger 输出到控制台；debug 打开时补一行，便于确认插件确实挂载。
    if (config.debug) console.log(`[x-opencode-session] ${summary}`)
    return release
  }, `${name}: fetch shim`)

  // global + prepend：无论哪个上下文发起，都能在最外层把会话 id 装进流上下文。
  ctx.on('llm/stream', llmStreamListener, { global: true, prepend: true })

  // 可选：没有 sessionId 的辅助请求用发起 Agent 的会话 id 兜底。
  if (typeof ctx.inject === 'function') {
    ctx.inject(['agents'], (agentCtx) => {
      agentCtx.effect(() => {
        ambient = () => {
          const initiator = agentCtx.agents?.currentInitiator?.()
          const sessionId = initiator?.session?.id
          return sessionId === undefined ? undefined : String(sessionId)
        }
        return () => {
          ambient = undefined
        }
      }, `${name}: ambient agent session`)
    })

    // 可选：设置页 API（需要 configEditor 写回 profile 配置、webServer 提供 HTTP 路由）。
    ctx.inject(['configEditor', 'webServer'], (settingsCtx) => {
      mountSettingsApi(settingsCtx, {
        entryId: ROW_ID,
        defaults: DEFAULTS,
        normalize: normalizeConfig,
        sanitize: sanitizeSettings,
        log,
      })
    })
  }
}
