/**
 * Cross-session lessons: the guard's memory of mistakes it has already made.
 *
 * The problem is not that the guard does not try hard enough. It is that a lesson
 * learned in one session is gone by the next one, so the same mistake stays
 * available to be made again. Everything here makes a lesson survive the session
 * that produced it.
 *
 * THREE DECISIONS THAT SHAPE THE DESIGN
 *
 * 1. APPEND-ONLY. A lesson is never rewritten and never deleted. Retiring one
 *    means appending a later lesson that supersedes it, because the injected text
 *    sits at the very front of every request: editing an old entry would move the
 *    bytes of the prompt prefix for every session, and prompt caches invalidate
 *    from the first differing token.
 *
 * 2. TRIGGERS ARE A CLOSED SET. The model picks a trigger from LESSON_TRIGGERS and
 *    cannot invent one. A free-text trigger could only be matched by fuzzy
 *    judgement, and this project already measured that kind of matching: semantic
 *    similarity scored below random on the task it was tried for. A closed enum
 *    can be matched mechanically, so a reminder either fires or it does not.
 *
 * 3. A LESSON IS A CLAIM, NOT A FACT. supersededBy exists because a lesson can be
 *    wrong, and the honest way to fix a wrong lesson is to record that it was
 *    wrong. Nothing here verifies a lesson is true; a human reading lessons.json
 *    is the only check that exists.
 */
import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs'

/** The store's file name, relative to wherever the plugin keeps it. */
export const LESSONS_FILE = 'lessons.json'

/**
 * When a lesson should be raised. Closed on purpose - see the header.
 *
 * Each entry names a moment the guard can actually detect from a tool call or a
 * step count. A trigger nobody can evaluate would be a lesson that never fires.
 */
export const LESSON_TRIGGERS = {
  'bulk-replace': 'You are about to rewrite many occurrences at once (a scripted replace, sed, or a loop doing edits).',
  'before-editing-tests': 'You are about to edit a test file. Tests are the evidence; changing them changes what counts as proof.',
  'long-turn': 'This turn has run for many steps. Long turns are where the original request quietly stops being in view.',
  'no-contract-yet': 'Several steps have passed with no committed contract, so nothing is being held to the request.',
}

/** Every trigger name, in stable order, for schema enums and validation. */
export const LESSON_TRIGGER_NAMES = Object.keys(LESSON_TRIGGERS)

/** Longest accepted text for one field, so a lesson cannot become an essay. */
const MAX_FIELD = 400

/** Read the store. A missing file is an empty store, not an error. */
export function loadLessons(file) {
  if (!existsSync(file)) return { version: 1, lessons: [] }
  let parsed
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    throw new Error(LESSONS_FILE + ' is not valid JSON: ' + error.message)
  }
  if (parsed === null || typeof parsed !== 'object' || !Array.isArray(parsed.lessons)) {
    throw new Error(LESSONS_FILE + ' must be an object with a "lessons" array')
  }
  return { version: 1, lessons: parsed.lessons }
}

/** Lessons still in force: those no later entry has superseded. */
export function activeLessons(store) {
  const retired = new Set()
  for (const lesson of store.lessons) {
    if (typeof lesson.supersededBy === 'string') retired.add(lesson.id)
  }
  return store.lessons.filter(lesson => !retired.has(lesson.id))
}

/** Validate one lesson, refusing anything the store should not carry. */
export function validateLesson(input) {
  const raw = input ?? {}
  const field = (name, value) => {
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new TypeError('drift_lesson: ' + name + ' is required')
    }
    const text = value.trim()
    if (text.length > MAX_FIELD) {
      throw new TypeError('drift_lesson: ' + name + ' is longer than ' + MAX_FIELD + ' characters')
    }
    return text
  }
  const trigger = field('trigger', raw.trigger)
  if (!LESSON_TRIGGER_NAMES.includes(trigger)) {
    throw new TypeError('drift_lesson: trigger must be one of ' + LESSON_TRIGGER_NAMES.join('/'))
  }
  return {
    symptom: field('symptom', raw.symptom),
    rule: field('rule', raw.rule),
    trigger,
    triggerNote: raw.trigger_note === undefined ? '' : field('trigger_note', raw.trigger_note),
    supersedes: raw.supersedes === undefined ? undefined : field('supersedes', raw.supersedes),
  }
}

/**
 * Append one lesson and return the stored record.
 *
 * Writes through a temporary file and renames, so an interrupted write cannot
 * leave a half-written store: this file is the only durable memory the guard has.
 */
export function recordLesson(file, input, now) {
  const lesson = validateLesson(input)
  const store = loadLessons(file)
  const record = {
    id: 'L' + String(store.lessons.length + 1),
    at: now,
    symptom: lesson.symptom,
    rule: lesson.rule,
    trigger: lesson.trigger,
  }
  if (lesson.triggerNote !== '') record.triggerNote = lesson.triggerNote
  const next = { version: 1, lessons: store.lessons.slice() }
  if (lesson.supersedes !== undefined) {
    const index = next.lessons.findIndex(entry => entry.id === lesson.supersedes)
    if (index < 0) {
      throw new TypeError('drift_lesson: supersedes names ' + lesson.supersedes + ', which is not in the store')
    }
    if (next.lessons[index].supersededBy !== undefined) {
      throw new TypeError('drift_lesson: ' + lesson.supersedes + ' is already superseded')
    }
    // Retirement is recorded ON THE OLD entry; the new entry is never an edit of
    // the old one, so a reader holding the cached block keeps the same prefix.
    next.lessons[index] = Object.assign({}, next.lessons[index], { supersededBy: record.id })
  }
  next.lessons.push(record)
  const temp = file + '.tmp'
  writeFileSync(temp, JSON.stringify(next, null, 2) + '\n')
  renameSync(temp, file)
  return record
}

/**
 * The block injected into the prompt, or an empty string when there is nothing.
 *
 * Stable for a fixed set of lessons. The caller renders this ONCE per session and
 * keeps the string, so the prompt prefix does not move as lessons accumulate.
 */
export function renderLessons(lessons) {
  if (lessons.length === 0) return ''
  const lines = [
    '## Lessons from earlier sessions',
    '',
    'Mistakes already made in this project, each paid for by a session. They are not hypothetical.',
    'When a trigger below matches what you are about to do the guard will remind you: read the',
    'reminder instead of treating it as noise.',
    '',
  ]
  for (const lesson of lessons) {
    lines.push('**' + lesson.id + '** (trigger: ' + lesson.trigger + ') - ' + lesson.symptom)
    lines.push('> ' + lesson.rule)
    lines.push('')
  }
  return lines.join('\n').trimEnd()
}

/** Which lessons a given moment should raise. */
export function lessonsForTriggers(lessons, fired) {
  if (fired === undefined || fired.size === 0) return []
  return lessons.filter(lesson => fired.has(lesson.trigger))
}

/** Steps after which a turn counts as long. */
export const LONG_TURN_STEPS = 12
/** Steps after which a missing contract is worth raising. */
export const NO_CONTRACT_STEPS = 4

/** Tool names that rewrite text in bulk, so bulk-replace can be detected. */
const BULK_TOOL = /(^|_)(sed|awk|perl|replace|bulk|rewrite)($|_)/i
/**
 * Paths that make a file evidence. The name has to declare it: a trigger of
 * "anything ending in .mjs" would fire on every source edit and teach the reader
 * to ignore reminders.
 */
const TEST_FILE = /([._-](spec|test)\.[a-z]+$)|(\.(spec|test)\.)|((^|[\\/])tests?[\\/])/i
/** Tools that write a file. */
const WRITE_TOOL = /^(edit|write|str_replace|multi_edit|apply_patch|create_file)$/i

/**
 * Decide which triggers hold for one tool call.
 *
 * Mechanical on purpose: string facts about the tool name and its arguments. A
 * trigger that needed judgement could not be trusted to fire consistently, and a
 * reminder that fires inconsistently teaches the reader to ignore reminders.
 */
export function triggersForCall(name, args, state) {
  const fired = new Set()
  const tool = String(name ?? '')
  const text = tool + ' ' + JSON.stringify(args ?? {})
  if (BULK_TOOL.test(tool) || /\bsed\s+-i\b|\bawk\b[^|]*-i\b|\.replaceAll\(/i.test(text)) {
    fired.add('bulk-replace')
  }
  if (WRITE_TOOL.test(tool)) {
    const target = String(args?.file_path ?? args?.path ?? args?.file ?? '')
    if (TEST_FILE.test(target)) fired.add('before-editing-tests')
  }
  const steps = Number.isFinite(state?.stepsThisTurn) ? state.stepsThisTurn : 0
  if (steps >= LONG_TURN_STEPS) fired.add('long-turn')
  const inForce = Boolean(state?.contract) && state?.contractTurn === state?.turnKey
  if (steps >= NO_CONTRACT_STEPS && !inForce) fired.add('no-contract-yet')
  return fired
}

/** One reminder for a lesson that just fired. */
export function renderReminder(lesson, trigger) {
  return 'drift-guard lesson ' + lesson.id + ' (trigger: ' + trigger + ')\n'
    + '- already paid for: ' + lesson.symptom + '\n'
    + '- what to do instead: ' + lesson.rule
}