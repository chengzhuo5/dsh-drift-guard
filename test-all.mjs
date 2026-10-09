#!/usr/bin/env node
/**
 * Run every suite the project has.
 *
 * `check.mjs` and `rsi.spec.mjs` are deliberately NOT merged into one file. The
 * mutation harness rewrites index.js on purpose while it works, and rsi.spec.mjs
 * asserts that index.js still matches the pinned constitution in core.json — so
 * running the RSI spec inside the mutation loop fails for a reason that has
 * nothing to do with the loop's own correctness. Separating them keeps each suite
 * meaningful; this entry point keeps "did I run everything" from depending on
 * remembering two commands.
 *
 * Exit code is non-zero unless BOTH suites report an explicit all-green verdict.
 * An exit code alone is not treated as a pass, for the same reason rsi.mjs does
 * not treat one as a pass.
 */
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

const SUITES = [
  { file: 'check.mjs', what: 'the guard' },
  { file: 'rsi.spec.mjs', what: "the self-improvement loop's constraints" },
]

let bad = 0
for (const suite of SUITES) {
  let out = ''
  let code = 0
  try {
    out = execFileSync(process.execPath, [join(HERE, suite.file)], {
      cwd: HERE, encoding: 'utf8',
      env: { ...process.env, DSH_ALLOW_MUTATION_LOCK: '1' },
    })
  } catch (error) {
    code = error.status ?? 1
    out = `${error.stdout ?? ''}${error.stderr ?? ''}`
  }
  const green = out.includes('all checks passed') || /^ok\s+rsi:/m.test(out)
  const failed = /check\(s\) failed/.test(out)
  const passes = code === 0 && green && !failed
  console.log(`${passes ? 'PASS' : 'FAIL'}  ${suite.file}  (${suite.what})`)
  if (!passes) {
    bad++
    console.log(out.trim().split('\n').slice(-12).map(line => `      ${line}`).join('\n'))
  }
}

console.log(bad === 0 ? '\nall suites passed' : `\n${bad} suite(s) failed`)
process.exitCode = bad === 0 ? 0 : 1
