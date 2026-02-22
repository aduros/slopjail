/// <reference types="vitest/config" />

import { playwright } from '@vitest/browser-playwright'
import {
  defineConfig,
  type Plugin,
  type Rollup,
  build as viteBuild,
} from 'vite'
import dts from 'vite-plugin-dts'

const bundledSuffix = '?bundled'

function bundled(): Plugin {
  return {
    name: 'bundled',
    async resolveId(source, importer) {
      if (!source.endsWith(bundledSuffix)) return null
      const clean = source.slice(0, -bundledSuffix.length)
      const resolved = await this.resolve(clean, importer, { skipSelf: true })
      return resolved ? resolved.id + bundledSuffix : null
    },
    async load(id) {
      if (!id.endsWith(bundledSuffix)) return null
      const filePath = id.slice(0, -bundledSuffix.length)
      const result = await viteBuild({
        configFile: false,
        plugins: [stripVitePreload()],
        build: {
          write: false,
          rollupOptions: {
            input: filePath,
            output: { format: 'module' },
          },
        },
      })
      const bundle = (
        Array.isArray(result) ? result[0] : result
      ) as Rollup.RollupOutput
      return `export default ${JSON.stringify(bundle.output[0].code)}`
    },
  }
}

// Hack to strip Vite's import() glue code from pre-bundled scripts:
// https://github.com/vitejs/vite/issues/19505#issuecomment-2683954298
function stripVitePreload(): Plugin {
  return {
    name: 'stripVitePreload',
    configResolved(config) {
      const pI = config.plugins.findIndex(
        (p) => p.name === 'vite:build-import-analysis',
      )
      ;(config.plugins as Plugin[]).splice(pI, 1)
    },
    renderChunk(code) {
      return `const __VITE_IS_MODERN__=true;${code}`
    },
  }
}

export default defineConfig({
  build: {
    lib: {
      entry: 'src/index.ts',
      formats: ['es', 'cjs'],
      fileName: (format) => `index.${format === 'es' ? 'mjs' : 'cjs'}`,
    },
    rollupOptions: {
      external: ['shrimp-rpc'],
    },
  },
  plugins: [bundled(), dts({ include: ['src'] })],
  test: {
    browser: {
      enabled: true,
      headless: true,
      screenshotFailures: false,
      provider: playwright(),
      instances: [
        { browser: 'chromium' },
        { browser: 'firefox' },
        { browser: 'webkit' },
      ],
    },
  },
})
