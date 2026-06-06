// Minimal `vscode` module stub used by the VS Code extension tests.
//
// Implements only the API surface actually touched by the 5 source files
// (analyzerWasm, codelens, decorations, extension, wasmHost). Tests drive
// every branch through the test-only `__*` helpers exported at the bottom.
//
// IMPORTANT: the existing integration test depends on `FakeTextDocument`,
// `workspace.textDocuments`, `__upsertOpenDoc`, and `__clearOpenDocs`. Those
// shapes must remain backwards-compatible.

// === Position / Range / Location ===========================================

export class Position {
  public constructor(
    public readonly line: number,
    public readonly character: number,
  ) {}
}

export class Range {
  public constructor(
    public readonly start: Position,
    public readonly end: Position,
  ) {}
}

class FakeUri {
  public readonly scheme: string

  public constructor(
    public readonly fsPath: string,
    scheme = 'file',
  ) {
    this.scheme = scheme
  }

  public toString(): string {
    return this.scheme + '://' + this.fsPath.replaceAll('\\', '/')
  }
}

export class Location {
  public constructor(
    public readonly uri: FakeUri,
    public readonly position: Position,
  ) {}
}

export const Uri = {
  file(fsPath: string): FakeUri {
    return new FakeUri(fsPath, 'file')
  },
  parse(raw: string): FakeUri {
    const idx = raw.indexOf('://')
    if (idx === -1) {
      return new FakeUri(raw, 'file')
    }
    return new FakeUri(raw.slice(idx + 3), raw.slice(0, idx))
  },
}

// === MarkdownString ========================================================

export class MarkdownString {
  public constructor(public readonly value: string) {}
}

// === CodeLens ==============================================================

export interface CodeLensCommand {
  arguments?: unknown[]
  command: string
  title: string
}

export class CodeLens {
  public constructor(
    public readonly range: Range,
    public readonly command?: CodeLensCommand,
  ) {}
}

// === Disposable ============================================================

export class Disposable {
  public constructor(private readonly callback: () => void) {}

  public dispose(): void {
    this.callback()
  }
}

// === EventEmitter ==========================================================

type Listener<T> = (e: T) => unknown
type Event<T> = (
  listener: Listener<T>,
  thisArgs?: unknown,
  disposables?: Disposable[],
) => Disposable

export class EventEmitter<T> {
  private listeners: Listener<T>[] = []

  public event: Event<T> = (
    listener: Listener<T>,
    _thisArgs?: unknown,
    disposables?: Disposable[],
  ): Disposable => {
    this.listeners.push(listener)
    const disposable = new Disposable(() => {
      const idx = this.listeners.indexOf(listener)
      if (idx >= 0) {
        this.listeners.splice(idx, 1)
      }
    })
    if (disposables) {
      disposables.push(disposable)
    }
    return disposable
  }

  public fire(e: T): void {
    // Snapshot before iteration so a listener that registers/disposes
    // another listener mid-fire can't corrupt the loop.
    const snapshot = this.listeners.slice()
    for (const listener of snapshot) {
      listener(e)
    }
  }

  public dispose(): void {
    this.listeners = []
  }
}

// === RelativePattern =======================================================

export class RelativePattern {
  public constructor(
    public readonly base: unknown,
    public readonly pattern: string,
  ) {}
}

// === Enums =================================================================

export const OverviewRulerLane = {
  Right: 1,
  Center: 2,
  Left: 4,
  Full: 7,
} as const
export const DecorationRangeBehavior = {
  OpenOpen: 0,
  ClosedClosed: 1,
  OpenClosed: 2,
  ClosedOpen: 3,
} as const

// === FakeTextDocument (existing, extended) =================================

export interface FakeWorkspaceFolder {
  index: number
  name: string
  uri: FakeUri
}

export class FakeTextDocument {
  public version: number
  public readonly uri: FakeUri
  public languageId: string
  private text: string

  public constructor(
    public readonly fileName: string,
    text: string,
    version = 1,
    languageId = 'typescriptreact',
    scheme = 'file',
  ) {
    this.text = text
    this.version = version
    this.languageId = languageId
    this.uri = new FakeUri(fileName, scheme)
  }

  public getText(): string {
    return this.text
  }

  public setText(nextText: string, nextVersion?: number): void {
    this.text = nextText
    this.version = nextVersion ?? this.version + 1
  }

  public positionAt(offset: number): Position {
    const clamped = Math.max(0, Math.min(offset, this.text.length))
    let line = 0
    let lastNewline = -1
    for (let i = 0; i < clamped; i++) {
      if (this.text.charCodeAt(i) === 10) {
        line++
        lastNewline = i
      }
    }
    return new Position(line, clamped - lastNewline - 1)
  }
}

// === Decoration / Watcher mock types =======================================

interface DecorationTypeOptions {
  color: string
  overviewRulerColor?: string
  overviewRulerLane?: number
  rangeBehavior?: number
}

export class DecorationTypeMock {
  public disposed = false

  public constructor(public readonly options: DecorationTypeOptions) {}

  public dispose(): void {
    this.disposed = true
  }
}

interface DecorationOption {
  hoverMessage: MarkdownString
  range: Range
}

export interface FakeTextEditor {
  document: FakeTextDocument
  setDecorations(
    type: DecorationTypeMock,
    ranges: readonly DecorationOption[],
  ): void
}

export interface SetDecorationsCall {
  decorations: readonly DecorationOption[]
  editor: FakeTextEditor
  type: DecorationTypeMock
}

export class FileSystemWatcherMock {
  public disposed = false
  public readonly changeEmitter = new EventEmitter<FakeUri>()
  public readonly createEmitter = new EventEmitter<FakeUri>()
  public readonly deleteEmitter = new EventEmitter<FakeUri>()
  public readonly onDidChange = this.changeEmitter.event
  public readonly onDidCreate = this.createEmitter.event
  public readonly onDidDelete = this.deleteEmitter.event

  public constructor(public readonly pattern: RelativePattern) {}

  public dispose(): void {
    this.disposed = true
  }
}

// === Internal state ========================================================

const openDocs: FakeTextDocument[] = []
let visibleEditors: FakeTextEditor[] = []
let workspaceFoldersValue: FakeWorkspaceFolder[] | undefined
const configurationValues = new Map<string, unknown>()
const affectsConfigurationOverride: {
  fn: ((section: string) => boolean) | undefined
} = {
  fn: undefined,
}

const decorationTypes: DecorationTypeMock[] = []
const setDecorationsCalls: SetDecorationsCall[] = []
const registeredCommands = new Map<string, (...args: unknown[]) => unknown>()
const registeredCodeLensProviders: { provider: unknown; selector: unknown }[] =
  []
const shownInfoMessages: string[] = []
const createdWatchers: FileSystemWatcherMock[] = []

const emitters = {
  didChangeActiveTextEditor: new EventEmitter<FakeTextEditor | undefined>(),
  didChangeVisibleTextEditors: new EventEmitter<readonly FakeTextEditor[]>(),
  didChangeTextDocument: new EventEmitter<{ document: FakeTextDocument }>(),
  didOpenTextDocument: new EventEmitter<FakeTextDocument>(),
  didSaveTextDocument: new EventEmitter<FakeTextDocument>(),
  didChangeWorkspaceFolders: new EventEmitter<void>(),
  didChangeConfiguration: new EventEmitter<{
    affectsConfiguration(section: string): boolean
  }>(),
}

// === Namespaces ============================================================

export const window = {
  createTextEditorDecorationType(
    options: DecorationTypeOptions,
  ): DecorationTypeMock {
    const type = new DecorationTypeMock(options)
    decorationTypes.push(type)
    return type
  },
  get visibleTextEditors(): readonly FakeTextEditor[] {
    return visibleEditors
  },
  onDidChangeActiveTextEditor: emitters.didChangeActiveTextEditor.event,
  onDidChangeVisibleTextEditors: emitters.didChangeVisibleTextEditors.event,
  showInformationMessage(message: string): Promise<string | undefined> {
    shownInfoMessages.push(message)
    return Promise.resolve(undefined)
  },
}

export const workspace = {
  get textDocuments(): readonly FakeTextDocument[] {
    return openDocs
  },
  get workspaceFolders(): readonly FakeWorkspaceFolder[] | undefined {
    return workspaceFoldersValue
  },
  getConfiguration(section?: string): {
    get<T>(key: string, defaultValue: T): T
  } {
    const prefix = section ? section + '.' : ''
    return {
      get<T>(key: string, defaultValue: T): T {
        const fullKey = prefix + key
        if (configurationValues.has(fullKey)) {
          return configurationValues.get(fullKey) as T
        }
        return defaultValue
      },
    }
  },
  createFileSystemWatcher(pattern: RelativePattern): FileSystemWatcherMock {
    const watcher = new FileSystemWatcherMock(pattern)
    createdWatchers.push(watcher)
    return watcher
  },
  onDidChangeTextDocument: emitters.didChangeTextDocument.event,
  onDidOpenTextDocument: emitters.didOpenTextDocument.event,
  onDidSaveTextDocument: emitters.didSaveTextDocument.event,
  onDidChangeWorkspaceFolders: emitters.didChangeWorkspaceFolders.event,
  onDidChangeConfiguration: emitters.didChangeConfiguration.event,
}

export const languages = {
  registerCodeLensProvider(selector: unknown, provider: unknown): Disposable {
    registeredCodeLensProviders.push({ provider, selector })
    return new Disposable(() => {
      const idx = registeredCodeLensProviders.findIndex(
        (entry) => entry.provider === provider,
      )
      if (idx >= 0) {
        registeredCodeLensProviders.splice(idx, 1)
      }
    })
  },
}

export const commands = {
  registerCommand(
    name: string,
    handler: (...args: unknown[]) => unknown,
  ): Disposable {
    registeredCommands.set(name, handler)
    return new Disposable(() => registeredCommands.delete(name))
  },
}

// === Public test helpers ===================================================

export function __upsertOpenDoc(doc: FakeTextDocument): void {
  const index = openDocs.findIndex(
    (existing) => existing.fileName === doc.fileName,
  )
  if (index >= 0) {
    openDocs[index] = doc
  } else {
    openDocs.push(doc)
  }
}

export function __clearOpenDocs(): void {
  openDocs.length = 0
}

export function __setVisibleTextEditors(editors: FakeTextEditor[]): void {
  visibleEditors = editors
}

export function __setWorkspaceFolders(
  folders: FakeWorkspaceFolder[] | undefined,
): void {
  workspaceFoldersValue = folders
}

export function __setConfigValue(key: string, value: unknown): void {
  configurationValues.set(key, value)
}

export function __clearConfigValues(): void {
  configurationValues.clear()
}

export function __setAffectsConfigurationOverride(
  fn: ((section: string) => boolean) | undefined,
): void {
  affectsConfigurationOverride.fn = fn
}

export function __makeWorkspaceFolder(
  fsPath: string,
  name = 'root',
  index = 0,
): FakeWorkspaceFolder {
  return { index, name, uri: new FakeUri(fsPath, 'file') }
}

export function __makeFakeEditor(
  document: FakeTextDocument,
  onSetDecorations?: (call: SetDecorationsCall) => void,
): FakeTextEditor {
  const editor: FakeTextEditor = {
    document,
    setDecorations(
      type: DecorationTypeMock,
      decorations: readonly DecorationOption[],
    ): void {
      const call: SetDecorationsCall = { decorations, editor, type }
      setDecorationsCalls.push(call)
      if (onSetDecorations) {
        onSetDecorations(call)
      }
    },
  }
  return editor
}

export function __getDecorationTypes(): readonly DecorationTypeMock[] {
  return decorationTypes
}

export function __getSetDecorationsCalls(): readonly SetDecorationsCall[] {
  return setDecorationsCalls
}

export function __clearSetDecorationsCalls(): void {
  setDecorationsCalls.length = 0
}

export function __getRegisteredCommand(
  name: string,
): ((...args: unknown[]) => unknown) | undefined {
  return registeredCommands.get(name)
}

export function __getRegisteredCodeLensProviders(): readonly {
  provider: unknown
  selector: unknown
}[] {
  return registeredCodeLensProviders
}

export function __getInfoMessages(): readonly string[] {
  return shownInfoMessages
}

export function __clearInfoMessages(): void {
  shownInfoMessages.length = 0
}

export function __getCreatedWatchers(): readonly FileSystemWatcherMock[] {
  return createdWatchers
}

export function __clearWatchers(): void {
  createdWatchers.length = 0
}

export function __fireDidChangeActiveTextEditor(
  editor: FakeTextEditor | undefined,
): void {
  emitters.didChangeActiveTextEditor.fire(editor)
}

export function __fireDidChangeVisibleTextEditors(
  editors: readonly FakeTextEditor[],
): void {
  emitters.didChangeVisibleTextEditors.fire(editors)
}

export function __fireDidChangeTextDocument(document: FakeTextDocument): void {
  emitters.didChangeTextDocument.fire({ document })
}

export function __fireDidOpenTextDocument(document: FakeTextDocument): void {
  emitters.didOpenTextDocument.fire(document)
}

export function __fireDidSaveTextDocument(document: FakeTextDocument): void {
  emitters.didSaveTextDocument.fire(document)
}

export function __fireDidChangeWorkspaceFolders(): void {
  emitters.didChangeWorkspaceFolders.fire()
}

export function __fireDidChangeConfiguration(
  affectedSections: readonly string[],
): void {
  const set = new Set(affectedSections)
  emitters.didChangeConfiguration.fire({
    affectsConfiguration(section: string): boolean {
      if (affectsConfigurationOverride.fn) {
        return affectsConfigurationOverride.fn(section)
      }
      return set.has(section)
    },
  })
}

export function __resetAll(): void {
  openDocs.length = 0
  visibleEditors = []
  workspaceFoldersValue = undefined
  configurationValues.clear()
  affectsConfigurationOverride.fn = undefined
  decorationTypes.length = 0
  setDecorationsCalls.length = 0
  registeredCommands.clear()
  registeredCodeLensProviders.length = 0
  shownInfoMessages.length = 0
  createdWatchers.length = 0
}
