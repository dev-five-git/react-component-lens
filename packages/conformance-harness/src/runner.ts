import * as fs from 'node:fs'
import * as path from 'node:path'

import {
  ComponentLensAnalyzer,
  type ComponentUsage,
  createDiskSignature,
  ImportResolver,
  type ScopeConfig,
  serializeCanonical,
  type SourceHost,
} from '@react-component-lens/core'

const ENTRY_BASENAMES = ['entry.tsx', 'entry.jsx', 'entry.ts', 'entry.js']

const DEFAULT_SCOPE: ScopeConfig = {
  declaration: true,
  element: true,
  export: true,
  import: true,
  type: true,
}

const HARNESS_DIR = path.resolve(import.meta.dir, '..')
const REPO_ROOT = path.resolve(HARNESS_DIR, '..', '..')

export const FIXTURES_ROOT = path.join(REPO_ROOT, 'conformance', 'fixtures')
export const GOLDENS_ROOT = path.join(REPO_ROOT, 'conformance', 'goldens')

export function createDiskHost(): SourceHost {
  return {
    fileExists(filePath: string): boolean {
      return fs.existsSync(filePath)
    },
    getSignature(filePath: string): string | undefined {
      if (!fs.existsSync(filePath)) {
        return undefined
      }
      const stats = fs.statSync(filePath)
      return createDiskSignature(stats.mtimeMs, stats.size)
    },
    readFile(filePath: string): string | undefined {
      return fs.existsSync(filePath)
        ? fs.readFileSync(filePath, 'utf8')
        : undefined
    },
  }
}

export function findEntryFile(caseDir: string): string | undefined {
  for (const name of ENTRY_BASENAMES) {
    const candidate = path.join(caseDir, name)
    if (fs.existsSync(candidate)) {
      return candidate
    }
  }
  return undefined
}

function readScope(caseDir: string): ScopeConfig {
  const scopePath = path.join(caseDir, 'scope.json')
  if (!fs.existsSync(scopePath)) {
    return DEFAULT_SCOPE
  }
  const parsed = JSON.parse(
    fs.readFileSync(scopePath, 'utf8'),
  ) as Partial<ScopeConfig>
  return { ...DEFAULT_SCOPE, ...parsed }
}

function toPosixRelative(fromDir: string, absolute: string): string {
  return path.relative(fromDir, absolute).split(path.sep).join('/')
}

/**
 * Analyze a fixture case with the TS oracle and return canonical JSON
 * (contract §3.4) with `sourceFilePath` made relative to the case directory
 * so goldens are machine-independent.
 */
export async function runFixture(caseDir: string): Promise<string> {
  const entry = findEntryFile(caseDir)
  if (!entry) {
    throw new Error(
      `No entry file (entry.tsx|jsx|ts|js) in fixture: ${caseDir}`,
    )
  }
  const host = createDiskHost()
  const analyzer = new ComponentLensAnalyzer(host, new ImportResolver(host))
  const source = fs.readFileSync(entry, 'utf8')
  const stats = fs.statSync(entry)
  const signature = createDiskSignature(stats.mtimeMs, stats.size)
  const usages = await analyzer.analyzeDocument(
    entry,
    source,
    signature,
    readScope(caseDir),
  )
  const relativized: ComponentUsage[] = usages.map((usage) => ({
    kind: usage.kind,
    ranges: usage.ranges,
    sourceFilePath: toPosixRelative(caseDir, usage.sourceFilePath),
    tagName: usage.tagName,
  }))
  return serializeCanonical(relativized)
}

/** Recursively find fixture case directories (those containing an entry file). */
export function findCaseDirs(root: string): string[] {
  const result: string[] = []
  const walk = (dir: string): void => {
    if (findEntryFile(dir)) {
      result.push(dir)
      return
    }
    const childDirs = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
    for (const name of childDirs) {
      walk(path.join(dir, name))
    }
  }
  walk(root)
  return result.sort()
}

/** Golden file path for a fixture case directory. */
export function goldenPathFor(caseDir: string): string {
  const relative = path
    .relative(FIXTURES_ROOT, caseDir)
    .split(path.sep)
    .join('/')
  return path.join(GOLDENS_ROOT, `${relative}.json`)
}
