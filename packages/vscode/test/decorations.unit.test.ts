// Unit tests for `src/decorations.ts`.
//
// Drives every branch of `LensDecorations`: constructor, updateColors (dispose
// old + create new), apply (client + server, hover-cache miss-then-hit,
// multiple ranges per usage), clear, dispose, plus `toDisplayPath` (relative
// vs. basename fallback) and `createDecorationType` (via constructor).

import * as path from 'node:path'

import { beforeEach, describe, expect, test } from 'bun:test'
import type * as vscode from 'vscode'

import type { ComponentUsage } from '../src/analyzerWasm'
import { LensDecorations } from '../src/decorations'
import * as vscodeMock from './_mocks/vscode'

const CLIENT_COLOR = '#aa0000'
const SERVER_COLOR = '#0000aa'

function makeUsage(
  kind: 'client' | 'server',
  sourceFilePath: string,
  ranges: { start: number; end: number }[],
  tagName = 'Demo',
): ComponentUsage {
  return { kind, ranges, sourceFilePath, tagName }
}

function makeEditor(fileName: string, text: string): vscode.TextEditor {
  // FakeTextEditor only implements `document` and `setDecorations` — the
  // only surface `LensDecorations.apply` actually touches. Cast at the
  // boundary so the production type contract elsewhere stays intact.
  const document = new vscodeMock.FakeTextDocument(fileName, text)
  return vscodeMock.__makeFakeEditor(document) as unknown as vscode.TextEditor
}

beforeEach(() => {
  vscodeMock.__resetAll()
})

describe('LensDecorations.constructor', () => {
  test('creates two decoration types from the provided colors', () => {
    new LensDecorations({
      clientComponent: CLIENT_COLOR,
      serverComponent: SERVER_COLOR,
    })

    const types = vscodeMock.__getDecorationTypes()
    expect(types.length).toBe(2)
    expect(types[0]!.options.color).toBe(CLIENT_COLOR)
    expect(types[1]!.options.color).toBe(SERVER_COLOR)
    // sanity-check the immutable decoration knobs the production code sets.
    expect(types[0]!.options.overviewRulerColor).toBe(CLIENT_COLOR)
    expect(types[0]!.options.overviewRulerLane).toBe(
      vscodeMock.OverviewRulerLane.Right,
    )
    expect(types[0]!.options.rangeBehavior).toBe(
      vscodeMock.DecorationRangeBehavior.ClosedClosed,
    )
  })
})

describe('LensDecorations.updateColors', () => {
  test('disposes the old decoration types and creates fresh ones', () => {
    const decorations = new LensDecorations({
      clientComponent: CLIENT_COLOR,
      serverComponent: SERVER_COLOR,
    })

    const before = vscodeMock.__getDecorationTypes().slice()
    decorations.updateColors({
      clientComponent: '#new-client',
      serverComponent: '#new-server',
    })

    expect(before[0]!.disposed).toBe(true)
    expect(before[1]!.disposed).toBe(true)

    const all = vscodeMock.__getDecorationTypes()
    expect(all.length).toBe(4)
    expect(all[2]!.options.color).toBe('#new-client')
    expect(all[3]!.options.color).toBe('#new-server')
  })
})

describe('LensDecorations.apply', () => {
  test('partitions ranges by kind, builds hover messages, and dedupes per source path', () => {
    const decorations = new LensDecorations({
      clientComponent: CLIENT_COLOR,
      serverComponent: SERVER_COLOR,
    })

    // editor lives at C:\proj\app\page.tsx (the platform-appropriate join).
    const editorFile = path.join('proj', 'app', 'page.tsx')
    const editorText = 'aaaa\nbbbbbb\ncccc'

    // Two client usages sharing the SAME sourceFilePath → hover should be
    // built once and then re-used on the second usage (cache HIT).
    const clientSource = path.join('proj', 'components', 'Button.tsx')
    const serverSource = path.join('proj', 'app', 'page.tsx')
    const otherClientSource = path.join('proj', 'components', 'Modal.tsx')

    const usages: ComponentUsage[] = [
      // client #1, two ranges
      makeUsage(
        'client',
        clientSource,
        [
          { end: 4, start: 0 },
          { end: 11, start: 5 },
        ],
        'Button',
      ),
      // client #2 with the SAME source path → hover-cache HIT branch
      makeUsage('client', clientSource, [{ end: 16, start: 12 }], 'Button'),
      // client #3 with a different source path → another cache MISS
      makeUsage('client', otherClientSource, [{ end: 16, start: 12 }], 'Modal'),
      // server #1
      makeUsage('server', serverSource, [{ end: 4, start: 0 }], 'Page'),
      // server #2 same source as server #1 → cache HIT (server side)
      makeUsage('server', serverSource, [{ end: 4, start: 0 }], 'Page'),
    ]

    const editor = makeEditor(editorFile, editorText)
    decorations.apply(editor, usages)

    const calls = vscodeMock.__getSetDecorationsCalls()
    expect(calls.length).toBe(2)
    // First call: client. Two client usages with the shared source plus the
    // separate one → 2 + 1 + 1 = 4 range entries.
    expect(calls[0]!.type.options.color).toBe(CLIENT_COLOR)
    expect(calls[0]!.decorations.length).toBe(4)
    // First two decorations come from the same usage so share their hover.
    expect(calls[0]!.decorations[0]!.hoverMessage).toBe(
      calls[0]!.decorations[1]!.hoverMessage,
    )
    // Second client usage points at the same source → same hover instance.
    expect(calls[0]!.decorations[2]!.hoverMessage).toBe(
      calls[0]!.decorations[0]!.hoverMessage,
    )
    // Third client usage uses a different source → different hover instance.
    expect(calls[0]!.decorations[3]!.hoverMessage).not.toBe(
      calls[0]!.decorations[0]!.hoverMessage,
    )
    // Hover renders the "Client component from ..." string with the
    // editor-relative path.
    const clientHover = calls[0]!.decorations[0]!.hoverMessage
    expect(clientHover.value).toContain('Client component from')
    const editorDir = path.dirname(editorFile)
    expect(clientHover.value).toContain(path.relative(editorDir, clientSource))
    // Ranges are wrapped through `document.positionAt`; the first range
    // spans offsets 0..4 which is line 0.
    expect(calls[0]!.decorations[0]!.range.start.line).toBe(0)

    // Second call: server. Two server usages with the same source.
    expect(calls[1]!.type.options.color).toBe(SERVER_COLOR)
    expect(calls[1]!.decorations.length).toBe(2)
    expect(calls[1]!.decorations[0]!.hoverMessage).toBe(
      calls[1]!.decorations[1]!.hoverMessage,
    )
    expect(calls[1]!.decorations[0]!.hoverMessage.value).toContain(
      'Server component from',
    )
  })

  test('falls back to basename when sourceFilePath equals the editor directory', () => {
    // When `path.relative(editorDir, sourceFilePath)` returns '' the display
    // falls back to `path.basename(sourceFilePath)`.
    const decorations = new LensDecorations({
      clientComponent: CLIENT_COLOR,
      serverComponent: SERVER_COLOR,
    })

    const editorFile = path.join('proj', 'a', 'page.tsx')
    const editorDir = path.dirname(editorFile)
    const editor = makeEditor(editorFile, 'xxxxxx')

    // The source is the editor directory itself: `path.relative` returns ''.
    decorations.apply(editor, [
      makeUsage('client', editorDir, [{ end: 3, start: 0 }], 'Same'),
    ])

    const call = vscodeMock.__getSetDecorationsCalls()[0]!
    expect(call.decorations[0]!.hoverMessage.value).toContain(
      path.basename(editorDir),
    )
  })
})

describe('LensDecorations.clear', () => {
  test('sends empty decoration arrays for both kinds', () => {
    const decorations = new LensDecorations({
      clientComponent: CLIENT_COLOR,
      serverComponent: SERVER_COLOR,
    })
    const editor = makeEditor('p.tsx', '')
    decorations.clear(editor)

    const calls = vscodeMock.__getSetDecorationsCalls()
    expect(calls.length).toBe(2)
    expect(calls[0]!.decorations.length).toBe(0)
    expect(calls[1]!.decorations.length).toBe(0)
  })
})

describe('LensDecorations.dispose', () => {
  test('disposes both decoration types', () => {
    const decorations = new LensDecorations({
      clientComponent: CLIENT_COLOR,
      serverComponent: SERVER_COLOR,
    })
    const [client, server] = vscodeMock.__getDecorationTypes()
    decorations.dispose()
    expect(client!.disposed).toBe(true)
    expect(server!.disposed).toBe(true)
  })
})
