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

interface FileAnalysis {
  imports: Map<string, ImportBinding>
  jsxTags: JsxTagReference[]
  localComponentNames: Set<string>
  ownComponentKind: Exclude<ComponentKind, 'unknown'>
}

interface ImportBinding {
  source: string
}

interface JsxTagReference {
  lookupName: string
  ranges: DecorationSegment[]
  tagName: string
}

export class ComponentLensAnalyzer {
  private readonly analysisCache = new Map<string, CachedAnalysis>()

  public constructor(
    private readonly host: SourceHost,
    private readonly resolver: ImportResolver,
  ) {}

  public clear(): void {
    this.analysisCache.clear()
    this.resolver.clear()
  }

  public invalidateFile(filePath: string): void {
    this.analysisCache.delete(filePath)
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

    const tagResolutions = new Map<JsxTagReference, string>()
    const uniqueFilePaths = new Set<string>()

    for (const jsxTag of analysis.jsxTags) {
      if (analysis.localComponentNames.has(jsxTag.lookupName)) {
        continue
      }

      const importBinding = analysis.imports.get(jsxTag.lookupName)
      if (!importBinding) {
        continue
      }

      const resolvedFilePath = this.resolver.resolveImport(
        filePath,
        importBinding.source,
      )
      if (!resolvedFilePath) {
        continue
      }

      tagResolutions.set(jsxTag, resolvedFilePath)
      uniqueFilePaths.add(resolvedFilePath)
    }

    const componentKinds = new Map<string, ComponentKind>()
    await Promise.all(
      [...uniqueFilePaths].map(async (resolvedPath) => {
        componentKinds.set(
          resolvedPath,
          await this.getFileComponentKind(resolvedPath),
        )
      }),
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

      const resolvedFilePath = tagResolutions.get(jsxTag)
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

    const analysis = this.getAnalysis(filePath, sourceText, signature)
    return analysis?.ownComponentKind ?? 'unknown'
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

  const imports = new Map<string, ImportBinding>()
  const localComponentNames = new Set<string>()

  for (const statement of sourceFile.statements) {
    collectImportBindings(statement, imports)
    collectLocalComponentName(statement, localComponentNames)
  }

  const jsxTags = collectJsxTags(sourceFile)

  return {
    imports,
    jsxTags,
    localComponentNames,
    ownComponentKind: hasUseClientDirective(sourceFile) ? 'client' : 'server',
  }
}

function collectImportBindings(
  statement: ts.Statement,
  imports: Map<string, ImportBinding>,
): void {
  if (
    !ts.isImportDeclaration(statement) ||
    !ts.isStringLiteral(statement.moduleSpecifier)
  ) {
    return
  }

  const importClause = statement.importClause
  if (!importClause) {
    return
  }

  const binding: ImportBinding = { source: statement.moduleSpecifier.text }

  if (importClause.name) {
    imports.set(importClause.name.text, binding)
  }

  const namedBindings = importClause.namedBindings
  if (!namedBindings) {
    return
  }

  if (ts.isNamespaceImport(namedBindings)) {
    imports.set(namedBindings.name.text, binding)
    return
  }

  for (const element of namedBindings.elements) {
    imports.set(element.name.text, binding)
  }
}

function collectLocalComponentName(
  statement: ts.Statement,
  localComponentNames: Set<string>,
): void {
  if (
    ts.isFunctionDeclaration(statement) &&
    statement.name &&
    isComponentIdentifier(statement.name.text)
  ) {
    localComponentNames.add(statement.name.text)
    return
  }

  if (
    ts.isClassDeclaration(statement) &&
    statement.name &&
    isComponentIdentifier(statement.name.text)
  ) {
    localComponentNames.add(statement.name.text)
    return
  }

  if (!ts.isVariableStatement(statement)) {
    return
  }

  for (const declaration of statement.declarationList.declarations) {
    if (!ts.isIdentifier(declaration.name)) {
      continue
    }

    if (
      !isComponentIdentifier(declaration.name.text) ||
      !isComponentInitializer(declaration.initializer)
    ) {
      continue
    }

    localComponentNames.add(declaration.name.text)
  }
}

function hasUseClientDirective(sourceFile: ts.SourceFile): boolean {
  for (const statement of sourceFile.statements) {
    if (
      !ts.isExpressionStatement(statement) ||
      !ts.isStringLiteral(statement.expression)
    ) {
      return false
    }

    if (statement.expression.text === 'use client') {
      return true
    }
  }

  return false
}

const COMPONENT_NAME_RE = /^[A-Z]/u
const COMPONENT_WRAPPER_NAMES = new Set([
  'forwardRef',
  'memo',
  'React.forwardRef',
  'React.memo',
])

function isComponentIdentifier(name: string): boolean {
  return COMPONENT_NAME_RE.test(name)
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

  const callee = initializer.expression
  const calleeName = ts.isIdentifier(callee) ? callee.text : callee.getText()
  if (!COMPONENT_WRAPPER_NAMES.has(calleeName)) {
    return false
  }

  return initializer.arguments.some(
    (argument) =>
      ts.isArrowFunction(argument) || ts.isFunctionExpression(argument),
  )
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
