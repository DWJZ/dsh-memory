/**
 * Runtime output for the plugin. `tsc` still owns type checking and the
 * declarations; this only transpiles, so a module can be migrated to TypeScript
 * and typed over several steps without the build gate going red in between.
 * The harness builds its own packages the same way.
 */
export default {
  entry: ['src/index.ts', 'src/index.js'],
  outDir: 'lib',
  format: 'esm',
  dts: false,
  clean: true,
}
