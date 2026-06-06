// Unit tests for `src/analyzerWasm.ts`.
//
// Drives every public surface (constructor, clear, invalidateFile,
// analyzeDocument, findComponentDeclaration). `clear()` and
// `invalidateFile()` are intentional no-ops on the WASM adapter today; we
// still call them to keep the contract honest. `analyzeDocument` and
// `findComponentDeclaration` exercise the real WASM core: `wasmSetup.ts`
// copies `core_wasm.js` next to the source before any test runs.

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterAll, beforeEach, describe, expect, test } from 'bun:test'

import { ComponentLensAnalyzer, type ScopeConfig } from '../src/analyzerWasm'
import { toWasmPath, WorkspaceHost } from '../src/wasmHost'
import * as vscodeMock from './_mocks/vscode'

const FULL_SCOPE: ScopeConfig = {
  declaration: true,
  element: true,
  export: true,
  import: true,
  type: true,
}

const tempRoots: string[] = []

function makeTempProject(label: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `rcl-test-aw-${label}-`))
  tempRoots.push(root)
  return root
}

function writeProjectFile(root: string, rel: string, content: string): string {
  const full = path.join(root, rel)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, content)
  return full
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
  vscodeMock.__clearOpenDocs()
})

describe('ComponentLensAnalyzer.clear / invalidateFile', () => {
  test('clear() is a documented no-op that does not throw', () => {
    const analyzer = new ComponentLensAnalyzer(new WorkspaceHost())
    expect(() => analyzer.clear()).not.toThrow()
  })

  test('invalidateFile() is a documented no-op that does not throw', () => {
    const analyzer = new ComponentLensAnalyzer(new WorkspaceHost())
    expect(() => analyzer.invalidateFile('whatever')).not.toThrow()
  })
})

describe('ComponentLensAnalyzer.analyzeDocument', () => {
  test('maps WASM result through toDiskPath for sourceFilePath', async () => {
    const root = makeTempProject('analyze-disk-path')
    const pagePath = writeProjectFile(
      root,
      'app/page.tsx',
      "import { Button } from '../components/Button'\nexport default function Page(){ return <Button/> }\n",
    )
    const buttonPath = writeProjectFile(
      root,
      'components/Button.tsx',
      "'use client'\nexport function Button(){ return null }\n",
    )

    const analyzer = new ComponentLensAnalyzer(new WorkspaceHost())
    const usages = await analyzer.analyzeDocument(
      pagePath,
      fs.readFileSync(pagePath, 'utf8'),
      'open:1',
      FULL_SCOPE,
    )

    expect(usages.length).toBeGreaterThan(0)
    const button = usages.find((u) => u.tagName === 'Button')
    expect(button).toBeDefined()
    expect(button?.kind).toBe('client')
    // sourceFilePath must round-trip back to the OS-native form via
    // toDiskPath - on win32 that's backslashes + drive letter.
    if (process.platform === 'win32') {
      expect(button?.sourceFilePath).toMatch(/^[A-Z]:\\/)
      expect(button?.sourceFilePath).toBe(fs.realpathSync(buttonPath))
    } else {
      expect(button?.sourceFilePath).toBe(fs.realpathSync(buttonPath))
    }
  })
})

describe('ComponentLensAnalyzer.findComponentDeclaration', () => {
  test('returns undefined when readToString cannot resolve the file', async () => {
    const analyzer = new ComponentLensAnalyzer(new WorkspaceHost())
    const missing = path.join(os.tmpdir(), 'rcl-missing', 'never.tsx')
    const position = await analyzer.findComponentDeclaration(missing, 'Foo')
    expect(position).toBeUndefined()
  })

  test('returns a 0-based line/character for an exported function component', async () => {
    const root = makeTempProject('find-decl')
    const buttonPath = writeProjectFile(
      root,
      'Button.tsx',
      "'use client'\nexport function Button(){ return null }\n",
    )
    // Open the file as a buffer so WorkspaceHost.readToString hits the
    // open-doc fast path (and we don't need to wait on a real disk read).
    vscodeMock.__upsertOpenDoc(
      new vscodeMock.FakeTextDocument(
        buttonPath,
        fs.readFileSync(buttonPath, 'utf8'),
      ),
    )

    const analyzer = new ComponentLensAnalyzer(new WorkspaceHost())
    const position = await analyzer.findComponentDeclaration(
      buttonPath,
      'Button',
    )

    expect(position).toBeDefined()
    expect(position?.line).toBe(1)
    expect(typeof position?.character).toBe('number')
    expect(position?.character).toBeGreaterThanOrEqual(0)
  })

  test('returns undefined when the requested identifier is not declared', async () => {
    const root = makeTempProject('find-decl-missing')
    const buttonPath = writeProjectFile(
      root,
      'Button.tsx',
      "'use client'\nexport function Button(){ return null }\n",
    )
    vscodeMock.__upsertOpenDoc(
      new vscodeMock.FakeTextDocument(
        buttonPath,
        fs.readFileSync(buttonPath, 'utf8'),
      ),
    )

    const analyzer = new ComponentLensAnalyzer(new WorkspaceHost())
    // toWasmPath is already what analyzer would apply internally; we just
    // want the WASM core to be asked for a name that isn't present.
    const ignored = toWasmPath(buttonPath)
    expect(ignored.length).toBeGreaterThan(0)
    const position = await analyzer.findComponentDeclaration(
      buttonPath,
      'DoesNotExist',
    )
    expect(position).toBeUndefined()
  })
})
