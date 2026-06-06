// Unit tests for `src/wasmHost.ts`. Cover every branch of:
//   - toWasmPath / toDiskPath path bijection (BOTH platforms via stubbed
//     `process.platform`)
//   - WorkspaceHost.readToString / read / metadata / symlinkMetadata /
//     canonicalize (open-doc, fs success, fs failure)
//   - WorkspaceHost.getOpenDocument cache build + lastFilePath fast-path
//   - WorkspaceHost.invalidateDocumentCache
//   - createOpenSignature / createDiskSignature

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

import {
  createDiskSignature,
  createOpenSignature,
  toDiskPath,
  toWasmPath,
  WorkspaceHost,
} from '../src/wasmHost'
import * as vscodeMock from './_mocks/vscode'

const originalPlatform = process.platform
const tempRoots: string[] = []

function withPlatform(value: NodeJS.Platform, body: () => void): void {
  Object.defineProperty(process, 'platform', {
    configurable: true,
    value,
  })
  try {
    body()
  } finally {
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: originalPlatform,
    })
  }
}

function makeTempProject(label: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `rcl-test-unit-${label}-`))
  tempRoots.push(root)
  return root
}

beforeEach(() => {
  vscodeMock.__clearOpenDocs()
})

afterEach(() => {
  vscodeMock.__clearOpenDocs()
})

afterAll(() => {
  for (const root of tempRoots) {
    try {
      fs.rmSync(root, { recursive: true, force: true })
    } catch {
      // ignore
    }
  }
})

describe('toWasmPath', () => {
  test('POSIX-absolute paths pass through unchanged', () => {
    expect(toWasmPath('/etc/host.tsx')).toBe('/etc/host.tsx')
  })

  test('Windows drive paths become POSIX with leading slash', () => {
    expect(toWasmPath('C:\\a\\b.tsx')).toBe('/C:/a/b.tsx')
    expect(toWasmPath('d:\\Users\\x.tsx')).toBe('/d:/Users/x.tsx')
  })

  test('relative non-drive paths only normalize separators', () => {
    expect(toWasmPath('a\\b\\c.tsx')).toBe('a/b/c.tsx')
    expect(toWasmPath('a/b/c.tsx')).toBe('a/b/c.tsx')
  })
})

describe('toDiskPath', () => {
  test('non-win32 returns the WASM path verbatim', () => {
    withPlatform('linux', () => {
      expect(toDiskPath('/C:/a/b.tsx')).toBe('/C:/a/b.tsx')
      expect(toDiskPath('/etc/host')).toBe('/etc/host')
    })
  })

  test('win32 strips the synthetic leading slash and converts separators', () => {
    withPlatform('win32', () => {
      expect(toDiskPath('/C:/a/b.tsx')).toBe('C:\\a\\b.tsx')
    })
  })

  test('win32 leaves a POSIX path without a drive untouched apart from separators', () => {
    withPlatform('win32', () => {
      expect(toDiskPath('/etc/host')).toBe('\\etc\\host')
    })
  })
})

describe('WorkspaceHost.readToString', () => {
  test('returns the open document text when one is registered', () => {
    const root = makeTempProject('reads-open')
    const filePath = path.join(root, 'page.tsx')
    fs.writeFileSync(filePath, 'on-disk')
    vscodeMock.__upsertOpenDoc(
      new vscodeMock.FakeTextDocument(filePath, 'in-buffer'),
    )

    const host = new WorkspaceHost()
    expect(host.readToString(toWasmPath(filePath))).toBe('in-buffer')
  })

  test('falls back to disk read when no buffer is open', () => {
    const root = makeTempProject('reads-disk')
    const filePath = path.join(root, 'page.tsx')
    fs.writeFileSync(filePath, 'disk-content')

    const host = new WorkspaceHost()
    expect(host.readToString(toWasmPath(filePath))).toBe('disk-content')
  })

  test('returns undefined when fs.readFileSync throws', () => {
    const host = new WorkspaceHost()
    const missing = path.join(os.tmpdir(), 'rcl-missing-xyz', 'nope.tsx')
    expect(host.readToString(toWasmPath(missing))).toBeUndefined()
  })
})

describe('WorkspaceHost.read', () => {
  test('returns Buffer-backed Uint8Array for an open document', () => {
    const root = makeTempProject('read-open')
    const filePath = path.join(root, 'page.tsx')
    vscodeMock.__upsertOpenDoc(new vscodeMock.FakeTextDocument(filePath, 'hi'))

    const host = new WorkspaceHost()
    const bytes = host.read(toWasmPath(filePath))
    expect(bytes).toBeInstanceOf(Uint8Array)
    expect(new TextDecoder().decode(bytes)).toBe('hi')
  })

  test('falls back to fs.readFileSync for disk-only files', () => {
    const root = makeTempProject('read-disk')
    const filePath = path.join(root, 'page.tsx')
    fs.writeFileSync(filePath, 'from-disk')

    const host = new WorkspaceHost()
    const bytes = host.read(toWasmPath(filePath))
    expect(new TextDecoder().decode(bytes)).toBe('from-disk')
  })

  test('returns undefined when the file is missing', () => {
    const host = new WorkspaceHost()
    const missing = path.join(os.tmpdir(), 'rcl-missing-xyz', 'nope.tsx')
    expect(host.read(toWasmPath(missing))).toBeUndefined()
  })
})

describe('WorkspaceHost.metadata', () => {
  test('uses the open-document fast path', () => {
    const root = makeTempProject('meta-open')
    const filePath = path.join(root, 'p.tsx')
    vscodeMock.__upsertOpenDoc(new vscodeMock.FakeTextDocument(filePath, 'x'))

    const host = new WorkspaceHost()
    const meta = host.metadata(toWasmPath(filePath))
    expect(meta).toEqual({ isFile: true, isDir: false, isSymlink: false })
  })

  test('returns stat-based metadata for a file on disk', () => {
    const root = makeTempProject('meta-disk')
    const filePath = path.join(root, 'p.tsx')
    fs.writeFileSync(filePath, 'x')

    const host = new WorkspaceHost()
    expect(host.metadata(toWasmPath(filePath))).toEqual({
      isFile: true,
      isDir: false,
      isSymlink: false,
    })
  })

  test('returns undefined when the file is missing', () => {
    const host = new WorkspaceHost()
    const missing = path.join(os.tmpdir(), 'rcl-missing-xyz', 'nope.tsx')
    expect(host.metadata(toWasmPath(missing))).toBeUndefined()
  })
})

describe('WorkspaceHost.symlinkMetadata', () => {
  test('returns lstat-based metadata when the file exists', () => {
    const root = makeTempProject('lmeta')
    const filePath = path.join(root, 'p.tsx')
    fs.writeFileSync(filePath, 'x')

    const host = new WorkspaceHost()
    const meta = host.symlinkMetadata(toWasmPath(filePath))
    expect(meta).toEqual({ isFile: true, isDir: false, isSymlink: false })
  })

  test('returns undefined when the file is missing', () => {
    const host = new WorkspaceHost()
    const missing = path.join(os.tmpdir(), 'rcl-missing-xyz', 'nope.tsx')
    expect(host.symlinkMetadata(toWasmPath(missing))).toBeUndefined()
  })
})

describe('WorkspaceHost.canonicalize', () => {
  test('returns the realpath rendered as a WASM path', () => {
    const root = makeTempProject('canon')
    const filePath = path.join(root, 'p.tsx')
    fs.writeFileSync(filePath, 'x')

    const host = new WorkspaceHost()
    const resolved = host.canonicalize(toWasmPath(filePath))
    expect(resolved).toBeDefined()
    // Realpath of a file is the file itself; we then re-encode through
    // toWasmPath so the result is POSIX-style.
    expect(resolved).toBe(toWasmPath(fs.realpathSync(filePath)))
  })

  test('returns undefined when realpath throws', () => {
    const host = new WorkspaceHost()
    const missing = path.join(os.tmpdir(), 'rcl-missing-xyz', 'nope.tsx')
    expect(host.canonicalize(toWasmPath(missing))).toBeUndefined()
  })
})

describe('WorkspaceHost.getOpenDocument caching', () => {
  test('invalidateDocumentCache forces a fresh scan of workspace.textDocuments', () => {
    const root = makeTempProject('cache')
    const filePath = path.join(root, 'p.tsx')
    const host = new WorkspaceHost()

    // No open doc yet → readToString falls back to disk (missing → undefined),
    // which also builds the (empty) cache.
    expect(host.readToString(toWasmPath(filePath))).toBeUndefined()

    // Now register an open buffer and read again. Without invalidation the
    // cached (empty) map would still be used.
    vscodeMock.__upsertOpenDoc(
      new vscodeMock.FakeTextDocument(filePath, 'fresh-text'),
    )
    expect(host.readToString(toWasmPath(filePath))).toBeUndefined()

    host.invalidateDocumentCache()
    expect(host.readToString(toWasmPath(filePath))).toBe('fresh-text')
  })

  test('repeated reads of the same path hit the lastFilePath fast-path', () => {
    const root = makeTempProject('fast')
    const filePath = path.join(root, 'p.tsx')
    vscodeMock.__upsertOpenDoc(
      new vscodeMock.FakeTextDocument(filePath, 'cached'),
    )

    const host = new WorkspaceHost()
    expect(host.readToString(toWasmPath(filePath))).toBe('cached')
    // Same path → exercises the `filePath === lastFilePath` skip branch.
    expect(host.readToString(toWasmPath(filePath))).toBe('cached')
  })
})

describe('signature helpers', () => {
  test('createOpenSignature renders an open: token', () => {
    expect(createOpenSignature(7)).toBe('open:7')
  })

  test('createDiskSignature renders a disk: token', () => {
    expect(createDiskSignature(1234.5, 9)).toBe('disk:1234.5:9')
  })
})
