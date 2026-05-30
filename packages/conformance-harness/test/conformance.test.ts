import * as fs from 'node:fs'
import * as path from 'node:path'

import {
  type ComponentUsage,
  serializeCanonical,
} from '@react-component-lens/core'
import { expect, test } from 'bun:test'

import {
  findCaseDirs,
  FIXTURES_ROOT,
  goldenPathFor,
  runFixture,
} from '../src/runner'

interface Golden {
  meta: { contractVersion: number; generatorVersion: string; tsVersion: string }
  usages: ComponentUsage[]
}

const caseDirs = findCaseDirs(FIXTURES_ROOT)

test('fixture corpus is non-empty', () => {
  expect(caseDirs.length).toBeGreaterThan(0)
})

for (const caseDir of caseDirs) {
  const name = path.relative(FIXTURES_ROOT, caseDir).split(path.sep).join('/')

  test(`oracle output matches committed golden: ${name}`, async () => {
    const goldenPath = goldenPathFor(caseDir)
    expect(
      fs.existsSync(goldenPath),
      `Missing golden for "${name}". Run: bun run --filter @react-component-lens/conformance-harness generate`,
    ).toBe(true)

    const golden = JSON.parse(fs.readFileSync(goldenPath, 'utf8')) as Golden
    expect(golden.meta.contractVersion).toBe(1)

    const actual = await runFixture(caseDir)
    const expected = serializeCanonical(golden.usages)
    expect(actual).toBe(expected)
  })
}
