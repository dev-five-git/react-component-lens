import * as vscode from 'vscode'

import { ComponentLensAnalyzer, type ScopeConfig } from './analyzerWasm'
import { type CodeLensConfig, ComponentCodeLensProvider } from './codelens'
import { type HighlightColors, LensDecorations } from './decorations'
import { WorkspaceHost } from './wasmHost'

const LANG_JSX = 'javascriptreact'
const LANG_TSX = 'typescriptreact'
const SOURCE_WATCH_PATTERN = '**/*.{js,jsx,ts,tsx}'
const CONFIG_WATCH_PATTERN = '**/{tsconfig,jsconfig}.json'
const DEFAULT_HIGHLIGHT_COLORS: HighlightColors = {
  clientComponent: '#14b8a6',
  serverComponent: '#f59e0b',
}

interface DecorationSnapshot {
  kind: 'client' | 'server'
  ranges: { start: number; end: number }[]
}

interface RclTestGlobal {
  __rclGetDecorationsForTest?: (uri: string) => DecorationSnapshot[] | undefined
}

export function activate(context: vscode.ExtensionContext): void {
  let config = getConfiguration()
  const host = new WorkspaceHost()
  const analyzer = new ComponentLensAnalyzer(host)
  const decorations = new LensDecorations(config.highlightColors)
  const codeLensProvider = new ComponentCodeLensProvider(
    analyzer,
    config.codeLens,
  )

  const decorationSnapshots = new Map<string, DecorationSnapshot[]>()

  if (process.env.RCL_TEST === '1') {
    ;(globalThis as RclTestGlobal).__rclGetDecorationsForTest = (
      uri: string,
    ): DecorationSnapshot[] | undefined => decorationSnapshots.get(uri)
  }

  context.subscriptions.push(decorations, codeLensProvider)

  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider(
      [{ language: LANG_TSX }, { language: LANG_JSX }],
      codeLensProvider,
    ),
  )

  let refreshTimer: NodeJS.Timeout | undefined
  let watcherDisposables: vscode.Disposable[] = []

  const clearCachesAndRefresh = (delay = config.debounceMs): void => {
    analyzer.clear()
    scheduleRefresh(delay)
  }

  const refreshVisibleEditors = async (): Promise<void> => {
    host.invalidateDocumentCache()
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
      codeLensProvider.refresh()
      void refreshVisibleEditors()
    }, delay)
  }

  const refreshEditor = async (editor: vscode.TextEditor): Promise<void> => {
    const document = editor.document
    const uriKey = document.uri.toString()
    if (!config.enabled || !isSupportedDocument(document)) {
      decorations.clear(editor)
      decorationSnapshots.delete(uriKey)
      return
    }

    const signature = 'open:' + document.version
    const usages = await analyzer.analyzeDocument(
      document.fileName,
      document.getText(),
      signature,
      config.scope,
    )
    decorations.apply(editor, usages)
    decorationSnapshots.set(
      uriKey,
      usages.map((usage) => ({ kind: usage.kind, ranges: usage.ranges })),
    )
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

      if (event.affectsConfiguration('reactComponentLens.codelens')) {
        codeLensProvider.updateConfig(config.codeLens)
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
  codeLens: CodeLensConfig
  debounceMs: number
  enabled: boolean
  highlightColors: HighlightColors
  scope: ScopeConfig
} {
  const configuration = vscode.workspace.getConfiguration('reactComponentLens')
  const debounceMs = configuration.get<number>('debounceMs', 200)
  const configuredHighlightColors = configuration.get<Partial<HighlightColors>>(
    'highlightColors',
    DEFAULT_HIGHLIGHT_COLORS,
  )

  return {
    codeLens: {
      clientComponent: configuration.get<boolean>(
        'codelens.clientComponent',
        true,
      ),
      enabled: configuration.get<boolean>('codelens.enabled', true),
      globalEnabled: configuration.get<boolean>('enabled', true),
      serverComponent: configuration.get<boolean>(
        'codelens.serverComponent',
        true,
      ),
    },
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
    scope: {
      declaration: configuration.get<boolean>('scope.declaration', true),
      element: configuration.get<boolean>('scope.element', true),
      export: configuration.get<boolean>('scope.export', true),
      import: configuration.get<boolean>('scope.import', true),
      type: configuration.get<boolean>('scope.type', true),
    },
  }
}

function isSupportedDocument(document: vscode.TextDocument): boolean {
  return (
    document.uri.scheme === 'file' &&
    (document.languageId === LANG_TSX || document.languageId === LANG_JSX)
  )
}

function normalizeColor(
  color: string | undefined,
  fallbackColor: string,
): string {
  const trimmedColor = color?.trim()
  return trimmedColor || fallbackColor
}
