import * as fs from 'node:fs'
import * as path from 'node:path'

import * as vscode from 'vscode'

import { ComponentLensAnalyzer } from './analyzer'
import { type HighlightColors, LensDecorations } from './decorations'
import { ImportResolver, type SourceHost } from './resolver'

const SUPPORTED_LANGUAGE_IDS = new Set(['javascriptreact', 'typescriptreact'])
const WATCH_PATTERNS = ['**/*.{js,jsx,ts,tsx}', '**/{tsconfig,jsconfig}.json']
const DEFAULT_HIGHLIGHT_COLORS: HighlightColors = {
  clientComponent: '#14b8a6',
  serverComponent: '#f59e0b',
}

export function activate(context: vscode.ExtensionContext): void {
  const initialConfiguration = getConfiguration()
  const sourceHost = new WorkspaceSourceHost()
  const resolver = new ImportResolver(sourceHost)
  const analyzer = new ComponentLensAnalyzer(sourceHost, resolver)
  const decorations = new LensDecorations(initialConfiguration.highlightColors)

  context.subscriptions.push(decorations)

  let refreshTimer: NodeJS.Timeout | undefined
  let watcherDisposables: vscode.Disposable[] = []

  const clearCachesAndRefresh = (
    delay = getConfiguration().debounceMs,
  ): void => {
    analyzer.clear()
    scheduleRefresh(delay)
  }

  const refreshVisibleEditors = (): void => {
    for (const editor of vscode.window.visibleTextEditors) {
      refreshEditor(editor)
    }
  }

  const scheduleRefresh = (delay = getConfiguration().debounceMs): void => {
    if (refreshTimer) {
      clearTimeout(refreshTimer)
    }

    refreshTimer = setTimeout(() => {
      refreshTimer = undefined
      refreshVisibleEditors()
    }, delay)
  }

  const refreshEditor = (editor: vscode.TextEditor): void => {
    if (!getConfiguration().enabled || !isSupportedDocument(editor.document)) {
      decorations.clear(editor)
      return
    }

    const signature = createOpenSignature(editor.document.version)
    const usages = analyzer.analyzeDocument(
      editor.document.fileName,
      editor.document.getText(),
      signature,
    )
    decorations.apply(editor, usages)
  }

  const registerWatchers = (): void => {
    for (const disposable of watcherDisposables) {
      disposable.dispose()
    }

    watcherDisposables = []

    for (const workspaceFolder of vscode.workspace.workspaceFolders ?? []) {
      for (const pattern of WATCH_PATTERNS) {
        const watcher = vscode.workspace.createFileSystemWatcher(
          new vscode.RelativePattern(workspaceFolder, pattern),
        )
        watcher.onDidChange(
          () => clearCachesAndRefresh(),
          undefined,
          context.subscriptions,
        )
        watcher.onDidCreate(
          () => clearCachesAndRefresh(),
          undefined,
          context.subscriptions,
        )
        watcher.onDidDelete(
          () => clearCachesAndRefresh(),
          undefined,
          context.subscriptions,
        )
        watcherDisposables.push(watcher)
        context.subscriptions.push(watcher)
      }
    }
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('reactComponentLens.refresh', () => {
      analyzer.clear()
      refreshVisibleEditors()
      void vscode.window.showInformationMessage(
        'React Component Lens refreshed.',
      )
    }),
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (editor) {
        scheduleRefresh(0)
      }
    }),
    vscode.window.onDidChangeVisibleTextEditors(() => {
      scheduleRefresh(0)
    }),
    vscode.workspace.onDidChangeTextDocument(() => {
      clearCachesAndRefresh()
    }),
    vscode.workspace.onDidOpenTextDocument(() => {
      clearCachesAndRefresh()
    }),
    vscode.workspace.onDidSaveTextDocument(() => {
      clearCachesAndRefresh(0)
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      analyzer.clear()
      registerWatchers()
      scheduleRefresh(0)
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration('reactComponentLens')) {
        return
      }

      if (event.affectsConfiguration('reactComponentLens.highlightColors')) {
        decorations.updateColors(getConfiguration().highlightColors)
      }

      scheduleRefresh(0)
    }),
    new vscode.Disposable(() => {
      if (refreshTimer) {
        clearTimeout(refreshTimer)
      }
    }),
  )

  registerWatchers()
  scheduleRefresh(0)
}

export function deactivate(): void {
  return
}

function getConfiguration(): {
  debounceMs: number
  enabled: boolean
  highlightColors: HighlightColors
} {
  const configuration = vscode.workspace.getConfiguration('reactComponentLens')
  const debounceMs = configuration.get<number>('debounceMs', 200)
  const configuredHighlightColors = configuration.get<Partial<HighlightColors>>(
    'highlightColors',
    DEFAULT_HIGHLIGHT_COLORS,
  )

  return {
    debounceMs: Math.max(0, Math.min(2000, debounceMs)),
    enabled: configuration.get<boolean>('enabled', true),
    highlightColors: {
      clientComponent: normalizeColor(
        configuredHighlightColors?.clientComponent,
        DEFAULT_HIGHLIGHT_COLORS.clientComponent,
      ),
      serverComponent: normalizeColor(
        configuredHighlightColors?.serverComponent,
        DEFAULT_HIGHLIGHT_COLORS.serverComponent,
      ),
    },
  }
}

function isSupportedDocument(document: vscode.TextDocument): boolean {
  return (
    document.uri.scheme === 'file' &&
    SUPPORTED_LANGUAGE_IDS.has(document.languageId)
  )
}

class WorkspaceSourceHost implements SourceHost {
  public fileExists(filePath: string): boolean {
    return (
      this.getOpenDocument(filePath) !== undefined || fs.existsSync(filePath)
    )
  }

  public getSignature(filePath: string): string | undefined {
    const openDocument = this.getOpenDocument(filePath)
    if (openDocument) {
      return createOpenSignature(openDocument.version)
    }

    if (!fs.existsSync(filePath)) {
      return undefined
    }

    const stats = fs.statSync(filePath)
    return createDiskSignature(stats.mtimeMs, stats.size)
  }

  public readFile(filePath: string): string | undefined {
    const openDocument = this.getOpenDocument(filePath)
    if (openDocument) {
      return openDocument.getText()
    }

    if (!fs.existsSync(filePath)) {
      return undefined
    }

    return fs.readFileSync(filePath, 'utf8')
  }

  private getOpenDocument(filePath: string): vscode.TextDocument | undefined {
    const normalizedPath = path.normalize(filePath)
    return vscode.workspace.textDocuments.find(
      (document) => path.normalize(document.fileName) === normalizedPath,
    )
  }
}

function createOpenSignature(version: number): string {
  return `open:${String(version)}`
}

function createDiskSignature(mtimeMs: number, size: number): string {
  return `disk:${String(mtimeMs)}:${String(size)}`
}

function normalizeColor(
  color: string | undefined,
  fallbackColor: string,
): string {
  const trimmedColor = color?.trim()
  return trimmedColor && trimmedColor.length > 0 ? trimmedColor : fallbackColor
}
