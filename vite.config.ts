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
        build: {
          write: false,
          rollupOptions: {
            input: filePath,
            output: { format: 'iife' },
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
})
