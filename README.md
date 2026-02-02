# 🔒 slopjail

`slopjail` is a sandbox for running untrusted JavaScript in the browser. It can be used to safely implement a code execution tool for browser-based AI agents, among other use cases.

> Status: Alpha ⚡

## Features

- Tiny (~3 KB gzipped)
- Simple API: `createSandbox()` → `run()` → `dispose()`.
- Expose variables and functions for untrusted code to access.
- Pretty good security:
    * Code runs in a Web Worker on an opaque origin: no access to the host page's storage, cookies, or DOM.
    * Network access is blocked by default using a strict [Content-Security-Policy](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/CSP).
    * Disables APIs like `navigator` to resist device fingerprinting.

## Quickstart

Install:

```
npm install slopjail
```

Create a sandbox, run some code, and clean up:

```typescript
import { createSandbox } from 'slopjail'

const sandbox = await createSandbox({
  globals: {
    twenty: 20,
    add: (a: number, b: number) => a + b,
  },
})

try {
  await sandbox.run('console.log(await add(twenty, 5))') // 25
} finally {
  sandbox.dispose()
}
```

## How it works

slopjail creates a hidden `<iframe>` with an opaque origin and a restrictive CSP. A small relay script inside the iframe spawns a Web Worker and bridges a `MessagePort` back to the host for RPC. Untrusted code runs in the Worker, completely isolated from the main page. Any functions you provide as globals are replaced with RPC proxies — when the sandbox calls them, they execute in the host context and the result is sent back.

```
Host (main thread)
 └─ iframe (sandbox="allow-scripts", opaque origin, strict CSP)
     └─ Worker (runs untrusted code)
         └─ RPC proxy functions → call back to host via MessagePort
```

## Advanced

### Nested globals

Objects are traversed recursively, so nested functions work the same way:

```typescript
const sandbox = await createSandbox({
  globals: {
    math: {
      add: (a: number, b: number) => a + b,
      multiply: (a: number, b: number) => a * b,
    },
    version: '1.0.0',
  },
})

try {
  await sandbox.run(`
    const sum = await math.add(2, 3)
    const product = await math.multiply(sum, 4)
    console.log(version, product) // "1.0.0" 20
  `)
} finally {
  sandbox.dispose()
}
```

### Content-Security-Policy

By default, the sandbox blocks all network access and resource loading:

Use the `contentSecurityPolicy` option to relax specific directives:

```typescript
const sandbox = await createSandbox({
  // Allow access to the GitHub API
  contentSecurityPolicy: "connect-src https://api.github.com",
})

await sandbox.run(`
  const res = await fetch('https://api.github.com/zen')
  console.log(await res.text())
`)
```

### Naming sandboxes

Give a sandbox a name for easier debugging:

```typescript
const sandbox = await createSandbox({
  name: `ai-code-tool-${Date.now()}`,
})
```

### Automatic disposal

`Sandbox` implements [`Symbol.dispose`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Statements/using), so you can use `using` to automatically clean up when leaving scope:

```typescript
using sandbox = await createSandbox()
await sandbox.run(code)
```

Which is equivalent to:

```typescript
const sandbox = await createSandbox()
try {
  await sandbox.run(code)
} finally {
  sandbox.dispose()
}
```

## FAQ

### How do I capture `console.log` messages?

Simply expose your own `console` global to capture them:

```typescript
const sandbox = await createSandbox({
  globals: {
    console: {
      log: (...args: unknown[]) => {
        document.getElementById('output')!.textContent += args.join(' ') + '\n'
      },
    },
  },
})

try {
  await sandbox.run('console.log("hello from the sandbox!")')
} finally {
  sandbox.dispose()
}
```

### How do I read global variables back out of the sandbox?

`run()` returns the return value of the code, so you can use a `return` statement:

```typescript
const sandbox = await createSandbox({
  globals: { fruit: ['apple', 'banana'] },
})

try {
  // First run some untrusted code that may modify the state
  await sandbox.run('fruit.push("cherry")')

  // Then query the updated state
  const updatedState = await sandbox.run('return fruit')
  console.log(updatedState); // ['apple', 'banana', 'cherry']
} finally {
  sandbox.dispose()
}
```

### How do I implement a timeout?

Untrusted code can run forever, so setting a timeout is a good idea. Call `dispose()` to tear down the sandbox if `run()` doesn't resolve in time:

```typescript
const sandbox = await createSandbox()

const timeout = new Promise((_, reject) =>
  setTimeout(() => reject(new Error('Timed out')), 5000),
)

try {
  await Promise.race([sandbox.run(code), timeout])
} finally {
  sandbox.dispose()
}
```

## API

### `createSandbox(opts): Promise<Sandbox>`

Create a new sandboxed execution environment.

**Options:**

| Option | Type | Description |
|---|---|---|
| `globals` | `Record<string, unknown>` | Variables and functions to expose inside the sandbox. |
| `contentSecurityPolicy` | `string` | Additional CSP directives appended to the default policy. |
| `name` | `string` | Name for debugging. |

### `Sandbox`

| Method | Description |
|---|---|
| `run(code: string): Promise<unknown>` | Execute JavaScript inside the sandbox. Supports top-level `await`. Returns the return value of the executed code. |
| `dispose(): void` | Terminate the worker and clean up all resources. |
