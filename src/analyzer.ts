import ts from 'typescript'

import type { ImportResolver, SourceHost } from './resolver'

export type ComponentKind = 'client' | 'server' | 'unknown'

export interface ComponentUsage {
  kind: Exclude<ComponentKind, 'unknown'>
  ranges: DecorationSegment[]
  sourceFilePath: string
  tagName: string
}

interface DecorationSegment {
  end: number
  start: number
}

interface CachedAnalysis {
  analysis: FileAnalysis
  signature: string
}

interface CachedDirective {
  kind: Exclude<ComponentKind, 'unknown'>
  signature: string
}

interface FileAnalysis {
  imports: Map<string, string>
  jsxTags: JsxTagReference[]
  localComponentNames: Set<string>
  ownComponentKind: Exclude<ComponentKind, 'unknown'>
}

interface JsxTagReference {
  lookupName: string
  ranges: DecorationSegment[]
  tagName: string
}

export class ComponentLensAnalyzer {
  private readonly analysisCache = new Map<string, CachedAnalysis>()
  private readonly directiveCache = new Map<string, CachedDirective>()

  public constructor(
    private readonly host: SourceHost,
    private readonly resolver: ImportResolver,
  ) {}

  public clear(): void {
    this.analysisCache.clear()
    this.directiveCache.clear()
    this.resolver.clear()
  }

  public invalidateFile(filePath: string): void {
    this.analysisCache.delete(filePath)
    this.directiveCache.delete(filePath)
  }

  public async analyzeDocument(
    filePath: string,
    sourceText: string,
    signature: string,
  ): Promise<ComponentUsage[]> {
    const analysis = this.getAnalysis(filePath, sourceText, signature)
    if (!analysis) {
      return []
    }

    const resolvedPaths = new Map<string, string>()
    const uniqueFilePaths = new Set<string>()

    for (const jsxTag of analysis.jsxTags) {
      const lookupName = jsxTag.lookupName
      if (
        analysis.localComponentNames.has(lookupName) ||
        resolvedPaths.has(lookupName)
      ) {
        continue
      }

      const importSource = analysis.imports.get(lookupName)
      if (!importSource) {
        continue
      }

      const resolvedFilePath = this.resolver.resolveImport(
        filePath,
        importSource,
      )
      if (resolvedFilePath) {
        resolvedPaths.set(lookupName, resolvedFilePath)
        uniqueFilePaths.add(resolvedFilePath)
      }
    }

    const componentKinds = new Map<string, ComponentKind>()
    await Promise.all(
      Array.from(uniqueFilePaths, (resolvedPath) =>
        this.getFileComponentKind(resolvedPath).then((kind) => {
          componentKinds.set(resolvedPath, kind)
        }),
      ),
    )

    const usages: ComponentUsage[] = []

    for (const jsxTag of analysis.jsxTags) {
      if (analysis.localComponentNames.has(jsxTag.lookupName)) {
        usages.push({
          kind: analysis.ownComponentKind,
          ranges: jsxTag.ranges,
          sourceFilePath: filePath,
          tagName: jsxTag.tagName,
        })
        continue
      }

      const resolvedFilePath = resolvedPaths.get(jsxTag.lookupName)
      if (!resolvedFilePath) {
        continue
      }

      const componentKind = componentKinds.get(resolvedFilePath)
      if (!componentKind || componentKind === 'unknown') {
        continue
      }

      usages.push({
        kind: componentKind,
        ranges: jsxTag.ranges,
        sourceFilePath: resolvedFilePath,
        tagName: jsxTag.tagName,
      })
    }

    return usages
  }

  private async getFileComponentKind(filePath: string): Promise<ComponentKind> {
    let sourceText: string | undefined
    let signature: string | undefined

    if (this.host.readFileAsync) {
      ;[sourceText, signature] = await Promise.all([
        this.host.readFileAsync(filePath),
        this.host.getSignatureAsync!(filePath),
      ])
    } else {
      sourceText = this.host.readFile(filePath)
      signature = this.host.getSignature(filePath)
    }

    if (sourceText === undefined || signature === undefined) {
      return 'unknown'
    }

    const cached = this.directiveCache.get(filePath)
    if (cached && cached.signature === signature) {
      return cached.kind
    }

    const kind: Exclude<ComponentKind, 'unknown'> = hasUseClientDirective(
      sourceText,
    )
      ? 'client'
      : 'server'
    this.directiveCache.set(filePath, { kind, signature })
    return kind
  }

  private getAnalysis(
    filePath: string,
    sourceText: string,
    signature: string,
  ): FileAnalysis | undefined {
    const cached = this.analysisCache.get(filePath)
    if (cached && cached.signature === signature) {
      return cached.analysis
    }

    const analysis = parseFileAnalysis(filePath, sourceText)
    this.analysisCache.set(filePath, { analysis, signature })
    return analysis
  }
}

function parseFileAnalysis(filePath: string, sourceText: string): FileAnalysis {
  const sourceFile = ts.createSourceFile(
    filePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    getScriptKind(filePath),
  )

  const imports = new Map<string, string>()
  const localComponentNames = new Set<string>()
  let ownComponentKind: Exclude<ComponentKind, 'unknown'> = 'server'
  let statementIndex = 0

  for (; statementIndex < sourceFile.statements.length; statementIndex++) {
    const statement = sourceFile.statements[statementIndex]!
    if (
      !ts.isExpressionStatement(statement) ||
      !ts.isStringLiteral(statement.expression)
    ) {
      break
    }
    if (statement.expression.text === 'use client') {
      ownComponentKind = 'client'
      statementIndex++
      break
    }
  }

  for (; statementIndex < sourceFile.statements.length; statementIndex++) {
    const statement = sourceFile.statements[statementIndex]!

    if (
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      const source = statement.moduleSpecifier.text
      const importClause = statement.importClause
      if (importClause) {
        if (importClause.name) {
          imports.set(importClause.name.text, source)
        }
        const namedBindings = importClause.namedBindings
        if (namedBindings) {
          if (ts.isNamespaceImport(namedBindings)) {
            imports.set(namedBindings.name.text, source)
          } else {
            for (const element of namedBindings.elements) {
              imports.set(element.name.text, source)
            }
          }
        }
      }
      continue
    }

    if (
      ts.isFunctionDeclaration(statement) &&
      statement.name &&
      isComponentIdentifier(statement.name.text)
    ) {
      localComponentNames.add(statement.name.text)
      continue
    }

    if (
      ts.isClassDeclaration(statement) &&
      statement.name &&
      isComponentIdentifier(statement.name.text)
    ) {
      localComponentNames.add(statement.name.text)
      continue
    }

    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (
          ts.isIdentifier(declaration.name) &&
          isComponentIdentifier(declaration.name.text) &&
          isComponentInitializer(declaration.initializer)
        ) {
          localComponentNames.add(declaration.name.text)
        }
      }
    }
  }

  return {
    imports,
    jsxTags: collectJsxTags(sourceFile),
    localComponentNames,
    ownComponentKind,
  }
}

const COMPONENT_WRAPPER_NAMES = new Set([
  'forwardRef',
  'memo',
  'React.forwardRef',
  'React.memo',
])

function isComponentIdentifier(name: string): boolean {
  const code = name.charCodeAt(0)
  return code >= 65 && code <= 90
}

function isComponentInitializer(
  initializer: ts.Expression | undefined,
): boolean {
  if (!initializer) {
    return false
  }

  if (
    ts.isArrowFunction(initializer) ||
    ts.isFunctionExpression(initializer) ||
    ts.isClassExpression(initializer)
  ) {
    return true
  }

  if (!ts.isCallExpression(initializer)) {
    return false
  }

  if (!COMPONENT_WRAPPER_NAMES.has(getCalleeText(initializer.expression))) {
    return false
  }

  return initializer.arguments.some(
    (argument) =>
      ts.isArrowFunction(argument) || ts.isFunctionExpression(argument),
  )
}

function getCalleeText(expression: ts.Expression): string {
  if (ts.isIdentifier(expression)) {
    return expression.text
  }

  if (
    ts.isPropertyAccessExpression(expression) &&
    ts.isIdentifier(expression.expression)
  ) {
    return `${expression.expression.text}.${expression.name.text}`
  }

  return ''
}

function collectJsxTags(sourceFile: ts.SourceFile): JsxTagReference[] {
  const jsxTags: JsxTagReference[] = []
  const visit = (node: ts.Node): void => {
    if (
      ts.isJsxOpeningElement(node) ||
      ts.isJsxSelfClosingElement(node) ||
      ts.isJsxClosingElement(node)
    ) {
      const jsxTag = createJsxTagReference(node, sourceFile)
      if (jsxTag) {
        jsxTags.push(jsxTag)
      }
    }
    ts.forEachChild(node, visit)
  }
  ts.forEachChild(sourceFile, visit)
  return jsxTags
}

function createJsxTagReference(
  node: ts.JsxOpeningElement | ts.JsxSelfClosingElement | ts.JsxClosingElement,
  sourceFile: ts.SourceFile,
): JsxTagReference | undefined {
  const tagNameExpression = node.tagName

  if (ts.isIdentifier(tagNameExpression)) {
    if (!isComponentIdentifier(tagNameExpression.text)) {
      return undefined
    }

    return {
      lookupName: tagNameExpression.text,
      ranges: getTagRanges(node, tagNameExpression, sourceFile),
      tagName: tagNameExpression.text,
    }
  }

  if (!ts.isPropertyAccessExpression(tagNameExpression)) {
    return undefined
  }

  const rootIdentifier = getRootIdentifier(tagNameExpression.expression)
  if (!rootIdentifier || !isComponentIdentifier(rootIdentifier.text)) {
    return undefined
  }

  return {
    lookupName: rootIdentifier.text,
    ranges: getTagRanges(node, tagNameExpression, sourceFile),
    tagName: tagNameExpression.getText(sourceFile),
  }
}

function getTagRanges(
  node: ts.JsxOpeningElement | ts.JsxSelfClosingElement | ts.JsxClosingElement,
  tagNameExpression: ts.JsxTagNameExpression,
  sourceFile: ts.SourceFile,
): DecorationSegment[] {
  if (ts.isJsxClosingElement(node)) {
    return [
      {
        end: node.getEnd(),
        start: node.getStart(sourceFile),
      },
    ]
  }

  const tagNameEnd = tagNameExpression.getEnd()
  const nodeEnd = node.getEnd()
  const delimiterLength = ts.isJsxSelfClosingElement(node) ? 2 : 1
  const delimiterStart = nodeEnd - delimiterLength

  const ranges: DecorationSegment[] = [
    {
      end: tagNameEnd,
      start: node.getStart(sourceFile),
    },
  ]

  if (delimiterStart >= tagNameEnd) {
    ranges.push({
      end: nodeEnd,
      start: delimiterStart,
    })
  }

  return ranges
}

function getRootIdentifier(
  expression: ts.Expression,
): ts.Identifier | undefined {
  if (ts.isIdentifier(expression)) {
    return expression
  }

  if (ts.isPropertyAccessExpression(expression)) {
    return getRootIdentifier(expression.expression)
  }

  return undefined
}

function getScriptKind(filePath: string): ts.ScriptKind {
  if (filePath.endsWith('.tsx')) {
    return ts.ScriptKind.TSX
  }

  if (filePath.endsWith('.jsx')) {
    return ts.ScriptKind.JSX
  }

  if (filePath.endsWith('.js')) {
    return ts.ScriptKind.JS
  }

  return ts.ScriptKind.TS
}

function hasUseClientDirective(sourceText: string): boolean {
  const len = sourceText.length
  let i = 0

  while (i < len) {
    const ch = sourceText.charCodeAt(i)

    if (ch <= 32 || ch === 59 || ch === 0xfeff) {
      i++
      continue
    }

    if (ch === 47 && i + 1 < len) {
      const next = sourceText.charCodeAt(i + 1)
      if (next === 47) {
        i += 2
        while (i < len && sourceText.charCodeAt(i) !== 10) i++
        continue
      }
      if (next === 42) {
        i += 2
        while (i + 1 < len) {
          if (
            sourceText.charCodeAt(i) === 42 &&
            sourceText.charCodeAt(i + 1) === 47
          ) {
            i += 2
            break
          }
          i++
        }
        continue
      }
    }

    if (ch === 34 && sourceText.startsWith('"use client"', i)) {
      return true
    }

    if (ch === 39 && sourceText.startsWith("'use client'", i)) {
      return true
    }

    if (ch === 34 || ch === 39) {
      i++
      while (i < len && sourceText.charCodeAt(i) !== ch) i++
      if (i < len) i++
      continue
    }

    return false
  }

  return false
}
