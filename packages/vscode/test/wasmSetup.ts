// Bun preload script. Runs BEFORE the integration test file's imports are
// resolved, so that:
//   1. The WASM artifact required by `src/analyzerWasm.ts` (via
//      `createRequire(__filename)('./core_wasm.js')`) is reachable next to
//      the TypeScript source.
//   2. The `vscode` module imported by `src/wasmHost.ts` is replaced with the
//      minimal stub at `./_mocks/vscode.ts` -- there is no real `vscode`
//      package in `node_modules` (only `@types/vscode`), so without this the
//      ESM import in `wasmHost.ts` fails immediately.
//
// Cleanup of the copied WASM files is handled by `integration.node.test.ts`
// (`afterAll`).

import * as fs from 'node:fs'
import * as path from 'node:path'

import { mock } from 'bun:test'

const PACKAGE_ROOT = path.resolve(__dirname, '..')
const SRC_DIR = path.join(PACKAGE_ROOT, 'src')
const OUT_DIR = path.join(PACKAGE_ROOT, 'out')
const WASM_FILES = ['core_wasm.js', 'core_wasm_bg.wasm'] as const

for (const file of WASM_FILES) {
  const source = path.join(OUT_DIR, file)
  const destination = path.join(SRC_DIR, file)
  if (!fs.existsSync(source)) {
    throw new Error(
      `wasmSetup: missing build artifact ${source}. Run \`bun run build\` first.`,
    )
  }
  fs.copyFileSync(source, destination)
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
mock.module('vscode', () => require('./_mocks/vscode'))
