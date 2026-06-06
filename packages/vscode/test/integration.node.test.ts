// Integration tests for the VS Code WASM analyzer boundary.
//
// `wasmSetup.ts` preloads a minimal `vscode` module mock and copies the real
// WASM artifact next to the TypeScript source so `analyzerWasm.ts` can require
// it exactly as the extension does. These tests feed native OS-absolute paths
// (Windows `C:\\...\\app\\page.tsx` or POSIX `/.../app/page.tsx`, via
// `os.tmpdir()`) into the public analyzer API; only the JS/WASM boundary may
// translate them. Path-separator assertions use `path.sep`, and the Windows
// drive-letter bijection is asserted only on win32.
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterAll, beforeEach, describe, expect, test } from 'bun:test'

import {
  ComponentLensAnalyzer,
  type ComponentUsage,
  type ScopeConfig,
} from '../src/analyzerWasm'
import { toDiskPath, toWasmPath, WorkspaceHost } from '../src/wasmHost'
import * as vscodeMock from './_mocks/vscode'

const FULL_SCOPE: ScopeConfig = {
  declaration: true,
  element: true,
  export: true,
  import: true,
  type: true,
}

const PACKAGE_ROOT = path.resolve(__dirname, '..')
const SRC_DIR = path.join(PACKAGE_ROOT, 'src')
const COPIED_WASM_FILES = ['core_wasm.js', 'core_wasm_bg.wasm'] as const
const createdTempRoots: string[] = []

function makeTempProject(label: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `rcl-test-${label}-`))
  createdTempRoots.push(root)
  return root
}

function writeProjectFile(
  root: string,
  relativePath: string,
  content: string,
): string {
  const fullPath = path.join(root, relativePath)
  fs.mkdirSync(path.dirname(fullPath), { recursive: true })
  fs.writeFileSync(fullPath, content)
  return fullPath
}

function kindsFor(usages: ComponentUsage[], tagName: string): string[] {
  return usages
    .filter((usage) => usage.tagName === tagName)
    .map((usage) => usage.kind)
}

afterAll(() => {
  for (const file of COPIED_WASM_FILES) {
    try {
      fs.unlinkSync(path.join(SRC_DIR, file))
    } catch {
      // ignore: file already gone or unwritable
    }
  }
  for (const root of createdTempRoots) {
    try {
      fs.rmSync(root, { recursive: true, force: true })
    } catch {
      // ignore: temp dir already gone
    }
  }
})

beforeEach(() => {
  vscodeMock.__clearOpenDocs()
})

describe('WASM path boundary helpers', () => {
  test('round-trips Windows drive paths through POSIX WASM paths', () => {
    // `toWasmPath` is a pure string transform (always POSIX-normalizes for the
    // WASM core), so it behaves identically on every platform.
    expect(toWasmPath('C:\\a\\b.tsx')).toBe('/C:/a/b.tsx')
    expect(toWasmPath('/C:/a/b.tsx')).toBe('/C:/a/b.tsx')

    if (process.platform === 'win32') {
      // On Windows the boundary maps the POSIX form back to a native drive path.
      expect(toDiskPath('/C:/a/b.tsx')).toBe('C:\\a\\b.tsx')
      expect(toDiskPath(toWasmPath('C:\\a\\b.tsx'))).toBe('C:\\a\\b.tsx')
    } else {
      // On POSIX `/C:/a/b.tsx` is already a valid disk path; there is no
      // drive-letter conversion to perform.
      expect(toDiskPath('/C:/a/b.tsx')).toBe('/C:/a/b.tsx')
      expect(toDiskPath(toWasmPath('/C:/a/b.tsx'))).toBe('/C:/a/b.tsx')
    }
  })
})

describe('VS Code extension integration (analyzerWasm -> WASM core -> resolver)', () => {
  test('S1 happy: real Windows path resolves relative import; <Button/> = client and Page declaration = server', async () => {
    const root = makeTempProject('s1-happy')
    const pagePath = writeProjectFile(
      root,
      'app/page.tsx',
      "import { Button } from '../components/Button'\nexport default function Page(){ return <Button/> }\n",
    )
    writeProjectFile(
      root,
      'components/Button.tsx',
      "'use client'\nexport function Button(){ return null }\n",
    )

    expect(pagePath).toContain(path.sep)
    expect(path.isAbsolute(pagePath)).toBe(true)

    const pageDoc = new vscodeMock.FakeTextDocument(
      pagePath,
      fs.readFileSync(pagePath, 'utf8'),
    )
    vscodeMock.__upsertOpenDoc(pageDoc)

    const analyzer = new ComponentLensAnalyzer(new WorkspaceHost())
    const usages = await analyzer.analyzeDocument(
      pagePath,
      pageDoc.getText(),
      'open:' + pageDoc.version,
      FULL_SCOPE,
    )

    const buttonKinds = kindsFor(usages, 'Button')
    const pageKinds = kindsFor(usages, 'Page')

    expect(buttonKinds.length).toBeGreaterThan(0)
    expect(pageKinds.length).toBeGreaterThan(0)
    expect(new Set(buttonKinds)).toEqual(new Set(['client']))
    expect(new Set(pageKinds)).toEqual(new Set(['server']))

    console.info(
      `S1 PASS realPath=${pagePath} Button.kind=${buttonKinds[0]} Page.kind=${pageKinds[0]}`,
    )
  })

  test('S2 live-edit: open Button buffer flips relative import client -> server -> client', async () => {
    const root = makeTempProject('s2-live')
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

    expect(pagePath).toContain(path.sep)
    expect(buttonPath).toContain(path.sep)

    const pageDoc = new vscodeMock.FakeTextDocument(
      pagePath,
      fs.readFileSync(pagePath, 'utf8'),
    )
    const buttonDoc = new vscodeMock.FakeTextDocument(
      buttonPath,
      fs.readFileSync(buttonPath, 'utf8'),
    )
    vscodeMock.__upsertOpenDoc(pageDoc)
    vscodeMock.__upsertOpenDoc(buttonDoc)

    const host = new WorkspaceHost()
    const analyzer = new ComponentLensAnalyzer(host)

    const analyze = async (): Promise<ComponentUsage[]> => {
      host.invalidateDocumentCache()
      return analyzer.analyzeDocument(
        pagePath,
        pageDoc.getText(),
        'open:' + pageDoc.version + ':' + buttonDoc.version,
        FULL_SCOPE,
      )
    }

    const initialKinds = kindsFor(await analyze(), 'Button')
    expect(initialKinds[0]).toBe('client')

    buttonDoc.setText('export function Button(){ return null }\n')
    expect(fs.readFileSync(buttonPath, 'utf8').startsWith("'use client'")).toBe(
      true,
    )
    const afterRemoveKinds = kindsFor(await analyze(), 'Button')
    expect(afterRemoveKinds[0]).toBe('server')

    buttonDoc.setText("'use client'\nexport function Button(){ return null }\n")
    const afterReAddKinds = kindsFor(await analyze(), 'Button')
    expect(afterReAddKinds[0]).toBe('client')

    console.info(
      `S2 PASS realPath=${pagePath} Button.kind transitions ${initialKinds[0]} -> ${afterRemoveKinds[0]} -> ${afterReAddKinds[0]}`,
    )
  })

  test('S3 tsconfig paths + barrel: @ui/index re-export resolves <Card/> as client', async () => {
    const root = makeTempProject('s3-alias')
    writeProjectFile(
      root,
      'tsconfig.json',
      JSON.stringify(
        {
          compilerOptions: {
            baseUrl: '.',
            paths: { '@ui/*': ['src/ui/*'] },
          },
        },
        null,
        2,
      ),
    )
    writeProjectFile(root, 'src/ui/index.ts', "export { Card } from './card'\n")
    writeProjectFile(
      root,
      'src/ui/card.tsx',
      "'use client'\nexport function Card(){ return null }\n",
    )
    const pagePath = writeProjectFile(
      root,
      'app/page.tsx',
      "import { Card } from '@ui/index'\nexport default function Page(){ return <Card/> }\n",
    )

    expect(pagePath).toContain(path.sep)
    const pageDoc = new vscodeMock.FakeTextDocument(
      pagePath,
      fs.readFileSync(pagePath, 'utf8'),
    )
    vscodeMock.__upsertOpenDoc(pageDoc)

    const analyzer = new ComponentLensAnalyzer(new WorkspaceHost())
    const usages = await analyzer.analyzeDocument(
      pagePath,
      pageDoc.getText(),
      'open:' + pageDoc.version,
      FULL_SCOPE,
    )

    const cardKinds = kindsFor(usages, 'Card')
    expect(cardKinds.length).toBeGreaterThan(0)
    expect(new Set(cardKinds)).toEqual(new Set(['client']))

    console.info(`S3 PASS realPath=${pagePath} Card.kind=${cardKinds[0]}`)
  })
})
