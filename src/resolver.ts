import * as path from 'node:path'

import ts from 'typescript'

export interface SourceHost {
  fileExists(filePath: string): boolean
  getSignature(filePath: string): string | undefined
  readFile(filePath: string): string | undefined
  getSignatureAsync?(filePath: string): Promise<string | undefined>
  readFileAsync?(filePath: string): Promise<string | undefined>
}

const DEFAULT_COMPILER_OPTIONS: ts.CompilerOptions = {
  allowJs: true,
  jsx: ts.JsxEmit.Preserve,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  target: ts.ScriptTarget.ES2022,
}

const CONFIG_FILE_NAMES = ['tsconfig.json', 'jsconfig.json'] as const
const SOURCE_EXTENSIONS = new Set(['.js', '.jsx', '.ts', '.tsx'])

interface CachedCompilerOptions {
  options: ts.CompilerOptions
  signature: string
}

export class ImportResolver {
  private readonly compilerOptionsCache = new Map<
    string,
    CachedCompilerOptions
  >()
  private readonly configPathCache = new Map<string, string | undefined>()
  private readonly resolutionCache = new Map<string, string | undefined>()
  private readonly resolutionHost: ts.ModuleResolutionHost
  private currentDirectory = ''
  private lastFromPath = ''
  private lastNormalizedFromPath = ''

  public constructor(private readonly host: SourceHost) {
    this.resolutionHost = {
      directoryExists: (directoryPath) =>
        host.fileExists(directoryPath) || ts.sys.directoryExists(directoryPath),
      fileExists: (filePath) =>
        host.fileExists(filePath) || ts.sys.fileExists(filePath),
      getCurrentDirectory: () => this.currentDirectory,
      getDirectories: ts.sys.getDirectories,
      readFile: (filePath) =>
        host.readFile(filePath) ?? ts.sys.readFile(filePath),
      realpath: ts.sys.realpath,
      useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames,
    }
  }

  public clear(): void {
    this.compilerOptionsCache.clear()
    this.configPathCache.clear()
    this.resolutionCache.clear()
    this.lastFromPath = ''
    this.lastNormalizedFromPath = ''
  }

  public resolveImport(
    fromFilePath: string,
    specifier: string,
  ): string | undefined {
    let normalizedFromFilePath: string
    if (fromFilePath === this.lastFromPath) {
      normalizedFromFilePath = this.lastNormalizedFromPath
    } else {
      normalizedFromFilePath = path.normalize(fromFilePath)
      this.lastFromPath = fromFilePath
      this.lastNormalizedFromPath = normalizedFromFilePath
    }

    const cacheKey = `${normalizedFromFilePath}::${specifier}`
    const cached = this.resolutionCache.get(cacheKey)
    if (cached !== undefined || this.resolutionCache.has(cacheKey)) {
      return cached
    }

    const compilerOptions = this.getCompilerOptions(normalizedFromFilePath)
    this.currentDirectory = path.dirname(normalizedFromFilePath)

    const result = ts.resolveModuleName(
      specifier,
      normalizedFromFilePath,
      compilerOptions,
      this.resolutionHost,
    ).resolvedModule

    if (!result || !isSupportedSourceFile(result.resolvedFileName)) {
      this.resolutionCache.set(cacheKey, undefined)
      return undefined
    }

    const resolvedFilePath = path.normalize(result.resolvedFileName)
    this.resolutionCache.set(cacheKey, resolvedFilePath)
    return resolvedFilePath
  }

  private getCompilerOptions(filePath: string): ts.CompilerOptions {
    const directory = path.dirname(filePath)
    let configPath: string | undefined
    if (this.configPathCache.has(directory)) {
      configPath = this.configPathCache.get(directory)
    } else {
      configPath = findNearestConfigFile(directory)
      this.configPathCache.set(directory, configPath)
    }
    if (!configPath) {
      return DEFAULT_COMPILER_OPTIONS
    }

    const signature = this.host.getSignature(configPath) ?? 'missing'
    const cached = this.compilerOptionsCache.get(configPath)
    if (cached && cached.signature === signature) {
      return cached.options
    }

    const configFile = ts.readConfigFile(configPath, (readFilePath) =>
      ts.sys.readFile(readFilePath),
    )
    if (configFile.error) {
      this.compilerOptionsCache.set(configPath, {
        options: DEFAULT_COMPILER_OPTIONS,
        signature,
      })
      return DEFAULT_COMPILER_OPTIONS
    }

    const parsedConfig = ts.parseJsonConfigFileContent(
      configFile.config,
      ts.sys,
      path.dirname(configPath),
    )
    const options = {
      ...DEFAULT_COMPILER_OPTIONS,
      ...parsedConfig.options,
    } satisfies ts.CompilerOptions

    this.compilerOptionsCache.set(configPath, { options, signature })
    return options
  }
}

function findNearestConfigFile(startDirectory: string): string | undefined {
  let currentDirectory = path.normalize(startDirectory)

  for (;;) {
    for (const configFileName of CONFIG_FILE_NAMES) {
      const candidatePath = path.join(currentDirectory, configFileName)
      if (ts.sys.fileExists(candidatePath)) {
        return candidatePath
      }
    }

    const parentDirectory = path.dirname(currentDirectory)
    if (parentDirectory === currentDirectory) {
      return undefined
    }

    currentDirectory = parentDirectory
  }
}

function isSupportedSourceFile(filePath: string): boolean {
  if (filePath.endsWith('.d.ts')) {
    return false
  }

  return SOURCE_EXTENSIONS.has(path.extname(filePath).toLowerCase())
}
