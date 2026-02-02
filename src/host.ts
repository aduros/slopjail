import {
  createMessagePortClient,
  createMessagePortServer,
  type Service,
} from 'shrimp-rpc'
import iframeSource from './iframe?bundled'
import { escapeHtml } from './utils'
import type { GuestService } from './worker'
import workerSource from './worker?bundled'

export type HostService = Service<{
  onMethod(params: { methodId: number; params: unknown[] }): unknown
}>

/**
 * Options for creating a sandboxed execution environment.
 */
export type CreateSandboxOptions = {
  /**
   * Variables and functions to expose inside the sandbox as globals.
   *
   * - **Functions** are extracted and executed in the host context; the sandbox
   *   receives transparent RPC proxies so calls cross the boundary seamlessly.
   * - **Objects** are traversed recursively so nested functions are handled the
   *   same way.
   * - **Primitive values** are passed through as-is.
   */
  globals?: Record<string, unknown>

  /**
   * Additional Content-Security-Policy directives appended to the default
   * policy. The default CSP is:
   *
   * ```
   * default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; worker-src data:;
   * ```
   *
   * @example Allow fetch requests to the GitHub API:
   * ```typescript
   * const sandbox = await createSandbox({
   *   contentSecurityPolicy: "connect-src https://api.github.com",
   * })
   * ```
   */
  contentSecurityPolicy?: string

  /**
   * An optional name for the sandbox to aid in debugging. Used as the iframe's and worker's name.
   */
  name?: string
}

/**
 * A sandboxed execution environment.
 *
 * Code executed inside the sandbox runs in an isolated Web Worker hosted by a
 * sandboxed iframe with a restrictive Content-Security-Policy. Functions
 * provided via {@link CreateSandboxOptions.globals} are callable from inside
 * the sandbox but execute in the host context.
 */
export type Sandbox = {
  /**
   * Execute arbitrary JavaScript code inside the sandbox.
   *
   * The code string is compiled as an async function body, so top-level
   * `await` is supported. All globals provided at creation time are available.
   *
   * @param code - JavaScript source code to execute.
   * @returns The return value of the executed code.
   */
  run(code: string): Promise<unknown>

  /**
   * Destroy the sandbox, terminating its worker and removing the backing
   * iframe from the DOM.
   */
  dispose(): void

  [Symbol.dispose](): void
}

/**
 * Create a new sandboxed execution environment.
 *
 * Sets up a hidden iframe with a strict Content-Security-Policy and spawns a
 * Web Worker inside it. Functions provided in `opts.globals` are extracted and
 * replaced with RPC proxies so they execute in the host context when called
 * from inside the sandbox.
 *
 * @param opts - Sandbox configuration.
 * @returns A {@link Sandbox} handle for running code and cleaning up.
 *
 * @example
 * ```typescript
 * await using sandbox = await createSandbox({
 *   globals: {
 *     add: (a: number, b: number) => a + b,
 *   },
 * })
 *
 * await sandbox.run('console.log(await add(1, 2))')
 * ```
 */
export async function createSandbox(
  opts?: CreateSandboxOptions,
): Promise<Sandbox> {
  // biome-ignore lint/complexity/noBannedTypes: false positive
  const methodsById: Array<Function> = []

  function extractMethods(source: Record<string, unknown>): {
    constants: Record<string, unknown>
    methods: Record<string, unknown>
  } {
    const constants: Record<string, unknown> = {}
    const methods: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(source)) {
      switch (typeof value) {
        case 'function':
          methods[key] = methodsById.length
          methodsById.push(value)
          break
        case 'object': {
          if (value != null) {
            const child = extractMethods(value as Record<string, unknown>)
            constants[key] = child.constants
            if (Object.keys(child.methods).length > 0) {
              methods[key] = child.methods
            }
          } else {
            constants[key] = value
          }
          break
        }
        default:
          constants[key] = value
          break
      }
    }
    return { constants, methods }
  }

  const { constants, methods } = extractMethods(opts?.globals ?? {})

  const channel = new MessageChannel()
  const name = opts?.name ?? 'slopjail'

  const iframe = await new Promise<HTMLIFrameElement>((resolve, reject) => {
    const iframe = document.createElement('iframe')
    iframe.sandbox = 'allow-scripts'
    iframe.name = name

    const fullContentSecurityPolicy = `default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; worker-src data:; ${opts?.contentSecurityPolicy ?? ''}`
    const safeIframeSource = iframeSource.replaceAll('</script', '<\\/script')
    iframe.srcdoc = `<head><meta http-equiv="Content-Security-Policy" content="${escapeHtml(fullContentSecurityPolicy)}"></head><body><script>${safeIframeSource}</script></body>`

    iframe.addEventListener('load', () => {
      // biome-ignore lint/style/noNonNullAssertion: fail fast if contentWindow is ever null here
      iframe.contentWindow!.postMessage(
        { type: 'slopjail:init', name, workerSource },
        '*',
        [channel.port1],
      )
      resolve(iframe)
    })
    iframe.addEventListener('error', reject)

    iframe.style.display = 'none'
    document.body.appendChild(iframe)
  })

  const port = channel.port2
  port.start()

  createMessagePortServer<HostService>(port, {
    onMethod({ methodId, params }) {
      if (typeof methodId === 'number') {
        return methodsById[methodId](...params)
      }
    },
  })

  const guestClient = createMessagePortClient<GuestService>(port)
  await guestClient.call('setGlobals', { constants, methods })

  const dispose = () => {
    port.close()
    iframe.remove()
  }

  return {
    run(code) {
      return guestClient.call('run', { code })
    },
    dispose,
    [Symbol.dispose]: dispose,
  }
}
