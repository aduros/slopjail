import {
  createWorkerClient,
  createWorkerServer,
  type Service,
} from 'shrimp-rpc'
import type { HostService } from './host'

export type GuestService = Service<{
  setGlobals(params: {
    constants: Record<string, unknown>
    methods: Record<string, unknown>
  }): void

  run(params: { code: string }): unknown
}>

const hostClient = createWorkerClient<HostService>(self)

const AsyncFunction = (async () => {}).constructor as FunctionConstructor

createWorkerServer<GuestService>(self, {
  setGlobals({ constants, methods }) {
    function injectMethods(
      methods: Record<string, unknown>,
      dest: Record<string, unknown>,
    ) {
      for (const [key, value] of Object.entries(methods)) {
        if (typeof value === 'object') {
          if (value) {
            const child = {}
            dest[key] = child
            injectMethods(value as Record<string, unknown>, child)
          }
        } else if (typeof value === 'number') {
          dest[key] = (...params: unknown[]) => {
            return hostClient.call('onMethod', { methodId: value, params })
          }
        }
      }
    }
    injectMethods(methods, constants)

    for (const [key, value] of Object.entries(constants)) {
      ;(globalThis as Record<string, unknown>)[key] = value
    }
  },

  run({ code }) {
    const fn = new AsyncFunction(code)
    return fn()
  },
})
