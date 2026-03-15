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

interface LocalComponent {
  kind: Exclude<ComponentKind, 'unknown'>
  range: DecorationSegment
}

interface FileAnalysis {
  exportReferences: NamedRange[]
  imports: Map<string, { range: DecorationSegment; source: string }>
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
          ranges: [entry.range],
          sourceFilePath: resolvedFilePath,
          tagName: name,
        })
      }
    }

    if (scope.declaration) {
      for (const [name, component] of analysis.localComponents) {
        usages.push({
          kind: component.kind,
          ranges: [component.range],
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
    { range: DecorationSegment; source: string }
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
      range: nodeRange(nameNode),
    })
    componentRanges.push({
      end: scopeNode.end,
      name,
      pos: scopeNode.pos,
    })
  }

  const hasAsyncModifier = (
    modifiers: ts.NodeArray<ts.ModifierLike> | undefined,
  ): boolean => modifiers?.some((m) => m.kind === ASYNC_KEYWORD) ?? false

  const addImport = (identifier: ts.Identifier, source: string): void => {
    if (isComponentIdentifier(identifier.text)) {
      imports.set(identifier.text, {
        range: nodeRange(identifier),
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
          !ts.isIdentifier(declaration.name) ||
          !isComponentIdentifier(declaration.name.text) ||
          !declaration.initializer
        ) {
          continue
        }

        if (ts.isClassExpression(declaration.initializer)) {
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
  initializer: ts.Expression,
): ts.ArrowFunction | ts.FunctionExpression | undefined {
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
      if (ts.isIdentifier(typeName) && isComponentIdentifier(typeName.text)) {
        typeIdentifiers.push({
          enclosingComponent: currentComponent,
          name: typeName.text,
          range: {
            end: typeName.end,
            start: typeName.getStart(sourceFile),
          },
        })
      }
    }

    if (
      currentComponentTracked &&
      !componentsWithInlineFn!.has(currentComponent!)
    ) {
      if (ts.isFunctionDeclaration(node) && node.name) {
        perComponentFuncs!
          .get(currentComponent!)!
          .set(node.name.text, hasUseServerDirective(node))
      } else if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer &&
        (ts.isArrowFunction(node.initializer) ||
          ts.isFunctionExpression(node.initializer))
      ) {
        perComponentFuncs!
          .get(currentComponent!)!
          .set(node.name.text, hasUseServerDirective(node.initializer))
      } else if (
        ts.isJsxAttribute(node) &&
        node.initializer &&
        ts.isJsxExpression(node.initializer) &&
        node.initializer.expression
      ) {
        const expr = node.initializer.expression

        if (
          (ts.isArrowFunction(expr) || ts.isFunctionExpression(expr)) &&
          !hasUseServerDirective(expr)
        ) {
          componentsWithInlineFn!.add(currentComponent!)
        } else if (ts.isIdentifier(expr)) {
          perComponentRefs!.get(currentComponent!)!.push(expr.text)
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
        sourceText.startsWith('use client', i + 1)
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
