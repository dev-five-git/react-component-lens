import * as vscode from 'vscode'

import type {
  ComponentLensAnalyzer,
  ComponentUsage,
  ScopeConfig,
} from './analyzer'
import { createOpenSignature } from './resolver'

export interface CodeLensConfig {
  clientComponent: boolean
  enabled: boolean
  globalEnabled: boolean
  serverComponent: boolean
}

const CODELENS_SCOPE: ScopeConfig = {
  declaration: true,
  element: true,
  export: true,
  import: true,
  type: true,
}

export class ComponentCodeLensProvider
  implements vscode.CodeLensProvider, vscode.Disposable
{
  private readonly changeEmitter = new vscode.EventEmitter<void>()
  public readonly onDidChangeCodeLenses = this.changeEmitter.event

  private config: CodeLensConfig

  public constructor(
    private readonly analyzer: ComponentLensAnalyzer,
    config: CodeLensConfig,
  ) {
    this.config = config
  }

  public updateConfig(config: CodeLensConfig): void {
    this.config = config
    this.changeEmitter.fire()
  }

  public refresh(): void {
    this.changeEmitter.fire()
  }

  public dispose(): void {
    this.changeEmitter.dispose()
  }

  public async provideCodeLenses(
    document: vscode.TextDocument,
  ): Promise<vscode.CodeLens[]> {
    if (!this.config.globalEnabled || !this.config.enabled) {
      return []
    }

    if (!this.config.clientComponent && !this.config.serverComponent) {
      return []
    }

    const signature = createOpenSignature(document.version)
    const usages = await this.analyzer.analyzeDocument(
      document.fileName,
      document.getText(),
      signature,
      CODELENS_SCOPE,
    )

    return this.buildCodeLenses(document, usages)
  }

  private buildCodeLenses(
    document: vscode.TextDocument,
    usages: ComponentUsage[],
  ): vscode.CodeLens[] {
    const lineMap = new Map<
      number,
      { clients: Set<string>; servers: Set<string> }
    >()

    for (let i = 0; i < usages.length; i++) {
      const usage = usages[i]!
      if (usage.kind === 'client' && !this.config.clientComponent) {
        continue
      }
      if (usage.kind === 'server' && !this.config.serverComponent) {
        continue
      }

      if (usage.ranges.length === 0) {
        continue
      }

      const line = document.positionAt(usage.ranges[0]!.start).line
      let entry = lineMap.get(line)
      if (!entry) {
        entry = { clients: new Set(), servers: new Set() }
        lineMap.set(line, entry)
      }

      if (usage.kind === 'client') {
        entry.clients.add(usage.tagName)
      } else {
        entry.servers.add(usage.tagName)
      }
    }

    const codeLenses: vscode.CodeLens[] = []

    for (const [line, { clients, servers }] of lineMap) {
      const parts: string[] = []
      if (clients.size > 0) {
        parts.push('Client Component')
      }
      if (servers.size > 0) {
        parts.push('Server Component')
      }

      if (parts.length === 0) {
        continue
      }

      codeLenses.push(
        new vscode.CodeLens(new vscode.Range(line, 0, line, 0), {
          command: '',
          title: parts.join(' · '),
        }),
      )
    }

    return codeLenses
  }
}
