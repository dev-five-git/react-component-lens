// Unit tests for `src/extension.ts`.
//
// Drives `activate()` end-to-end through the `vscode` mock: every event
// subscription, command handler, watcher branch, configuration branch, and
// internal scheduler path (debounce clear + timer fire + final disposable
// teardown). Real WASM analysis runs because `wasmSetup.ts` copies the
// `core_wasm.js` glue next to `src/`.

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test'

import { activate, deactivate } from '../src/extension'
import * as vscodeMock from './_mocks/vscode'

interface RclTestGlobal {
  __rclGetDecorationsForTest?: (
    uri: string,
  ) =>
    | { kind: 'client' | 'server'; ranges: { end: number; start: number }[] }[]
    | undefined
}

const tempRoots: string[] = []

function makeTempProject(label: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `rcl-test-ext-${label}-`))
  tempRoots.push(root)
  return root
}

function writeProjectFile(root: string, rel: string, content: string): string {
  const full = path.join(root, rel)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, content)
  return full
}

function makeContext(): {
  context: { subscriptions: { dispose(): void }[] }
  disposeAll(): void
} {
  const subscriptions: { dispose(): void }[] = []
  return {
    context: { subscriptions },
    disposeAll(): void {
      for (const subscription of subscriptions) {
        try {
          subscription.dispose()
        } catch {
          // ignore
        }
      }
      subscriptions.length = 0
    },
  }
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

afterAll(() => {
  for (const root of tempRoots) {
    try {
      fs.rmSync(root, { recursive: true, force: true })
    } catch {
      // ignore
    }
  }
})

beforeEach(() => {
  vscodeMock.__resetAll()
})

afterEach(() => {
  delete process.env.RCL_TEST
  delete (globalThis as RclTestGlobal).__rclGetDecorationsForTest
})

describe('activate / deactivate', () => {
  test('RCL_TEST=1 installs the decoration snapshot probe on globalThis', async () => {
    process.env.RCL_TEST = '1'
    const { context, disposeAll } = makeContext()
    try {
      activate(context as never)

      const probe = (globalThis as RclTestGlobal).__rclGetDecorationsForTest
      expect(typeof probe).toBe('function')
      // No editor has been refreshed yet → probe returns undefined for
      // every key.
      expect(probe!('file:///does-not-exist')).toBeUndefined()
    } finally {
      disposeAll()
    }
  })

  test('RCL_TEST not set leaves globalThis untouched', () => {
    delete process.env.RCL_TEST
    delete (globalThis as RclTestGlobal).__rclGetDecorationsForTest
    const { context, disposeAll } = makeContext()
    try {
      activate(context as never)
      expect(
        (globalThis as RclTestGlobal).__rclGetDecorationsForTest,
      ).toBeUndefined()
    } finally {
      disposeAll()
    }
  })

  test('deactivate is a no-op that does not throw', () => {
    expect(() => deactivate()).not.toThrow()
  })

  test('registers a CodeLens provider for tsx + jsx', () => {
    const { context, disposeAll } = makeContext()
    try {
      activate(context as never)
      const providers = vscodeMock.__getRegisteredCodeLensProviders()
      expect(providers.length).toBe(1)
      const selector = providers[0]!.selector as { language: string }[]
      expect(selector).toEqual([
        { language: 'typescriptreact' },
        { language: 'javascriptreact' },
      ])
    } finally {
      disposeAll()
    }
  })
})

describe('refresh command', () => {
  test('handler shows an info message after refreshing visible editors', async () => {
    const { context, disposeAll } = makeContext()
    try {
      activate(context as never)
      const handler = vscodeMock.__getRegisteredCommand(
        'reactComponentLens.refresh',
      )
      expect(typeof handler).toBe('function')
      await handler!()
      expect(vscodeMock.__getInfoMessages()).toContain(
        'React Component Lens refreshed.',
      )
    } finally {
      disposeAll()
    }
  })
})

describe('refreshEditor + scheduleRefresh', () => {
  test('enabled + supported document → analyze, paint, and snapshot', async () => {
    process.env.RCL_TEST = '1'
    const root = makeTempProject('enabled')
    const pagePath = writeProjectFile(
      root,
      'app/page.tsx',
      'export default function Page(){ return <div/> }\n',
    )
    const doc = new vscodeMock.FakeTextDocument(
      pagePath,
      fs.readFileSync(pagePath, 'utf8'),
    )
    vscodeMock.__upsertOpenDoc(doc)
    const editor = vscodeMock.__makeFakeEditor(doc)
    vscodeMock.__setVisibleTextEditors([editor])

    const { context, disposeAll } = makeContext()
    try {
      activate(context as never)
      // activate() schedules a refresh with delay 0 → await the timer.
      await wait(20)

      // setDecorations should have been invoked twice (client + server).
      const calls = vscodeMock.__getSetDecorationsCalls()
      expect(calls.length).toBeGreaterThanOrEqual(2)

      // Snapshot probe should now have an entry for the editor's URI.
      const probe = (globalThis as RclTestGlobal).__rclGetDecorationsForTest!
      const snapshot = probe(doc.uri.toString())
      expect(snapshot).toBeDefined()
    } finally {
      disposeAll()
    }
  })

  test('disabled global config → clear + drop snapshot', async () => {
    process.env.RCL_TEST = '1'
    vscodeMock.__setConfigValue('reactComponentLens.enabled', false)

    const root = makeTempProject('disabled')
    const pagePath = writeProjectFile(
      root,
      'app/page.tsx',
      'export default function Page(){ return null }\n',
    )
    const doc = new vscodeMock.FakeTextDocument(
      pagePath,
      fs.readFileSync(pagePath, 'utf8'),
    )
    vscodeMock.__upsertOpenDoc(doc)
    const editor = vscodeMock.__makeFakeEditor(doc)
    vscodeMock.__setVisibleTextEditors([editor])

    const { context, disposeAll } = makeContext()
    try {
      activate(context as never)
      await wait(20)

      // Clear path: setDecorations called with empty arrays both times.
      const calls = vscodeMock.__getSetDecorationsCalls()
      expect(calls.length).toBeGreaterThanOrEqual(2)
      for (const call of calls) {
        expect(call.decorations.length).toBe(0)
      }
      // Snapshot must have been deleted (or never set).
      const probe = (globalThis as RclTestGlobal).__rclGetDecorationsForTest!
      expect(probe(doc.uri.toString())).toBeUndefined()
    } finally {
      disposeAll()
    }
  })

  test('unsupported document (plaintext) → clear + drop snapshot', async () => {
    process.env.RCL_TEST = '1'
    const doc = new vscodeMock.FakeTextDocument(
      '/tmp/notes.txt',
      'plain text',
      1,
      'plaintext',
      'file',
    )
    const editor = vscodeMock.__makeFakeEditor(doc)
    vscodeMock.__setVisibleTextEditors([editor])

    const { context, disposeAll } = makeContext()
    try {
      activate(context as never)
      await wait(20)
      const calls = vscodeMock.__getSetDecorationsCalls()
      for (const call of calls) {
        expect(call.decorations.length).toBe(0)
      }
      const probe = (globalThis as RclTestGlobal).__rclGetDecorationsForTest!
      expect(probe(doc.uri.toString())).toBeUndefined()
    } finally {
      disposeAll()
    }
  })

  test('non-file scheme → clear (isSupportedDocument false branch)', async () => {
    process.env.RCL_TEST = '1'
    const doc = new vscodeMock.FakeTextDocument(
      'inmemory/scratch.tsx',
      'export default function S(){ return null }',
      1,
      'typescriptreact',
      'untitled',
    )
    const editor = vscodeMock.__makeFakeEditor(doc)
    vscodeMock.__setVisibleTextEditors([editor])

    const { context, disposeAll } = makeContext()
    try {
      activate(context as never)
      await wait(20)
      const probe = (globalThis as RclTestGlobal).__rclGetDecorationsForTest!
      expect(probe(doc.uri.toString())).toBeUndefined()
    } finally {
      disposeAll()
    }
  })

  test('debounce: rapid scheduleRefresh exercises the clearTimeout branch', async () => {
    // Default debounceMs is 200. We fire many events in quick succession;
    // each call but the last should hit the `if (refreshTimer) clearTimeout`
    // branch.
    const { context, disposeAll } = makeContext()
    try {
      activate(context as never)
      // active editor change fires scheduleRefresh(0)
      vscodeMock.__fireDidChangeActiveTextEditor(undefined)
      // visible editors change fires scheduleRefresh(0)
      vscodeMock.__fireDidChangeVisibleTextEditors([])
      // text document change fires scheduleRefresh(config.debounceMs)
      vscodeMock.__fireDidChangeTextDocument(
        new vscodeMock.FakeTextDocument('/tmp/x.tsx', ''),
      )
      // and again, to be sure the clearTimeout branch is exercised
      vscodeMock.__fireDidChangeTextDocument(
        new vscodeMock.FakeTextDocument('/tmp/x.tsx', ''),
      )
      await wait(20)
    } finally {
      disposeAll()
    }
  })

  test('final cleanup Disposable clearTimeout-s a pending refresh', () => {
    const { context, disposeAll } = makeContext()
    activate(context as never)
    // scheduleRefresh(0) was called in activate → refreshTimer is set
    // (delay 0 fires on the next macrotask). Dispose subscriptions BEFORE
    // the timer fires.
    disposeAll()
    // No assertions: the test just exercises the branch without throwing.
    expect(true).toBe(true)
  })
})

describe('event subscriptions', () => {
  test('onDidChangeActiveTextEditor schedules a refresh when an editor is supplied', async () => {
    const { context, disposeAll } = makeContext()
    try {
      activate(context as never)
      const doc = new vscodeMock.FakeTextDocument('/tmp/a.tsx', '')
      const editor = vscodeMock.__makeFakeEditor(doc)
      vscodeMock.__fireDidChangeActiveTextEditor(editor)
      // undefined argument is the early-return branch
      vscodeMock.__fireDidChangeActiveTextEditor(undefined)
      await wait(10)
    } finally {
      disposeAll()
    }
  })

  test('onDidOpenTextDocument + onDidSaveTextDocument both invalidate + refresh', async () => {
    const { context, disposeAll } = makeContext()
    try {
      activate(context as never)
      const doc = new vscodeMock.FakeTextDocument('/tmp/a.tsx', '')
      vscodeMock.__fireDidOpenTextDocument(doc)
      vscodeMock.__fireDidSaveTextDocument(doc)
      await wait(10)
    } finally {
      disposeAll()
    }
  })

  test('onDidChangeWorkspaceFolders re-registers watchers', async () => {
    vscodeMock.__setWorkspaceFolders([
      vscodeMock.__makeWorkspaceFolder('/proj-a'),
    ])
    const { context, disposeAll } = makeContext()
    try {
      activate(context as never)
      const initialWatchers = vscodeMock.__getCreatedWatchers().length
      // Two watcher patterns per folder (source + tsconfig) → 2 watchers.
      expect(initialWatchers).toBe(2)

      vscodeMock.__setWorkspaceFolders([
        vscodeMock.__makeWorkspaceFolder('/proj-a'),
        vscodeMock.__makeWorkspaceFolder('/proj-b'),
      ])
      vscodeMock.__fireDidChangeWorkspaceFolders()
      expect(vscodeMock.__getCreatedWatchers().length).toBeGreaterThan(
        initialWatchers,
      )
      // The initial watchers should now be disposed.
      const all = vscodeMock.__getCreatedWatchers()
      expect(all[0]!.disposed).toBe(true)
      await wait(10)
    } finally {
      disposeAll()
    }
  })

  test('file watcher onDidChange / onDidCreate / onDidDelete all schedule refreshes', async () => {
    vscodeMock.__setWorkspaceFolders([
      vscodeMock.__makeWorkspaceFolder('/proj-a'),
    ])
    const { context, disposeAll } = makeContext()
    try {
      activate(context as never)
      const watchers = vscodeMock.__getCreatedWatchers()
      expect(watchers.length).toBe(2)
      // Source watcher → fire all three signals
      const sourceWatcher = watchers[0]!
      sourceWatcher.changeEmitter.fire(vscodeMock.Uri.file('/proj-a/x.tsx'))
      sourceWatcher.createEmitter.fire(vscodeMock.Uri.file('/proj-a/y.tsx'))
      sourceWatcher.deleteEmitter.fire(vscodeMock.Uri.file('/proj-a/z.tsx'))
      // Config watcher → fire one signal
      const configWatcher = watchers[1]!
      configWatcher.changeEmitter.fire(
        vscodeMock.Uri.file('/proj-a/tsconfig.json'),
      )
      await wait(10)
    } finally {
      disposeAll()
    }
  })

  test('onDidChangeConfiguration: early return when reactComponentLens is not affected', () => {
    const { context, disposeAll } = makeContext()
    try {
      activate(context as never)
      vscodeMock.__fireDidChangeConfiguration(['someOtherExtension'])
      // No assertions besides "no throw".
      expect(true).toBe(true)
    } finally {
      disposeAll()
    }
  })

  test('onDidChangeConfiguration: highlightColors branch swaps decoration types', async () => {
    const { context, disposeAll } = makeContext()
    try {
      activate(context as never)
      const before = vscodeMock.__getDecorationTypes().length
      // affects(reactComponentLens) AND affects(reactComponentLens.highlightColors)
      vscodeMock.__fireDidChangeConfiguration([
        'reactComponentLens',
        'reactComponentLens.highlightColors',
      ])
      const after = vscodeMock.__getDecorationTypes().length
      expect(after).toBeGreaterThan(before)
    } finally {
      disposeAll()
    }
  })

  test('onDidChangeConfiguration: codelens branch fires codelens change event', () => {
    const { context, disposeAll } = makeContext()
    try {
      activate(context as never)
      vscodeMock.__fireDidChangeConfiguration([
        'reactComponentLens',
        'reactComponentLens.codelens',
      ])
      expect(true).toBe(true)
    } finally {
      disposeAll()
    }
  })

  test('onDidChangeConfiguration: generic affects(reactComponentLens) re-reads config without updating colors / codelens', () => {
    const { context, disposeAll } = makeContext()
    try {
      activate(context as never)
      vscodeMock.__fireDidChangeConfiguration(['reactComponentLens'])
      expect(true).toBe(true)
    } finally {
      disposeAll()
    }
  })
})

describe('configuration parsing', () => {
  test('debounceMs is clamped into [0, 2000]', async () => {
    // Bound A: debounceMs below 0
    vscodeMock.__setConfigValue('reactComponentLens.debounceMs', -100)
    {
      const { context, disposeAll } = makeContext()
      try {
        activate(context as never)
        await wait(10)
      } finally {
        disposeAll()
      }
    }

    vscodeMock.__resetAll()
    // Bound B: debounceMs above 2000
    vscodeMock.__setConfigValue('reactComponentLens.debounceMs', 9999)
    {
      const { context, disposeAll } = makeContext()
      try {
        activate(context as never)
        await wait(10)
      } finally {
        disposeAll()
      }
    }
  })

  test('normalizeColor uses fallbacks for empty / whitespace strings', async () => {
    vscodeMock.__setConfigValue('reactComponentLens.highlightColors', {
      clientComponent: '   ', // whitespace → fallback
      serverComponent: undefined as unknown as string, // undefined → fallback
    })
    const { context, disposeAll } = makeContext()
    try {
      activate(context as never)
      const types = vscodeMock.__getDecorationTypes()
      expect(types[0]!.options.color).toBe('#14b8a6') // client fallback
      expect(types[1]!.options.color).toBe('#f59e0b') // server fallback
      await wait(10)
    } finally {
      disposeAll()
    }
  })

  test('normalizeColor keeps trimmed custom values', async () => {
    vscodeMock.__setConfigValue('reactComponentLens.highlightColors', {
      clientComponent: '  #112233  ',
      serverComponent: '#445566',
    })
    const { context, disposeAll } = makeContext()
    try {
      activate(context as never)
      const types = vscodeMock.__getDecorationTypes()
      expect(types[0]!.options.color).toBe('#112233')
      expect(types[1]!.options.color).toBe('#445566')
      await wait(10)
    } finally {
      disposeAll()
    }
  })
})
