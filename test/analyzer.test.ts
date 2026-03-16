import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { expect, test } from 'bun:test'

import { ComponentLensAnalyzer, type ScopeConfig } from '../src/analyzer'
import { ImportResolver, type SourceHost } from '../src/resolver'

test('detects client and server component usages from relative imports', async () => {
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
    const usages = await analyzer.analyzeDocument(
      pagePath,
      pageSource,
      project.signature('Page.tsx'),
    )

    expect(usages.length).toBe(5)
    expect(
      usages.map((usage) => ({ kind: usage.kind, tagName: usage.tagName })),
    ).toEqual([
      { kind: 'client', tagName: 'Button' },
      { kind: 'server', tagName: 'Layout' },
      { kind: 'client', tagName: 'Button' },
      { kind: 'server', tagName: 'Layout' },
      { kind: 'server', tagName: 'Page' },
    ])
    expect(
      usages.map((usage) =>
        usage.ranges.map((range) => pageSource.slice(range.start, range.end)),
      ),
    ).toEqual([
      ['<Button', '/>'],
      ['<Layout', '/>'],
      ['Button'],
      ['Layout'],
      ['Page'],
    ])
  } finally {
    project[Symbol.dispose]()
  }
})

test('includes full delimiters for opening and closing tags', async () => {
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
    const usages = await analyzer.analyzeDocument(
      filePath,
      source,
      project.signature('Page.tsx'),
    )

    expect(
      usages.map((usage) =>
        usage.ranges.map((range) => source.slice(range.start, range.end)),
      ),
    ).toEqual([['<Button', '>'], ['</Button>'], ['Button'], ['Page']])
  } finally {
    project[Symbol.dispose]()
  }
})

test('excludes props while keeping self-closing delimiters', async () => {
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
    const usages = await analyzer.analyzeDocument(
      filePath,
      source,
      project.signature('Page.tsx'),
    )

    expect(
      usages.map((usage) =>
        usage.ranges.map((range) => source.slice(range.start, range.end)),
      ),
    ).toEqual([['<Button', '/' + '>'], ['Button'], ['Page']])
  } finally {
    project[Symbol.dispose]()
  }
})

test('treats locally declared components as the current file kind', async () => {
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
    const usages = await analyzer.analyzeDocument(
      filePath,
      project.readFile('Card.tsx'),
      project.signature('Card.tsx'),
    )

    expect(usages.length).toBe(3)
    expect(usages[0]?.kind).toBe('client')
    expect(usages[0]?.tagName).toBe('Action')
  } finally {
    project[Symbol.dispose]()
  }
})

test('resolves tsconfig path aliases when mapping component types', async () => {
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
    const usages = await analyzer.analyzeDocument(
      filePath,
      project.readFile('src/Page.tsx'),
      project.signature('src/Page.tsx'),
    )

    expect(usages.length).toBe(3)
    expect(usages[0]?.kind).toBe('client')
    expect(usages[0]?.sourceFilePath ?? '').toMatch(/src[\\/]Button\.tsx$/u)
  } finally {
    project[Symbol.dispose]()
  }
})

test('invalidateFile() re-evaluates kind after imported file changes', async () => {
  const project = createProject({
    'Page.tsx': [
      "import Button from './Button';",
      '',
      'export default function Page() {',
      '  return <Button />;',
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
    const pagePath = project.filePath('Page.tsx')
    const pageSource = project.readFile('Page.tsx')

    const before = await analyzer.analyzeDocument(
      pagePath,
      pageSource,
      project.signature('Page.tsx'),
    )
    expect(before[0]?.kind).toBe('server')

    fs.writeFileSync(
      project.filePath('Button.tsx'),
      "'use client';\nexport default function Button() { return <button />; }",
    )
    analyzer.invalidateFile(project.filePath('Button.tsx'))

    const after = await analyzer.analyzeDocument(
      pagePath,
      pageSource,
      project.signature('Page.tsx'),
    )
    expect(after[0]?.kind).toBe('client')
  } finally {
    project[Symbol.dispose]()
  }
})

test('clear() resets all caches and re-analyses from scratch', async () => {
  const project = createProject({
    'Page.tsx': [
      "import Button from './Button';",
      '',
      'export default function Page() {',
      '  return <Button />;',
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
    const sig = project.signature('Page.tsx')

    const before = await analyzer.analyzeDocument(filePath, source, sig)
    expect(before.length).toBe(3)
    expect(before[0]?.kind).toBe('client')

    analyzer.clear()

    const after = await analyzer.analyzeDocument(filePath, source, sig)
    expect(after.length).toBe(3)
    expect(after[0]?.kind).toBe('client')
  } finally {
    project[Symbol.dispose]()
  }
})

test('recognizes forwardRef-wrapped local components', async () => {
  const project = createProject({
    'Card.tsx': [
      "'use client';",
      '',
      'const Button = forwardRef((props) => <button />);',
      '',
      'export function Card() {',
      '  return <Button />;',
      '}',
    ].join('\n'),
  })

  try {
    const analyzer = createAnalyzer(project.host)
    const filePath = project.filePath('Card.tsx')
    const usages = await analyzer.analyzeDocument(
      filePath,
      project.readFile('Card.tsx'),
      project.signature('Card.tsx'),
    )

    expect(usages.length).toBe(3)
    expect(usages[0]?.kind).toBe('client')
    expect(usages[0]?.tagName).toBe('Button')
  } finally {
    project[Symbol.dispose]()
  }
})

test('resolves namespaced JSX like <UI.Button />', async () => {
  const project = createProject({
    'Page.tsx': [
      "import * as UI from './ui';",
      '',
      'export default function Page() {',
      '  return <UI.Button />;',
      '}',
    ].join('\n'),
    'ui.tsx': [
      "'use client';",
      '',
      'export function Button() {',
      '  return <button />;',
      '}',
    ].join('\n'),
  })

  try {
    const analyzer = createAnalyzer(project.host)
    const filePath = project.filePath('Page.tsx')
    const source = project.readFile('Page.tsx')
    const usages = await analyzer.analyzeDocument(
      filePath,
      source,
      project.signature('Page.tsx'),
    )

    expect(usages.length).toBe(3)
    expect(usages[0]?.kind).toBe('client')
    expect(usages[0]?.tagName).toBe('UI.Button')
  } finally {
    project[Symbol.dispose]()
  }
})

test('resolves bare package imports through node_modules', async () => {
  const project = createProject({
    'Page.tsx': [
      "import Button from 'my-ui';",
      '',
      'export default function Page() {',
      '  return <Button />;',
      '}',
    ].join('\n'),
    'node_modules/my-ui/package.json': JSON.stringify({
      name: 'my-ui',
      main: './index.tsx',
    }),
    'node_modules/my-ui/index.tsx': [
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
    const usages = await analyzer.analyzeDocument(
      filePath,
      project.readFile('Page.tsx'),
      project.signature('Page.tsx'),
    )

    expect(usages.length).toBe(3)
    expect(usages[0]?.kind).toBe('client')
    expect(usages[0]?.tagName).toBe('Button')
  } finally {
    project[Symbol.dispose]()
  }
})

test('resolves deeply nested namespaced JSX like <UI.Forms.Input />', async () => {
  const project = createProject({
    'Page.tsx': [
      "import * as UI from './ui';",
      '',
      'export default function Page() {',
      '  return <UI.Forms.Input />;',
      '}',
    ].join('\n'),
    'ui.tsx': [
      "'use client';",
      '',
      'export const Forms = { Input: () => <input /> };',
    ].join('\n'),
  })

  try {
    const analyzer = createAnalyzer(project.host)
    const filePath = project.filePath('Page.tsx')
    const usages = await analyzer.analyzeDocument(
      filePath,
      project.readFile('Page.tsx'),
      project.signature('Page.tsx'),
    )

    expect(usages.length).toBe(3)
    expect(usages[0]?.kind).toBe('client')
    expect(usages[0]?.tagName).toBe('UI.Forms.Input')
  } finally {
    project[Symbol.dispose]()
  }
})

test('colors interface and type alias declaration names', async () => {
  const project = createProject({
    'Card.tsx': [
      "'use client';",
      '',
      'export interface CardProps {',
      '  title: string;',
      '}',
      '',
      'type CardVariant = "primary" | "secondary";',
      '',
      'export function Card() {',
      '  return <div />;',
      '}',
    ].join('\n'),
  })

  try {
    const analyzer = createAnalyzer(project.host)
    const filePath = project.filePath('Card.tsx')
    const source = project.readFile('Card.tsx')
    const usages = await analyzer.analyzeDocument(
      filePath,
      source,
      project.signature('Card.tsx'),
    )

    expect(usages.length).toBe(3)
    expect(
      usages.map((usage) => ({ kind: usage.kind, tagName: usage.tagName })),
    ).toEqual([
      { kind: 'client', tagName: 'Card' },
      { kind: 'client', tagName: 'CardProps' },
      { kind: 'client', tagName: 'CardVariant' },
    ])
    expect(
      usages.map((usage) =>
        usage.ranges.map((range) => source.slice(range.start, range.end)),
      ),
    ).toEqual([['Card'], ['CardProps'], ['CardVariant']])
  } finally {
    project[Symbol.dispose]()
  }
})

test('colors type references in function parameter annotations', async () => {
  const project = createProject({
    'Button.tsx': [
      "'use client';",
      '',
      'interface ThemeButtonProps {',
      '  color: string;',
      '}',
      '',
      'export function ThemeButton({ color }: ThemeButtonProps) {',
      '  return <button style={{ color }} />;',
      '}',
    ].join('\n'),
  })

  try {
    const analyzer = createAnalyzer(project.host)
    const filePath = project.filePath('Button.tsx')
    const source = project.readFile('Button.tsx')
    const scope: ScopeConfig = {
      declaration: false,
      element: false,
      export: false,
      import: false,
      type: true,
    }
    const usages = await analyzer.analyzeDocument(
      filePath,
      source,
      project.signature('Button.tsx'),
      scope,
    )

    expect(usages.length).toBe(2)
    expect(
      usages.map((usage) => ({ kind: usage.kind, tagName: usage.tagName })),
    ).toEqual([
      { kind: 'client', tagName: 'ThemeButtonProps' },
      { kind: 'client', tagName: 'ThemeButtonProps' },
    ])
    expect(
      usages.map((usage) =>
        usage.ranges.map((range) => source.slice(range.start, range.end)),
      ),
    ).toEqual([['ThemeButtonProps'], ['ThemeButtonProps']])
  } finally {
    project[Symbol.dispose]()
  }
})

test('scope.element disables JSX tag coloring', async () => {
  const project = createProject({
    'Page.tsx': [
      "import Button from './Button';",
      '',
      'export default function Page() {',
      '  return <Button />;',
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
    const scope: ScopeConfig = {
      declaration: true,
      element: false,
      export: false,
      import: false,
      type: true,
    }
    const usages = await analyzer.analyzeDocument(
      filePath,
      source,
      project.signature('Page.tsx'),
      scope,
    )

    expect(usages.length).toBe(1)
    expect(usages[0]?.tagName).toBe('Page')
  } finally {
    project[Symbol.dispose]()
  }
})

test('scope.declaration disables component declaration coloring', async () => {
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
    const source = project.readFile('Card.tsx')
    const scope: ScopeConfig = {
      declaration: false,
      element: true,
      export: false,
      import: false,
      type: true,
    }
    const usages = await analyzer.analyzeDocument(
      filePath,
      source,
      project.signature('Card.tsx'),
      scope,
    )

    expect(usages.length).toBe(1)
    expect(usages[0]?.tagName).toBe('Action')
  } finally {
    project[Symbol.dispose]()
  }
})

test('scope.type disables interface and type alias coloring', async () => {
  const project = createProject({
    'Card.tsx': [
      "'use client';",
      '',
      'export interface CardProps {',
      '  title: string;',
      '}',
      '',
      'export function Card() {',
      '  return <div />;',
      '}',
    ].join('\n'),
  })

  try {
    const analyzer = createAnalyzer(project.host)
    const filePath = project.filePath('Card.tsx')
    const source = project.readFile('Card.tsx')
    const scope: ScopeConfig = {
      declaration: true,
      element: true,
      export: false,
      import: false,
      type: false,
    }
    const usages = await analyzer.analyzeDocument(
      filePath,
      source,
      project.signature('Card.tsx'),
      scope,
    )

    expect(usages.length).toBe(1)
    expect(usages[0]?.tagName).toBe('Card')
  } finally {
    project[Symbol.dispose]()
  }
})

test('colors import identifier names based on resolved module kind', async () => {
  const project = createProject({
    'Page.tsx': [
      "import Button from './Button';",
      "import { Layout } from './Layout';",
      '',
      'export default function Page() {',
      '  return <div />;',
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
    const analyzer = createAnalyzer(project.host)
    const filePath = project.filePath('Page.tsx')
    const source = project.readFile('Page.tsx')
    const scope: ScopeConfig = {
      declaration: false,
      element: false,
      export: false,
      import: true,
      type: false,
    }
    const usages = await analyzer.analyzeDocument(
      filePath,
      source,
      project.signature('Page.tsx'),
      scope,
    )

    expect(usages.length).toBe(2)
    expect(
      usages.map((usage) => ({ kind: usage.kind, tagName: usage.tagName })),
    ).toEqual([
      { kind: 'client', tagName: 'Button' },
      { kind: 'server', tagName: 'Layout' },
    ])
    expect(
      usages.map((usage) =>
        usage.ranges.map((range) => source.slice(range.start, range.end)),
      ),
    ).toEqual([['Button'], ['Layout']])
  } finally {
    project[Symbol.dispose]()
  }
})

test('scope.import disables import identifier coloring', async () => {
  const project = createProject({
    'Page.tsx': [
      "import Button from './Button';",
      '',
      'export default function Page() {',
      '  return <Button />;',
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
    const scope: ScopeConfig = {
      declaration: true,
      element: true,
      export: false,
      import: false,
      type: false,
    }
    const usages = await analyzer.analyzeDocument(
      filePath,
      source,
      project.signature('Page.tsx'),
      scope,
    )

    expect(usages.length).toBe(2)
    expect(usages.map((usage) => usage.tagName)).toEqual(['Button', 'Page'])
  } finally {
    project[Symbol.dispose]()
  }
})

test('colors export declaration names based on file directive', async () => {
  const project = createProject({
    'index.tsx': [
      "'use client';",
      '',
      'function Card() {',
      '  return <div />;',
      '}',
      '',
      'const Button = () => <button />;',
      '',
      'export { Card, Button };',
    ].join('\n'),
  })

  try {
    const analyzer = createAnalyzer(project.host)
    const filePath = project.filePath('index.tsx')
    const source = project.readFile('index.tsx')
    const scope: ScopeConfig = {
      declaration: false,
      element: false,
      export: true,
      import: false,
      type: false,
    }
    const usages = await analyzer.analyzeDocument(
      filePath,
      source,
      project.signature('index.tsx'),
      scope,
    )

    expect(usages.length).toBe(2)
    expect(
      usages.map((usage) => ({ kind: usage.kind, tagName: usage.tagName })),
    ).toEqual([
      { kind: 'client', tagName: 'Card' },
      { kind: 'client', tagName: 'Button' },
    ])
    expect(
      usages.map((usage) =>
        usage.ranges.map((range) => source.slice(range.start, range.end)),
      ),
    ).toEqual([['Card'], ['Button']])
  } finally {
    project[Symbol.dispose]()
  }
})

test('colors export default assignment based on file directive', async () => {
  const project = createProject({
    'Card.tsx': [
      "'use client';",
      '',
      'function Card() {',
      '  return <div />;',
      '}',
      '',
      'export default Card;',
    ].join('\n'),
  })

  try {
    const analyzer = createAnalyzer(project.host)
    const filePath = project.filePath('Card.tsx')
    const source = project.readFile('Card.tsx')
    const scope: ScopeConfig = {
      declaration: false,
      element: false,
      export: true,
      import: false,
      type: false,
    }
    const usages = await analyzer.analyzeDocument(
      filePath,
      source,
      project.signature('Card.tsx'),
      scope,
    )

    expect(usages.length).toBe(1)
    expect(usages[0]?.kind).toBe('client')
    expect(usages[0]?.tagName).toBe('Card')
    expect(
      usages[0]?.ranges.map((range) => source.slice(range.start, range.end)),
    ).toEqual(['Card'])
  } finally {
    project[Symbol.dispose]()
  }
})

test('scope.export disables export declaration coloring', async () => {
  const project = createProject({
    'index.tsx': [
      "'use client';",
      '',
      'function Card() {',
      '  return <div />;',
      '}',
      '',
      'export { Card };',
    ].join('\n'),
  })

  try {
    const analyzer = createAnalyzer(project.host)
    const filePath = project.filePath('index.tsx')
    const source = project.readFile('index.tsx')
    const scope: ScopeConfig = {
      declaration: true,
      element: false,
      export: false,
      import: false,
      type: false,
    }
    const usages = await analyzer.analyzeDocument(
      filePath,
      source,
      project.signature('index.tsx'),
      scope,
    )

    expect(usages.length).toBe(1)
    expect(usages[0]?.tagName).toBe('Card')
  } finally {
    project[Symbol.dispose]()
  }
})

test('infers client kind when component passes function prop', async () => {
  const project = createProject({
    'Button.tsx': [
      'export function ThemeButton() {',
      '  return <button onClick={() => console.log("click")} />;',
      '}',
    ].join('\n'),
  })

  try {
    const analyzer = createAnalyzer(project.host)
    const filePath = project.filePath('Button.tsx')
    const source = project.readFile('Button.tsx')
    const scope: ScopeConfig = {
      declaration: true,
      element: false,
      export: false,
      import: false,
      type: false,
    }
    const usages = await analyzer.analyzeDocument(
      filePath,
      source,
      project.signature('Button.tsx'),
      scope,
    )

    expect(usages.length).toBe(1)
    expect(usages[0]?.kind).toBe('client')
    expect(usages[0]?.tagName).toBe('ThemeButton')
  } finally {
    project[Symbol.dispose]()
  }
})

test('async component stays server even with function props', async () => {
  const project = createProject({
    'Page.tsx': [
      'export async function Page() {',
      '  return <button onClick={() => {}} />;',
      '}',
    ].join('\n'),
  })

  try {
    const analyzer = createAnalyzer(project.host)
    const filePath = project.filePath('Page.tsx')
    const source = project.readFile('Page.tsx')
    const scope: ScopeConfig = {
      declaration: true,
      element: false,
      export: false,
      import: false,
      type: false,
    }
    const usages = await analyzer.analyzeDocument(
      filePath,
      source,
      project.signature('Page.tsx'),
      scope,
    )

    expect(usages.length).toBe(1)
    expect(usages[0]?.kind).toBe('server')
  } finally {
    project[Symbol.dispose]()
  }
})

test('function prop with use server directive stays server', async () => {
  const project = createProject({
    'Form.tsx': [
      'export function MyForm() {',
      '  return (',
      '    <form action={async () => {',
      '      "use server";',
      '      console.log("submitted");',
      '    }}>',
      '      <button type="submit" />',
      '    </form>',
      '  );',
      '}',
    ].join('\n'),
  })

  try {
    const analyzer = createAnalyzer(project.host)
    const filePath = project.filePath('Form.tsx')
    const source = project.readFile('Form.tsx')
    const scope: ScopeConfig = {
      declaration: true,
      element: false,
      export: false,
      import: false,
      type: false,
    }
    const usages = await analyzer.analyzeDocument(
      filePath,
      source,
      project.signature('Form.tsx'),
      scope,
    )

    expect(usages.length).toBe(1)
    expect(usages[0]?.kind).toBe('server')
  } finally {
    project[Symbol.dispose]()
  }
})

test('infers client when local function reference passed as prop', async () => {
  const project = createProject({
    'Button.tsx': [
      'export function ThemeButton() {',
      '  function handleClick() {',
      '    console.log("click");',
      '  }',
      '  return <button onClick={handleClick} />;',
      '}',
    ].join('\n'),
  })

  try {
    const analyzer = createAnalyzer(project.host)
    const filePath = project.filePath('Button.tsx')
    const source = project.readFile('Button.tsx')
    const scope: ScopeConfig = {
      declaration: true,
      element: false,
      export: false,
      import: false,
      type: false,
    }
    const usages = await analyzer.analyzeDocument(
      filePath,
      source,
      project.signature('Button.tsx'),
      scope,
    )

    expect(usages.length).toBe(1)
    expect(usages[0]?.kind).toBe('client')
  } finally {
    project[Symbol.dispose]()
  }
})

test('local function reference with use server stays server', async () => {
  const project = createProject({
    'Form.tsx': [
      'export function MyForm() {',
      '  function submitAction() {',
      '    "use server";',
      '    console.log("submitted");',
      '  }',
      '  return <form action={submitAction} />;',
      '}',
    ].join('\n'),
  })

  try {
    const analyzer = createAnalyzer(project.host)
    const filePath = project.filePath('Form.tsx')
    const source = project.readFile('Form.tsx')
    const scope: ScopeConfig = {
      declaration: true,
      element: false,
      export: false,
      import: false,
      type: false,
    }
    const usages = await analyzer.analyzeDocument(
      filePath,
      source,
      project.signature('Form.tsx'),
      scope,
    )

    expect(usages.length).toBe(1)
    expect(usages[0]?.kind).toBe('server')
  } finally {
    project[Symbol.dispose]()
  }
})

test('infers client when const function reference passed as prop', async () => {
  const project = createProject({
    'Toggle.tsx': [
      'export function Toggle() {',
      '  const handleEnter = () => {};',
      '  return <div onMouseEnter={handleEnter} />;',
      '}',
    ].join('\n'),
  })

  try {
    const analyzer = createAnalyzer(project.host)
    const filePath = project.filePath('Toggle.tsx')
    const source = project.readFile('Toggle.tsx')
    const scope: ScopeConfig = {
      declaration: true,
      element: false,
      export: false,
      import: false,
      type: false,
    }
    const usages = await analyzer.analyzeDocument(
      filePath,
      source,
      project.signature('Toggle.tsx'),
      scope,
    )

    expect(usages.length).toBe(1)
    expect(usages[0]?.kind).toBe('client')
  } finally {
    project[Symbol.dispose]()
  }
})

test('forwardRef component infers client from function props', async () => {
  const project = createProject({
    'Button.tsx': [
      'const Button = forwardRef((props) => {',
      '  return <button onClick={() => {}} />;',
      '});',
    ].join('\n'),
  })

  try {
    const analyzer = createAnalyzer(project.host)
    const filePath = project.filePath('Button.tsx')
    const source = project.readFile('Button.tsx')
    const scope: ScopeConfig = {
      declaration: true,
      element: false,
      export: false,
      import: false,
      type: false,
    }
    const usages = await analyzer.analyzeDocument(
      filePath,
      source,
      project.signature('Button.tsx'),
      scope,
    )

    expect(usages.length).toBe(1)
    expect(usages[0]?.kind).toBe('client')
  } finally {
    project[Symbol.dispose]()
  }
})

test('async arrow component stays server even with function props', async () => {
  const project = createProject({
    'Page.tsx': [
      'const Page = async () => {',
      '  return <div onClick={() => {}} />;',
      '};',
    ].join('\n'),
  })

  try {
    const analyzer = createAnalyzer(project.host)
    const filePath = project.filePath('Page.tsx')
    const source = project.readFile('Page.tsx')
    const scope: ScopeConfig = {
      declaration: true,
      element: false,
      export: false,
      import: false,
      type: false,
    }
    const usages = await analyzer.analyzeDocument(
      filePath,
      source,
      project.signature('Page.tsx'),
      scope,
    )

    expect(usages.length).toBe(1)
    expect(usages[0]?.kind).toBe('server')
  } finally {
    project[Symbol.dispose]()
  }
})

test('arrow component infers client from function props', async () => {
  const project = createProject({
    'Toggle.tsx': [
      'const Toggle = () => {',
      '  return <div onMouseEnter={() => {}} />;',
      '};',
    ].join('\n'),
  })

  try {
    const analyzer = createAnalyzer(project.host)
    const filePath = project.filePath('Toggle.tsx')
    const source = project.readFile('Toggle.tsx')
    const scope: ScopeConfig = {
      declaration: true,
      element: false,
      export: false,
      import: false,
      type: false,
    }
    const usages = await analyzer.analyzeDocument(
      filePath,
      source,
      project.signature('Toggle.tsx'),
      scope,
    )

    expect(usages.length).toBe(1)
    expect(usages[0]?.kind).toBe('client')
  } finally {
    project[Symbol.dispose]()
  }
})

test('type inherits kind from enclosing component context', async () => {
  const project = createProject({
    'Button.tsx': [
      'interface ThemeButtonProps {',
      '  color?: string;',
      '}',
      '',
      'export function ThemeButton({ color }: ThemeButtonProps) {',
      '  return <button onClick={() => console.log(color)} />;',
      '}',
    ].join('\n'),
  })

  try {
    const analyzer = createAnalyzer(project.host)
    const filePath = project.filePath('Button.tsx')
    const source = project.readFile('Button.tsx')
    const scope: ScopeConfig = {
      declaration: false,
      element: false,
      export: false,
      import: false,
      type: true,
    }
    const usages = await analyzer.analyzeDocument(
      filePath,
      source,
      project.signature('Button.tsx'),
      scope,
    )

    expect(
      usages.map((usage) => ({ kind: usage.kind, tagName: usage.tagName })),
    ).toEqual([
      { kind: 'client', tagName: 'ThemeButtonProps' },
      { kind: 'client', tagName: 'ThemeButtonProps' },
    ])
  } finally {
    project[Symbol.dispose]()
  }
})

test('colors component declaration names based on file directive', async () => {
  const project = createProject({
    'Card.tsx': [
      "'use client';",
      '',
      'export function Card() {',
      '  return <div>hello</div>;',
      '}',
    ].join('\n'),
    'Header.tsx': [
      'export const Header = () => {',
      '  return <header />;',
      '};',
    ].join('\n'),
  })

  try {
    const analyzer = createAnalyzer(project.host)

    const cardPath = project.filePath('Card.tsx')
    const cardSource = project.readFile('Card.tsx')
    const cardUsages = await analyzer.analyzeDocument(
      cardPath,
      cardSource,
      project.signature('Card.tsx'),
    )

    expect(cardUsages.length).toBe(1)
    expect(cardUsages[0]?.kind).toBe('client')
    expect(cardUsages[0]?.tagName).toBe('Card')
    expect(
      cardUsages[0]?.ranges.map((range) =>
        cardSource.slice(range.start, range.end),
      ),
    ).toEqual(['Card'])

    const headerPath = project.filePath('Header.tsx')
    const headerSource = project.readFile('Header.tsx')
    const headerUsages = await analyzer.analyzeDocument(
      headerPath,
      headerSource,
      project.signature('Header.tsx'),
    )

    expect(headerUsages.length).toBe(1)
    expect(headerUsages[0]?.kind).toBe('server')
    expect(headerUsages[0]?.tagName).toBe('Header')
  } finally {
    project[Symbol.dispose]()
  }
})

test('does not highlight PascalCase variable imports that are not components', async () => {
  const project = createProject({
    'Page.tsx': [
      "import { Button, ThemeConfig, MaxRetries } from './utils';",
      '',
      'export default function Page() {',
      '  return <Button />;',
      '}',
    ].join('\n'),
    'utils.tsx': [
      "'use client';",
      '',
      'export const ThemeConfig = { dark: true, light: false };',
      'export const MaxRetries = 3;',
      'export function Button() {',
      '  return <button />;',
      '}',
    ].join('\n'),
  })

  try {
    const analyzer = createAnalyzer(project.host)
    const filePath = project.filePath('Page.tsx')
    const source = project.readFile('Page.tsx')
    const scope: ScopeConfig = {
      declaration: false,
      element: false,
      export: false,
      import: true,
      type: false,
    }
    const usages = await analyzer.analyzeDocument(
      filePath,
      source,
      project.signature('Page.tsx'),
      scope,
    )

    expect(usages.length).toBe(1)
    expect(usages[0]?.kind).toBe('client')
    expect(usages[0]?.tagName).toBe('Button')
  } finally {
    project[Symbol.dispose]()
  }
})

test('does not highlight PascalCase variable exports that are not components', async () => {
  const project = createProject({
    'index.tsx': [
      "'use client';",
      '',
      'function Card() {',
      '  return <div />;',
      '}',
      '',
      'const ThemeConfig = { dark: true };',
      '',
      'export { Card, ThemeConfig };',
    ].join('\n'),
  })

  try {
    const analyzer = createAnalyzer(project.host)
    const filePath = project.filePath('index.tsx')
    const source = project.readFile('index.tsx')
    const scope: ScopeConfig = {
      declaration: false,
      element: false,
      export: true,
      import: false,
      type: false,
    }
    const usages = await analyzer.analyzeDocument(
      filePath,
      source,
      project.signature('index.tsx'),
      scope,
    )

    expect(usages.length).toBe(1)
    expect(usages[0]?.kind).toBe('client')
    expect(usages[0]?.tagName).toBe('Card')
  } finally {
    project[Symbol.dispose]()
  }
})

test('highlights components through barrel re-exports', async () => {
  const project = createProject({
    'Page.tsx': [
      "import { Button, ThemeConfig } from './components';",
      '',
      'export default function Page() {',
      '  return <Button />;',
      '}',
    ].join('\n'),
    'components/index.ts': [
      "export { Button } from './Button';",
      "export { ThemeConfig } from './config';",
    ].join('\n'),
    'components/Button.tsx': [
      "'use client';",
      '',
      'export function Button() {',
      '  return <button />;',
      '}',
    ].join('\n'),
    'components/config.ts': ['export const ThemeConfig = { dark: true };'].join(
      '\n',
    ),
  })

  try {
    const analyzer = createAnalyzer(project.host)
    const filePath = project.filePath('Page.tsx')
    const source = project.readFile('Page.tsx')
    const scope: ScopeConfig = {
      declaration: false,
      element: false,
      export: false,
      import: true,
      type: false,
    }
    const usages = await analyzer.analyzeDocument(
      filePath,
      source,
      project.signature('Page.tsx'),
      scope,
    )

    expect(usages.length).toBe(1)
    expect(usages[0]?.kind).toBe('client')
    expect(usages[0]?.tagName).toBe('Button')
  } finally {
    project[Symbol.dispose]()
  }
})

test('does not highlight non-component JSX usage from imports', async () => {
  const project = createProject({
    'Page.tsx': [
      "import { ThemeConfig } from './config';",
      '',
      'export default function Page() {',
      '  return <ThemeConfig />;',
      '}',
    ].join('\n'),
    'config.ts': [
      "'use client';",
      '',
      'export const ThemeConfig = { dark: true };',
    ].join('\n'),
  })

  try {
    const analyzer = createAnalyzer(project.host)
    const filePath = project.filePath('Page.tsx')
    const source = project.readFile('Page.tsx')
    const usages = await analyzer.analyzeDocument(
      filePath,
      source,
      project.signature('Page.tsx'),
    )

    expect(usages.map((usage) => usage.tagName)).toEqual(['Page'])
  } finally {
    project[Symbol.dispose]()
  }
})

test('highlights default import when source file exports a component', async () => {
  const project = createProject({
    'Page.tsx': [
      "import Button from './Button';",
      '',
      'export default function Page() {',
      '  return <Button />;',
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
    const scope: ScopeConfig = {
      declaration: false,
      element: false,
      export: false,
      import: true,
      type: false,
    }
    const usages = await analyzer.analyzeDocument(
      filePath,
      source,
      project.signature('Page.tsx'),
      scope,
    )

    expect(usages.length).toBe(1)
    expect(usages[0]?.kind).toBe('client')
    expect(usages[0]?.tagName).toBe('Button')
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
