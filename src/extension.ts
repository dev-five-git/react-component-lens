import * as fs from 'node:fs'
import * as path from 'node:path'

import * as vscode from 'vscode'

import { ComponentLensAnalyzer } from './analyzer'
import { type HighlightColors, LensDecorations } from './decorations'
import { ImportResolver, type SourceHost } from './resolver'

const SUPPORTED_LANGUAGE_IDS = new Set(['javascriptreact', 'typescriptreact'])
const SOURCE_WATCH_PATTERN = '**/*.{js,jsx,ts,tsx}'
const CONFIG_WATCH_PATTERN = '**/{tsconfig,jsconfig}.json'
const DEFAULT_HIGHLIGHT_COLORS: HighlightColors = {
  clientComponent: '#14b8a6',
  serverComponent: '#f59e0b',
}

export function activate(context: vscode.ExtensionContext): void {
  let config = getConfiguration()
  const sourceHost = new WorkspaceSourceHost()
  const resolver = new ImportResolver(sourceHost)
  const analyzer = new ComponentLensAnalyzer(sourceHost, resolver)
  const decorations = new LensDecorations(config.highlightColors)

  context.subscriptions.push(decorations)

  let refreshTimer: NodeJS.Timeout | undefined
  let watcherDisposables: vscode.Disposable[] = []

  const clearCachesAndRefresh = (delay = config.debounceMs): void => {
    analyzer.clear()
    scheduleRefresh(delay)
  }

  const refreshVisibleEditors = async (): Promise<void> => {
    sourceHost.invalidateDocumentCache()
    await Promise.all(
      vscode.window.visibleTextEditors.map((editor) => refreshEditor(editor)),
    )
  }

  const scheduleRefresh = (delay = config.debounceMs): void => {
    if (refreshTimer) {
      clearTimeout(refreshTimer)
    }

    refreshTimer = setTimeout(() => {
      refreshTimer = undefined
      void refreshVisibleEditors()
    }, delay)
  }

  const refreshEditor = async (editor: vscode.TextEditor): Promise<void> => {
    if (!config.enabled || !isSupportedDocument(editor.document)) {
      decorations.clear(editor)
      return
    }

    const signature = createOpenSignature(editor.document.version)
    const usages = await analyzer.analyzeDocument(
      editor.document.fileName,
      editor.document.getText(),
      signature,
    )
    decorations.apply(editor, usages)
  }

  const createWatcher = (
    folder: vscode.WorkspaceFolder,
    pattern: string,
    onChange: (uri: vscode.Uri) => void,
  ): void => {
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(folder, pattern),
    )
    watcher.onDidChange(onChange, undefined, context.subscriptions)
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

  const registerWatchers = (): void => {
    for (const disposable of watcherDisposables) {
      disposable.dispose()
    }

    watcherDisposables = []

    for (const workspaceFolder of vscode.workspace.workspaceFolders ?? []) {
      createWatcher(workspaceFolder, SOURCE_WATCH_PATTERN, (uri) => {
        analyzer.invalidateFile(uri.fsPath)
        scheduleRefresh()
      })
      createWatcher(workspaceFolder, CONFIG_WATCH_PATTERN, () =>
        clearCachesAndRefresh(),
      )
    }
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('reactComponentLens.refresh', async () => {
      analyzer.clear()
      await refreshVisibleEditors()
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
    vscode.workspace.onDidChangeTextDocument((event) => {
      analyzer.invalidateFile(event.document.fileName)
      scheduleRefresh()
    }),
    vscode.workspace.onDidOpenTextDocument((document) => {
      analyzer.invalidateFile(document.fileName)
      scheduleRefresh()
    }),
    vscode.workspace.onDidSaveTextDocument((document) => {
      analyzer.invalidateFile(document.fileName)
      scheduleRefresh(0)
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

      config = getConfiguration()

      if (event.affectsConfiguration('reactComponentLens.highlightColors')) {
        decorations.updateColors(config.highlightColors)
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

    try {
      const stats = fs.statSync(filePath)
      return createDiskSignature(stats.mtimeMs, stats.size)
    } catch {
      return undefined
    }
  }

  public readFile(filePath: string): string | undefined {
    const openDocument = this.getOpenDocument(filePath)
    if (openDocument) {
      return openDocument.getText()
    }

    try {
      return fs.readFileSync(filePath, 'utf8')
    } catch {
      return undefined
    }
  }

  public async readFileAsync(filePath: string): Promise<string | undefined> {
    const openDocument = this.getOpenDocument(filePath)
    if (openDocument) {
      return openDocument.getText()
    }

    try {
      return await fs.promises.readFile(filePath, 'utf8')
    } catch {
      return undefined
    }
  }

  public async getSignatureAsync(
    filePath: string,
  ): Promise<string | undefined> {
    const openDocument = this.getOpenDocument(filePath)
    if (openDocument) {
      return createOpenSignature(openDocument.version)
    }

    try {
      const stats = await fs.promises.stat(filePath)
      return createDiskSignature(stats.mtimeMs, stats.size)
    } catch {
      return undefined
    }
  }

  public invalidateDocumentCache(): void {
    this.documentCache = undefined
  }

  private documentCache: Map<string, vscode.TextDocument> | undefined

  private getOpenDocument(filePath: string): vscode.TextDocument | undefined {
    if (!this.documentCache) {
      this.documentCache = new Map()
      for (const document of vscode.workspace.textDocuments) {
        this.documentCache.set(path.normalize(document.fileName), document)
      }
    }
    return this.documentCache.get(path.normalize(filePath))
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
