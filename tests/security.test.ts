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
