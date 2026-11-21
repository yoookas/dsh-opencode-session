import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'

import {
  DEFAULTS,
  SETTINGS_ROUTE,
  apply,
  createFetchShim,
  currentSessionId,
  headerValue,
  isHeaderValueSafe,
  llmStreamListener,
  matchesHost,
  normalizeConfig,
  requestUrl,
  sanitizeSettings,
} from '../lib/index.js'

/** 起一个记录请求头的本地网关，返回 { base, seen, close }。 */
async function mockGateway() {
  const seen = []
  const server = http.createServer((req, res) => {
    seen.push({ headers: { ...req.headers }, url: req.url })
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{}')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return {
    base: `http://127.0.0.1:${port}`,
    seen,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

/** 模拟适配器：第一次 next() 时才真正发出 HTTP 请求。 */
async function* adapterStream(url) {
  const response = await fetch(url, { method: 'GET' })
  yield { type: 'text', text: String(response.status) }
}

/** 在临时替换全局 fetch 的前提下跑一段逻辑，结束后恢复。 */
async function withShim(options, run) {
  const original = globalThis.fetch
  globalThis.fetch = createFetchShim({ ...options, fetchImpl: original })
  try {
    return await run()
  } finally {
    globalThis.fetch = original
  }
}

/** 带记录能力的假 cordis 上下文。 */
function fakeContext() {
  const listeners = new Map()
  const effects = []
  const logs = []
  const children = []
  const ctx = {
    logger: {
      info: (message) => logs.push(['info', message]),
      debug: (message) => logs.push(['debug', message]),
      warn: (message) => logs.push(['warn', message]),
      error: (message) => logs.push(['error', message]),
    },
    on(event, listener) {
      listeners.set(event, listener)
      return () => listeners.delete(event)
    },
    effect(setup) {
      const dispose = setup()
      effects.push(dispose)
      return dispose
    },
    inject(_deps, callback) {
      const routes = []
      const child = {
        agents: { currentInitiator: () => undefined },
        configEditor: { documentPath: '/tmp/cordis.patch.yml', entries: () => [], edit: async () => {} },
        webServer: {
          routes,
          register(route) {
            routes.push(route)
            return () => {
              const index = routes.indexOf(route)
              if (index >= 0) routes.splice(index, 1)
            }
          },
        },
        effect(setup) {
          const dispose = setup()
          effects.push(dispose)
          return dispose
        },
      }
      children.push(child)
      callback(child)
      return child
    },
  }
  return {
    ctx,
    listeners,
    logs,
    children,
    disposeAll() {
      for (const dispose of effects.reverse()) if (typeof dispose === 'function') dispose()
    },
  }
}

// ── 纯函数 ───────────────────────────────────────────────────────────────

test('matchesHost: 完全相等与子域命中，不做子串匹配', () => {
  const hosts = ['opencode.ai']
  assert.equal(matchesHost('opencode.ai', hosts), true)
  assert.equal(matchesHost('go.opencode.ai', hosts), true)
  assert.equal(matchesHost('GO.OpenCode.AI', hosts), true)
  assert.equal(matchesHost('notopencode.ai', hosts), false)
  assert.equal(matchesHost('opencode.ai.example.com', hosts), false)
  assert.equal(matchesHost(undefined, hosts), false)
  assert.equal(matchesHost('anything', ['*']), true)
})

test('headerValue: session-id 原样，uuid 去前缀', () => {
  const id = 'session-05681fd4-1667-4f46-874f-11fd7f10abbe'
  assert.equal(headerValue(id, 'session-id'), id)
  assert.equal(headerValue(id, 'uuid'), '05681fd4-1667-4f46-874f-11fd7f10abbe')
  assert.equal(headerValue('not-a-uuid', 'uuid'), 'not-a-uuid')
  assert.equal(headerValue(42, 'session-id'), '42')
})

test('isHeaderValueSafe: 拒绝控制字符与空值', () => {
  assert.equal(isHeaderValueSafe('session-abc'), true)
  assert.equal(isHeaderValueSafe(''), false)
  assert.equal(isHeaderValueSafe('abc\r\nX-Injected: 1'), false)
  assert.equal(isHeaderValueSafe('a'.repeat(4097)), false)
})

test('normalizeConfig: 非法配置回落到默认值', () => {
  assert.deepEqual(normalizeConfig(undefined), { ...DEFAULTS, hosts: [...DEFAULTS.hosts] })
  assert.deepEqual(normalizeConfig({ hosts: [] }).hosts, [...DEFAULTS.hosts])
  assert.equal(normalizeConfig({ header: 'bad header' }).header, DEFAULTS.header)
  assert.equal(normalizeConfig({ value: 'nope' }).value, DEFAULTS.value)
  assert.equal(normalizeConfig({ override: 'yes' }).override, false)
  const custom = normalizeConfig({ hosts: [' Example.COM '], override: true, debug: true })
  assert.deepEqual(custom.hosts, ['example.com'])
  assert.equal(custom.override, true)
  assert.equal(custom.debug, true)
})

test('requestUrl: 字符串、URL、Request 形态', () => {
  assert.equal(requestUrl('https://opencode.ai/x'), 'https://opencode.ai/x')
  assert.equal(requestUrl(new URL('https://opencode.ai/y')), 'https://opencode.ai/y')
  assert.equal(requestUrl(new Request('https://opencode.ai/z')), 'https://opencode.ai/z')
  assert.equal(requestUrl({}), undefined)
})

// ── 设置页配置校验 ───────────────────────────────────────────────────────

test('sanitizeSettings: 规范化合法输入', () => {
  const { config, error } = sanitizeSettings({
    hosts: ' OpenCode.AI \n go.example.com , opencode.ai ',
    header: ' x-opencode-session ',
    value: 'uuid',
    override: true,
    debug: 'true',
  })
  assert.equal(error, undefined)
  assert.deepEqual(config, {
    hosts: ['opencode.ai', 'go.example.com'],
    header: 'x-opencode-session',
    value: 'uuid',
    override: true,
    debug: false,
  })
})

test('sanitizeSettings: 非法输入返回可读错误', () => {
  assert.match(sanitizeSettings({ hosts: [], header: 'x' }).error, /至少保留一个主机/)
  assert.match(sanitizeSettings({ hosts: ['bad host'], header: 'x' }).error, /主机名不合法/)
  assert.match(sanitizeSettings({ hosts: ['opencode.ai'], header: 'bad header' }).error, /请求头名不合法/)
  assert.match(sanitizeSettings({ hosts: ['opencode.ai'], header: 'x', value: 'nope' }).error, /session-id/)
})

test('sanitizeSettings: * 表示所有主机', () => {
  assert.deepEqual(sanitizeSettings({ hosts: ['*'], header: 'x-opencode-session' }).config.hosts, ['*'])
})

// ── fetch 补丁 ───────────────────────────────────────────────────────────

test('同一会话的请求携带同一个值，会话之间互不相同', async () => {
  const gateway = await mockGateway()
  let session
  try {
    await withShim(
      { getSession: () => session, config: normalizeConfig({ hosts: ['127.0.0.1'] }) },
      async () => {
        session = 'session-11111111-1111-4111-8111-111111111111'
        await fetch(`${gateway.base}/v1/chat/completions`)
        await fetch(`${gateway.base}/v1/models`)

        session = 'session-22222222-2222-4222-8222-222222222222'
        await fetch(`${gateway.base}/v1/chat/completions`)
      },
    )
  } finally {
    await gateway.close()
  }

  assert.deepEqual(
    gateway.seen.map((entry) => entry.headers['x-opencode-session']),
    [
      'session-11111111-1111-4111-8111-111111111111',
      'session-11111111-1111-4111-8111-111111111111',
      'session-22222222-2222-4222-8222-222222222222',
    ],
  )
})

test('没有会话、主机不命中、值不安全时一律不注入', async () => {
  const gateway = await mockGateway()
  let session
  try {
    await withShim(
      { getSession: () => session, config: normalizeConfig({ hosts: ['127.0.0.1'] }) },
      async () => {
        await fetch(`${gateway.base}/no-session`)
        session = 'session-33333333-3333-4333-8333-333333333333'
        await fetch(`http://localhost:${new URL(gateway.base).port}/other-host`)
        session = 'bad\r\nvalue'
        await fetch(`${gateway.base}/unsafe`)
      },
    )
  } finally {
    await gateway.close()
  }

  assert.equal(gateway.seen.length, 3)
  for (const entry of gateway.seen) assert.equal(entry.headers['x-opencode-session'], undefined)
})

test('已有同名头默认保留，override 为 true 时替换', async () => {
  const gateway = await mockGateway()
  try {
    await withShim(
      {
        getSession: () => 'session-44444444-4444-4444-8444-444444444444',
        config: normalizeConfig({ hosts: ['127.0.0.1'], override: false }),
      },
      () => fetch(`${gateway.base}/keep`, { headers: { 'x-opencode-session': 'static-value' } }),
    )
    await withShim(
      {
        getSession: () => 'session-44444444-4444-4444-8444-444444444444',
        config: normalizeConfig({ hosts: ['127.0.0.1'], override: true }),
      },
      () => fetch(`${gateway.base}/replace`, { headers: { 'x-opencode-session': 'static-value' } }),
    )
  } finally {
    await gateway.close()
  }
  assert.equal(gateway.seen[0].headers['x-opencode-session'], 'static-value')
  assert.equal(gateway.seen[1].headers['x-opencode-session'], 'session-44444444-4444-4444-8444-444444444444')
})

test('Request 入参的既有头不会丢，且能补上会话头', async () => {
  const gateway = await mockGateway()
  try {
    await withShim(
      {
        getSession: () => 'session-55555555-5555-4555-8555-555555555555',
        config: normalizeConfig({ hosts: ['127.0.0.1'] }),
      },
      () => {
        const request = new Request(`${gateway.base}/request-input`, {
          method: 'GET',
          headers: { authorization: 'Bearer test-token' },
        })
        return fetch(request)
      },
    )
  } finally {
    await gateway.close()
  }
  assert.equal(gateway.seen[0].headers.authorization, 'Bearer test-token')
  assert.equal(gateway.seen[0].headers['x-opencode-session'], 'session-55555555-5555-4555-8555-555555555555')
})

// ── llm/stream 瀑布 ──────────────────────────────────────────────────────

test('llm/stream 包装后，流内部的 fetch 自动带会话 id', async () => {
  const gateway = await mockGateway()
  try {
    await withShim(
      { getSession: () => currentSessionId(), config: normalizeConfig({ hosts: ['127.0.0.1'] }) },
      async () => {
        const stream = llmStreamListener(
          { sessionId: 'session-66666666-6666-4666-8666-666666666666' },
          () => adapterStream(`${gateway.base}/stream`),
        )
        for await (const chunk of stream) assert.equal(chunk.type, 'text')
      },
    )
  } finally {
    await gateway.close()
  }
  assert.equal(gateway.seen[0].headers['x-opencode-session'], 'session-66666666-6666-4666-8666-666666666666')
})

test('并发流的会话上下文不串号', async () => {
  const gateway = await mockGateway()
  const ids = [
    'session-77777777-7777-4777-8777-777777777777',
    'session-88888888-8888-4888-8888-888888888888',
  ]
  try {
    await withShim(
      { getSession: () => currentSessionId(), config: normalizeConfig({ hosts: ['127.0.0.1'] }) },
      () =>
        Promise.all(
          ids.map(async (id) => {
            const stream = llmStreamListener({ sessionId: id }, () => adapterStream(`${gateway.base}/${id}`))
            for await (const _ of stream) {
              // 消费
            }
          }),
        ),
    )
  } finally {
    await gateway.close()
  }
  const byPath = new Map(
    gateway.seen.map((entry) => [entry.url.slice(1), entry.headers['x-opencode-session']]),
  )
  for (const id of ids) assert.equal(byPath.get(id), id)
})

test('没有 sessionId 的请求原样放行', () => {
  let called = 0
  const iterable = llmStreamListener({}, () => {
    called += 1
    return (async function* () {
      yield 1
    })()
  })
  assert.equal(called, 1)
  assert.equal(typeof iterable[Symbol.asyncIterator], 'function')
})

// ── 插件入口 ─────────────────────────────────────────────────────────────

test('apply 安装 fetch 补丁、注册 llm/stream，并在卸载时恢复', async () => {
  const gateway = await mockGateway()
  const original = globalThis.fetch
  const fake = fakeContext()
  apply(fake.ctx, { hosts: ['127.0.0.1'] })

  try {
    assert.notEqual(globalThis.fetch, original, 'fetch 应已被补丁替换')
    assert.equal(typeof fake.listeners.get('llm/stream'), 'function', '应注册 llm/stream')
    assert.ok(fake.logs.some(([level, message]) => level === 'info' && message.includes('x-opencode-session')))
    const route = fake.children.flatMap((child) => child.webServer.routes).find((item) => item.path === SETTINGS_ROUTE)
    assert.ok(route !== undefined, '应注册设置页读写路由')

    const stream = fake.listeners.get('llm/stream')(
      { sessionId: 'session-99999999-9999-4999-8999-999999999999' },
      () => adapterStream(`${gateway.base}/applied`),
    )
    for await (const _ of stream) {
      // 消费一次即可
    }
    assert.equal(
      gateway.seen[0].headers['x-opencode-session'],
      'session-99999999-9999-4999-8999-999999999999',
    )
  } finally {
    await gateway.close()
    fake.disposeAll()
  }
  assert.equal(globalThis.fetch, original, '卸载后应恢复原始 fetch')
})
