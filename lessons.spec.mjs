/**
 * Tests for the cross-session lesson store.
 *
 * The store is the guard's only durable memory, and the injected block sits at the
 * very front of every request, so the properties tested here are the ones whose
 * failure would be silent:
 *
 *   1. Append-only. Editing or removing an entry would move the bytes of a prompt
 *      prefix other sessions have already cached.
 *   2. A closed trigger set. A free-text trigger could only be matched by
 *      judgement, and this project measured that kind of matching as worse than
 *      random.
 *   3. Mechanical trigger detection. A reminder that fires inconsistently teaches
 *      the reader to ignore reminders, which is worse than not having them.
 *   4. A rendered block that is byte-identical for the same lessons, so it can be
 *      computed once per session and kept.
 *
 * Run through test-all.mjs.
 */
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  LESSON_TRIGGERS,
  LESSON_TRIGGER_NAMES,
  activeLessons,
  loadLessons,
  recordLesson,
  renderLessons,
  renderReminder,
  lessonsForTriggers,
  triggersForCall,
  validateLesson,
} from './lessons.js'

const cases = []
const check = (label, fn) => {
  try {
    fn()
    cases.push({ label, ok: true })
  } catch (error) {
    cases.push({ label, ok: false, why: error.message })
  }
}

/** Run body against a fresh temporary store. */
function withStore(body) {
  const dir = mkdtempSync(join(tmpdir(), 'lessons-spec-'))
  try {
    return body(join(dir, 'lessons.json'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const sample = {
  symptom: 'Passed generated code through a shell here-string, so escape sequences became literal text.',
  rule: 'Write generated code to a file with the file tool instead of piping it through the shell.',
  trigger: 'bulk-replace',
}

check('store: a missing file is an empty store, not an error', () => {
  withStore(file => { assert.deepEqual(loadLessons(file), { version: 1, lessons: [] }) })
})
check('store: recording appends and returns the stored record', () => {
  withStore(file => {
    const record = recordLesson(file, sample, 1)
    assert.equal(record.id, 'L1')
    assert.equal(record.trigger, 'bulk-replace')
    const store = loadLessons(file)
    assert.equal(store.lessons.length, 1)
    assert.equal(store.lessons[0].symptom, sample.symptom)
  })
})
check('store: ids keep counting so a supersede can name a specific entry', () => {
  withStore(file => {
    recordLesson(file, sample, 1)
    recordLesson(file, { ...sample, symptom: 'second' }, 2)
    assert.deepEqual(loadLessons(file).lessons.map(l => l.id), ['L1', 'L2'])
  })
})
check('store: a superseded lesson is retired, not deleted or edited', () => {
  withStore(file => {
    recordLesson(file, sample, 1)
    const second = recordLesson(file, { ...sample, symptom: 'the same trap, stated better', supersedes: 'L1' }, 2)
    const store = loadLessons(file)
    assert.equal(store.lessons.length, 2, 'the original entry is still in the file')
    assert.equal(store.lessons[0].symptom, sample.symptom, 'and its text was not rewritten')
    assert.equal(store.lessons[0].supersededBy, second.id, 'retirement is recorded on the old entry')
    assert.deepEqual(activeLessons(store).map(l => l.id), ['L2'])
  })
})
check('store: superseding an unknown or already-retired id is refused', () => {
  withStore(file => {
    assert.throws(() => recordLesson(file, { ...sample, supersedes: 'L99' }, 1), /not in the store/)
    recordLesson(file, sample, 1)
    recordLesson(file, { ...sample, symptom: 'replacement', supersedes: 'L1' }, 2)
    assert.throws(() => recordLesson(file, { ...sample, symptom: 'third', supersedes: 'L1' }, 3), /already superseded/)
  })
})
check('store: a malformed file fails loudly rather than reading as empty', () => {
  withStore(file => {
    writeFileSync(file, '{ not json')
    assert.throws(() => loadLessons(file), /not valid JSON/)
    writeFileSync(file, '{"lessons": 7}')
    assert.throws(() => loadLessons(file), /must be an object with a "lessons" array/)
  })
})
check('store: writes are atomic, leaving no temporary file behind', () => {
  withStore(file => {
    recordLesson(file, sample, 1)
    assert.equal(existsSync(file + '.tmp'), false)
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).lessons.length, 1)
  })
})
check('validate: the trigger must come from the closed set', () => {
  assert.ok(LESSON_TRIGGER_NAMES.length >= 4, 'there is a real set of triggers')
  assert.throws(() => validateLesson({ ...sample, trigger: 'whatever-feels-right' }), /trigger must be one of/)
  assert.throws(() => validateLesson({ ...sample, trigger: '' }), /trigger is required/)
  for (const name of LESSON_TRIGGER_NAMES) {
    assert.ok(typeof LESSON_TRIGGERS[name] === 'string' && LESSON_TRIGGERS[name].length > 0,
      name + ' explains when it applies')
  }
})
check('validate: symptom and rule are required and bounded', () => {
  assert.throws(() => validateLesson({ ...sample, symptom: '   ' }), /symptom is required/)
  assert.throws(() => validateLesson({ ...sample, rule: undefined }), /rule is required/)
  assert.throws(() => validateLesson({ ...sample, rule: 'x'.repeat(401) }), /longer than 400/)
})
check('triggers: editing a test file raises before-editing-tests', () => {
  // A file only counts as evidence if its NAME declares it as a test. A trigger of
  // "anything ending in .mjs" would fire on every source edit and teach the reader
  // to ignore reminders.
  assert.ok(triggersForCall('edit', { file_path: '/repo/lessons.spec.mjs' }, { stepsThisTurn: 1 }).has('before-editing-tests'))
  assert.ok(triggersForCall('edit', { file_path: '/repo/parser.test.ts' }, { stepsThisTurn: 1 }).has('before-editing-tests'))
  assert.ok(triggersForCall('edit', { file_path: '/repo/tests/parser.ts' }, { stepsThisTurn: 1 }).has('before-editing-tests'))
  assert.equal(triggersForCall('edit', { file_path: '/repo/index.js' }, { stepsThisTurn: 1 }).has('before-editing-tests'), false,
    'editing source is not editing evidence')
})
check('triggers: bulk rewriting is recognised, a single edit is not', () => {
  assert.ok(triggersForCall('bulk_replace', {}, {}).has('bulk-replace'))
  assert.ok(triggersForCall('shell', { command: "sed -i 's/a/b/' f.js" }, {}).has('bulk-replace'))
  assert.equal(triggersForCall('edit', { file_path: '/repo/a.js' }, {}).has('bulk-replace'), false)
})
check('triggers: long turns and missing contracts are step facts', () => {
  assert.equal(triggersForCall('read', {}, { stepsThisTurn: 3 }).has('long-turn'), false)
  assert.ok(triggersForCall('read', {}, { stepsThisTurn: 12 }).has('long-turn'))
  const noContract = { stepsThisTurn: 5, contract: null, turnKey: 1, contractTurn: null }
  assert.ok(triggersForCall('read', {}, noContract).has('no-contract-yet'))
  const withContract = { stepsThisTurn: 5, contract: { mustDeliver: [] }, turnKey: 1, contractTurn: 1 }
  assert.equal(triggersForCall('read', {}, withContract).has('no-contract-yet'), false,
    'a contract in force silences the missing-contract trigger')
})
check('reminders: only lessons whose trigger fired are raised', () => {
  const lessons = [
    { id: 'L1', trigger: 'bulk-replace', symptom: 's1', rule: 'r1' },
    { id: 'L2', trigger: 'long-turn', symptom: 's2', rule: 'r2' },
  ]
  assert.deepEqual(lessonsForTriggers(lessons, new Set(['long-turn'])).map(l => l.id), ['L2'])
  assert.deepEqual(lessonsForTriggers(lessons, new Set()), [], 'no trigger, no interruption')
  assert.deepEqual(lessonsForTriggers(lessons, undefined), [], 'a missing set is not a match')
  const text = renderReminder(lessons[0], 'bulk-replace')
  assert.match(text, /L1/)
  assert.match(text, /already paid for: s1/)
  assert.match(text, /what to do instead: r1/)
})
check('render: the same lessons give byte-identical text, and no lessons give none', () => {
  const lessons = [
    { id: 'L1', trigger: 'bulk-replace', symptom: 's1', rule: 'r1' },
    { id: 'L2', trigger: 'long-turn', symptom: 's2', rule: 'r2' },
  ]
  assert.equal(renderLessons(lessons), renderLessons(lessons.slice()), 'rendering is a pure function')
  assert.match(renderLessons(lessons), /L1/)
  assert.equal(renderLessons([]), '', 'nothing to say means nothing injected')
})
check('render: a retired lesson leaves the active block', () => {
  const lessons = [
    { id: 'L1', trigger: 'bulk-replace', symptom: 'old', rule: 'old rule' },
    { id: 'L2', trigger: 'bulk-replace', symptom: 'new', rule: 'new rule' },
  ]
  const active = activeLessons({ version: 1, lessons: [{ ...lessons[0], supersededBy: 'L2' }, lessons[1]] })
  const text = renderLessons(active)
  assert.equal(text.includes('old rule'), false)
  assert.match(text, /new rule/)
})

const failed = cases.filter(entry => !entry.ok)
for (const entry of cases) {
  console.log((entry.ok ? 'ok  ' : 'FAIL') + ' lessons: ' + entry.label + (entry.ok ? '' : ': ' + entry.why))
}
if (failed.length > 0) {
  console.error('\n' + failed.length + ' lessons check(s) failed')
  process.exitCode = 1
}