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
  ranges: DecorationSegment[]
}

interface LocalComponent {
  kind: Exclude<ComponentKind, 'unknown'>
  ranges: DecorationSegment[]
}

interface FileAnalysis {
  exportReferences: NamedRange[]
  imports: Map<string, { ranges: DecorationSegment[]; source: string }>
  jsxTags: JsxTagReference[]
  localComponents: Map<string, LocalComponent>
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
  ranges: DecorationSegment[]
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

    if ((scope.element || scope.import) && analysis.imports.size > 0) {
      const uniqueFilePaths = new Set<string>()

      for (const [lookupName, entry] of analysis.imports) {
        if (
          analysis.localComponents.has(lookupName) ||
          resolvedPaths.has(lookupName)
        ) {
          continue
        }

        const resolvedFilePath = this.resolver.resolveImport(
          filePath,
          entry.source,
        )
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
        const localComponent = analysis.localComponents.get(jsxTag.lookupName)
        if (localComponent) {
          usages.push({
            kind: localComponent.kind,
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
      for (const [name, entry] of analysis.imports) {
        const resolvedFilePath = resolvedPaths.get(name)
        if (!resolvedFilePath) {
          continue
        }

        const componentKind = componentKinds.get(resolvedFilePath)
        if (!componentKind || componentKind === 'unknown') {
          continue
        }

        usages.push({
          kind: componentKind,
          ranges: entry.ranges,
          sourceFilePath: resolvedFilePath,
          tagName: name,
        })
      }
    }

    if (scope.declaration) {
      for (const [name, component] of analysis.localComponents) {
        usages.push({
          kind: component.kind,
          ranges: component.ranges,
          sourceFilePath: filePath,
          tagName: name,
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
            analysis.localComponents.get(typeId.enclosingComponent)?.kind ??
            analysis.ownComponentKind
          if (!typeUsageKinds.has(typeId.name) || kind === 'client') {
            typeUsageKinds.set(typeId.name, kind)
          }
          usages.push({
            kind,
            ranges: typeId.ranges,
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
          ranges: typeId.ranges,
          sourceFilePath: filePath,
          tagName: typeId.name,
        })
      }
    }

    if (scope.export) {
      for (const exportRef of analysis.exportReferences) {
        usages.push({
          kind: analysis.ownComponentKind,
          ranges: exportRef.ranges,
          sourceFilePath: filePath,
          tagName: exportRef.name,
        })
      }
    }

    return usages
  }

  private async getFileComponentKind(filePath: string): Promise<ComponentKind> {
    const signature = this.host.getSignatureAsync
      ? await this.host.getSignatureAsync(filePath)
      : this.host.getSignature(filePath)

    if (signature === undefined) {
      return 'unknown'
    }

    const cached = this.directiveCache.get(filePath)
    if (cached && cached.signature === signature) {
      return cached.kind
    }

    const sourceText = this.host.readFileAsync
      ? await this.host.readFileAsync(filePath)
      : this.host.readFile(filePath)

    if (sourceText === undefined) {
      return 'unknown'
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

  const asyncComponents = new Set<string>()
  const componentRanges: { end: number; name: string; pos: number }[] = []
  const exportReferences: NamedRange[] = []
  const imports = new Map<
    string,
    { ranges: DecorationSegment[]; source: string }
  >()
  const localComponents = new Map<string, LocalComponent>()
  const typeIdentifiers: TypeIdentifier[] = []
  let ownComponentKind: Exclude<ComponentKind, 'unknown'> = 'server'
  let statementIndex = 0

  const nodeRange = (node: ts.Node): DecorationSegment => ({
    end: node.end,
    start: node.getStart(sourceFile),
  })

  const registerComponent = (
    name: string,
    nameNode: ts.Node,
    scopeNode: ts.Node,
  ): void => {
    localComponents.set(name, {
      kind: ownComponentKind,
      ranges: [nodeRange(nameNode)],
    })
    componentRanges.push({
      end: scopeNode.end,
      name,
      pos: scopeNode.pos,
    })
  }

  const hasAsyncModifier = (
    modifiers: ts.NodeArray<ts.ModifierLike> | undefined,
  ): boolean => {
    if (!modifiers) return false
    for (let i = 0; i < modifiers.length; i++) {
      if (modifiers[i]!.kind === ASYNC_KEYWORD) return true
    }
    return false
  }

  const addImport = (identifier: ts.Identifier, source: string): void => {
    if (isComponentIdentifier(identifier.text)) {
      imports.set(identifier.text, {
        ranges: [nodeRange(identifier)],
        source,
      })
    }
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
      const importClause = statement.importClause
      if (importClause) {
        if (importClause.name) {
          addImport(importClause.name, source)
        }
        const namedBindings = importClause.namedBindings
        if (namedBindings) {
          if (ts.isNamespaceImport(namedBindings)) {
            addImport(namedBindings.name, source)
          } else {
            for (const element of namedBindings.elements) {
              addImport(element.name, source)
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
      registerComponent(statement.name.text, statement.name, statement)
      if (hasAsyncModifier(statement.modifiers)) {
        asyncComponents.add(statement.name.text)
      }
      continue
    }

    if (
      ts.isClassDeclaration(statement) &&
      statement.name &&
      isComponentIdentifier(statement.name.text)
    ) {
      registerComponent(statement.name.text, statement.name, statement)
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
        ranges: [nodeRange(statement.name)],
      })
      continue
    }

    if (ts.isExportDeclaration(statement)) {
      if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
        for (const element of statement.exportClause.elements) {
          if (isComponentIdentifier(element.name.text)) {
            exportReferences.push({
              name: element.name.text,
              ranges: [nodeRange(element.name)],
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
        ranges: [nodeRange(statement.expression)],
      })
      continue
    }

    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (
          !ts.isIdentifier(declaration.name) ||
          !isComponentIdentifier(declaration.name.text) ||
          !declaration.initializer
        ) {
          continue
        }

        if (declaration.initializer.kind === SK_ClassExpr) {
          registerComponent(
            declaration.name.text,
            declaration.name,
            declaration,
          )
          continue
        }

        const fn = getComponentFunction(declaration.initializer)
        if (fn) {
          registerComponent(
            declaration.name.text,
            declaration.name,
            declaration,
          )
          if (hasAsyncModifier(fn.modifiers)) {
            asyncComponents.add(declaration.name.text)
          }
        }
      }
    }
  }

  const jsxTags = collectSourceElements(
    sourceFile,
    componentRanges,
    typeIdentifiers,
    localComponents,
    asyncComponents,
    ownComponentKind === 'server',
  )

  return {
    exportReferences,
    imports,
    jsxTags,
    localComponents,
    ownComponentKind,
    typeIdentifiers,
  }
}

const ASYNC_KEYWORD = ts.SyntaxKind.AsyncKeyword
const SK_Identifier = ts.SyntaxKind.Identifier
const SK_PropertyAccess = ts.SyntaxKind.PropertyAccessExpression
const SK_JsxOpening = ts.SyntaxKind.JsxOpeningElement
const SK_JsxSelfClosing = ts.SyntaxKind.JsxSelfClosingElement
const SK_JsxClosing = ts.SyntaxKind.JsxClosingElement
const SK_TypeReference = ts.SyntaxKind.TypeReference
const SK_ImportDecl = ts.SyntaxKind.ImportDeclaration
const SK_EnumDecl = ts.SyntaxKind.EnumDeclaration
const SK_ExportDecl = ts.SyntaxKind.ExportDeclaration
const SK_FunctionDecl = ts.SyntaxKind.FunctionDeclaration
const SK_VariableDecl = ts.SyntaxKind.VariableDeclaration
const SK_JsxAttribute = ts.SyntaxKind.JsxAttribute
const SK_JsxExpression = ts.SyntaxKind.JsxExpression
const SK_ArrowFunction = ts.SyntaxKind.ArrowFunction
const SK_FunctionExpr = ts.SyntaxKind.FunctionExpression
const SK_CallExpression = ts.SyntaxKind.CallExpression
const SK_ClassExpr = ts.SyntaxKind.ClassExpression
const SK_Block = ts.SyntaxKind.Block
const SK_ExprStmt = ts.SyntaxKind.ExpressionStatement
const SK_StringLiteral = ts.SyntaxKind.StringLiteral

function isComponentIdentifier(name: string): boolean {
  const code = name.charCodeAt(0)
  return code >= 65 && code <= 90
}

function getComponentFunction(
  initializer: ts.Expression,
): ts.ArrowFunction | ts.FunctionExpression | undefined {
  const kind = initializer.kind
  if (kind === SK_ArrowFunction || kind === SK_FunctionExpr) {
    return initializer as ts.ArrowFunction | ts.FunctionExpression
  }

  if (kind === SK_CallExpression) {
    const call = initializer as ts.CallExpression
    if (isComponentWrapper(call.expression)) {
      const args = call.arguments
      for (let i = 0; i < args.length; i++) {
        const argKind = args[i]!.kind
        if (argKind === SK_ArrowFunction || argKind === SK_FunctionExpr) {
          return args[i] as ts.ArrowFunction | ts.FunctionExpression
        }
      }
    }
  }

  return undefined
}

function hasUseServerDirective(
  fn: ts.ArrowFunction | ts.FunctionDeclaration | ts.FunctionExpression,
): boolean {
  const body = fn.body
  if (!body || body.kind !== SK_Block) {
    return false
  }

  const statements = (body as ts.Block).statements
  for (let i = 0; i < statements.length; i++) {
    const stmt = statements[i]!
    if (stmt.kind !== SK_ExprStmt) break
    const expr = (stmt as ts.ExpressionStatement).expression
    if (expr.kind !== SK_StringLiteral) break
    if ((expr as ts.StringLiteral).text === 'use server') {
      return true
    }
  }

  return false
}

function isComponentWrapper(expr: ts.Expression): boolean {
  if (expr.kind === SK_Identifier) {
    const text = (expr as ts.Identifier).text
    return text === 'forwardRef' || text === 'memo'
  }
  if (expr.kind === SK_PropertyAccess) {
    const pa = expr as ts.PropertyAccessExpression
    return (
      pa.expression.kind === SK_Identifier &&
      (pa.expression as ts.Identifier).text === 'React' &&
      (pa.name.text === 'forwardRef' || pa.name.text === 'memo')
    )
  }
  return false
}

function collectSourceElements(
  sourceFile: ts.SourceFile,
  componentRanges: { end: number; name: string; pos: number }[],
  typeIdentifiers: TypeIdentifier[],
  localComponents: Map<string, LocalComponent>,
  asyncComponents: Set<string>,
  inferClientKind: boolean,
): JsxTagReference[] {
  const jsxTags: JsxTagReference[] = []

  const componentByPos = new Map<number, { end: number; name: string }>()
  for (const range of componentRanges) {
    componentByPos.set(range.pos, range)
  }

  let perComponentFuncs: Map<string, Map<string, boolean>> | undefined
  let perComponentRefs: Map<string, string[]> | undefined
  let componentsWithInlineFn: Set<string> | undefined

  if (inferClientKind) {
    perComponentFuncs = new Map()
    perComponentRefs = new Map()
    componentsWithInlineFn = new Set()
    for (const range of componentRanges) {
      if (!asyncComponents.has(range.name)) {
        perComponentFuncs.set(range.name, new Map())
        perComponentRefs.set(range.name, [])
      }
    }
  }

  let currentComponent: string | undefined
  let currentComponentTracked = false

  const visit = (node: ts.Node): void => {
    const nodeKind = node.kind

    if (
      nodeKind === SK_ImportDecl ||
      nodeKind === SK_EnumDecl ||
      nodeKind === SK_ExportDecl
    ) {
      return
    }

    const entry = componentByPos.get(node.pos)
    const entered = entry !== undefined && entry.end === node.end

    let savedComponent: string | undefined
    let savedTracked = false
    if (entered) {
      savedComponent = currentComponent
      savedTracked = currentComponentTracked
      currentComponent = entry.name
      currentComponentTracked = perComponentFuncs?.has(entry.name) ?? false
    }

    if (
      nodeKind === SK_JsxOpening ||
      nodeKind === SK_JsxSelfClosing ||
      nodeKind === SK_JsxClosing
    ) {
      const jsxTag = createJsxTagReference(
        node as
          | ts.JsxOpeningElement
          | ts.JsxSelfClosingElement
          | ts.JsxClosingElement,
        sourceFile,
        nodeKind,
      )
      if (jsxTag) {
        jsxTags.push(jsxTag)
      }
    } else if (nodeKind === SK_TypeReference) {
      const typeName = (node as ts.TypeReferenceNode).typeName
      if (
        typeName.kind === SK_Identifier &&
        isComponentIdentifier((typeName as ts.Identifier).text)
      ) {
        const id = typeName as ts.Identifier
        typeIdentifiers.push({
          enclosingComponent: currentComponent,
          name: id.text,
          ranges: [{ end: id.end, start: id.getStart(sourceFile) }],
        })
      }
    }

    if (
      currentComponentTracked &&
      !componentsWithInlineFn!.has(currentComponent!)
    ) {
      if (nodeKind === SK_FunctionDecl) {
        const fn = node as ts.FunctionDeclaration
        if (fn.name) {
          perComponentFuncs!
            .get(currentComponent!)!
            .set(fn.name.text, hasUseServerDirective(fn))
        }
      } else if (nodeKind === SK_VariableDecl) {
        const decl = node as ts.VariableDeclaration
        if (
          decl.name.kind === SK_Identifier &&
          decl.initializer &&
          (decl.initializer.kind === SK_ArrowFunction ||
            decl.initializer.kind === SK_FunctionExpr)
        ) {
          perComponentFuncs!
            .get(currentComponent!)!
            .set(
              (decl.name as ts.Identifier).text,
              hasUseServerDirective(
                decl.initializer as ts.ArrowFunction | ts.FunctionExpression,
              ),
            )
        }
      } else if (nodeKind === SK_JsxAttribute) {
        const attr = node as ts.JsxAttribute
        if (attr.initializer && attr.initializer.kind === SK_JsxExpression) {
          const expr = (attr.initializer as ts.JsxExpression).expression
          if (expr) {
            const exprKind = expr.kind
            if (
              (exprKind === SK_ArrowFunction || exprKind === SK_FunctionExpr) &&
              !hasUseServerDirective(
                expr as ts.ArrowFunction | ts.FunctionExpression,
              )
            ) {
              componentsWithInlineFn!.add(currentComponent!)
            } else if (exprKind === SK_Identifier) {
              perComponentRefs!
                .get(currentComponent!)!
                .push((expr as ts.Identifier).text)
            }
          }
        }
      }
    }

    ts.forEachChild(node, visit)

    if (entered) {
      currentComponent = savedComponent
      currentComponentTracked = savedTracked
    }
  }
  ts.forEachChild(sourceFile, visit)

  if (!perComponentFuncs) {
    return jsxTags
  }

  for (const [name, funcs] of perComponentFuncs) {
    if (componentsWithInlineFn!.has(name)) {
      localComponents.get(name)!.kind = 'client'
      continue
    }
    const refs = perComponentRefs!.get(name)!
    if (refs.some((ref) => funcs.has(ref) && !funcs.get(ref))) {
      localComponents.get(name)!.kind = 'client'
    }
  }

  return jsxTags
}

function createJsxTagReference(
  node: ts.JsxOpeningElement | ts.JsxSelfClosingElement | ts.JsxClosingElement,
  sourceFile: ts.SourceFile,
  nodeKind: ts.SyntaxKind,
): JsxTagReference | undefined {
  const tagNameExpression = node.tagName
  const tagKind = tagNameExpression.kind

  if (tagKind === SK_Identifier) {
    const text = (tagNameExpression as ts.Identifier).text
    if (!isComponentIdentifier(text)) {
      return undefined
    }

    return {
      lookupName: text,
      ranges: getTagRanges(node, tagNameExpression, sourceFile, nodeKind),
      tagName: text,
    }
  }

  if (tagKind !== SK_PropertyAccess) {
    return undefined
  }

  const rootIdentifier = getRootIdentifier(
    (tagNameExpression as ts.PropertyAccessExpression).expression,
  )
  if (!rootIdentifier || !isComponentIdentifier(rootIdentifier.text)) {
    return undefined
  }

  return {
    lookupName: rootIdentifier.text,
    ranges: getTagRanges(node, tagNameExpression, sourceFile, nodeKind),
    tagName: sourceFile.text.substring(
      tagNameExpression.getStart(sourceFile),
      tagNameExpression.end,
    ),
  }
}

function getTagRanges(
  node: ts.JsxOpeningElement | ts.JsxSelfClosingElement | ts.JsxClosingElement,
  tagNameExpression: ts.JsxTagNameExpression,
  sourceFile: ts.SourceFile,
  nodeKind: ts.SyntaxKind,
): DecorationSegment[] {
  if (nodeKind === SK_JsxClosing) {
    return [
      {
        end: node.end,
        start: node.getStart(sourceFile),
      },
    ]
  }

  const tagNameEnd = tagNameExpression.end
  const nodeEnd = node.end
  const delimiterLength = nodeKind === SK_JsxSelfClosing ? 2 : 1
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
  while (current.kind === SK_PropertyAccess) {
    current = (current as ts.PropertyAccessExpression).expression
  }
  return current.kind === SK_Identifier ? (current as ts.Identifier) : undefined
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

    if (ch === 34 || ch === 39) {
      if (
        i + 11 < len &&
        sourceText.charCodeAt(i + 11) === ch &&
        sourceText.charCodeAt(i + 1) === 117 &&
        sourceText.charCodeAt(i + 2) === 115 &&
        sourceText.charCodeAt(i + 3) === 101 &&
        sourceText.charCodeAt(i + 4) === 32 &&
        sourceText.charCodeAt(i + 5) === 99 &&
        sourceText.charCodeAt(i + 6) === 108 &&
        sourceText.charCodeAt(i + 7) === 105 &&
        sourceText.charCodeAt(i + 8) === 101 &&
        sourceText.charCodeAt(i + 9) === 110 &&
        sourceText.charCodeAt(i + 10) === 116
      ) {
        return true
      }
      i++
      while (i < len && sourceText.charCodeAt(i) !== ch) i++
      if (i < len) i++
      continue
    }

    return false
  }

  return false
}
