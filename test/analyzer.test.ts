import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import { ComponentLensAnalyzer } from '../src/analyzer'
import { ImportResolver, type SourceHost } from '../src/resolver'

void test('detects client and server component usages from relative imports', () => {
  const project = createProject({
    'Page.tsx': [
      "import Button from './Button';",
      "import { Layout } from './Layout';",
      '',
      'export default function Page() {',
      '  return (',
      '    <>',
      '      <Button />',
      '      <Layout />',
      '    </>',
      '  );',
      '}',
    ].join('\n'),
    'Button.tsx': [
      "'use client';",
      '',
      'export default function Button() {',
      '  return <button />;',
      '}',
    ].join('\n'),
    'Layout.tsx': [
      'export function Layout() {',
      '  return <section />;',
      '}',
    ].join('\n'),
  })

  try {
    const pagePath = project.filePath('Page.tsx')
    const analyzer = createAnalyzer(project.host)
    const pageSource = project.readFile('Page.tsx')
    const usages = analyzer.analyzeDocument(
      pagePath,
      pageSource,
      project.signature('Page.tsx'),
    )

    assert.equal(usages.length, 2)
    assert.deepEqual(
      usages.map((usage) => ({ kind: usage.kind, tagName: usage.tagName })),
      [
        { kind: 'client', tagName: 'Button' },
        { kind: 'server', tagName: 'Layout' },
      ],
    )
    assert.deepEqual(
      usages.map((usage) =>
        usage.ranges.map((range) => pageSource.slice(range.start, range.end)),
      ),
      [
        ['<Button', '/>'],
        ['<Layout', '/>'],
      ],
    )
  } finally {
    project[Symbol.dispose]()
  }
})

void test('includes full delimiters for opening and closing tags', () => {
  const project = createProject({
    'Page.tsx': [
      "import Button from './Button';",
      '',
      'export default function Page() {',
      '  return <Button value="text">ok</Button>;',
      '}',
    ].join('\n'),
    'Button.tsx': [
      "'use client';",
      '',
      'export default function Button() {',
      '  return <button />;',
      '}',
    ].join('\n'),
  })

  try {
    const analyzer = createAnalyzer(project.host)
    const filePath = project.filePath('Page.tsx')
    const source = project.readFile('Page.tsx')
    const usages = analyzer.analyzeDocument(
      filePath,
      source,
      project.signature('Page.tsx'),
    )

    assert.deepEqual(
      usages.map((usage) =>
        usage.ranges.map((range) => source.slice(range.start, range.end)),
      ),
      [['<Button', '>'], ['</Button>']],
    )
  } finally {
    project[Symbol.dispose]()
  }
})

void test('excludes props while keeping self-closing delimiters', () => {
  const project = createProject({
    'Page.tsx': [
      "import Button from './Button';",
      '',
      'export default function Page() {',
      '  return <Button value="text" disabled />;',
      '}',
    ].join('\n'),
    'Button.tsx': [
      'export default function Button() {',
      '  return <button />;',
      '}',
    ].join('\n'),
  })

  try {
    const analyzer = createAnalyzer(project.host)
    const filePath = project.filePath('Page.tsx')
    const source = project.readFile('Page.tsx')
    const usages = analyzer.analyzeDocument(
      filePath,
      source,
      project.signature('Page.tsx'),
    )

    assert.deepEqual(
      usages.map((usage) =>
        usage.ranges.map((range) => source.slice(range.start, range.end)),
      ),
      [['<Button', '/>']],
    )
  } finally {
    project[Symbol.dispose]()
  }
})

void test('treats locally declared components as the current file kind', () => {
  const project = createProject({
    'Card.tsx': [
      "'use client';",
      '',
      'const Action = () => <button />;',
      '',
      'export function Card() {',
      '  return <Action />;',
      '}',
    ].join('\n'),
  })

  try {
    const analyzer = createAnalyzer(project.host)
    const filePath = project.filePath('Card.tsx')
    const usages = analyzer.analyzeDocument(
      filePath,
      project.readFile('Card.tsx'),
      project.signature('Card.tsx'),
    )

    assert.equal(usages.length, 1)
    assert.equal(usages[0]?.kind, 'client')
    assert.equal(usages[0]?.tagName, 'Action')
  } finally {
    project[Symbol.dispose]()
  }
})

void test('resolves tsconfig path aliases when mapping component types', () => {
  const project = createProject({
    'tsconfig.json': JSON.stringify(
      {
        compilerOptions: {
          baseUrl: '.',
          jsx: 'preserve',
          paths: {
            '@/*': ['src/*'],
          },
        },
      },
      undefined,
      2,
    ),
    'src/Page.tsx': [
      "import Button from '@/Button';",
      '',
      'export default function Page() {',
      '  return <Button />;',
      '}',
    ].join('\n'),
    'src/Button.tsx': [
      '"use client";',
      '',
      'export default function Button() {',
      '  return <button />;',
      '}',
    ].join('\n'),
  })

  try {
    const analyzer = createAnalyzer(project.host)
    const filePath = project.filePath('src/Page.tsx')
    const usages = analyzer.analyzeDocument(
      filePath,
      project.readFile('src/Page.tsx'),
      project.signature('src/Page.tsx'),
    )

    assert.equal(usages.length, 1)
    assert.equal(usages[0]?.kind, 'client')
    assert.match(usages[0]?.sourceFilePath ?? '', /src[\\/]Button\.tsx$/u)
  } finally {
    project[Symbol.dispose]()
  }
})

function createAnalyzer(host: SourceHost): ComponentLensAnalyzer {
  const resolver = new ImportResolver(host)
  return new ComponentLensAnalyzer(host, resolver)
}

function createProject(files: Record<string, string>): {
  [Symbol.dispose](): void
  filePath(relativePath: string): string
  host: SourceHost
  readFile(relativePath: string): string
  signature(relativePath: string): string
} {
  const rootDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'react-component-lens-'),
  )

  for (const [relativePath, contents] of Object.entries(files)) {
    const absolutePath = path.join(rootDirectory, relativePath)
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true })
    fs.writeFileSync(absolutePath, contents, 'utf8')
  }

  return {
    [Symbol.dispose](): void {
      fs.rmSync(rootDirectory, { force: true, recursive: true })
    },
    filePath(relativePath: string): string {
      return path.join(rootDirectory, relativePath)
    },
    host: {
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
    },
    readFile(relativePath: string): string {
      return fs.readFileSync(path.join(rootDirectory, relativePath), 'utf8')
    },
    signature(relativePath: string): string {
      const filePath = path.join(rootDirectory, relativePath)
      const stats = fs.statSync(filePath)
      return createDiskSignature(stats.mtimeMs, stats.size)
    },
  }
}

function createDiskSignature(mtimeMs: number, size: number): string {
  return `disk:${String(mtimeMs)}:${String(size)}`
}
