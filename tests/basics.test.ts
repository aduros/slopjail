import { afterEach, describe, expect, test, vi } from 'vitest'
import { createSandbox, type Sandbox } from '../src'

let sandbox: Sandbox

afterEach(() => {
  sandbox?.dispose()
})

describe('code execution', () => {
  test('returns a primitive value', async () => {
    sandbox = await createSandbox()
    expect(await sandbox.run('return 123')).toBe(123)
  })

  test('returns a string', async () => {
    sandbox = await createSandbox()
    expect(await sandbox.run('return "hello"')).toBe('hello')
  })

  test('returns a boolean', async () => {
    sandbox = await createSandbox()
    expect(await sandbox.run('return true')).toBe(true)
  })

  test('returns null', async () => {
    sandbox = await createSandbox()
    expect(await sandbox.run('return null')).toBe(null)
  })

  test('returns undefined when no return statement', async () => {
    sandbox = await createSandbox()
    expect(await sandbox.run('1 + 1')).toBeUndefined()
  })

  test('returns an object', async () => {
    sandbox = await createSandbox()
    expect(await sandbox.run('return { a: 1, b: "two" }')).toEqual({
      a: 1,
      b: 'two',
    })
  })

  test('returns an array', async () => {
    sandbox = await createSandbox()
    expect(await sandbox.run('return [1, 2, 3]')).toEqual([1, 2, 3])
  })

  test('supports top-level await', async () => {
    sandbox = await createSandbox()
    const result = await sandbox.run(`
      const value = await Promise.resolve(42)
      return value
    `)
    expect(result).toBe(42)
  })

  test('runs multiple executions sequentially', async () => {
    sandbox = await createSandbox()
    expect(await sandbox.run('return 1')).toBe(1)
    expect(await sandbox.run('return 2')).toBe(2)
    expect(await sandbox.run('return 3')).toBe(3)
  })

  test('preserves global state across runs', async () => {
    sandbox = await createSandbox()
    await sandbox.run('globalThis.__counter = 1')
    await sandbox.run('globalThis.__counter += 1')
    expect(await sandbox.run('return globalThis.__counter')).toBe(2)
  })

  test('propagates synchronous errors', async () => {
    sandbox = await createSandbox()
    await expect(sandbox.run('throw new Error("boom")')).rejects.toThrow()
  })

  test('propagates async errors', async () => {
    sandbox = await createSandbox()
    await expect(
      sandbox.run('await Promise.reject(new Error("async boom"))'),
    ).rejects.toThrow()
  })

  test('propagates syntax errors', async () => {
    sandbox = await createSandbox()
    await expect(sandbox.run('return {{')).rejects.toThrow()
  })
})

describe('globals', () => {
  test('exposes primitive constants', async () => {
    sandbox = await createSandbox({
      globals: {
        myNumber: 42,
        myString: 'hello',
        myBool: true,
        myNull: null,
      },
    })
    expect(await sandbox.run('return myNumber')).toBe(42)
    expect(await sandbox.run('return myString')).toBe('hello')
    expect(await sandbox.run('return myBool')).toBe(true)
    expect(await sandbox.run('return myNull')).toBe(null)
  })

  test('exposes synchronous functions', async () => {
    sandbox = await createSandbox({
      globals: {
        add: (a: number, b: number) => a + b,
      },
    })
    expect(await sandbox.run('return await add(2, 3)')).toBe(5)
  })

  test('exposes async functions', async () => {
    sandbox = await createSandbox({
      globals: {
        fetchValue: async () => 'async-result',
      },
    })
    expect(await sandbox.run('return await fetchValue()')).toBe('async-result')
  })

  test('exposes nested objects with functions', async () => {
    sandbox = await createSandbox({
      globals: {
        math: {
          add: (a: number, b: number) => a + b,
          multiply: (a: number, b: number) => a * b,
        },
      },
    })
    expect(await sandbox.run('return await math.add(2, 3)')).toBe(5)
    expect(await sandbox.run('return await math.multiply(4, 5)')).toBe(20)
  })

  test('exposes nested objects with constants only', async () => {
    sandbox = await createSandbox({
      globals: {
        config: {
          version: 1,
          name: 'test',
        },
      },
    })
    expect(await sandbox.run('return config.version')).toBe(1)
    expect(await sandbox.run('return config.name')).toBe('test')
  })

  test('deeply nested objects', async () => {
    sandbox = await createSandbox({
      globals: {
        a: {
          b: {
            c: {
              getValue: () => 'deep',
            },
          },
        },
      },
    })
    expect(await sandbox.run('return await a.b.c.getValue()')).toBe('deep')
  })

  test('host functions receive correct arguments', async () => {
    const fn = vi.fn((...args: unknown[]) => args)
    sandbox = await createSandbox({ globals: { fn } })
    const result = await sandbox.run('return await fn(1, "two", true, null)')
    expect(result).toEqual([1, 'two', true, null])
    expect(fn).toHaveBeenCalledWith(1, 'two', true, null)
  })

  test('host function errors propagate to sandbox', async () => {
    sandbox = await createSandbox({
      globals: {
        fail: () => {
          throw new Error('host error')
        },
      },
    })
    await expect(sandbox.run('return await fail()')).rejects.toThrow()
  })

  test('works with no globals', async () => {
    sandbox = await createSandbox()
    expect(await sandbox.run('return 1 + 1')).toBe(2)
  })

  test('works with empty globals object', async () => {
    sandbox = await createSandbox({ globals: {} })
    expect(await sandbox.run('return 1 + 1')).toBe(2)
  })
})

describe('lifecycle', () => {
  test('dispose removes the iframe from the DOM', async () => {
    sandbox = await createSandbox()
    expect(document.querySelectorAll('iframe').length).toBe(1)
    sandbox.dispose()
    expect(document.querySelectorAll('iframe').length).toBe(0)
  })

  test('Symbol.dispose works', async () => {
    sandbox = await createSandbox()
    expect(document.querySelectorAll('iframe').length).toBe(1)
    sandbox[Symbol.dispose]()
    expect(document.querySelectorAll('iframe').length).toBe(0)
  })

  test('dispose can be called multiple times safely', async () => {
    sandbox = await createSandbox()
    sandbox.dispose()
    sandbox.dispose()
  })

  test('run after dispose rejects with an error', async () => {
    sandbox = await createSandbox()
    sandbox.dispose()
    await expect(sandbox.run('return 1')).rejects.toThrow(
      'Sandbox has been disposed',
    )
  })

  test('dispose during run rejects the pending promise', async () => {
    sandbox = await createSandbox()
    const pending = sandbox.run('await new Promise(() => {})')
    sandbox.dispose()
    await expect(pending).rejects.toThrow('Sandbox has been disposed')
  })
})

describe('options', () => {
  test('custom name is applied', async () => {
    sandbox = await createSandbox({ name: 'my-test-sandbox' })
    const iframe = document.querySelector(
      'iframe[name="my-test-sandbox"]',
    ) as HTMLIFrameElement
    expect(iframe).not.toBeNull()
  })

  test('default name is slopjail', async () => {
    sandbox = await createSandbox()
    const iframe = document.querySelector(
      'iframe[name="slopjail"]',
    ) as HTMLIFrameElement
    expect(iframe).not.toBeNull()
  })

  test('custom CSP allows network access', async () => {
    sandbox = await createSandbox({
      contentSecurityPolicy: 'connect-src https://httpbin.org',
    })
    const result = await sandbox.run(`
      const res = await fetch('https://httpbin.org/get')
      return res.ok
    `)
    expect(result).toBe(true)
  })
})

describe('multiple sandboxes', () => {
  test('sandboxes are isolated from each other', async () => {
    const sandbox1 = await createSandbox()
    const sandbox2 = await createSandbox()

    await sandbox1.run('globalThis.__value = "from-1"')
    await sandbox2.run('globalThis.__value = "from-2"')

    expect(await sandbox1.run('return globalThis.__value')).toBe('from-1')
    expect(await sandbox2.run('return globalThis.__value')).toBe('from-2')

    sandbox1.dispose()
    sandbox2.dispose()
  })
})
