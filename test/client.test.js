import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

/**
 * 浏览器端模块是手写的 `window.__ModuleLoader__` 工厂，没有构建步骤；
 * 这里用假 React 和假 ctx 执行它，确认它能挂上设置小节、注册中英文字典，
 * 并且注册出的组件工厂可以调用（不需要真实浏览器）。
 */
const source = await readFile(new URL('../client.js', import.meta.url), 'utf8')

/** 在假的模块加载器环境里执行 client.js，返回它导出的插件对象。 */
function loadClientModule() {
  let exported
  const previousWindow = globalThis.window
  globalThis.window = {
    __ModuleLoader__: {
      load(definition) {
        assert.equal(definition.id, 'dsh-opencode-session', '模块 id 必须与包名一致')
        const react = {
          createElement: (type, props, ...children) => ({ type, props, children }),
          useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
          useEffect: () => {},
          useCallback: (callback) => callback,
        }
        exported = definition.factory((name) => {
          if (name === 'react') return react
          throw new Error(`unexpected require: ${name}`)
        })
      },
    },
  }
  try {
    new Function(source)()
  } finally {
    globalThis.window = previousWindow
  }
  return exported
}

test('浏览器端模块：注册设置小节与中英文字典', () => {
  const plugin = loadClientModule()
  assert.deepEqual(plugin.inject, ['slots', 'locale'])

  const dictionaries = []
  const registrations = []
  const ctx = {
    effect(setup) {
      return setup()
    },
    locale: {
      register(namespace, dicts) {
        dictionaries.push({ namespace, dicts })
        return () => {}
      },
      bind() {
        return (key) => key
      },
    },
    slots: {
      inject(slot, register) {
        assert.equal(slot, 'settings.section')
        register()
        return () => {}
      },
      register(options, component) {
        registrations.push({ options, component })
        return () => {}
      },
    },
  }

  plugin.apply(ctx)

  assert.equal(dictionaries.length, 1)
  assert.deepEqual(Object.keys(dictionaries[0].dicts).sort(), ['en', 'zh'])
  assert.ok(dictionaries[0].dicts.zh.nav.length > 0)
  assert.ok(dictionaries[0].dicts.en.nav.length > 0)

  assert.equal(registrations.length, 1)
  const { options, component } = registrations[0]
  assert.equal(options.name, 'settings.section')
  assert.equal(options.id, 'opencode-session')
  assert.equal(typeof options.order, 'number')
  assert.equal(options.label(), 'nav')
  const element = component()
  assert.equal(element.type.name, 'SettingsPage')
  assert.equal(typeof element.props.t, 'function')

  // 页面上的每个配置项都要有说明文案（这就是「每个配置项都显示说明」的保证）。
  for (const key of ['hostsDesc', 'headerDesc', 'valueDesc', 'overrideDesc', 'debugDesc']) {
    assert.ok(dictionaries[0].dicts.zh[key].length > 10, `缺少中文说明: ${key}`)
    assert.ok(dictionaries[0].dicts.en[key].length > 10, `缺少英文说明: ${key}`)
  }
})
