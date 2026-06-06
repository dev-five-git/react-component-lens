import * as fs from 'node:fs'
import * as path from 'node:path'

import * as vscode from 'vscode'

interface FileMetadata {
  isFile: boolean
  isDir: boolean
  isSymlink: boolean
}

const OPEN_DOC_METADATA: FileMetadata = {
  isFile: true,
  isDir: false,
  isSymlink: false,
}

const DRIVE_PATH_RE = /^[A-Za-z]:\//
const WASM_DRIVE_PATH_RE = /^\/[A-Za-z]:\//

export function toWasmPath(diskPath: string): string {
  if (diskPath.startsWith('/')) {
    return diskPath
  }

  const normalizedPath = diskPath.replaceAll('\\', '/')
  if (DRIVE_PATH_RE.test(normalizedPath)) {
    return '/' + normalizedPath
  }
  return normalizedPath
}

export function toDiskPath(wasmPath: string): string {
  if (process.platform !== 'win32') {
    return wasmPath
  }

  const diskPath = WASM_DRIVE_PATH_RE.test(wasmPath)
    ? wasmPath.slice(1)
    : wasmPath
  return diskPath.replaceAll('/', '\\')
}

export class WorkspaceHost {
  private documentCache: Map<string, vscode.TextDocument> | undefined
  private lastFilePath: string
  private lastNormalizedPath: string

  // Explicit constructor (the field initializers below run in its body): bun
  // 1.3.9's coverage emits a phantom synthetic default constructor at an
  // out-of-range source offset that can never be marked "hit", capping function
  // coverage (oven-sh/bun#29691, fixed in 1.3.13). Declaring the constructor
  // makes it count normally; runtime behavior is identical.
  public constructor() {
    this.lastFilePath = ''
    this.lastNormalizedPath = ''
  }

  public readToString(filePath: string): string | undefined {
    const diskPath = toDiskPath(filePath)
    const openDocument = this.getOpenDocument(diskPath)
    if (openDocument) {
      return openDocument.getText()
    }

    try {
      return fs.readFileSync(diskPath, 'utf8')
    } catch {
      return undefined
    }
  }

  public read(filePath: string): Uint8Array | undefined {
    const diskPath = toDiskPath(filePath)
    const openDocument = this.getOpenDocument(diskPath)
    if (openDocument) {
      return Buffer.from(openDocument.getText(), 'utf8')
    }

    try {
      const buffer = fs.readFileSync(diskPath)
      return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
    } catch {
      return undefined
    }
  }

  public metadata(filePath: string): FileMetadata | undefined {
    const diskPath = toDiskPath(filePath)
    const openDocument = this.getOpenDocument(diskPath)
    if (openDocument) {
      return { ...OPEN_DOC_METADATA }
    }

    const stats = fs.statSync(diskPath, { throwIfNoEntry: false })
    if (!stats) {
      return undefined
    }
    return {
      isFile: stats.isFile(),
      isDir: stats.isDirectory(),
      isSymlink: stats.isSymbolicLink(),
    }
  }

  public symlinkMetadata(filePath: string): FileMetadata | undefined {
    const diskPath = toDiskPath(filePath)
    const stats = fs.lstatSync(diskPath, { throwIfNoEntry: false })
    if (!stats) {
      return undefined
    }
    return {
      isFile: stats.isFile(),
      isDir: stats.isDirectory(),
      isSymlink: stats.isSymbolicLink(),
    }
  }

  public canonicalize(filePath: string): string | undefined {
    const diskPath = toDiskPath(filePath)
    try {
      return toWasmPath(fs.realpathSync(diskPath))
    } catch {
      return undefined
    }
  }

  public invalidateDocumentCache(): void {
    this.documentCache = undefined
  }

  private getOpenDocument(filePath: string): vscode.TextDocument | undefined {
    if (!this.documentCache) {
      this.documentCache = new Map()
      for (const document of vscode.workspace.textDocuments) {
        this.documentCache.set(path.normalize(document.uri.fsPath), document)
      }
    }

    if (filePath !== this.lastFilePath) {
      this.lastFilePath = filePath
      this.lastNormalizedPath = path.normalize(filePath)
    }
    return this.documentCache.get(this.lastNormalizedPath)
  }
}

export function createOpenSignature(version: number): string {
  return 'open:' + version
}

export function createDiskSignature(mtimeMs: number, size: number): string {
  return 'disk:' + mtimeMs + ':' + size
}
