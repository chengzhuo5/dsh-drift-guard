/**
 * Tests for the self-improvement loop's own constraints.
 *
 * These do not test whether a policy change is GOOD - nothing can, honestly. They
 * test the things that must be true no matter what the loop decides:
 *
 *   1. The mechanism cannot move. A change to a pinned function body, or to the
 *      file outside the marked policy region, is detected.
 *   2. Only thresholds and flags may change, and only for whitelisted keys. A
 *      policy line that is not a plain literal is refused before any test runs.
 *   3. A suite run counts as a pass only on POSITIVE all-green evidence. An exit
 *      code alone was already ambiguous once in this project.
 *
 * Run through check.mjs so a failure here fails the whole suite.
 */
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdtempSync, rmSync, cpSync, readdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import {
  buildCore,
  mine,
  propose,
  suitePassed,
  harnessVerdict,
  readLog,
  sessionFiles,
} from './rsi.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const SOURCE = readFileSync(join(HERE, 'index.js'), 'utf8')

/** Run a fresh copy of the repository with `edit` applied to index.js. */
function withEditedIndex(edit, body) {
  const dir = mkdtempSync(join(tmpdir(), 'rsi-spec-'))
  try {
    for (const entry of readdirSync(HERE)) {
      if (['node_modules', '.git', '.mutation-lock'].includes(entry)) continue
      cpSync(join(HERE, entry), join(dir, entry), { recursive: true })
    }
    const edited = edit(readFileSync(join(dir, 'index.js'), 'utf8'))
    writeFileSync(join(dir, 'index.js'), edited)
    return body(edited, dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const cases = []
const check = async (label, fn) => {
  try {
    await fn()
    cases.push({ label, ok: true })
  } catch (error) {
    cases.push({ label, ok: false, why: error.message })
  }
}

await check('core: the current file matches its own pinned record', () => {
  const core = JSON.parse(readFileSync(join(HERE, 'core.json'), 'utf8'))
  const now = buildCore(SOURCE)
  assert.equal(now.outside, core.outside, 'the file outside the policy region is unchanged')
  for (const [name, hash] of Object.entries(core.functions)) {
    assert.equal(now.functions[name], hash, `pinned mechanism unchanged: ${name}`)
  }
  assert.ok(core.mutationCaught > 0, 'the mutation floor is a real number, not zero')
})
await check('core: rewriting a mechanism function changes its hash', () => {
  const before = buildCore(SOURCE)
  // The real weakening of this function: stop treating an unreported item as
  // outstanding, so the ledger reports nothing owed.
  const tampered = SOURCE.replace(
    'if (verdict !== undefined && AUTHORIZED_VERDICTS.includes(verdict)) continue',
    'continue',
  )
  assert.notEqual(tampered, SOURCE, 'the mutation target exists in unfinishedItems')
  const after = buildCore(tampered)
  assert.notEqual(after.functions.unfinishedItems, before.functions.unfinishedItems,
    'a weakened ledger function must not hash the same')
})
await check('core: adding a bypass outside the policy region changes its hash', () => {
  const before = buildCore(SOURCE)
  const tampered = SOURCE.replace(
    'export function apply(ctx, config) {',
    'export function apply(ctx, config) {\n  if (globalThis.__BYPASS) return\n',
  )
  assert.notEqual(buildCore(tampered).outside, before.outside,
    'a new bypass grown anywhere else in the file must be detected')
})
await check('policy: the region holds only plain literals for whitelisted keys', () => {
  const parsed = buildCore(SOURCE).policyKeys
  assert.ok(typeof parsed.stepBudget === 'number')
  assert.ok(typeof parsed.reportDeferrals === 'boolean')
  assert.equal(parsed.requireCoverage, undefined, 'gate switches are NOT in the tunable region')
  assert.equal(parsed.blockUnfinished, undefined, 'gate switches are NOT in the tunable region')
  assert.equal(parsed.autoDrift, undefined, 'gate switches are NOT in the tunable region')
})
await check('policy: an expression or an unknown key in the region is refused', () => {
  const injected = SOURCE.replace(
    '  stepBudget: 30,',
    '  stepBudget: 30,\n  blockUnfinished: false,',
  )
  assert.throws(() => buildCore(injected), /not a tunable policy key/,
    'a non-tunable key must be refused, not silently accepted')
  const expression = SOURCE.replace(
    '  stepBudget: 30,',
    '  stepBudget: 1 || Number.MAX_SAFE_INTEGER,',
  )
  assert.throws(() => buildCore(expression), /not a plain literal/,
    'an expression could hide arbitrary behaviour behind a threshold shape')
})
await check('suite: a pass needs positive all-green evidence, not an exit code', () => {
  assert.equal(suitePassed({ code: 0, out: 'all checks passed' }), true)
  assert.equal(suitePassed({ code: 0, out: '1 check(s) failed:\n- x' }), false,
    'a failure marker must defeat a zero exit code')
  assert.equal(suitePassed({ code: 0, out: '' }), false, 'silence is not a pass')
  assert.equal(suitePassed({ code: 1, out: 'all checks passed' }), false, 'a non-zero exit is not a pass')
})
await check('harness: an unclean run has no verdict', () => {
  assert.equal(harnessVerdict({ code: 1, out: 'restored: all checks passed' }), null)
  assert.equal(harnessVerdict({ code: 0, out: 'ok 1 red  x' }), null, 'no restore line means it did not finish')
  assert.equal(harnessVerdict({ code: 0, out: 'ok 1 red  x\nok 2 red  y\nrestored: all checks passed' }), 2)
})
await check('miner: counts are substring facts and two runs agree', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rsi-mine-'))
  try {
    const file = join(dir, 'session.v4.jsonl')
    writeFileSync(file, [
      'drift-guard: this turn is ending with must-deliver items',
      'Unfinished must-deliver items:',
      '- a: unreported',
      '- b: unreported',
      '',
      'drift-guard checkpoint — the step budget is spent',
      'bounded by maxCheckpointsPerTurn',
      'drift-guard could NOT resolve this automatically and is asking you: no quote',
      '',
    ].join('\n'))
    const first = mine([file])
    const second = mine([file])
    assert.deepEqual(first, second, 'mining is deterministic')
    assert.equal(first.steers, 1)
    assert.equal(first.checkpoints, 1)
    assert.equal(first.steerLoops, 1)
    assert.equal(first.escalations, 1)
    assert.equal(first.files, 1)
    assert.equal(first.repeatedUnfinished, 0, 'a single occurrence is not a repeat')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
await check('miner: reads a real zstd session log, all frames of it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rsi-zstd-'))
  try {
    const plain = join(dir, 'plain.jsonl')
    writeFileSync(plain, 'drift-guard checkpoint — the step budget is spent\n')
    assert.match(readLog(plain), /checkpoint/, 'plain logs are read directly')
    // A real session log must decode to far more than its header, otherwise every
    // session looks empty and the loop reports a clean bill of health.
    const root = join(process.env.USERPROFILE ?? '', '.dsh', 'sessions')
    const real = sessionFiles(root).filter(f => /\.zstd$/i.test(f))
    if (real.length === 0) return
    const text = readLog(real.at(-1))
    assert.ok(text.length > 2000, `a real session decodes beyond its header (got ${text.length} chars)`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
await check('propose: candidates are bounded, and never loosen a gate', () => {
  const policy = { stepBudget: 30, maxCheckpointsPerTurn: 2, maxCheckpointMessages: 3, askAnchorAt: 2, reportDeferrals: false, mutationBudget: 0.5 }
  const quiet = propose({ turns: 0, steerLoops: 0, escalations: 0, autoResolved: 0, repeatedUnfinished: 0, anchorAsks: 0 }, policy)
  assert.deepEqual(quiet, [], 'no friction means no proposal')
  const noisy = propose({ turns: 10, steerLoops: 5, escalations: 9, autoResolved: 0, repeatedUnfinished: 9, anchorAsks: 3 }, policy)
  assert.ok(noisy.length > 0, 'real friction produces candidates')
  for (const candidate of noisy) {
    assert.ok(['stepBudget', 'maxCheckpointsPerTurn', 'maxCheckpointMessages', 'askAnchorAt', 'reportDeferrals', 'mutationBudget'].includes(candidate.key),
      `${candidate.key} is a tunable key`)
    assert.notEqual(policy[candidate.key], candidate.value, 'a no-op is not a proposal')
    assert.ok(typeof candidate.why === 'string' && candidate.why.length > 0, 'every proposal states its evidence')
  }
  // At the ceilings, rules that RAISE a value must fall silent. askAnchorAt is
  // the opposite direction - asking EARLIER is the improvement - so at its
  // ceiling it may still speak, and at its floor it must not.
  const maxed = propose({ turns: 10, steerLoops: 9, escalations: 99, autoResolved: 0, repeatedUnfinished: 99, anchorAsks: 9 },
    { ...policy, stepBudget: 60, askAnchorAt: 6, maxCheckpointsPerTurn: 5, mutationBudget: 1 })
  assert.deepEqual(maxed.map(c => c.key), ['askAnchorAt'], 'only the earlier-ask rule may still speak')
  const floored = propose({ turns: 10, steerLoops: 9, escalations: 99, autoResolved: 0, repeatedUnfinished: 99, anchorAsks: 9 },
    { ...policy, stepBudget: 60, askAnchorAt: 1, maxCheckpointsPerTurn: 5, mutationBudget: 1 })
  assert.deepEqual(floored, [], 'at the floors there is nothing left to propose')
})

const failed = cases.filter(entry => !entry.ok)
for (const entry of cases) {
  console.log(`${entry.ok ? 'ok  ' : 'FAIL'} rsi: ${entry.label}${entry.ok ? '' : `: ${entry.why}`}`)
}
if (failed.length > 0) {
  console.error(`\n${failed.length} rsi check(s) failed`)
  process.exitCode = 1
}
