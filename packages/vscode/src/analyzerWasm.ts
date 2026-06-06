import { toDiskPath, toWasmPath, type WorkspaceHost } from './wasmHost'

export interface ComponentUsage {
  kind: 'client' | 'server'
  ranges: { start: number; end: number }[]
  sourceFilePath: string
  tagName: string
}

export interface ScopeConfig {
  declaration: boolean
  element: boolean
  export: boolean
  import: boolean
  type: boolean
}

interface JsHostInstance {
  free(): void
}

interface CoreWasmModule {
  JsHost: new (obj: object) => JsHostInstance
  analyze(
    path: string,
    text: string,
    scope: ScopeConfig,
    host: JsHostInstance,
  ): ComponentUsage[]
  findComponentDeclaration(
    path: string,
    text: string,
    name: string,
    host: JsHostInstance,
  ): { line: number; character: number } | undefined
}

// core_wasm.js (the wasm-pack --target nodejs glue) is copied next to the
// emitted out/extension.js at build time and shipped in the VSIX. It is loaded
// lazily via a runtime `require(coreWasmPath)`:
//   - the extension calls setCoreWasmPath(context.asAbsolutePath('out/core_wasm.js'))
//     in activate(), giving an absolute path that is correct in BOTH dev mode
//     (extensionDevelopmentPath) and a packaged install;
//   - tests leave the default './core_wasm.js', which resolves next to this
//     source file (test/wasmSetup.ts copies the glue there).
// This avoids bun's `createRequire(__filename)` rewrite, which hardcodes
// __filename to the build-machine src path and so resolves './core_wasm.js'
// against src/ instead of out/ — breaking activation in dev and packaged installs.
let coreWasmPath = './core_wasm.js'
let wasmModule: CoreWasmModule | undefined

export function setCoreWasmPath(absolutePath: string): void {
  coreWasmPath = absolutePath
}

function getWasm(): CoreWasmModule {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  wasmModule ??= require(coreWasmPath) as unknown as CoreWasmModule
  return wasmModule
}

export class ComponentLensAnalyzer {
  private readonly host: WorkspaceHost
  private readonly jsHost: JsHostInstance

  public constructor(host: WorkspaceHost) {
    this.host = host
    const wasm = getWasm()
    this.jsHost = new wasm.JsHost(host)
  }

  public clear(): void {
    return
  }

  public invalidateFile(_filePath: string): void {
    return
  }

  public analyzeDocument(
    filePath: string,
    sourceText: string,
    _signature: string,
    scope: ScopeConfig,
  ): Promise<ComponentUsage[]> {
    const wasmPath = toWasmPath(filePath)
    return Promise.resolve(
      getWasm()
        .analyze(wasmPath, sourceText, scope, this.jsHost)
        .map((usage) => ({
          ...usage,
          sourceFilePath: toDiskPath(usage.sourceFilePath),
        })),
    )
  }

  public findComponentDeclaration(
    filePath: string,
    name: string,
  ): Promise<{ line: number; character: number } | undefined> {
    const wasmPath = toWasmPath(filePath)
    const text = this.host.readToString(wasmPath)
    if (text === undefined) {
      return Promise.resolve(undefined)
    }
    return Promise.resolve(
      getWasm().findComponentDeclaration(wasmPath, text, name, this.jsHost) ??
        undefined,
    )
  }
}
