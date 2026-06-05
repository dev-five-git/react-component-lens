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

// The wasm shim is copied next to extension.js at build time (see package.json
// build script). It is loaded via a relative require so it resolves against
// out/extension.js at runtime, sidestepping the bundler entirely.
import { createRequire } from 'node:module'

const wasm = createRequire(__filename)(
  './core_wasm.js',
) as unknown as CoreWasmModule

export class ComponentLensAnalyzer {
  private readonly host: WorkspaceHost
  private readonly jsHost: JsHostInstance

  public constructor(host: WorkspaceHost) {
    this.host = host
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
      wasm.analyze(wasmPath, sourceText, scope, this.jsHost).map((usage) => ({
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
      wasm.findComponentDeclaration(wasmPath, text, name, this.jsHost) ??
        undefined,
    )
  }
}
