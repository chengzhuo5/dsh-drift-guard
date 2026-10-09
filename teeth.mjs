// Throwaway: mutation checks for the three live-run fixes, using plain substring
// needles so indentation differences cannot silently skip a mutation.
import { readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const FILE = 'index.js'
const original = readFileSync(FILE, 'utf8')

const MUTATIONS = [
  {
    label: 'a new request keeps the old contract as in-force (no reset)',
    needles: [{
      from: 'contract: state.contractTurn === event.seq ? state.contract : null,',
      to: 'contract: state.contract,',
    }],
  },
  {
    label: 'budget uses whole-session steps (permanent-overspend bug)',
    needles: [{
      from: 'state.stepsThisTurn - state.contract.atStep',
      to: 'state.steps - state.contract.atStep',
      all: true,
    }],
  },
  {
    label: 'checkpoint memory keyed on the contract, not the request',
    needles: [{
      from: 'const seen = entry.turnKey === state.turnKey',
      to: 'const seen = entry.contractSeq === state.contractSeq',
    }],
  },
  {
    label: 'checkpoint ignores a finished ledger (the nag-after-done bug)',
    needles: [{
      from: 'if (unfinishedItems(state).length === 0) return undefined',
      to: 'if (false) return undefined',
    }],
  },
  {
    label: 'deferral detector without the work-verb requirement (false positives)',
    needles: [{ from: 'if (!WORK_VERBS.test(sentence)) continue', to: 'if (false) continue' }],
  },
  {
    label: 'assistant records from other producers are watched too',
    needles: [{
      from: "if (origin !== undefined && origin !== 'model') return state",
      to: 'if (false) return state',
    }],
  },
]

for (const mutation of MUTATIONS) {
  let mutated = original
  let applied = 0
  let missing = 0
  for (const needle of mutation.needles) {
    const count = mutated.split(needle.from).length - 1
    if (count === 0) {
      missing += 1
      continue
    }
    applied += 1
    mutated = needle.all
      ? mutated.split(needle.from).join(needle.to)
      : mutated.replace(needle.from, needle.to)
  }
  if (missing > 0) {
    console.log(`SKIP  needle not found (${missing})  ${mutation.label}`)
    continue
  }
  writeFileSync(FILE, mutated)
  const onDisk = readFileSync(FILE, 'utf8')
  const wrote = onDisk !== original
  let output = ''
  try {
    output = execFileSync('node', ['check.mjs'], { encoding: 'utf8' })
  } catch (error) {
    output = `${error.stdout ?? ''}${error.stderr ?? ''}`
  }
  const failed = (output.match(/^FAIL /gm) ?? []).length
  console.log(`${failed > 0 ? 'ok  ' : 'MISS'} ${String(failed).padStart(2)} red  applied=${applied} wrote=${wrote}  ${mutation.label}`)
  if (failed > 0) {
    for (const line of output.split('\n').filter(l => l.startsWith('FAIL ')).slice(0, 2)) {
      console.log(`        ${line.slice(0, 100)}`)
    }
  }
}

writeFileSync(FILE, original)
const final = execFileSync('node', ['check.mjs'], { encoding: 'utf8' })
console.log(`\nrestored: ${final.trim().split('\n').at(-1)}`)
