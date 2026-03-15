import ts from 'typescript'

import type { ImportResolver, SourceHost } from './resolver'

export type ComponentKind = 'client' | 'server' | 'unknown'

export interface ScopeConfig {
  declaration: boolean
  element: boolean
  export: boolean
  import: boolean
  type: boolean
}

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

interface NamedRange {
  name: string
  range: DecorationSegment
}

interface FileAnalysis {
  exportReferences: NamedRange[]
  importReferences: NamedRange[]
  imports: Map<string, string>
  jsxTags: JsxTagReference[]
  localComponentDeclarations: NamedRange[]
  localComponentKinds: Map<string, Exclude<ComponentKind, 'unknown'>>
  ownComponentKind: Exclude<ComponentKind, 'unknown'>
  typeIdentifiers: TypeIdentifier[]
}

interface JsxTagReference {
  lookupName: string
  ranges: DecorationSegment[]
  tagName: string
}

interface TypeIdentifier {
  enclosingComponent: string | undefined
  name: string
  range: DecorationSegment
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
    scope: ScopeConfig = {
      declaration: true,
      element: true,
      export: true,
      import: true,
      type: true,
    },
  ): Promise<ComponentUsage[]> {
    const analysis = this.getAnalysis(filePath, sourceText, signature)
    if (!analysis) {
      return []
    }

    const usages: ComponentUsage[] = []
    const resolvedPaths = new Map<string, string>()
    const componentKinds = new Map<string, ComponentKind>()

    if (scope.element || scope.import) {
      const uniqueFilePaths = new Set<string>()

      for (const [lookupName, source] of analysis.imports) {
        if (
          analysis.localComponentKinds.has(lookupName) ||
          resolvedPaths.has(lookupName)
        ) {
          continue
        }

        const resolvedFilePath = this.resolver.resolveImport(filePath, source)
        if (resolvedFilePath) {
          resolvedPaths.set(lookupName, resolvedFilePath)
          uniqueFilePaths.add(resolvedFilePath)
        }
      }

      await Promise.all(
        Array.from(uniqueFilePaths, (resolvedPath) =>
          this.getFileComponentKind(resolvedPath).then((kind) => {
            componentKinds.set(resolvedPath, kind)
          }),
        ),
      )
    }

    if (scope.element) {
      for (const jsxTag of analysis.jsxTags) {
        if (analysis.localComponentKinds.has(jsxTag.lookupName)) {
          usages.push({
            kind:
              analysis.localComponentKinds.get(jsxTag.lookupName) ??
              analysis.ownComponentKind,
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
    }

    if (scope.import) {
      for (const ref of analysis.importReferences) {
        const resolvedFilePath = resolvedPaths.get(ref.name)
        if (!resolvedFilePath) {
          continue
        }

        const componentKind = componentKinds.get(resolvedFilePath)
        if (!componentKind || componentKind === 'unknown') {
          continue
        }

        usages.push({
          kind: componentKind,
          ranges: [ref.range],
          sourceFilePath: resolvedFilePath,
          tagName: ref.name,
        })
      }
    }

    if (scope.declaration) {
      for (const declaration of analysis.localComponentDeclarations) {
        usages.push({
          kind:
            analysis.localComponentKinds.get(declaration.name) ??
            analysis.ownComponentKind,
          ranges: [declaration.range],
          sourceFilePath: filePath,
          tagName: declaration.name,
        })
      }
    }

    if (scope.type) {
      const typeUsageKinds = new Map<
        string,
        Exclude<ComponentKind, 'unknown'>
      >()
      const deferredDeclarations: TypeIdentifier[] = []

      for (const typeId of analysis.typeIdentifiers) {
        if (typeId.enclosingComponent) {
          const kind =
            analysis.localComponentKinds.get(typeId.enclosingComponent) ??
            analysis.ownComponentKind
          if (!typeUsageKinds.has(typeId.name) || kind === 'client') {
            typeUsageKinds.set(typeId.name, kind)
          }
          usages.push({
            kind,
            ranges: [typeId.range],
            sourceFilePath: filePath,
            tagName: typeId.name,
          })
        } else {
          deferredDeclarations.push(typeId)
        }
      }

      for (const typeId of deferredDeclarations) {
        usages.push({
          kind: typeUsageKinds.get(typeId.name) ?? analysis.ownComponentKind,
          ranges: [typeId.range],
          sourceFilePath: filePath,
          tagName: typeId.name,
        })
      }
    }

    if (scope.export) {
      for (const exportRef of analysis.exportReferences) {
        usages.push({
          kind: analysis.ownComponentKind,
          ranges: [exportRef.range],
          sourceFilePath: filePath,
          tagName: exportRef.name,
        })
      }
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
    false,
    getScriptKind(filePath),
  )

  const componentRanges: { end: number; name: string; start: number }[] = []
  const exportReferences: NamedRange[] = []
  const importReferences: NamedRange[] = []
  const imports = new Map<string, string>()
  const localComponentDeclarations: NamedRange[] = []
  const localComponentKinds = new Map<
    string,
    Exclude<ComponentKind, 'unknown'>
  >()
  const typeIdentifiers: TypeIdentifier[] = []
  let ownComponentKind: Exclude<ComponentKind, 'unknown'> = 'server'
  let statementIndex = 0

  const nodeRange = (node: ts.Node): DecorationSegment => ({
    end: node.getEnd(),
    start: node.getStart(sourceFile),
  })

  const registerComponent = (
    name: string,
    nameNode: ts.Node,
    scopeNode: ts.Node,
    kind: Exclude<ComponentKind, 'unknown'>,
  ): void => {
    localComponentDeclarations.push({ name, range: nodeRange(nameNode) })
    localComponentKinds.set(name, kind)
    componentRanges.push({
      end: scopeNode.getEnd(),
      name,
      start: scopeNode.getStart(sourceFile),
    })
  }

  const inferKind = (
    isAsync: boolean,
    node: ts.Node,
  ): Exclude<ComponentKind, 'unknown'> => {
    if (ownComponentKind === 'client') {
      return 'client'
    }
    if (isAsync) {
      return 'server'
    }
    return hasNonServerFunctionProps(node) ? 'client' : 'server'
  }

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
      const addImport = (identifier: ts.Identifier): void => {
        imports.set(identifier.text, source)
        if (isComponentIdentifier(identifier.text)) {
          importReferences.push({
            name: identifier.text,
            range: nodeRange(identifier),
          })
        }
      }

      const importClause = statement.importClause
      if (importClause) {
        if (importClause.name) {
          addImport(importClause.name)
        }
        const namedBindings = importClause.namedBindings
        if (namedBindings) {
          if (ts.isNamespaceImport(namedBindings)) {
            addImport(namedBindings.name)
          } else {
            for (const element of namedBindings.elements) {
              addImport(element.name)
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
      const isAsync =
        statement.modifiers?.some(
          (m) => m.kind === ts.SyntaxKind.AsyncKeyword,
        ) ?? false
      registerComponent(
        statement.name.text,
        statement.name,
        statement,
        inferKind(isAsync, statement),
      )
      continue
    }

    if (
      ts.isClassDeclaration(statement) &&
      statement.name &&
      isComponentIdentifier(statement.name.text)
    ) {
      registerComponent(
        statement.name.text,
        statement.name,
        statement,
        inferKind(false, statement),
      )
      continue
    }

    if (
      (ts.isInterfaceDeclaration(statement) ||
        ts.isTypeAliasDeclaration(statement)) &&
      isComponentIdentifier(statement.name.text)
    ) {
      typeIdentifiers.push({
        enclosingComponent: undefined,
        name: statement.name.text,
        range: nodeRange(statement.name),
      })
      continue
    }

    if (ts.isExportDeclaration(statement)) {
      if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
        for (const element of statement.exportClause.elements) {
          if (isComponentIdentifier(element.name.text)) {
            exportReferences.push({
              name: element.name.text,
              range: nodeRange(element.name),
            })
          }
        }
      }
      continue
    }

    if (
      ts.isExportAssignment(statement) &&
      !statement.isExportEquals &&
      ts.isIdentifier(statement.expression) &&
      isComponentIdentifier(statement.expression.text)
    ) {
      exportReferences.push({
        name: statement.expression.text,
        range: nodeRange(statement.expression),
      })
      continue
    }

    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (
          ts.isIdentifier(declaration.name) &&
          isComponentIdentifier(declaration.name.text) &&
          isComponentInitializer(declaration.initializer)
        ) {
          const fn = getComponentFunction(declaration.initializer)
          const isAsync =
            fn?.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword) ??
            false
          registerComponent(
            declaration.name.text,
            declaration.name,
            declaration,
            inferKind(isAsync, declaration),
          )
        }
      }
    }
  }

  const jsxTags = collectSourceElements(
    sourceFile,
    componentRanges,
    typeIdentifiers,
  )

  return {
    exportReferences,
    importReferences,
    imports,
    jsxTags,
    localComponentDeclarations,
    localComponentKinds,
    ownComponentKind,
    typeIdentifiers,
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

function getComponentFunction(
  initializer: ts.Expression | undefined,
): ts.ArrowFunction | ts.FunctionExpression | undefined {
  if (!initializer) {
    return undefined
  }

  if (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)) {
    return initializer
  }

  if (
    ts.isCallExpression(initializer) &&
    COMPONENT_WRAPPER_NAMES.has(getCalleeText(initializer.expression))
  ) {
    return initializer.arguments.find(
      (arg): arg is ts.ArrowFunction | ts.FunctionExpression =>
        ts.isArrowFunction(arg) || ts.isFunctionExpression(arg),
    )
  }

  return undefined
}

function isComponentInitializer(
  initializer: ts.Expression | undefined,
): boolean {
  if (!initializer) {
    return false
  }

  return (
    ts.isClassExpression(initializer) ||
    getComponentFunction(initializer) !== undefined
  )
}

function hasNonServerFunctionProps(node: ts.Node): boolean {
  const localFunctions = new Map<string, boolean>()
  const identifierRefs: string[] = []
  let hasInlineFn = false

  const visit = (n: ts.Node): void => {
    if (hasInlineFn) {
      return
    }

    if (ts.isFunctionDeclaration(n) && n.name) {
      localFunctions.set(n.name.text, hasUseServerDirective(n))
    } else if (
      ts.isVariableDeclaration(n) &&
      ts.isIdentifier(n.name) &&
      n.initializer &&
      (ts.isArrowFunction(n.initializer) ||
        ts.isFunctionExpression(n.initializer))
    ) {
      localFunctions.set(n.name.text, hasUseServerDirective(n.initializer))
    } else if (
      ts.isJsxAttribute(n) &&
      n.initializer &&
      ts.isJsxExpression(n.initializer) &&
      n.initializer.expression
    ) {
      const expr = n.initializer.expression

      if (
        (ts.isArrowFunction(expr) || ts.isFunctionExpression(expr)) &&
        !hasUseServerDirective(expr)
      ) {
        hasInlineFn = true
        return
      }

      if (ts.isIdentifier(expr)) {
        identifierRefs.push(expr.text)
      }
    }

    ts.forEachChild(n, visit)
  }
  ts.forEachChild(node, visit)

  return (
    hasInlineFn ||
    identifierRefs.some(
      (ref) => localFunctions.has(ref) && !localFunctions.get(ref),
    )
  )
}

function hasUseServerDirective(
  fn: ts.ArrowFunction | ts.FunctionDeclaration | ts.FunctionExpression,
): boolean {
  const body = fn.body
  if (!body || !ts.isBlock(body)) {
    return false
  }

  for (const stmt of body.statements) {
    if (
      !ts.isExpressionStatement(stmt) ||
      !ts.isStringLiteral(stmt.expression)
    ) {
      break
    }
    if (stmt.expression.text === 'use server') {
      return true
    }
  }

  return false
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

function collectSourceElements(
  sourceFile: ts.SourceFile,
  componentRanges: { end: number; name: string; start: number }[],
  typeIdentifiers: TypeIdentifier[],
): JsxTagReference[] {
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
    } else if (
      ts.isTypeReferenceNode(node) &&
      ts.isIdentifier(node.typeName) &&
      isComponentIdentifier(node.typeName.text)
    ) {
      const start = node.typeName.getStart(sourceFile)
      const end = node.typeName.getEnd()
      typeIdentifiers.push({
        enclosingComponent: componentRanges.find(
          (r) => start >= r.start && end <= r.end,
        )?.name,
        name: node.typeName.text,
        range: { end, start },
      })
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
  let current = expression
  while (ts.isPropertyAccessExpression(current)) {
    current = current.expression
  }
  return ts.isIdentifier(current) ? current : undefined
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
