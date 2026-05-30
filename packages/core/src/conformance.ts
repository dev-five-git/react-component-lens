import type { ComponentUsage } from './analyzer'

/**
 * Canonical conformance representation of an analyzer result, per
 * `conformance/CONTRACT.md` (contractVersion 1). Both the TypeScript oracle
 * and the Rust engine must produce byte-identical `serializeCanonical` output.
 *
 * Positions are UTF-16 code-unit offsets (TypeScript-native = JS string
 * indices), `end` exclusive.
 */
export interface CanonicalRange {
  end: number
  start: number
}

export interface CanonicalUsage {
  kind: 'client' | 'server'
  ranges: CanonicalRange[]
  sourceFilePath: string
  tagName: string
}

/** Normalize a path to canonical form: forward slashes, lowercased drive letter. */
export function normalizePath(filePath: string): string {
  let normalized = filePath.replace(/\\/g, '/')
  if (normalized.length >= 2 && normalized[1] === ':') {
    const drive = normalized.charCodeAt(0)
    if (drive >= 65 && drive <= 90) {
      normalized = normalized[0]!.toLowerCase() + normalized.slice(1)
    }
  }
  return normalized
}

function compareRanges(a: CanonicalRange, b: CanonicalRange): number {
  if (a.start !== b.start) {
    return a.start - b.start
  }
  return a.end - b.end
}

function compareCanonical(a: CanonicalUsage, b: CanonicalUsage): number {
  const aFirst = a.ranges[0]
  const bFirst = b.ranges[0]
  if (aFirst && bFirst) {
    if (aFirst.start !== bFirst.start) {
      return aFirst.start - bFirst.start
    }
    if (aFirst.end !== bFirst.end) {
      return aFirst.end - bFirst.end
    }
  } else if (aFirst || bFirst) {
    return aFirst ? 1 : -1
  }

  if (a.kind !== b.kind) {
    return a.kind < b.kind ? -1 : 1
  }
  if (a.tagName !== b.tagName) {
    return a.tagName < b.tagName ? -1 : 1
  }
  if (a.sourceFilePath !== b.sourceFilePath) {
    return a.sourceFilePath < b.sourceFilePath ? -1 : 1
  }

  const shared = Math.min(a.ranges.length, b.ranges.length)
  for (let i = 1; i < shared; i++) {
    const diff = compareRanges(a.ranges[i]!, b.ranges[i]!)
    if (diff !== 0) {
      return diff
    }
  }
  return a.ranges.length - b.ranges.length
}

/**
 * Map raw analyzer usages into the canonical, deduplicated, total-ordered form.
 */
export function toCanonicalUsages(usages: ComponentUsage[]): CanonicalUsage[] {
  const mapped: CanonicalUsage[] = usages.map((usage) => ({
    kind: usage.kind,
    ranges: usage.ranges
      .map((range) => ({ end: range.end, start: range.start }))
      .sort(compareRanges),
    sourceFilePath: normalizePath(usage.sourceFilePath),
    tagName: usage.tagName,
  }))

  const seen = new Set<string>()
  const deduped: CanonicalUsage[] = []
  for (const usage of mapped) {
    const key = serializeUsage(usage)
    if (seen.has(key)) {
      continue
    }
    seen.add(key)
    deduped.push(usage)
  }

  deduped.sort(compareCanonical)
  return deduped
}

function serializeUsage(usage: CanonicalUsage): string {
  let rangesJson = '['
  for (let i = 0; i < usage.ranges.length; i++) {
    const range = usage.ranges[i]!
    if (i > 0) {
      rangesJson += ','
    }
    rangesJson += '{"start":' + range.start + ',"end":' + range.end + '}'
  }
  rangesJson += ']'
  return (
    '{"kind":' +
    JSON.stringify(usage.kind) +
    ',"tagName":' +
    JSON.stringify(usage.tagName) +
    ',"sourceFilePath":' +
    JSON.stringify(usage.sourceFilePath) +
    ',"ranges":' +
    rangesJson +
    '}'
  )
}

/**
 * Canonical compact-JSON serialization (contract §3.4). Fixed field order,
 * no insignificant whitespace; the byte-level parity unit for the analyzer.
 */
export function serializeCanonical(usages: ComponentUsage[]): string {
  const canonical = toCanonicalUsages(usages)
  let out = '['
  for (let i = 0; i < canonical.length; i++) {
    if (i > 0) {
      out += ','
    }
    out += serializeUsage(canonical[i]!)
  }
  out += ']'
  return out
}
