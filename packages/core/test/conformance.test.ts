import { expect, test } from 'bun:test'

import { ComponentLensAnalyzer, type ComponentUsage } from '../src/analyzer'
import {
  normalizePath,
  serializeCanonical,
  toCanonicalUsages,
} from '../src/conformance'
import { ImportResolver, type SourceHost } from '../src/resolver'

const noopHost: SourceHost = {
  fileExists: () => false,
  getSignature: () => undefined,
  readFile: () => undefined,
}

function analyze(filePath: string, source: string): Promise<ComponentUsage[]> {
  const analyzer = new ComponentLensAnalyzer(
    noopHost,
    new ImportResolver(noopHost),
  )
  return analyzer.analyzeDocument(filePath, source, 'open:1')
}

test('normalizePath: forward slashes + lowercased drive letter', () => {
  expect(normalizePath('C:\\a\\b\\Page.tsx')).toBe('c:/a/b/Page.tsx')
  expect(normalizePath('/home/user/Page.tsx')).toBe('/home/user/Page.tsx')
  expect(normalizePath('D:\\Mixed/Path.tsx')).toBe('d:/Mixed/Path.tsx')
})

test('toCanonicalUsages: dedup + total-order sort', () => {
  const dup: ComponentUsage = {
    kind: 'client',
    ranges: [{ end: 7, start: 1 }],
    sourceFilePath: '/p/A.tsx',
    tagName: 'A',
  }
  const later: ComponentUsage = {
    kind: 'server',
    ranges: [{ end: 30, start: 24 }],
    sourceFilePath: '/p/B.tsx',
    tagName: 'B',
  }
  const canonical = toCanonicalUsages([later, dup, { ...dup }])
  expect(canonical.length).toBe(2)
  expect(canonical.map((u) => u.tagName)).toEqual(['A', 'B'])
})

test('toCanonicalUsages: ranges within a usage are sorted ascending', () => {
  const usage: ComponentUsage = {
    kind: 'server',
    ranges: [
      { end: 12, start: 10 },
      { end: 7, start: 1 },
    ],
    sourceFilePath: '/p/A.tsx',
    tagName: 'A',
  }
  const [canonical] = toCanonicalUsages([usage])
  expect(canonical!.ranges).toEqual([
    { end: 7, start: 1 },
    { end: 12, start: 10 },
  ])
})

test('serializeCanonical: compact JSON, fixed field order, raw UTF-8', () => {
  const single: ComponentUsage = {
    kind: 'client',
    ranges: [{ end: 7, start: 1 }],
    sourceFilePath: '/프로젝트/A.tsx',
    tagName: 'A',
  }
  expect(serializeCanonical([single])).toBe(
    '[{"kind":"client","tagName":"A","sourceFilePath":"/프로젝트/A.tsx","ranges":[{"start":1,"end":7}]}]',
  )
})

test('serializeCanonical: multiple usages are comma-joined in canonical order', () => {
  const first: ComponentUsage = {
    kind: 'server',
    ranges: [{ end: 7, start: 1 }],
    sourceFilePath: '/p/A.tsx',
    tagName: 'A',
  }
  const second: ComponentUsage = {
    kind: 'client',
    ranges: [{ end: 30, start: 24 }],
    sourceFilePath: '/p/B.tsx',
    tagName: 'B',
  }
  expect(serializeCanonical([second, first])).toBe(
    '[{"kind":"server","tagName":"A","sourceFilePath":"/p/A.tsx","ranges":[{"start":1,"end":7}]},' +
      '{"kind":"client","tagName":"B","sourceFilePath":"/p/B.tsx","ranges":[{"start":24,"end":30}]}]',
  )
})

function usage(
  overrides: Partial<ComponentUsage> & Pick<ComponentUsage, 'ranges'>,
): ComponentUsage {
  return {
    kind: 'server',
    sourceFilePath: '/p/X.tsx',
    tagName: 'X',
    ...overrides,
  }
}

function order(usages: ComponentUsage[]): string[] {
  return toCanonicalUsages(usages).map(
    (u) =>
      `${u.tagName}:${u.kind}:${u.sourceFilePath}:${u.ranges
        .map((r) => `${r.start}-${r.end}`)
        .join(',')}`,
  )
}

test('compare tie-break: first-range end (equal start)', () => {
  const a = usage({ ranges: [{ end: 7, start: 1 }], tagName: 'A' })
  const b = usage({ ranges: [{ end: 9, start: 1 }], tagName: 'B' })
  expect(order([b, a])).toEqual([
    'A:server:/p/X.tsx:1-7',
    'B:server:/p/X.tsx:1-9',
  ])
})

test('compare tie-break: kind (equal range)', () => {
  const a = usage({
    kind: 'client',
    ranges: [{ end: 6, start: 5 }],
    tagName: 'A',
  })
  const b = usage({
    kind: 'server',
    ranges: [{ end: 6, start: 5 }],
    tagName: 'A',
  })
  expect(order([b, a]).map((s) => s.split(':')[1])).toEqual([
    'client',
    'server',
  ])
})

test('compare tie-break: tagName (equal range + kind)', () => {
  const a = usage({ ranges: [{ end: 6, start: 5 }], tagName: 'Aaa' })
  const b = usage({ ranges: [{ end: 6, start: 5 }], tagName: 'Bbb' })
  expect(order([b, a]).map((s) => s.split(':')[0])).toEqual(['Aaa', 'Bbb'])
})

test('compare tie-break: sourceFilePath (equal range + kind + tag)', () => {
  const a = usage({
    ranges: [{ end: 6, start: 5 }],
    sourceFilePath: '/p/A.tsx',
  })
  const b = usage({
    ranges: [{ end: 6, start: 5 }],
    sourceFilePath: '/p/B.tsx',
  })
  expect(order([b, a]).map((s) => s.split(':')[2])).toEqual([
    '/p/A.tsx',
    '/p/B.tsx',
  ])
})

test('compare tie-break: subsequent range start, then range count', () => {
  const fewer = usage({ ranges: [{ end: 6, start: 5 }], tagName: 'A' })
  const earlier = usage({
    ranges: [
      { end: 6, start: 5 },
      { end: 9, start: 7 },
    ],
    tagName: 'A',
  })
  const later = usage({
    ranges: [
      { end: 9, start: 5 },
      { end: 12, start: 10 },
    ],
    tagName: 'A',
  })
  // fewer (1 range) < earlier (2 ranges, second starts 7) by length;
  // later has different first-range end (9) so it sorts after by end.
  expect(order([later, earlier, fewer])).toEqual([
    'A:server:/p/X.tsx:5-6',
    'A:server:/p/X.tsx:5-6,7-9',
    'A:server:/p/X.tsx:5-9,10-12',
  ])
})

test('compare tie-break: remaining-ranges loop (identical first range)', () => {
  const a = usage({
    ranges: [
      { end: 6, start: 5 },
      { end: 9, start: 7 },
    ],
    tagName: 'A',
  })
  const b = usage({
    ranges: [
      { end: 6, start: 5 },
      { end: 9, start: 8 },
    ],
    tagName: 'A',
  })
  expect(order([b, a])).toEqual([
    'A:server:/p/X.tsx:5-6,7-9',
    'A:server:/p/X.tsx:5-6,8-9',
  ])
})

test('compare: remaining-ranges loop continues on equal range, breaks on later diff', () => {
  const a = usage({
    ranges: [
      { end: 6, start: 5 },
      { end: 8, start: 7 },
      { end: 12, start: 10 },
    ],
    tagName: 'A',
  })
  const b = usage({
    ranges: [
      { end: 6, start: 5 },
      { end: 8, start: 7 },
      { end: 15, start: 10 },
    ],
    tagName: 'A',
  })
  // i=1 ranges equal (diff 0, loop continues); i=2 equal start, end 12 < 15.
  expect(order([b, a])).toEqual([
    'A:server:/p/X.tsx:5-6,7-8,10-12',
    'A:server:/p/X.tsx:5-6,7-8,10-15',
  ])
})

test('compare: empty-range usages sort before ranged ones, then by kind', () => {
  const emptyClient = usage({ kind: 'client', ranges: [], tagName: 'Z' })
  const emptyServer = usage({ kind: 'server', ranges: [], tagName: 'Z' })
  const ranged = usage({ ranges: [{ end: 2, start: 1 }], tagName: 'A' })
  expect(
    order([ranged, emptyServer, emptyClient]).map((s) => s.split(':')[1]),
  ).toEqual(['client', 'server', 'server'])
})

test('UTF-16 position property: ranges slice to expected tag-shell text past unicode', async () => {
  // Leading comment mixes emoji (surrogate pair) + CJK + combining marks so
  // that byte offsets and UTF-16 offsets diverge. Ranges are UTF-16 units.
  const source = [
    '// 😀 한국어 é̀ comment with unicode',
    'export function Widget() {',
    '  return <Inner />',
    '}',
    'function Inner() {',
    '  return null',
    '}',
  ].join('\n')

  const usages = await analyze('/p/Widget.tsx', source)
  const elementUsage = usages.find(
    (u) => u.tagName === 'Inner' && u.ranges.length === 2,
  )
  expect(elementUsage).toBeDefined()

  const slices = elementUsage!.ranges.map((r) => source.slice(r.start, r.end))
  expect(slices).toEqual(['<Inner', '/>'])
})

test('UTF-16 position property: closing tag past unicode string literal', async () => {
  const source = [
    'export function Box() {',
    '  const label = "라벨 😀 value"',
    '  return <Inner>{label}</Inner>',
    '}',
    'function Inner() {',
    '  return null',
    '}',
  ].join('\n')

  const usages = await analyze('/p/Box.tsx', source)
  const reconstructed = usages
    .filter((u) => u.tagName === 'Inner')
    .flatMap((u) => u.ranges.map((r) => source.slice(r.start, r.end)))

  expect(reconstructed).toContain('<Inner')
  expect(reconstructed).toContain('</Inner>')
})
