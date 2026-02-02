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

// Block certain APIs that could be used for fingerprinting.
// We must also delete getters from the prototype chain, otherwise sandboxed
// code can recover them via Object.getOwnPropertyDescriptor on the prototype.
const blocked = [
  'name',
  'navigator',
  'location',
  'requestAnimationFrame',

  // We need to block nested Worker creation since a child Worker would get a
  // fresh global scope with unblocked APIs.
  'Worker',
  'SharedWorker',
]
for (const prop of blocked) {
  let proto = globalThis
  while (proto) {
    if (Object.hasOwn(proto, prop)) {
      Object.defineProperty(proto, prop, {
        value: undefined,
      })
    }
    proto = Object.getPrototypeOf(proto)
  }
}

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
