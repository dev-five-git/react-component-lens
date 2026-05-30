import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { expect, test } from 'bun:test'

import { createDiskHost, findEntryFile, runFixture } from '../src/runner'

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rcl-harness-'))
}

test('createDiskHost: non-existent path yields false/undefined', () => {
  const host = createDiskHost()
  const missing = path.join(tempDir(), 'nope.tsx')
  expect(host.fileExists(missing)).toBe(false)
  expect(host.getSignature(missing)).toBeUndefined()
  expect(host.readFile(missing)).toBeUndefined()
})

test('createDiskHost: existing file yields signature + contents', () => {
  const dir = tempDir()
  try {
    const file = path.join(dir, 'a.tsx')
    fs.writeFileSync(file, 'export const A = 1\n', 'utf8')
    const host = createDiskHost()
    expect(host.fileExists(file)).toBe(true)
    expect(host.getSignature(file)).toBeDefined()
    expect(host.readFile(file)).toBe('export const A = 1\n')
  } finally {
    fs.rmSync(dir, { force: true, recursive: true })
  }
})

test('findEntryFile: undefined when no entry present', () => {
  const dir = tempDir()
  try {
    expect(findEntryFile(dir)).toBeUndefined()
  } finally {
    fs.rmSync(dir, { force: true, recursive: true })
  }
})

test('runFixture: rejects when no entry file', async () => {
  const dir = tempDir()
  try {
    await expect(runFixture(dir)).rejects.toThrow('No entry file')
  } finally {
    fs.rmSync(dir, { force: true, recursive: true })
  }
})
