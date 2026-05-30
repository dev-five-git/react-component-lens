import * as fs from 'node:fs'
import * as path from 'node:path'

import {
  findCaseDirs,
  FIXTURES_ROOT,
  goldenPathFor,
  runFixture,
} from './runner'

const CONTRACT_VERSION = 1
const GENERATOR_VERSION = '1'
const TS_VERSION = '5.9.3'

async function main(): Promise<void> {
  const caseDirs = findCaseDirs(FIXTURES_ROOT)
  for (const caseDir of caseDirs) {
    const canonical = await runFixture(caseDir)
    const goldenPath = goldenPathFor(caseDir)
    fs.mkdirSync(path.dirname(goldenPath), { recursive: true })
    const golden = {
      meta: {
        contractVersion: CONTRACT_VERSION,
        generatorVersion: GENERATOR_VERSION,
        tsVersion: TS_VERSION,
      },
      usages: JSON.parse(canonical),
    }
    fs.writeFileSync(goldenPath, `${JSON.stringify(golden, null, 2)}\n`, 'utf8')
  }
  process.stdout.write(
    `Generated ${caseDirs.length} golden(s) under conformance/goldens\n`,
  )
}

main().catch((error: unknown) => {
  process.exitCode = 1
  process.stderr.write(`${String(error)}\n`)
})
