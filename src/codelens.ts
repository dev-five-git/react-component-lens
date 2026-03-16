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

interface LineGroup {
  clients: Set<string>
  components: Map<string, string>
  servers: Set<string>
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

  private async buildCodeLenses(
    document: vscode.TextDocument,
    usages: ComponentUsage[],
  ): Promise<vscode.CodeLens[]> {
    const lineMap = new Map<number, LineGroup>()

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
        entry = {
          clients: new Set(),
          components: new Map(),
          servers: new Set(),
        }
        lineMap.set(line, entry)
      }

      if (usage.kind === 'client') {
        entry.clients.add(usage.tagName)
      } else {
        entry.servers.add(usage.tagName)
      }

      if (!entry.components.has(usage.tagName)) {
        entry.components.set(usage.tagName, usage.sourceFilePath)
      }
    }

    const positions = await this.resolveDeclarationPositions(lineMap)
    const codeLenses: vscode.CodeLens[] = []

    for (const [line, { clients, servers, components }] of lineMap) {
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

      const locations = this.buildLocations(components, positions)
      const position = new vscode.Position(line, 0)

      if (locations.length > 0) {
        codeLenses.push(
          new vscode.CodeLens(new vscode.Range(position, position), {
            arguments: [document.uri, position, locations, 'peek'],
            command: 'editor.action.peekLocations',
            title: parts.join(' · '),
          }),
        )
      } else {
        codeLenses.push(
          new vscode.CodeLens(new vscode.Range(position, position), {
            command: '',
            title: parts.join(' · '),
          }),
        )
      }
    }

    return codeLenses
  }

  private async resolveDeclarationPositions(
    lineMap: Map<number, LineGroup>,
  ): Promise<Map<string, vscode.Position>> {
    const filesToResolve = new Map<string, Set<string>>()

    for (const [, { components }] of lineMap) {
      for (const [tagName, sourceFilePath] of components) {
        let names = filesToResolve.get(sourceFilePath)
        if (!names) {
          names = new Set()
          filesToResolve.set(sourceFilePath, names)
        }
        names.add(tagName)
      }
    }

    const positions = new Map<string, vscode.Position>()

    await Promise.all(
      Array.from(filesToResolve, async ([filePath, names]) => {
        for (const name of names) {
          const pos = await this.analyzer.findComponentDeclaration(
            filePath,
            name,
          )
          if (pos) {
            positions.set(
              filePath + ':' + name,
              new vscode.Position(pos.line, pos.character),
            )
          }
        }
      }),
    )

    return positions
  }

  private buildLocations(
    components: Map<string, string>,
    positions: Map<string, vscode.Position>,
  ): vscode.Location[] {
    const seen = new Set<string>()
    const locations: vscode.Location[] = []

    for (const [tagName, sourceFilePath] of components) {
      if (seen.has(sourceFilePath)) {
        continue
      }
      seen.add(sourceFilePath)

      const uri = vscode.Uri.file(sourceFilePath)
      const pos =
        positions.get(sourceFilePath + ':' + tagName) ??
        new vscode.Position(0, 0)
      locations.push(new vscode.Location(uri, pos))
    }

    return locations
  }
}
