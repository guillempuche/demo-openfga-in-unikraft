// Bundles the API into dist/server.mjs, the only file the unikernel ships: its
// root file system has Node.js and this one file, no node_modules (see the
// Dockerfile). Rolldown inlines every package the API imports, CommonJS ones
// included (axios, through @openfga/sdk), and defines `require` for them in the
// ES module itself; only Node.js built-ins stay imports.
import { defineConfig } from 'rolldown'

export default defineConfig({
  input: 'src/main.ts',
  platform: 'node',
  transform: { target: 'node24' },
  output: {
    file: 'dist/server.mjs',
    format: 'esm',
    minify: true,
  },
  // Rolldown leaves an import it can't resolve out of the bundle with only a
  // warning, so the image would build and then crash when the code reached it.
  // Fail the build instead.
  onLog(level, log, handler) {
    handler(log.code === 'UNRESOLVED_IMPORT' ? 'error' : level, log)
  },
})
