import { afterEach, describe, expect, test } from 'vitest'
import { createSandbox, type Sandbox } from '../src'
import { expression } from './testUtils'

let sandbox: Sandbox

afterEach(() => {
  sandbox?.dispose()
})

describe('global property isolation', () => {
  test.each([
    ['document'],
    ['window'],
    ['globalThis.parent'],
    ['globalThis.top'],
    ['globalThis.opener'],
    ['localStorage'],
    ['sessionStorage'],
    ['navigator'],
    ['location'],
    ['requestAnimationFrame'],
    ['name'],
    ['self.name'],
  ])('%s is undefined', async (property) => {
    sandbox = await createSandbox()
    await expect(expression(sandbox, `typeof ${property}`)).resolves.toBe(
      'undefined',
    )
  })
})

describe('network isolation (default CSP)', () => {
  test('cannot fetch external URLs', async () => {
    sandbox = await createSandbox()
    await expect(
      expression(sandbox, "await fetch('https://httpbin.org/get')"),
    ).rejects.toThrow()
  })

  test('XMLHttpRequest is blocked by CSP', async () => {
    sandbox = await createSandbox()
    await sandbox.run(`
      globalThis.__result = await new Promise((resolve) => {
        const xhr = new XMLHttpRequest()
        xhr.open('GET', 'https://httpbin.org/get')
        xhr.onerror = () => resolve('blocked')
        xhr.onload = () => resolve('allowed')
        xhr.send()
      })
    `)
    expect(await expression(sandbox, 'globalThis.__result')).toBe('blocked')
  })
})

describe('code import isolation', () => {
  test('cannot use import statements', async () => {
    sandbox = await createSandbox()
    await expect(
      sandbox.run('import _ from "https://esm.sh/underscore"'),
    ).rejects.toThrow()
  })

  test('cannot use dynamic import()', async () => {
    sandbox = await createSandbox()
    await expect(
      expression(sandbox, "await import('https://esm.sh/underscore')"),
    ).rejects.toThrow()
  })

  test('cannot use importScripts()', async () => {
    sandbox = await createSandbox()
    await expect(
      expression(
        sandbox,
        "importScripts('https://cdn.jsdelivr.net/npm/lodash@4.17.21/lodash.min.js')",
      ),
    ).rejects.toThrow()
  })
})

describe('global scope isolation', () => {
  test('only exposed globals are available', async () => {
    sandbox = await createSandbox({
      globals: { allowed: 'yes' },
    })
    expect(await expression(sandbox, 'allowed')).toBe('yes')
    await expect(expression(sandbox, 'notExposed')).rejects.toThrow()
  })

  test('cannot access host functions not explicitly exposed', async () => {
    // Set something on the host's globalThis
    ;(globalThis as Record<string, unknown>).__hostSecret = 'secret123'
    sandbox = await createSandbox()
    await expect(
      expression(sandbox, 'globalThis.__hostSecret'),
    ).resolves.toBeUndefined()
    delete (globalThis as Record<string, unknown>).__hostSecret
  })

  test('sandbox cannot modify host globalThis', async () => {
    sandbox = await createSandbox()
    await sandbox.run('globalThis.__injected = "hacked"')
    expect((globalThis as Record<string, unknown>).__injected).toBeUndefined()
  })
})

describe('prototype and constructor attacks', () => {
  test('cannot escape via Function constructor', async () => {
    sandbox = await createSandbox()
    // The Function constructor runs inside the Worker, not the host
    await expect(
      expression(sandbox, "new Function('return typeof document')()"),
    ).resolves.toBe('undefined')
  })

  test('cannot escape via eval', async () => {
    sandbox = await createSandbox()
    await expect(expression(sandbox, "eval('typeof document')")).resolves.toBe(
      'undefined',
    )
  })

  test('cannot pollute Object.prototype to affect host', async () => {
    sandbox = await createSandbox()
    await sandbox.run("Object.prototype.__polluted = 'yes'")
    expect(({} as Record<string, unknown>).__polluted).toBeUndefined()
  })

  test('cannot pollute Array.prototype to affect host', async () => {
    sandbox = await createSandbox()
    await sandbox.run("Array.prototype.__polluted = 'yes'")
    expect(
      ([] as unknown as Record<string, unknown>).__polluted,
    ).toBeUndefined()
  })
})

describe('exposed function safety', () => {
  test('sandbox cannot access host function source code', async () => {
    const secret = 'supersecret'
    sandbox = await createSandbox({
      globals: {
        fn: () => secret,
      },
    })
    // The fn in the sandbox is an RPC proxy, not the real function
    const source = await expression(sandbox, 'fn.toString()')
    expect(source).not.toContain('supersecret')
  })

  test('sandbox cannot modify exposed function behavior on host', async () => {
    let callCount = 0
    const increment = () => ++callCount
    sandbox = await createSandbox({ globals: { increment } })

    // Can't use expression() here as it calls the function twice (run + evaluate)
    await sandbox.run('await increment()')
    expect(callCount).toBe(1)

    // Try to overwrite in sandbox - should not affect host
    await sandbox.run('increment = () => 999')
    // The host function itself is unchanged
    expect(increment()).toBe(2)
  })

  test('sandbox cannot enumerate or access host methodsById', async () => {
    sandbox = await createSandbox({
      globals: {
        a: () => 'a',
        b: () => 'b',
      },
    })
    // Verify the sandbox can call a but has no way to call b via a's internals
    const result = await expression(sandbox, 'Object.getOwnPropertyNames(a)')
    // The proxy function should be a simple wrapper
    expect(result).not.toContain('methodsById')
  })
})

describe('iframe sandbox attribute', () => {
  test('iframe has sandbox attribute with only allow-scripts', async () => {
    sandbox = await createSandbox({ name: 'security-test-iframe' })
    const iframe = document.querySelector(
      'iframe[name="security-test-iframe"]',
    ) as HTMLIFrameElement
    expect(iframe).not.toBeNull()
    expect(iframe.sandbox.toString()).toBe('allow-scripts')
    expect(iframe.sandbox.contains('allow-same-origin')).toBe(false)
    expect(iframe.sandbox.contains('allow-forms')).toBe(false)
    expect(iframe.sandbox.contains('allow-popups')).toBe(false)
    expect(iframe.sandbox.contains('allow-top-navigation')).toBe(false)
  })

  test('iframe is hidden', async () => {
    sandbox = await createSandbox({ name: 'hidden-test-iframe' })
    const iframe = document.querySelector(
      'iframe[name="hidden-test-iframe"]',
    ) as HTMLIFrameElement
    expect(iframe.style.display).toBe('none')
  })
})

describe('fingerprinting prevention', () => {
  test('cannot recover navigator via prototype chain', async () => {
    sandbox = await createSandbox()
    await sandbox.run(`
      globalThis.__result = undefined
      let proto = Object.getPrototypeOf(self)
      while (proto) {
        const desc = Object.getOwnPropertyDescriptor(proto, 'navigator')
        if (desc) {
          globalThis.__result = desc.get ? desc.get.call(self) : desc.value
          break
        }
        proto = Object.getPrototypeOf(proto)
      }
    `)
    expect(await expression(sandbox, 'globalThis.__result')).toBeUndefined()
  })

  test('cannot recover navigator via __proto__', async () => {
    sandbox = await createSandbox()
    await sandbox.run(`
      globalThis.__result = undefined
      try {
        globalThis.__result = self.__proto__.__proto__.navigator
      } catch {}
    `)
    expect(await expression(sandbox, 'globalThis.__result')).toBeUndefined()
  })

  test('cannot recover location via prototype chain', async () => {
    sandbox = await createSandbox()
    await sandbox.run(`
      globalThis.__result = undefined
      let proto = Object.getPrototypeOf(self)
      while (proto) {
        const desc = Object.getOwnPropertyDescriptor(proto, 'location')
        if (desc) {
          globalThis.__result = desc.get ? desc.get.call(self) : desc.value
          break
        }
        proto = Object.getPrototypeOf(proto)
      }
    `)
    expect(await expression(sandbox, 'globalThis.__result')).toBeUndefined()
  })

  test('cannot recover name via prototype chain', async () => {
    sandbox = await createSandbox({ name: 'secret-sandbox' })
    await sandbox.run(`
      globalThis.__result = undefined
      let proto = Object.getPrototypeOf(self)
      while (proto) {
        const desc = Object.getOwnPropertyDescriptor(proto, 'name')
        if (desc) {
          globalThis.__result = desc.get ? desc.get.call(self) : desc.value
          break
        }
        proto = Object.getPrototypeOf(proto)
      }
    `)
    expect(await expression(sandbox, 'globalThis.__result')).toBeUndefined()
  })

  test('cannot recover navigator via constructor prototype', async () => {
    sandbox = await createSandbox()
    await sandbox.run(`
      globalThis.__result = undefined
      // Try accessing via the named global scope constructors
      for (const name of ['DedicatedWorkerGlobalScope', 'WorkerGlobalScope']) {
        const ctor = globalThis[name]
        if (ctor?.prototype) {
          const desc = Object.getOwnPropertyDescriptor(ctor.prototype, 'navigator')
          if (desc?.get) { globalThis.__result = desc.get.call(self); break }
          if (desc?.value) { globalThis.__result = desc.value; break }
        }
      }
    `)
    expect(await expression(sandbox, 'globalThis.__result')).toBeUndefined()
  })

  test('cannot recover navigator via Reflect.get on prototype', async () => {
    sandbox = await createSandbox()
    await sandbox.run(`
      globalThis.__result = undefined
      let proto = Object.getPrototypeOf(self)
      while (proto) {
        try {
          const val = Reflect.get(proto, 'navigator', self)
          if (val !== undefined) { globalThis.__result = val; break }
        } catch {}
        proto = Object.getPrototypeOf(proto)
      }
    `)
    expect(await expression(sandbox, 'globalThis.__result')).toBeUndefined()
  })

  test('cannot recover navigator via nested data: Worker', async () => {
    sandbox = await createSandbox()
    await sandbox.run(`
      globalThis.__result = '__blocked__'
      try {
        const code = 'postMessage(typeof navigator !== "undefined" && navigator.userAgent ? navigator.userAgent : "__blocked__")'
        const w = new Worker('data:,' + encodeURIComponent(code))
        globalThis.__result = await new Promise((resolve) => {
          w.onmessage = (e) => resolve(e.data)
          w.onerror = () => resolve('__blocked__')
          setTimeout(() => resolve('__blocked__'), 3000)
        })
      } catch {}
    `)
    expect(await expression(sandbox, 'globalThis.__result')).toBe('__blocked__')
  })
})

describe('Worker constructor recovery attempts', () => {
  test('cannot recover Worker via prototype chain', async () => {
    sandbox = await createSandbox()
    await sandbox.run(`
      globalThis.__result = 'not_found'
      // Walk the prototype chain looking for a Worker reference
      let proto = Object.getPrototypeOf(self)
      while (proto) {
        const desc = Object.getOwnPropertyDescriptor(proto, 'Worker')
        if (desc?.value) { globalThis.__result = 'found:' + typeof desc.value; break }
        if (desc?.get) { globalThis.__result = 'found:getter'; break }
        proto = Object.getPrototypeOf(proto)
      }
    `)
    expect(await expression(sandbox, 'globalThis.__result')).toBe('not_found')
  })

  test('cannot recover Worker via globalThis constructor', async () => {
    sandbox = await createSandbox()
    await sandbox.run(`
      globalThis.__result = 'not_found'
      // Try to find Worker on DedicatedWorkerGlobalScope or its prototypes
      const names = ['DedicatedWorkerGlobalScope', 'WorkerGlobalScope']
      for (const n of names) {
        const ctor = globalThis[n]
        if (ctor && ctor.Worker) { globalThis.__result = 'found:' + n + '.Worker'; break }
        if (ctor?.prototype?.Worker) { globalThis.__result = 'found:' + n + '.prototype.Worker'; break }
      }
      // Try self.constructor
      if (globalThis.__result === 'not_found' && self.constructor?.Worker) {
        globalThis.__result = 'found:self.constructor.Worker'
      }
    `)
    expect(await expression(sandbox, 'globalThis.__result')).toBe('not_found')
  })

  test('Worker and SharedWorker are not in globalThis', async () => {
    sandbox = await createSandbox()
    await expect(
      expression(
        sandbox,
        `({ Worker: typeof globalThis.Worker, SharedWorker: typeof globalThis.SharedWorker })`,
      ),
    ).resolves.toEqual({
      Worker: 'undefined',
      SharedWorker: 'undefined',
    })
  })
})

describe('CSP injection resistance', () => {
  test('CSP with HTML special characters is safely escaped', async () => {
    // If escaping fails, the iframe would break or allow injected content
    sandbox = await createSandbox({
      contentSecurityPolicy: {
        connectSrc: ['"> <script>location.href = "about:blank"</script>'],
      },
    })
    // If we reach here, the iframe was created safely without injection
    expect(await expression(sandbox, '1')).toBe(1)
  })
})
