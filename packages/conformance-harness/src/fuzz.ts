import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import {
  ComponentLensAnalyzer,
  type ComponentUsage,
  ImportResolver,
  serializeCanonical,
  type SourceHost,
} from '@react-component-lens/core'

/**
 * Differential fuzzer. With only the TypeScript oracle present it enforces
 * TS-only invariants (determinism, UTF-16 substring validity, canonical
 * ordering/dedup). When FUZZ_RUST=1 is set, also compares the TS oracle
 * output against the Rust `emit-canonical` binary for byte-equality.
 */

const NOOP_HOST: SourceHost = {
  fileExists: () => false,
  getSignature: () => undefined,
  readFile: () => undefined,
}

function makeAnalyzer(): ComponentLensAnalyzer {
  return new ComponentLensAnalyzer(NOOP_HOST, new ImportResolver(NOOP_HOST))
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function pick<T>(rng: () => number, items: readonly T[]): T {
  return items[Math.floor(rng() * items.length) % items.length]!
}

const DIRECTIVES = [
  '',
  "'use client'\n\n",
  "'use strict'\n'use client'\n\n",
  '// 😀 한국어 주석 é̀\n',
  'const __meta = 1\n',
]

const COMPONENT_TEMPLATES = [
  (n: string): string => `function ${n}() {\n  return <span />\n}\n`,
  (n: string): string => `async function ${n}() {\n  return <div />\n}\n`,
  (n: string): string =>
    `const ${n} = forwardRef(function ${n}() {\n  return <div />\n})\n`,
  (n: string): string =>
    `function ${n}() {\n  return <Pressable onPress={() => undefined} />\n}\n`,
  (n: string): string =>
    `export function ${n}() {\n  return (\n    <${n}>\n      <span />\n    </${n}>\n  )\n}\n`,
]

function generateSource(rng: () => number): string {
  const names = ['Alpha', 'Beta', 'Gamma', 'Delta', 'Pressable']
  let source = pick(rng, DIRECTIVES)
  const count = 1 + Math.floor(rng() * 4)
  for (let i = 0; i < count; i++) {
    const name = names[i % names.length]!
    source += pick(rng, COMPONENT_TEMPLATES)(name)
    source += '\n'
  }
  // A host component referencing some generated components + a member expr.
  source +=
    'export function Host() {\n  return (\n    <Alpha>\n' +
    '      <Beta />\n      <div />\n    </Alpha>\n  )\n}\n'
  return source
}

async function analyzeCanonical(source: string): Promise<string> {
  const usages = await makeAnalyzer().analyzeDocument(
    '/fuzz/Entry.tsx',
    source,
    'open:1',
  )
  const relativized: ComponentUsage[] = usages.map((usage) => ({
    kind: usage.kind,
    ranges: usage.ranges,
    sourceFilePath: 'Entry.tsx',
    tagName: usage.tagName,
  }))
  return serializeCanonical(relativized)
}

// ---------------------------------------------------------------------------
// Rust differential helpers
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(import.meta.dir, '..', '..', '..')
const RUST_BINARY = path.join(
  REPO_ROOT,
  'target',
  'release',
  process.platform === 'win32' ? 'emit-canonical.exe' : 'emit-canonical',
)

function ensureRustBinary(): void {
  if (!fs.existsSync(RUST_BINARY)) {
    process.stderr.write(
      `ERROR: Rust binary not found at ${RUST_BINARY}\n` +
        'Run: cargo build --release -p core-rs --bin emit-canonical\n',
    )
    process.exit(1)
  }
}

function rustCanonical(source: string): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fuzz-rust-'))
  const tmpFile = path.join(tmpDir, 'Entry.tsx')
  try {
    fs.writeFileSync(tmpFile, source, 'utf8')
    const result = Bun.spawnSync([RUST_BINARY, tmpFile], {
      stdout: 'pipe',
      stderr: 'pipe',
    })
    if (result.exitCode !== 0) {
      const errText = result.stderr
        ? new TextDecoder().decode(result.stderr)
        : ''
      throw new Error(`emit-canonical exited ${result.exitCode}: ${errText}`)
    }
    return result.stdout ? new TextDecoder().decode(result.stdout) : ''
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------
// Invariant checks
// ---------------------------------------------------------------------------

export async function checkInvariants(
  source: string,
  rustEnabled = false,
): Promise<string | undefined> {
  const first = await analyzeCanonical(source)
  const second = await analyzeCanonical(source)
  if (first !== second) {
    return 'non-deterministic output'
  }

  const usages = JSON.parse(first) as ComponentUsage[]
  for (const usage of usages) {
    for (const range of usage.ranges) {
      if (
        !(range.start >= 0 && range.start <= range.end) ||
        range.end > source.length
      ) {
        return `range out of bounds: ${JSON.stringify(range)}`
      }
      if (
        source.slice(range.start, range.end).length !==
        range.end - range.start
      ) {
        return `slice length mismatch: ${JSON.stringify(range)}`
      }
    }
  }

  // Canonical form must be idempotent (already sorted + deduped).
  if (serializeCanonical(usages) !== first) {
    return 'canonical form is not idempotent'
  }

  if (rustEnabled) {
    const rustOut = rustCanonical(source)
    if (rustOut !== first) {
      return 'rust-vs-ts diff'
    }
  }

  return undefined
}

async function shrink(source: string, rustEnabled: boolean): Promise<string> {
  let current = source.split('\n')
  let changed = true
  while (changed) {
    changed = false
    for (let i = 0; i < current.length; i++) {
      const candidate = [...current.slice(0, i), ...current.slice(i + 1)]
      // Keep removing lines as long as some invariant is still violated.
      if (
        (await checkInvariants(candidate.join('\n'), rustEnabled)) !== undefined
      ) {
        current = candidate
        changed = true
        break
      }
    }
  }
  return current.join('\n')
}

async function main(): Promise<void> {
  const seedArg = Number(process.env.FUZZ_SEED ?? '1')
  const iterations = Number(process.env.FUZZ_ITERATIONS ?? '500')
  const rustEnabled = process.env.FUZZ_RUST === '1'
  const rng = mulberry32(seedArg)

  if (rustEnabled) {
    ensureRustBinary()
  }

  for (let i = 0; i < iterations; i++) {
    const source = generateSource(rng)
    const violation = await checkInvariants(source, rustEnabled)
    if (violation) {
      const minimized = await shrink(source, rustEnabled)
      let failMsg =
        `FUZZ FAIL (seed=${seedArg}, iter=${i}): ${violation}\n` +
        `--- minimized source ---\n${minimized}\n`
      if (rustEnabled && violation === 'rust-vs-ts diff') {
        const tsOut = await analyzeCanonical(minimized)
        const rustOut = rustCanonical(minimized)
        failMsg +=
          `--- TS output ---\n${tsOut}\n` + `--- Rust output ---\n${rustOut}\n`
      }
      process.stderr.write(failMsg)
      process.exitCode = 1
      return
    }
  }
  const rustSuffix = rustEnabled ? ', zero Rust-vs-TS diffs' : ''
  process.stdout.write(
    `Fuzz OK: ${iterations} iterations from seed ${seedArg}, zero invariant violations${rustSuffix}\n`,
  )
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    process.exitCode = 1
    process.stderr.write(`${String(error)}\n`)
  })
}
