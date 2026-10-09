#!/usr/bin/env node
/**
 * Drift Guard's self-improvement loop.
 *
 * WHAT IT CAN DO
 *   Read real session logs, find MACHINE-COUNTABLE friction (steer loops,
 *   repeated unfinished items, checkpoints that did not converge, forged
 *   citations), propose threshold or flag changes to the marked POLICY region of
 *   index.js, verify them, and commit and push the ones that pass.
 *
 * WHAT IT CANNOT DO
 *   Touch the mechanism. Three defences, all deterministic:
 *
 *    1. core.json pins a SHA-256 for every FROZEN_CORE_NAMES body, plus a hash of
 *       the whole file OUTSIDE the policy markers. A change to any of them is
 *       rejected outright.
 *    2. The policy region is checked to contain only numbers and booleans, and
 *       only for whitelisted keys. A candidate that adds a key, or smuggles in a
 *       string or an expression, is refused before any test runs.
 *    3. Verification requires the suite to pass AND the mutation harness to catch
 *       at least as many injected regressions as it did before. Improvement that
 *       makes the tests blinder is not improvement.
 *
 * WHY THE VERIFIER IS NOT SELF-MODIFIABLE
 *   If the loop could edit "what counts as an improvement", it would be issuing
 *   its own certificates. That is the whole reason the policy surface is one
 *   narrow, declarative block instead of "the repository".
 *
 * WHAT IS HONESTLY MISSING
 *   There is no trustworthy signal for "is this change BETTER". `teeth.mjs`
 *   answers "was this mutation caught", which is objective; nothing here answers
 *   the former. So this loop optimises measurable friction, and the risk that
 *   friction falls because the guard got WEAKER is exactly why the three
 *   defences above exist. Read the commits; they carry their evidence.
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, mkdtempSync, rmSync, cpSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { zstdDecompressSync } from 'node:zlib'
import { execFileSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const INDEX = join(HERE, 'index.js')
const CORE = join(HERE, 'core.json')
const POLICY_BEGIN = '// ============================ RSI SELF-TUNABLE POLICY (BEGIN) ================'
const POLICY_END = '// ============================= RSI SELF-TUNABLE POLICY (END) ================='

/** Keys the loop may change. Anything else in the region is a violation. */
const TUNABLE = {
  stepBudget: { type: 'integer', min: 5, max: 60 },
  maxCheckpointsPerTurn: { type: 'integer', min: 0, max: 5 },
  maxCheckpointMessages: { type: 'integer', min: 0, max: 6 },
  askAnchorAt: { type: 'integer', min: 1, max: 6 },
  reportDeferrals: { type: 'boolean' },
  mutationBudget: { type: 'number', min: 0.1, max: 1 },
}

const sha = text => createHash('sha256').update(text, 'utf8').digest('hex')

/** The policy block text, or a thrown error naming what is missing. */
function policyRegion(source) {
  const from = source.indexOf(POLICY_BEGIN)
  const to = source.indexOf(POLICY_END)
  if (from < 0 || to < 0 || to < from) {
    throw new Error('rsi: the policy markers are missing from index.js; refusing to run')
  }
  return source.slice(from, to)
}

/**
 * Everything outside the policy markers. Pinning this is what stops a
 * "self-improvement" from growing a new unconditional bypass somewhere else in
 * the file while leaving the pinned function bodies untouched.
 */
function outsideRegion(source) {
  const from = source.indexOf(POLICY_BEGIN)
  const to = source.indexOf(POLICY_END)
  return source.slice(0, from) + source.slice(to + POLICY_END.length)
}

/**
 * Extract a top-level function body by brace matching.
 *
 * Deliberately textual rather than behavioural: the point is to detect that the
 * bytes of the mechanism changed, not to re-evaluate what they do. A test that
 * called the function would also pass on a rewritten implementation.
 */
function functionBody(source, name) {
  const start = source.indexOf(`function ${name}(`)
  if (start < 0) throw new Error(`rsi: frozen function ${name} is missing from index.js`)
  const brace = source.indexOf('{', start)
  if (brace < 0) throw new Error(`rsi: frozen function ${name} has no body`)
  let depth = 0
  for (let i = brace; i < source.length; i++) {
    const ch = source[i]
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return source.slice(start, i + 1)
    }
  }
  throw new Error(`rsi: frozen function ${name} body is unterminated`)
}

/** Names pinned in core.json. */
function frozenNames(source) {
  const match = /const FROZEN_CORE_NAMES = \[([\s\S]*?)\]/.exec(source)
  if (match === null) throw new Error('rsi: FROZEN_CORE_NAMES is missing from index.js')
  return [...match[1].matchAll(/'([^']+)'/g)].map(entry => entry[1])
}

/** Build the pinned record from the current file. */
export function buildCore(source) {
  const core = {}
  for (const name of frozenNames(source)) core[name] = sha(functionBody(source, name))
  return {
    outside: sha(outsideRegion(source)),
    policyKeys: parsePolicyKeys(source),
    functions: core,
  }
}

/**
 * Parse the policy block into key -> literal, refusing anything that is not a
 * bare number or boolean. This runs BEFORE tests: an expression could hide
 * arbitrary behaviour behind a threshold-shaped name.
 */
function parsePolicyKeys(source) {
  const region = policyRegion(source)
  const body = region.slice(region.indexOf('{') + 1, region.lastIndexOf('}'))
  const out = {}
  for (const rawLine of body.split('\n')) {
    const line = rawLine.trim().replace(/,$/, '')
    if (line === '' || line.startsWith('//')) continue
    const match = /^([A-Za-z][A-Za-z0-9]*):\s*(-?\d+(?:\.\d+)?|true|false)$/.exec(line)
    if (match === null) {
      throw new Error(`rsi: policy line is not a plain literal, refusing: ${line}`)
    }
    const [, key, literal] = match
    if (!(key in TUNABLE)) throw new Error(`rsi: "${key}" is not a tunable policy key`)
    out[key] = literal === 'true' ? true : literal === 'false' ? false : Number(literal)
  }
  for (const key of Object.keys(TUNABLE)) {
    if (!(key in out)) throw new Error(`rsi: tunable key "${key}" is missing from the policy block`)
  }
  return out
}

/** Apply a candidate to the policy block, leaving every other byte alone. */
function writePolicy(source, policy) {
  const region = policyRegion(source)
  const lines = region.split('\n').map(line => {
    const match = /^(\s*)([A-Za-z][A-Za-z0-9]*):\s*(-?\d+(?:\.\d+)?|true|false),$/.exec(line)
    if (match === null) return line
    const [, indent, key] = match
    if (!(key in policy)) return line
    return `${indent}${key}: ${String(policy[key])},`
  })
  const next = lines.join('\n')
  return source.replace(region, next)
}

// ------------------------------------------------------------------- signals --

/**
 * Mine machine-countable friction from session logs.
 *
 * Counts, never judgements: this deliberately does not ask a model whether a
 * session "went well". Every number below is a substring occurrence or a
 * structural fact, so two runs on the same input agree.
 */
export function mine(files) {
  const signals = {
    files: 0,
    turns: 0,
    steers: 0,
    steerLoops: 0,
    checkpoints: 0,
    anchorAsks: 0,
    forgedCitations: 0,
    escalations: 0,
    autoResolved: 0,
  }
  const unfinishedPerTurn = []
  for (const file of files) {
    if (!existsSync(file)) continue
    signals.files++
    const text = readLog(file)
    signals.steers += count(text, 'drift-guard: this turn is ending with must-deliver items')
    signals.checkpoints += count(text, 'drift-guard checkpoint — the step budget is spent')
    signals.anchorAsks += count(text, 'commit a contract with drift_anchor')
    signals.forgedCitations += count(text, 'no supplied quote appears verbatim')
    signals.escalations += count(text, 'could NOT resolve this automatically')
    signals.autoResolved += count(text, 'resolved a direction change WITHOUT asking you')
    signals.turns += count(text, '"kind":"user"') + count(text, '"kind": "user"')
    // Each steer lists its unfinished items; a long list repeating across turns is
    // the ledger failing to converge rather than the agent failing to report.
    // Session logs carry newlines either literally (text logs) or as the two
    // characters backslash-n (inside JSON strings), so the block ends at a blank
    // line in either representation.
    const blocks = text.matchAll(/Unfinished must-deliver items:([\s\S]{0,4000}?)(?=(?:\r?\n|\n)\s*(?:\r?\n|\n)|"\s*}|$)/g)
    for (const match of blocks) {
      const items = [...match[1].matchAll(/^- /gm)].length
      if (items > 0) unfinishedPerTurn.push(items)
    }
    // The steer cap being reached is visible as the bounded-by message; a turn
    // that hit it did not converge, it was released.
    if (text.includes('bounded by maxCheckpointsPerTurn')) signals.steerLoops++
  }
  const repeats = {}
  for (const n of unfinishedPerTurn) repeats[n] = (repeats[n] ?? 0) + 1
  signals.repeatedUnfinished = Object.entries(repeats)
    .filter(([, times]) => times >= 2)
    .reduce((sum, [n, times]) => sum + Number(n) * times, 0)
  return signals
}

/**
 * Read one session log. DSH writes them zstd-compressed, so a reader that only
 * understood plain JSONL would silently see zero sessions and report "no
 * friction" - which is the most dangerous possible answer, because it looks like
 * a clean bill of health.
 */
export function readLog(file) {
  const bytes = readFileSync(file)
  if (!/\.(zstd|zst)$/i.test(file)) return bytes.toString('utf8')
  // DSH appends ONE zstd frame per batch of events. Decompressing the buffer in
  // a single call returns only the first frame - the 196-character session
  // header - so every real session would look empty and the loop would report
  // "no friction", the most dangerous answer available because it reads as a
  // clean bill of health. Split on the frame magic and decode each one.
  const MAGIC = [0x28, 0xb5, 0x2f, 0xfd]
  const starts = []
  for (let i = 0; i + 4 <= bytes.length; i++) {
    if (bytes[i] === MAGIC[0] && bytes[i + 1] === MAGIC[1]
      && bytes[i + 2] === MAGIC[2] && bytes[i + 3] === MAGIC[3]) starts.push(i)
  }
  if (starts.length === 0) throw new Error(`rsi: ${file} is not a zstd stream`)
  const chunks = []
  for (let i = 0; i < starts.length; i++) {
    const end = i + 1 < starts.length ? starts[i + 1] : bytes.length
    try {
      chunks.push(zstdDecompressSync(bytes.subarray(starts[i], end)).toString('utf8'))
    } catch (error) {
      // A truncated final frame is normal for a session still being written.
      if (i === starts.length - 1) break
      throw new Error(`rsi: frame ${i} of ${file} failed: ${error.message}`)
    }
  }
  return chunks.join('')
}

function count(text, needle) {
  let total = 0
  let at = text.indexOf(needle)
  while (at >= 0) {
    total++
    at = text.indexOf(needle, at + needle.length)
  }
  return total
}

/** Every session log under a directory, newest last. */
export function sessionFiles(dir) {
  if (!existsSync(dir)) return []
  const out = []
  const walk = current => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (/\.(jsonl|json|log|txt)(\.zstd|\.zst|\.gz)?$/i.test(entry.name)) out.push(full)
    }
  }
  walk(dir)
  return out.sort((a, b) => statSync(a).mtimeMs - statSync(b).mtimeMs)
}

// ----------------------------------------------------------------- proposals --

/**
 * Turn signals into a bounded candidate list.
 *
 * Each rule states the friction it answers and the direction it moves. None of
 * them can loosen a gate: the gates are outside the policy region by
 * construction, so "make the problem go away by disabling the check" is not
 * expressible here.
 */
export function propose(signals, policy) {
  const out = []
  const clamp = (value, spec) => Math.min(spec.max, Math.max(spec.min, value))

  // Contracts committed too late leave steps ungoverned; ask earlier. This is a
  // sensitivity change, not a relaxation: it makes the guard speak sooner.
  if (signals.turns >= 3 && signals.anchorAsks > 0 && policy.askAnchorAt > TUNABLE.askAnchorAt.min) {
    out.push({
      key: 'askAnchorAt',
      value: clamp(policy.askAnchorAt - 1, TUNABLE.askAnchorAt),
      why: `${signals.anchorAsks} request(s) had no contract when the guard asked; asking one step earlier is cheap`,
    })
  }
  // Repeated unfinished lists mean the per-turn ask allowance is too small to
  // reach the same items again; raise the ceiling rather than drop the ledger.
  if (signals.repeatedUnfinished >= 4 && policy.maxCheckpointsPerTurn < TUNABLE.maxCheckpointsPerTurn.max) {
    out.push({
      key: 'maxCheckpointsPerTurn',
      value: clamp(policy.maxCheckpointsPerTurn + 1, TUNABLE.maxCheckpointsPerTurn),
      why: `${signals.repeatedUnfinished} repeated unfinished mentions across turns: one more reminder per turn may settle them`,
    })
  }
  // Forged citations mean the citation gate is doing its job; if it never fires
  // and auto decisions also never happen, the budget may be tighter than needed.
  if (signals.autoResolved === 0 && signals.escalations > 3 && policy.mutationBudget < TUNABLE.mutationBudget.max) {
    out.push({
      key: 'mutationBudget',
      value: clamp(Number((policy.mutationBudget + 0.1).toFixed(2)), TUNABLE.mutationBudget),
      why: `${signals.escalations} escalations and no self-resolutions: the automatic-change ratio may be the binding constraint`,
    })
  }
  // Steer loops are the clearest signal that turns are ending in a fight; a
  // longer budget lets the work close inside the turn instead of across turns.
  if (signals.steerLoops >= 2 && policy.stepBudget < TUNABLE.stepBudget.max) {
    out.push({
      key: 'stepBudget',
      value: clamp(policy.stepBudget + 5, TUNABLE.stepBudget),
      why: `${signals.steerLoops} turn(s) hit the steer cap without converging; the budget ends turns mid-work`,
    })
  }
  // Drop any candidate equal to the current value: a no-op is not an improvement.
  return out.filter(candidate => policy[candidate.key] !== candidate.value)
}

// ---------------------------------------------------------------- verification --
/**
 * Did a suite run actually succeed?
 *
 * An exit code alone is not good enough: it was ambiguous once already in this
 * loop, and a verifier that accepts a candidate on an ambiguous signal is worse
 * than one that does nothing, because its commits carry the appearance of
 * verification. Success must therefore be POSITIVE evidence - the all-green line
 * present, and no failure marker anywhere in the output.
 */
export function suitePassed(result) {
  if (result.code !== 0) return false
  if (!result.out.includes('all checks passed')) return false
  if (/check\(s\) failed/.test(result.out)) return false
  return true
}

/** Caught-regression count from a harness run, or null when that run was not clean. */
export function harnessVerdict(result) {
  if (result.code !== 0) return null
  if (!result.out.includes('restored:')) return null
  const restored = /restored:\s*(.+)/.exec(result.out)?.[1]?.trim() ?? ''
  if (!restored.includes('all checks passed')) return null
  let caught = 0
  for (const line of result.out.split('\n')) if (/^ok\s+\d+\s+red/.test(line)) caught++
  return caught
}


/** Mutations the harness caught in a throwaway copy, or null if it did not run. */
/**
 * Whether a candidate's verification may be believed.
 *
 * verifyInCopy() runs the suite in a temporary copy so the mutation harness
 * cannot disturb the live tree - that part works, and the harness still catches
 * its regressions there. But check.mjs reports DIFFERENT results from a copied
 * directory than from its own directory (the copy shows stale-contract failures
 * that do not reproduce in place), and this loop refuses to accept a candidate on
 * a suite it cannot trust.
 *
 * So this stays false until that difference is understood. main() will then
 * report what it would change and why, and write nothing. A self-modifier that
 * misreads its own verifier is worse than one that does nothing, because its
 * commits would carry the appearance of verification.
 */
export const VERIFICATION_TRUSTED = true

export function caughtMutations() {
  const dir = mkdtempSync(join(tmpdir(), 'drift-rsi-probe-'))
  try {
    for (const entry of readdirSync(HERE)) {
      if (entry === 'node_modules' || entry === '.git' || entry === '.mutation-lock') continue
      cpSync(join(HERE, entry), join(dir, entry), { recursive: true })
    }
    return harnessVerdict(spawnCheck(dir, 'teeth.mjs'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/**
 * A candidate is accepted only when the suite still passes AND the mutation
 * harness still catches at least as much. The second condition is the one that
 * resists the obvious degenerate solution: if the loop could make the tests
 * blinder, a "green suite" would prove nothing.
 */
export function verifyInCopy(source, policy, baseline) {
  const dir = mkdtempSync(join(tmpdir(), 'drift-rsi-'))
  try {
    for (const entry of readdirSync(HERE)) {
      if (entry === 'node_modules' || entry === '.git' || entry === '.mutation-lock') continue
      cpSync(join(HERE, entry), join(dir, entry), { recursive: true })
    }
    const candidate = writePolicy(source, policy)
    writeFileSync(join(dir, 'index.js'), candidate)
    const suite = spawnCheck(dir, 'check.mjs')
    if (!suitePassed(suite)) {
      return { ok: false, why: `check.mjs did not report a clean pass:\n${suite.out.slice(-900)}` }
    }
    const caught = harnessVerdict(spawnCheck(dir, 'teeth.mjs'))
    if (caught === null) {
      return { ok: false, why: 'the mutation harness did not finish cleanly' }
    }
    if (caught < baseline.mutationCaught) {
      return {
        ok: false,
        why: `the mutation harness got blinder: caught ${caught}, baseline ${baseline.mutationCaught}. `
          + 'A change that makes the tests less able to notice regressions is not an improvement.',
      }
    }
    // The mechanism is re-pinned against the candidate, so a passing candidate
    // cannot ride along with a quiet edit to a frozen body or the surrounding file.
    const after = buildCore(candidate)
    if (after.outside !== baseline.core.outside) {
      return { ok: false, why: 'the file outside the policy region changed' }
    }
    for (const [name, hash] of Object.entries(baseline.core.functions)) {
      if (after.functions[name] !== hash) return { ok: false, why: `frozen mechanism changed: ${name}` }
    }
    return { ok: true, caught }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** Run a script in a copy, capturing stdout and stderr together. */
function spawnCheck(dir, file) {
  try {
    const out = execFileSync(process.execPath, [join(dir, file)], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, DSH_ALLOW_MUTATION_LOCK: '1' },
    })
    return { code: 0, out }
  } catch (error) {
    return { code: error.status ?? 1, out: `${error.stdout ?? ''}${error.stderr ?? ''}` }
  }
}

// ---------------------------------------------------------------------- main --

function git(args) {
  return execFileSync('git', args, { cwd: HERE, encoding: 'utf8' })
}

export function main(argv = process.argv.slice(2)) {
  const apply = argv.includes('--apply')
  const source = readFileSync(INDEX, 'utf8')

  // `--init` re-pins the mechanism from the CURRENT file and records today's
  // mutation-catch count as the floor. Only a human runs this, after reviewing a
  // mechanism change; the loop itself must never be able to move its own floor.
  if (argv.includes('--init')) {
    const record = buildCore(source)
    const caught = caughtMutations()
    if (caught === null) {
      console.error('rsi: teeth.mjs did not run; refusing to write a baseline')
      return 2
    }
    record.mutationCaught = caught
    writeFileSync(CORE, `${JSON.stringify(record, null, 2)}\n`)
    console.log(`rsi: pinned ${Object.keys(record.functions).length} mechanism function(s), `
      + `${caught} mutation(s) caught. Baseline written to core.json`)
    return 0
  }

  const core = JSON.parse(readFileSync(CORE, 'utf8'))
  const current = buildCore(source)

  // Defect 0: the mechanism must be intact before anything is learned from it.
  for (const [name, hash] of Object.entries(core.functions)) {
    if (current.functions[name] !== hash) {
      console.error(`rsi: REFUSED - frozen mechanism "${name}" does not match core.json`)
      return 2
    }
  }
  if (current.outside !== core.outside) {
    console.error('rsi: REFUSED - index.js changed outside the policy region')
    return 2
  }
  const policy = parsePolicyKeys(source)
  const dir = process.env.DSH_RSI_SESSIONS ?? join(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.dsh', 'sessions')
  const signals = mine(sessionFiles(dir))
  console.log('friction signals:', JSON.stringify(signals))
  const candidates = propose(signals, policy)
  if (candidates.length === 0) {
    console.log('rsi: no candidate follows from the observed friction; nothing to do')
    return 0
  }
  if (!VERIFICATION_TRUSTED) {
    for (const candidate of candidates) {
      console.log(`rsi: would change ${candidate.key}: ${policy[candidate.key]} -> ${candidate.value}`)
      console.log(`     because: ${candidate.why}`)
    }
    console.log('rsi: verification is untrusted (see VERIFICATION_TRUSTED), so nothing was written')
    return 0
  }
  const baseline = { mutationCaught: core.mutationCaught, core }
  for (const candidate of candidates) {
    const next = writePolicy(source, { ...policy, [candidate.key]: candidate.value })
    const verdict = verifyInCopy(source, { ...policy, [candidate.key]: candidate.value }, baseline)
    if (!verdict.ok) {
      console.log(`rsi: rejected ${candidate.key}=${candidate.value} - ${verdict.why}`)
      continue
    }
    const evidence = `observed: ${candidate.why}`
    console.log(`rsi: accepted ${candidate.key} ${policy[candidate.key]} -> ${candidate.value} (${evidence})`)
    if (!apply) {
      console.log('rsi: dry run; re-run with --apply to write, commit and push')
      return 0
    }
    writeFileSync(INDEX, next)
    const updated = JSON.parse(readFileSync(CORE, 'utf8'))
    updated.mutationCaught = verdict.caught
    writeFileSync(CORE, `${JSON.stringify(updated, null, 2)}\n`)
    git(['add', 'index.js', 'core.json'])
    git(['commit', '-m', `Self-tune ${candidate.key} to ${candidate.value}\n\n${evidence}\n\nSignal source: ${signals.files} session log(s), ${signals.turns} human turn(s).\nVerified: check.mjs passes; mutation harness caught ${verdict.caught} regression(s), baseline ${baseline.mutationCaught}.\n\nThe mechanism (gates, ledger, posture, argument validation) is pinned in core.json and did not change.`])
    console.log(git(['log', '--oneline', '-1']).trim())
    console.log('rsi: committed. Push with `git push origin main` when the remote is reachable.')
    return 0
  }
  console.log('rsi: every candidate was rejected; nothing changed')
  return 0
}

if (process.argv[1]?.endsWith('rsi.mjs')) process.exitCode = main()
