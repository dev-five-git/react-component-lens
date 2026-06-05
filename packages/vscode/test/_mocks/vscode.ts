// Minimal `vscode` module stub used by the integration tests in approach B.
//
// Only the surface area touched by `src/wasmHost.ts` is implemented:
// `workspace.textDocuments` returning an array of objects with `fileName`,
// `version`, and `getText()`. This is enough to drive the real
// ComponentLensAnalyzer + WASM core resolution path through open-buffer
// semantics; only the VS Code decoration painting itself is omitted, which the
// extension delegates to `decorations.ts` and is out of scope for component
// classification.

export class FakeTextDocument {
  public version: number
  public readonly uri: { fsPath: string }
  private text: string

  public constructor(
    public readonly fileName: string,
    text: string,
    version = 1,
  ) {
    this.text = text
    this.version = version
    this.uri = { fsPath: fileName }
  }

  public getText(): string {
    return this.text
  }

  public setText(nextText: string, nextVersion?: number): void {
    this.text = nextText
    this.version = nextVersion ?? this.version + 1
  }
}

const openDocs: FakeTextDocument[] = []

export const workspace = {
  get textDocuments(): readonly FakeTextDocument[] {
    return openDocs
  },
}

export function __upsertOpenDoc(doc: FakeTextDocument): void {
  const index = openDocs.findIndex(
    (existing) => existing.fileName === doc.fileName,
  )
  if (index >= 0) {
    openDocs[index] = doc
  } else {
    openDocs.push(doc)
  }
}

export function __clearOpenDocs(): void {
  openDocs.length = 0
}
