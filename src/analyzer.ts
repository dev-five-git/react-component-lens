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

interface FileAnalysis {
  exportReferences: LocalComponentDeclaration[]
  importReferences: ImportIdentifierReference[]
  imports: Map<string, string>
  jsxTags: JsxTagReference[]
  localComponentDeclarations: LocalComponentDeclaration[]
  localComponentKinds: Map<string, Exclude<ComponentKind, 'unknown'>>
  localComponentNames: Set<string>
  ownComponentKind: Exclude<ComponentKind, 'unknown'>
  typeIdentifiers: TypeIdentifier[]
}

interface JsxTagReference {
  lookupName: string
  ranges: DecorationSegment[]
  tagName: string
}

interface ImportIdentifierReference {
  name: string
  range: DecorationSegment
  source: string
}

interface LocalComponentDeclaration {
  name: string
  range: DecorationSegment
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
          analysis.localComponentNames.has(lookupName) ||
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
        if (analysis.localComponentNames.has(jsxTag.lookupName)) {
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
      for (const typeId of analysis.typeIdentifiers) {
        if (typeId.enclosingComponent) {
          const kind =
            analysis.localComponentKinds.get(typeId.enclosingComponent) ??
            analysis.ownComponentKind
          const existing = typeUsageKinds.get(typeId.name)
          if (!existing || kind === 'client') {
            typeUsageKinds.set(typeId.name, kind)
          }
        }
      }

      for (const typeId of analysis.typeIdentifiers) {
        let kind: Exclude<ComponentKind, 'unknown'>
        if (typeId.enclosingComponent) {
          kind =
            analysis.localComponentKinds.get(typeId.enclosingComponent) ??
            analysis.ownComponentKind
        } else {
          kind = typeUsageKinds.get(typeId.name) ?? analysis.ownComponentKind
        }

        usages.push({
          kind,
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
  const exportReferences: LocalComponentDeclaration[] = []
  const importReferences: ImportIdentifierReference[] = []
  const imports = new Map<string, string>()
  const localComponentDeclarations: LocalComponentDeclaration[] = []
  const localComponentKinds = new Map<
    string,
    Exclude<ComponentKind, 'unknown'>
  >()
  const localComponentNames = new Set<string>()
  const typeDeclarations: LocalComponentDeclaration[] = []
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
          if (isComponentIdentifier(importClause.name.text)) {
            importReferences.push({
              name: importClause.name.text,
              range: {
                start: importClause.name.getStart(sourceFile),
                end: importClause.name.getEnd(),
              },
              source,
            })
          }
        }
        const namedBindings = importClause.namedBindings
        if (namedBindings) {
          if (ts.isNamespaceImport(namedBindings)) {
            imports.set(namedBindings.name.text, source)
            if (isComponentIdentifier(namedBindings.name.text)) {
              importReferences.push({
                name: namedBindings.name.text,
                range: {
                  start: namedBindings.name.getStart(sourceFile),
                  end: namedBindings.name.getEnd(),
                },
                source,
              })
            }
          } else {
            for (const element of namedBindings.elements) {
              imports.set(element.name.text, source)
              if (isComponentIdentifier(element.name.text)) {
                importReferences.push({
                  name: element.name.text,
                  range: {
                    start: element.name.getStart(sourceFile),
                    end: element.name.getEnd(),
                  },
                  source,
                })
              }
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
      const name = statement.name.text
      localComponentNames.add(name)
      localComponentDeclarations.push({
        name,
        range: {
          start: statement.name.getStart(sourceFile),
          end: statement.name.getEnd(),
        },
      })

      let kind = ownComponentKind
      if (ownComponentKind === 'server') {
        const isAsync =
          statement.modifiers?.some(
            (m) => m.kind === ts.SyntaxKind.AsyncKeyword,
          ) ?? false
        if (!isAsync && hasNonServerFunctionProps(statement)) {
          kind = 'client'
        }
      }
      localComponentKinds.set(name, kind)
      componentRanges.push({
        end: statement.getEnd(),
        name,
        start: statement.getStart(sourceFile),
      })
      continue
    }

    if (
      ts.isClassDeclaration(statement) &&
      statement.name &&
      isComponentIdentifier(statement.name.text)
    ) {
      const name = statement.name.text
      localComponentNames.add(name)
      localComponentDeclarations.push({
        name,
        range: {
          start: statement.name.getStart(sourceFile),
          end: statement.name.getEnd(),
        },
      })

      let kind = ownComponentKind
      if (
        ownComponentKind === 'server' &&
        hasNonServerFunctionProps(statement)
      ) {
        kind = 'client'
      }
      localComponentKinds.set(name, kind)
      componentRanges.push({
        end: statement.getEnd(),
        name,
        start: statement.getStart(sourceFile),
      })
      continue
    }

    if (
      ts.isInterfaceDeclaration(statement) &&
      isComponentIdentifier(statement.name.text)
    ) {
      typeDeclarations.push({
        name: statement.name.text,
        range: {
          start: statement.name.getStart(sourceFile),
          end: statement.name.getEnd(),
        },
      })
      continue
    }

    if (
      ts.isTypeAliasDeclaration(statement) &&
      isComponentIdentifier(statement.name.text)
    ) {
      typeDeclarations.push({
        name: statement.name.text,
        range: {
          start: statement.name.getStart(sourceFile),
          end: statement.name.getEnd(),
        },
      })
      continue
    }

    if (ts.isExportDeclaration(statement)) {
      if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
        for (const element of statement.exportClause.elements) {
          if (isComponentIdentifier(element.name.text)) {
            exportReferences.push({
              name: element.name.text,
              range: {
                start: element.name.getStart(sourceFile),
                end: element.name.getEnd(),
              },
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
        range: {
          start: statement.expression.getStart(sourceFile),
          end: statement.expression.getEnd(),
        },
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
          const name = declaration.name.text
          localComponentNames.add(name)
          localComponentDeclarations.push({
            name,
            range: {
              start: declaration.name.getStart(sourceFile),
              end: declaration.name.getEnd(),
            },
          })

          let kind = ownComponentKind
          if (ownComponentKind === 'server') {
            const fn = getComponentFunction(declaration.initializer)
            const isAsync =
              fn?.modifiers?.some(
                (m) => m.kind === ts.SyntaxKind.AsyncKeyword,
              ) ?? false
            if (!isAsync && hasNonServerFunctionProps(declaration)) {
              kind = 'client'
            }
          }
          localComponentKinds.set(name, kind)
          componentRanges.push({
            end: declaration.getEnd(),
            name,
            start: declaration.getStart(sourceFile),
          })
        }
      }
    }
  }

  const allTypeRefs = collectTypeReferences(sourceFile)
  const typeIdentifiers: TypeIdentifier[] = []

  for (const decl of typeDeclarations) {
    typeIdentifiers.push({
      enclosingComponent: undefined,
      name: decl.name,
      range: decl.range,
    })
  }

  for (const ref of allTypeRefs) {
    const enclosing = componentRanges.find(
      (r) => ref.range.start >= r.start && ref.range.end <= r.end,
    )
    typeIdentifiers.push({
      enclosingComponent: enclosing?.name,
      name: ref.name,
      range: ref.range,
    })
  }

  return {
    exportReferences,
    importReferences,
    imports,
    jsxTags: collectJsxTags(sourceFile),
    localComponentDeclarations,
    localComponentKinds,
    localComponentNames,
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

function hasNonServerFunctionProps(node: ts.Node): boolean {
  const localFunctions = collectLocalFunctions(node)

  let found = false
  const visit = (n: ts.Node): void => {
    if (found) {
      return
    }

    if (
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
        found = true
        return
      }

      if (
        ts.isIdentifier(expr) &&
        localFunctions.has(expr.text) &&
        !localFunctions.get(expr.text)
      ) {
        found = true
        return
      }
    }

    ts.forEachChild(n, visit)
  }
  ts.forEachChild(node, visit)
  return found
}

function collectLocalFunctions(node: ts.Node): Map<string, boolean> {
  const functions = new Map<string, boolean>()
  const visit = (n: ts.Node): void => {
    if (ts.isFunctionDeclaration(n) && n.name) {
      functions.set(n.name.text, hasUseServerDirective(n))
    }

    if (
      ts.isVariableDeclaration(n) &&
      ts.isIdentifier(n.name) &&
      n.initializer &&
      (ts.isArrowFunction(n.initializer) ||
        ts.isFunctionExpression(n.initializer))
    ) {
      functions.set(n.name.text, hasUseServerDirective(n.initializer))
    }

    ts.forEachChild(n, visit)
  }
  ts.forEachChild(node, visit)
  return functions
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

function collectTypeReferences(
  sourceFile: ts.SourceFile,
): LocalComponentDeclaration[] {
  const refs: LocalComponentDeclaration[] = []
  const visit = (node: ts.Node): void => {
    if (
      ts.isTypeReferenceNode(node) &&
      ts.isIdentifier(node.typeName) &&
      isComponentIdentifier(node.typeName.text)
    ) {
      refs.push({
        name: node.typeName.text,
        range: {
          start: node.typeName.getStart(sourceFile),
          end: node.typeName.getEnd(),
        },
      })
    }
    ts.forEachChild(node, visit)
  }
  ts.forEachChild(sourceFile, visit)
  return refs
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
