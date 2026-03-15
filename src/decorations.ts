import * as path from 'node:path'

import * as vscode from 'vscode'

import type { ComponentUsage } from './analyzer'

export interface HighlightColors {
  clientComponent: string
  serverComponent: string
}

export class LensDecorations implements vscode.Disposable {
  private clientDecorationType: vscode.TextEditorDecorationType
  private serverDecorationType: vscode.TextEditorDecorationType

  public constructor(colors: HighlightColors) {
    this.clientDecorationType = createDecorationType(colors.clientComponent)
    this.serverDecorationType = createDecorationType(colors.serverComponent)
  }

  public updateColors(colors: HighlightColors): void {
    this.clientDecorationType.dispose()
    this.serverDecorationType.dispose()
    this.clientDecorationType = createDecorationType(colors.clientComponent)
    this.serverDecorationType = createDecorationType(colors.serverComponent)
  }

  public apply(editor: vscode.TextEditor, usages: ComponentUsage[]): void {
    const clientDecorations: vscode.DecorationOptions[] = []
    const serverDecorations: vscode.DecorationOptions[] = []
    const document = editor.document
    const editorDir = path.dirname(document.uri.fsPath)
    const clientHoverCache = new Map<string, vscode.MarkdownString>()
    const serverHoverCache = new Map<string, vscode.MarkdownString>()

    for (const usage of usages) {
      const isClient = usage.kind === 'client'
      const hoverMap = isClient ? clientHoverCache : serverHoverCache
      let hoverMessage = hoverMap.get(usage.sourceFilePath)
      if (!hoverMessage) {
        const displayPath = toDisplayPath(editorDir, usage.sourceFilePath)
        const label = isClient ? 'Client' : 'Server'
        hoverMessage = new vscode.MarkdownString(
          `${label} component from \`${displayPath}\``,
        )
        hoverMap.set(usage.sourceFilePath, hoverMessage)
      }

      const target =
        usage.kind === 'client' ? clientDecorations : serverDecorations

      for (const range of usage.ranges) {
        target.push({
          hoverMessage,
          range: new vscode.Range(
            document.positionAt(range.start),
            document.positionAt(range.end),
          ),
        })
      }
    }

    editor.setDecorations(this.clientDecorationType, clientDecorations)
    editor.setDecorations(this.serverDecorationType, serverDecorations)
  }

  public clear(editor: vscode.TextEditor): void {
    editor.setDecorations(this.clientDecorationType, [])
    editor.setDecorations(this.serverDecorationType, [])
  }

  public dispose(): void {
    this.clientDecorationType.dispose()
    this.serverDecorationType.dispose()
  }
}

function toDisplayPath(editorDir: string, sourceFilePath: string): string {
  const relativePath = path.relative(editorDir, sourceFilePath)
  return relativePath.length > 0 ? relativePath : path.basename(sourceFilePath)
}

function createDecorationType(color: string): vscode.TextEditorDecorationType {
  return vscode.window.createTextEditorDecorationType({
    color,
    overviewRulerColor: color,
    overviewRulerLane: vscode.OverviewRulerLane.Right,
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
  })
}
