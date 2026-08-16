import test from 'node:test'
import assert from 'node:assert/strict'

let handoff
globalThis.window = {
  __ModuleLoader__: {
    load(record) {
      handoff = record
    },
  },
}

const clientModule = await import('../lib/client.js')

test('client bundle registers a settings.plugin.item card', () => {
  assert.ok(handoff, 'lib/client.js must call window.__ModuleLoader__.load')
  assert.equal(handoff.id, 'dsh-auto-compact')

  const React = {
    useCallback: (callback) => callback,
    useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
    useState: (initial) => [initial, () => {}],
    useEffect: () => {},
    createElement: (type, props, ...children) => ({ type, props, children }),
  }

  const exports = handoff.factory((specifier) => {
    assert.equal(specifier, 'react')
    return React
  })

  assert.deepEqual(exports.inject, ['slots', 'locale'])
  assert.equal(typeof exports.apply, 'function')

  let injectedSlot
  let registration
  const ctx = {
    effect: (callback) => callback(),
    locale: {
      register: () => {},
      bind: () => (key) => key,
    },
    slots: {
      inject: (slot, provider) => {
        injectedSlot = slot
        registration = provider()
      },
      register: (options, render) => ({ options, render }),
    },
  }

  exports.apply(ctx)
  assert.equal(injectedSlot, 'settings.plugin.item')
  assert.equal(registration.options.name, 'settings.plugin.item')
  assert.equal(registration.options.id, 'auto-compact')
  assert.equal(typeof registration.render, 'function')

  // Rendering is smoke-tested with the fake React above; the real render path
  // is exercised by the browser card and the served bundle test in the web UI.
  const element = registration.render({ t: (key) => key })
  assert.ok(element)
})
