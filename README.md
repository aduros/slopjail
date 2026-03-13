# 🔒 slopjail

`slopjail` is a sandbox for running untrusted JavaScript in the browser. It can be used to safely implement a code execution tool for browser-based AI agents, among other use cases.

> Status: Alpha ⚡

## Features

- Tiny (~3 KB gzipped)
- Simple API: `createSandbox()` → `run()` → `dispose()`.
- Expose variables and functions for untrusted code to access.
- Pretty good security:
  - Code runs in a Web Worker on an opaque origin: no access to the host page's storage, cookies, or DOM.
  - Network access is blocked by default using a strict [Content-Security-Policy](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/CSP).
  - Disables APIs like `navigator` to resist device fingerprinting.

## Quickstart

Install:

```
npm install slopjail
```

Create a sandbox, run some code, and clean up:

```typescript
import { createSandbox } from "slopjail";

const sandbox = await createSandbox({
  globals: {
    twenty: 20,
    add: (a: number, b: number) => a + b,
  },
});

try {
  await sandbox.run("console.log(await add(twenty, 5))"); // 25
} finally {
  sandbox.dispose();
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
    version: "1.0.0",
  },
});

try {
  await sandbox.run(`
    const sum = await math.add(2, 3)
    const product = await math.multiply(sum, 4)
    console.log(version, product) // "1.0.0" 20
  `);
} finally {
  sandbox.dispose();
}
```

### Timeouts

`run()` enforces a 3-second execution timeout by default. If the code doesn't finish in time, the returned promise rejects with an error. You can override it per call:

```typescript
await sandbox.run(code, { timeout: 10_000 }); // 10 seconds
```

### Content-Security-Policy

By default, the sandbox blocks all network access.

Use the `contentSecurityPolicy` option to relax specific CSP directives:

```typescript
const sandbox = await createSandbox({
  contentSecurityPolicy: {
    // Allow access to the GitHub API
    connectSrc: ["https://api.github.com"],
  },
});

await sandbox.run(`
  const res = await fetch('https://api.github.com/zen')
  console.log(await res.text())
`);
```

You can allow ESM import statements by using `scriptSrc`:

```typescript
const sandbox = await createSandbox({
  contentSecurityPolicy: {
    // Allow importing ES modules from esm.sh
    scriptSrc: ["https://esm.sh"],
  },
});

await sandbox.run(`
  import _ from 'https://esm.sh/underscore'
  console.log(_.uniq([1, 2, 1, 4, 1, 3])) // [1, 2, 4, 3]
`);
```

### Naming sandboxes

Give a sandbox a name for easier debugging:

```typescript
const sandbox = await createSandbox({
  name: `ai-code-tool-${Date.now()}`,
});
```

### Automatic disposal

`Sandbox` implements [`Symbol.dispose`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Statements/using), so you can use `using` to automatically clean up when leaving scope:

```typescript
using sandbox = await createSandbox();
await sandbox.run(code);
```

Which is equivalent to:

```typescript
const sandbox = await createSandbox();
try {
  await sandbox.run(code);
} finally {
  sandbox.dispose();
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
        document.getElementById("output")!.textContent += args.join(" ") + "\n";
      },
    },
  },
});

try {
  await sandbox.run('console.log("hello from the sandbox!")');
} finally {
  sandbox.dispose();
}
```

### How do I read state back out of the sandbox?

You can either expose a global callback for sandboxed code to call, or use `evaluate()` to return the value of a JS expression:

```typescript
const sandbox = await createSandbox({
  // Globals are copied into the sandbox, references are not shared
  globals: { fruit: ["apple", "banana"] },
});

try {
  await sandbox.run('fruit.push("cherry")');

  const updatedFruit = await sandbox.evaluate("fruit");
  console.log(updatedFruit); // ['apple', 'banana', 'cherry']
} finally {
  sandbox.dispose();
}
```

## API

### `createSandbox(opts): Promise<Sandbox>`

Create a new sandboxed execution environment.

**Creation options:**

| Option                  | Type                      | Description                                               |
| ----------------------- | ------------------------- | --------------------------------------------------------- |
| `globals`               | `Record<string, unknown>` | Variables and functions to expose inside the sandbox.     |
| `contentSecurityPolicy` | `object`                  | Additional CSP directives appended to the default policy. |
| `name`                  | `string`                  | Name for debugging.                                       |

### `Sandbox`

| Method                                               | Description                                                                      |
| ---------------------------------------------------- | -------------------------------------------------------------------------------- |
| `run(code: string, options?): Promise<void>`         | Execute JavaScript inside the sandbox.                                           |
| `evaluate(expr: string, options?): Promise<unknown>` | Evaluate a single JavaScript expression inside the sandbox and return its value. |
| `dispose(): void`                                    | Terminate the worker and clean up all resources.                                 |

**Execution options:**

| Option    | Type     | Description                                                                                     |
| --------- | -------- | ----------------------------------------------------------------------------------------------- |
| `timeout` | `number` | Maximum time in milliseconds to wait before rejecting with a timeout error. Defaults to `3000`. |
