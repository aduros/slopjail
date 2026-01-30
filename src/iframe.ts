// This script runs inside the sandboxed iframe. It creates a Worker from the
// source provided by the host and bridges a MessagePort between them.

self.addEventListener('message', function onMessage(event) {
  if (event.data?.type === 'slopjail:init') {
    self.removeEventListener('message', onMessage)

    const worker = new Worker(
      `data:,${encodeURIComponent(event.data.workerSource)}`,
      { name: event.data.name },
    )

    // Connect the bridge to both sides
    const port = event.ports[0]
    port.onmessage = (event) => worker.postMessage(event.data)
    worker.onmessage = (event) => port.postMessage(event.data)
  }
})
