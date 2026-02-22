import { afterEach, describe, expect, test, vi } from 'vitest'
import { createSandbox, type Sandbox } from '../src'
import { expression } from './testUtils'

let sandbox: Sandbox

afterEach(() => {
  sandbox?.dispose()
})

describe('code execution', () => {
  test('returns a primitive value', async () => {
    sandbox = await createSandbox()
    expect(await expression(sandbox, '123')).toBe(123)
  })

  test('returns a string', async () => {
    sandbox = await createSandbox()
    expect(await expression(sandbox, '"hello"')).toBe('hello')
    expect(await expression(sandbox, '"emojis 🍕🍕🍕"')).toBe('emojis 🍕🍕🍕')
  })

  test('returns a boolean', async () => {
    sandbox = await createSandbox()
    expect(await expression(sandbox, 'true')).toBe(true)
  })

  test('returns a bigint', async () => {
    sandbox = await createSandbox()
    expect(await expression(sandbox, '123n')).toEqual(123n)
  })

  test('returns a RegExp', async () => {
    sandbox = await createSandbox()
    expect(await expression(sandbox, '/test/')).toEqual(/test/)
  })

  test('returns null', async () => {
    sandbox = await createSandbox()
    expect(await expression(sandbox, 'null')).toBe(null)
  })

  test('returns an object', async () => {
    sandbox = await createSandbox()
    expect(await expression(sandbox, '{ a: 1, b: "two" }')).toEqual({
      a: 1,
      b: 'two',
    })
  })

  test('returns an array', async () => {
    sandbox = await createSandbox()
    expect(await expression(sandbox, '[1, 2, 3]')).toEqual([1, 2, 3])
  })

  test('supports top-level await', async () => {
    sandbox = await createSandbox()
    await expect(
      expression(sandbox, 'await Promise.resolve(42)'),
    ).resolves.toBe(42)
  })

  test('runs multiple executions sequentially', async () => {
    sandbox = await createSandbox()
    expect(await expression(sandbox, '1')).toBe(1)
    expect(await expression(sandbox, '2')).toBe(2)
    expect(await expression(sandbox, '3')).toBe(3)
  })

  test('preserves global state across runs', async () => {
    sandbox = await createSandbox()
    await sandbox.run('globalThis.__counter = 1')
    await sandbox.run('globalThis.__counter += 1')
    expect(await expression(sandbox, 'globalThis.__counter')).toBe(2)
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
    await expect(sandbox.run('const x = {')).rejects.toThrow()
    await expect(expression(sandbox, '}}')).rejects.toThrow()
  })

  test('propagates serialization errors', async () => {
    sandbox = await createSandbox()
    await expect(
      expression(sandbox, 'new URL("https://test.invalid")'),
    ).rejects.toThrow('not be cloned')
  })

  test('uses strict mode JS', async () => {
    sandbox = await createSandbox()
    await expect(expression(sandbox, 'notFound = 666')).rejects.toThrow()
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
    expect(await expression(sandbox, 'myNumber')).toBe(42)
    expect(await expression(sandbox, 'myString')).toBe('hello')
    expect(await expression(sandbox, 'myBool')).toBe(true)
    expect(await expression(sandbox, 'myNull')).toBe(null)
  })

  test('exposes synchronous functions', async () => {
    sandbox = await createSandbox({
      globals: {
        add: (a: number, b: number) => a + b,
      },
    })
    expect(await expression(sandbox, 'await add(2, 3)')).toBe(5)
  })

  test('exposes async functions', async () => {
    sandbox = await createSandbox({
      globals: {
        fetchValue: async () => 'async-result',
      },
    })
    expect(await expression(sandbox, 'await fetchValue()')).toBe('async-result')
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
    expect(await expression(sandbox, 'await math.add(2, 3)')).toBe(5)
    expect(await expression(sandbox, 'await math.multiply(4, 5)')).toBe(20)
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
    expect(await expression(sandbox, 'config.version')).toBe(1)
    expect(await expression(sandbox, 'config.name')).toBe('test')
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
    expect(await expression(sandbox, 'await a.b.c.getValue()')).toBe('deep')
  })

  test('host functions receive correct arguments', async () => {
    const fn = vi.fn((...args: unknown[]) => args)
    sandbox = await createSandbox({ globals: { fn } })
    const result = await expression(sandbox, 'await fn(1, "two", true, null)')
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
    await expect(expression(sandbox, 'await fail()')).rejects.toThrow(
      'host error',
    )
  })

  test('works with no globals', async () => {
    sandbox = await createSandbox()
    expect(await expression(sandbox, '1 + 1')).toBe(2)
  })

  test('works with empty globals object', async () => {
    sandbox = await createSandbox({ globals: {} })
    expect(await expression(sandbox, '1 + 1')).toBe(2)
  })

  test('skips unserializable globals', async () => {
    // Hmmm, not sure if this is correct
    sandbox = await createSandbox({
      globals: { url: new URL('https://test.invalid') },
    })
    expect(await expression(sandbox, 'url.href')).toBeUndefined()
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
    await expect(sandbox.run('1')).rejects.toThrow('Sandbox has been disposed')
  })

  test('dispose during run rejects the pending promise', async () => {
    sandbox = await createSandbox()
    const pending = sandbox.run('await new Promise(() => {})', {
      timeout: 10_000,
    })
    sandbox.dispose()
    await expect(pending).rejects.toThrow('Sandbox has been disposed')
  })
})

describe('timeout', () => {
  test('rejects with timeout error when code exceeds the timeout', async () => {
    sandbox = await createSandbox()
    await expect(
      sandbox.run('await new Promise(() => {})', { timeout: 50 }),
    ).rejects.toThrow('Execution timed out')
  })

  test('does not reject when code finishes before the timeout', async () => {
    sandbox = await createSandbox()
    const result = await expression(sandbox, '42', { timeout: 5000 })
    expect(result).toBe(42)
  })

  test('dispose during timed run rejects with disposed error', async () => {
    sandbox = await createSandbox()
    const pending = sandbox.run('await new Promise(() => {})', {
      timeout: 5000,
    })
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
      contentSecurityPolicy: {
        connectSrc: ['https://httpbin.org'],
      },
    })
    await expect(
      expression(sandbox, '(await fetch("https://httpbin.org/get")).ok'),
    ).resolves.toBe(true)
  })

  test('custom CSP allows remote imports', async () => {
    sandbox = await createSandbox({
      contentSecurityPolicy: {
        scriptSrc: ['https://esm.sh'],
      },
    })
    await sandbox.run(`
      import _ from "https://esm.sh/underscore"
      globalThis.__result = _.uniq([1, 2, 1, 4, 1, 3]);
    `)
    await expect(
      sandbox.evaluate('globalThis.__result'),
    ).resolves.toStrictEqual([1, 2, 4, 3])
  })
})

describe('multiple sandboxes', () => {
  test('sandboxes are isolated from each other', async () => {
    const sandbox1 = await createSandbox()
    const sandbox2 = await createSandbox()

    await sandbox1.run('globalThis.__value = "from-1"')
    await sandbox2.run('globalThis.__value = "from-2"')

    expect(await sandbox1.evaluate('globalThis.__value')).toBe('from-1')
    expect(await sandbox2.evaluate('globalThis.__value')).toBe('from-2')

    sandbox1.dispose()
    sandbox2.dispose()
  })
})
