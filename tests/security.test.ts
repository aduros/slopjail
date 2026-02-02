import { afterEach, describe, expect, test } from 'vitest'
import { createSandbox, type Sandbox } from '../src'

let sandbox: Sandbox

afterEach(() => {
  sandbox?.dispose()
})

describe('DOM and window isolation', () => {
  test('cannot access parent document', async () => {
    sandbox = await createSandbox()
    await expect(sandbox.run('return document')).rejects.toThrow()
  })

  test('cannot access parent window', async () => {
    sandbox = await createSandbox()
    // In a Worker, `window` is not defined
    await expect(
      sandbox.run(
        'if (typeof window !== "undefined") throw new Error("window accessible")',
      ),
    ).resolves.toBeUndefined()
  })

  test('cannot access parent via globalThis.parent', async () => {
    sandbox = await createSandbox()
    const result = await sandbox.run('return typeof parent')
    expect(result).toBe('undefined')
  })

  test('cannot access parent via globalThis.top', async () => {
    sandbox = await createSandbox()
    const result = await sandbox.run('return typeof top')
    expect(result).toBe('undefined')
  })

  test('cannot access parent via globalThis.opener', async () => {
    sandbox = await createSandbox()
    const result = await sandbox.run('return typeof opener')
    expect(result).toBe('undefined')
  })
})

describe('storage isolation', () => {
  test('cannot access localStorage', async () => {
    sandbox = await createSandbox()
    await expect(sandbox.run('return localStorage')).rejects.toThrow()
  })

  test('cannot access sessionStorage', async () => {
    sandbox = await createSandbox()
    await expect(sandbox.run('return sessionStorage')).rejects.toThrow()
  })

  test('cannot access indexedDB', async () => {
    sandbox = await createSandbox()
    // indexedDB may exist in Workers but the opaque origin should prevent use
    const result = await sandbox.run(`
      try {
        const req = indexedDB.open('test')
        return await new Promise((resolve, reject) => {
          req.onerror = () => resolve('blocked')
          req.onsuccess = () => resolve('allowed')
        })
      } catch (e) {
        return 'blocked'
      }
    `)
    expect(result).toBe('blocked')
  })

  test('cannot access cookies', async () => {
    sandbox = await createSandbox()
    // document is not available in Worker, so cookies are inaccessible
    await expect(sandbox.run('return document.cookie')).rejects.toThrow()
  })
})

describe('network isolation (default CSP)', () => {
  test('cannot fetch external URLs', async () => {
    sandbox = await createSandbox()
    await expect(
      sandbox.run("await fetch('https://httpbin.org/get')"),
    ).rejects.toThrow()
  })

  test('XMLHttpRequest is blocked by CSP', async () => {
    sandbox = await createSandbox()
    const result = await sandbox.run(`
      return await new Promise((resolve) => {
        const xhr = new XMLHttpRequest()
        xhr.open('GET', 'https://httpbin.org/get')
        xhr.onerror = () => resolve('blocked')
        xhr.onload = () => resolve('allowed')
        xhr.send()
      })
    `)
    expect(result).toBe('blocked')
  })
})

describe('code import isolation', () => {
  test('cannot use dynamic import()', async () => {
    sandbox = await createSandbox()
    await expect(
      sandbox.run(
        "await import('https://cdn.jsdelivr.net/npm/lodash@4.17.21/lodash.min.js')",
      ),
    ).rejects.toThrow()
  })

  test('cannot importScripts', async () => {
    sandbox = await createSandbox()
    await expect(
      sandbox.run(
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
    expect(await sandbox.run('return allowed')).toBe('yes')
    await expect(sandbox.run('return notExposed')).rejects.toThrow()
  })

  test('cannot access host functions not explicitly exposed', async () => {
    // Set something on the host's globalThis
    ;(globalThis as Record<string, unknown>).__hostSecret = 'secret123'
    sandbox = await createSandbox()
    await expect(
      sandbox.run('return globalThis.__hostSecret'),
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
    const result = await sandbox.run(`
      const fn = new Function('return typeof document')
      return fn()
    `)
    expect(result).toBe('undefined')
  })

  test('cannot escape via eval', async () => {
    sandbox = await createSandbox()
    const result = await sandbox.run(`
      return eval('typeof document')
    `)
    expect(result).toBe('undefined')
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
    const source = await sandbox.run('return fn.toString()')
    expect(source).not.toContain('supersecret')
  })

  test('sandbox cannot modify exposed function behavior on host', async () => {
    let callCount = 0
    const increment = () => ++callCount
    sandbox = await createSandbox({ globals: { increment } })

    await sandbox.run('return await increment()')
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
    const result = await sandbox.run(`
      // Try to inspect the function to find references to other methods
      const keys = Object.getOwnPropertyNames(a)
      return keys
    `)
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
  test('navigator is undefined', async () => {
    sandbox = await createSandbox()
    expect(await sandbox.run('return typeof navigator')).toBe('undefined')
  })

  test('cannot read navigator.userAgent', async () => {
    sandbox = await createSandbox()
    await expect(sandbox.run('return navigator.userAgent')).rejects.toThrow()
  })

  test('location is undefined', async () => {
    sandbox = await createSandbox()
    expect(await sandbox.run('return typeof location')).toBe('undefined')
  })

  test('cannot read location.href', async () => {
    sandbox = await createSandbox()
    await expect(sandbox.run('return location.href')).rejects.toThrow()
  })

  test('requestAnimationFrame is undefined', async () => {
    sandbox = await createSandbox()
    expect(await sandbox.run('return typeof requestAnimationFrame')).toBe(
      'undefined',
    )
  })

  test('Worker name is undefined', async () => {
    sandbox = await createSandbox({ name: 'secret-sandbox' })
    expect(await sandbox.run('return typeof name')).toBe('undefined')
    expect(await sandbox.run('return self.name')).toBeUndefined()
    expect(await sandbox.run('return name')).toBeUndefined()
  })

  test('cannot recover navigator via prototype chain', async () => {
    sandbox = await createSandbox()
    const result = await sandbox.run(`
      let proto = Object.getPrototypeOf(self)
      while (proto) {
        const desc = Object.getOwnPropertyDescriptor(proto, 'navigator')
        if (desc) {
          if (desc.get) return desc.get.call(self)
          return desc.value
        }
        proto = Object.getPrototypeOf(proto)
      }
      return undefined
    `)
    expect(result).toBeUndefined()
  })

  test('cannot recover navigator via __proto__', async () => {
    sandbox = await createSandbox()
    const result = await sandbox.run(`
      try {
        return self.__proto__.__proto__.navigator
      } catch { return undefined }
    `)
    expect(result).toBeUndefined()
  })

  test('cannot recover location via prototype chain', async () => {
    sandbox = await createSandbox()
    const result = await sandbox.run(`
      let proto = Object.getPrototypeOf(self)
      while (proto) {
        const desc = Object.getOwnPropertyDescriptor(proto, 'location')
        if (desc) {
          if (desc.get) return desc.get.call(self)
          return desc.value
        }
        proto = Object.getPrototypeOf(proto)
      }
      return undefined
    `)
    expect(result).toBeUndefined()
  })

  test('cannot recover name via prototype chain', async () => {
    sandbox = await createSandbox({ name: 'secret-sandbox' })
    const result = await sandbox.run(`
      let proto = Object.getPrototypeOf(self)
      while (proto) {
        const desc = Object.getOwnPropertyDescriptor(proto, 'name')
        if (desc) {
          if (desc.get) return desc.get.call(self)
          return desc.value
        }
        proto = Object.getPrototypeOf(proto)
      }
      return undefined
    `)
    expect(result).toBeUndefined()
  })

  test('cannot recover navigator via constructor prototype', async () => {
    sandbox = await createSandbox()
    const result = await sandbox.run(`
      // Try accessing via the named global scope constructors
      for (const name of ['DedicatedWorkerGlobalScope', 'WorkerGlobalScope']) {
        const ctor = globalThis[name]
        if (ctor?.prototype) {
          const desc = Object.getOwnPropertyDescriptor(ctor.prototype, 'navigator')
          if (desc?.get) return desc.get.call(self)
          if (desc?.value) return desc.value
        }
      }
      return undefined
    `)
    expect(result).toBeUndefined()
  })

  test('cannot recover navigator via Reflect.get on prototype', async () => {
    sandbox = await createSandbox()
    const result = await sandbox.run(`
      let proto = Object.getPrototypeOf(self)
      while (proto) {
        try {
          const val = Reflect.get(proto, 'navigator', self)
          if (val !== undefined) return val
        } catch {}
        proto = Object.getPrototypeOf(proto)
      }
      return undefined
    `)
    expect(result).toBeUndefined()
  })

  test('cannot recover navigator via nested data: Worker', async () => {
    sandbox = await createSandbox()
    const result = await sandbox.run(`
      try {
        const code = 'postMessage(typeof navigator !== "undefined" && navigator.userAgent ? navigator.userAgent : "__blocked__")'
        const w = new Worker('data:,' + encodeURIComponent(code))
        return await new Promise((resolve, reject) => {
          w.onmessage = (e) => resolve(e.data)
          w.onerror = () => resolve('__blocked__')
          setTimeout(() => resolve('__blocked__'), 3000)
        })
      } catch {
        return '__blocked__'
      }
    `)
    expect(result).toBe('__blocked__')
  })
})

describe('Worker constructor recovery attempts', () => {
  test('cannot recover Worker via prototype chain', async () => {
    sandbox = await createSandbox()
    const result = await sandbox.run(`
      // Walk the prototype chain looking for a Worker reference
      let proto = Object.getPrototypeOf(self)
      while (proto) {
        const desc = Object.getOwnPropertyDescriptor(proto, 'Worker')
        if (desc?.value) return 'found:' + typeof desc.value
        if (desc?.get) return 'found:getter'
        proto = Object.getPrototypeOf(proto)
      }
      return 'not_found'
    `)
    expect(result).toBe('not_found')
  })

  test('cannot recover Worker via globalThis constructor', async () => {
    sandbox = await createSandbox()
    const result = await sandbox.run(`
      // Try to find Worker on DedicatedWorkerGlobalScope or its prototypes
      const names = ['DedicatedWorkerGlobalScope', 'WorkerGlobalScope']
      for (const n of names) {
        const ctor = globalThis[n]
        if (ctor && ctor.Worker) return 'found:' + n + '.Worker'
        if (ctor?.prototype?.Worker) return 'found:' + n + '.prototype.Worker'
      }
      // Try self.constructor
      if (self.constructor?.Worker) return 'found:self.constructor.Worker'
      return 'not_found'
    `)
    expect(result).toBe('not_found')
  })

  test('Worker and SharedWorker are not in globalThis', async () => {
    sandbox = await createSandbox()
    const result = await sandbox.run(`
      return {
        Worker: typeof globalThis.Worker,
        SharedWorker: typeof globalThis.SharedWorker,
      }
    `)
    expect(result).toEqual({
      Worker: 'undefined',
      SharedWorker: 'undefined',
    })
  })
})

describe('CSP injection resistance', () => {
  test('CSP with HTML special characters is safely escaped', async () => {
    // If escaping fails, the iframe would break or allow injected content
    sandbox = await createSandbox({
      contentSecurityPolicy:
        '"> <script>location.href = "about:blank"</script>',
    })
    // If we reach here, the iframe was created safely without injection
    expect(await sandbox.run('return 1')).toBe(1)
  })
})
