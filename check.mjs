/**
 * Offline self-check for Drift Guard. Runs without a Harness: it exercises the
 * config validator, the projection fold, the posture machine, the coverage
 * ledger, both gates, both tools, and the JSON-Schema subset the tool registry
 * enforces.
 *
 * Run: node check.mjs
 *
 * The fake host below is deliberately thin — it records registrations and
 * exposes only the service seams the plugin actually reads, so a test that
 * passes here cannot be passing because of an over-helpful double.
 */

import assert from 'node:assert/strict'
import {
  apply,
  resolveConfig,
  projectionDefinition,
  derivePosture,
  unfinishedItems,
  withDefaultOptions,
  mapDriftAnswer,
  deferralMarkers,
  parseState,
} from './index.js'

const failures = []
/** Await every case: a synchronous throw must become a FAIL line, not a crash. */
const check = async (label, fn) => {
  try {
    await fn()
    console.log(`ok   ${label}`)
  } catch (error) {
    failures.push(`${label}: ${error.message}`)
    console.log(`FAIL ${label}: ${error.message}`)
  }
}

// ===================================================================== config ==

await check('config defaults resolve', () => {
  const resolved = resolveConfig(undefined)
  assert.equal(resolved.stepBudget, 30)
  assert.equal(resolved.maxCheckpointsPerTurn, 2)
  assert.equal(resolved.maxCheckpointMessages, 3)
  assert.equal(resolved.askAnchorAt, 2)
  assert.equal(resolved.requireCoverage, true)
  assert.equal(resolved.blockUnfinished, true)
})
await check('config rejects a zero step budget', () => {
  assert.throws(() => resolveConfig({ stepBudget: 0 }), /stepBudget/)
})
await check('config rejects a non-integer ask mark', () => {
  assert.throws(() => resolveConfig({ askAnchorAt: 1.5 }), /askAnchorAt/)
})
await check('config rejects a negative message ceiling', () => {
  assert.throws(() => resolveConfig({ maxCheckpointMessages: -1 }), /maxCheckpointMessages/)
})
await check('config rejects a non-boolean switch', () => {
  assert.throws(() => resolveConfig({ blockUnfinished: 'yes' }), /blockUnfinished/)
})
await check('config accepts explicit overrides', () => {
  const resolved = resolveConfig({
    stepBudget: 7,
    maxCheckpointsPerTurn: 1,
    maxCheckpointMessages: 0,
    askAnchorAt: 4,
    requireCoverage: false,
    blockUnfinished: false,
    reportDeferrals: false,
  })
  assert.equal(resolved.stepBudget, 7)
  assert.equal(resolved.askAnchorAt, 4)
  assert.equal(resolved.blockUnfinished, false)
})

// ================================================== JSON Schema subset shape ==
// Mirrors checkSchemaNode in @deepseek-ai/dsh-tools: single type strings, no
// type beside oneOf, required/properties/additionalProperties only on objects,
// and no keyword outside the supported subset.
const CONSTRAINT = new Set(['type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const'])
const ANNOTATION = new Set(['description', 'title', 'default', 'examples'])
const TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'])

function assertSchema(node, path = 'schema') {
  if (typeof node !== 'object' || node === null || Array.isArray(node)) {
    throw new Error(`${path} must be a schema object`)
  }
  for (const key of Object.keys(node)) {
    if (CONSTRAINT.has(key) || ANNOTATION.has(key)) continue
    throw new Error(`${path}.${key} is not a supported keyword`)
  }
  const hasType = Object.hasOwn(node, 'type')
  const hasOneOf = Object.hasOwn(node, 'oneOf')
  if (hasType && hasOneOf) throw new Error(`${path} cannot declare both type and oneOf`)
  if (hasOneOf) {
    if (!Array.isArray(node.oneOf) || node.oneOf.length < 2) throw new Error(`${path}.oneOf needs two branches`)
    for (const key of ['properties', 'required', 'additionalProperties', 'items', 'enum', 'const']) {
      if (Object.hasOwn(node, key)) throw new Error(`${path}.${key} is not supported beside oneOf`)
    }
    node.oneOf.forEach((branch, index) => assertSchema(branch, `${path}.oneOf[${index}]`))
    return
  }
  if (typeof node.type !== 'string' || !TYPES.has(node.type)) {
    throw new Error(Array.isArray(node.type)
      ? `${path}.type must be a single type string (type arrays are not supported)`
      : `${path}.type must be a supported type`)
  }
  const allowedFor = {
    properties: ['object'],
    required: ['object'],
    additionalProperties: ['object'],
    items: ['array'],
    enum: ['string', 'number', 'integer', 'boolean', 'null'],
    const: ['string', 'number', 'integer', 'boolean', 'null'],
  }
  for (const [key, types] of Object.entries(allowedFor)) {
    if (Object.hasOwn(node, key) && !types.includes(node.type)) {
      throw new Error(`${path}.${key} is not supported on type "${node.type}"`)
    }
  }
  if (node.type === 'object') {
    if (Object.hasOwn(node, 'additionalProperties') && typeof node.additionalProperties !== 'boolean') {
      throw new Error(`${path}.additionalProperties must be a boolean`)
    }
    if (Object.hasOwn(node, 'required')) {
      if (!Array.isArray(node.required) || node.required.some(entry => typeof entry !== 'string')) {
        throw new Error(`${path}.required must be an array of strings`)
      }
      const declared = typeof node.properties === 'object' && node.properties !== null ? node.properties : {}
      for (const key of node.required) {
        if (!Object.hasOwn(declared, key)) throw new Error(`${path}.required names "${key}" which is not in properties`)
      }
    }
    if (Object.hasOwn(node, 'properties')) {
      if (typeof node.properties !== 'object' || node.properties === null || Array.isArray(node.properties)) {
        throw new Error(`${path}.properties must be an object of schemas`)
      }
      for (const [key, child] of Object.entries(node.properties)) assertSchema(child, `${path}.properties.${key}`)
    }
  }
  if (node.type === 'array' && Object.hasOwn(node, 'items')) assertSchema(node.items, `${path}.items`)
}

// ================================================================= fake host ==

/**
 * Minimal service doubles. `roots` is the live root registry, so an authority
 * test can add and remove the exact agent object.
 */
function fakeHost(roots = []) {
  const registered = { tools: [], toolsByName: new Map(), sections: [], contexts: [], listeners: new Map() }
  let projection = null
  const ctx = {
    sessionProjections: {
      register(definition) {
        projection = definition
        return () => {}
      },
      stateOf: session => session.__state,
    },
    systemPrompt: {
      getSectionOrder: () => 1000,
      getContextOrder: () => 100,
      section: section => registered.sections.push(section),
      context: context => registered.contexts.push(context),
    },
    tools: {
      register(definition) {
        registered.tools.push(definition)
        registered.toolsByName.set(definition.name, definition)
      },
    },
    // The real host resolves `agents` as a service; a double that answered
    // `undefined` would make every root-agent check fail silently.
    get: key => (key === 'agents' ? { roots: () => roots } : undefined),
    on: (event, listener) => {
      const list = registered.listeners.get(event) ?? []
      list.push(listener)
      registered.listeners.set(event, list)
    },
  }
  return { ctx, registered, projectionOf: () => projection }
}

/** Install the plugin on a fresh host and return everything needed to drive it. */
function mount(config, roots = []) {
  const host = fakeHost(roots)
  apply(host.ctx, config)
  const projection = host.projectionOf()
  const fold = (events, state = projection.init()) =>
    events.reduce((current, event) => projection.apply(current, event), state)
  const sessionFor = (events) => {
    const log = [...events]
    const session = {
      __state: fold(log),
      snapshotEvents: () => log,
      push(event) {
        log.push(event)
        session.__state = projection.apply(session.__state, event)
        return event
      },
    }
    return session
  }
  const tool = name => host.registered.toolsByName.get(name)
  const call = async (name, args, exec = {}) => {
    const definition = host.registered.toolsByName.get(name)
    if (definition === undefined) throw new Error(`no tool ${name}`)
    const deferred = []
    const value = await definition.execute(args, {
      agent: exec.agent,
      signal: exec.signal,
      name,
      deferContext: message => deferred.push(message),
    })
    return { value, deferred, definition }
  }
  const listener = name => host.registered.listeners.get(name)?.[0]
  /**
   * Fold inside a real request. A contract is scoped to the human message that
   * launched the turn, so a fixture that commits one without that message is
   * testing a state the runtime cannot produce.
   */
  const foldInTurn = (events, state = projection.init(), request = 'Fix the parser.') =>
    fold([turnStart(), human(request), ...events], state)
  return { host, projection, fold, foldInTurn, sessionFor, tool, call, listener }
}

/** Normalize a synchronous throw or a rejection into the error, for both shapes. */
async function rejection(operation) {
  try {
    await operation()
  } catch (error) {
    return error
  }
  return undefined
}

// ==================================================================== events ==

let seq = 0
const nextSeq = () => (seq += 1)
const human = (text, turn = 1) => ({
  type: 'user/message',
  seq: nextSeq(),
  time: Date.now(),
  data: { role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' }, turn },
})
const guardContext = (text) => ({
  type: 'user/message',
  seq: nextSeq(),
  time: Date.now(),
  data: { role: 'user', content: [{ type: 'text', text }], source: { kind: 'drift-guard', form: 'notice', summary: 'x' } },
})
const assistant = (text) => ({
  type: 'assistant/message',
  seq: nextSeq(),
  time: Date.now(),
  data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text }] }, stream: [] },
})
const step = (turn = 1) => ({ type: 'step/start', seq: nextSeq(), time: Date.now(), data: { turn, step: 1 } })
const toolCall = (name, args) => ({
  type: 'tool/call',
  seq: nextSeq(),
  time: Date.now(),
  data: { turn: 1, step: 1, callId: `c${seq}`, name, arguments: JSON.stringify(args) },
})
const turnStart = (turn = 1) => ({ type: 'turn/start', seq: nextSeq(), time: Date.now(), data: { turn } })
const turnEnd = (turn = 1) => ({
  type: 'turn/end',
  seq: nextSeq(),
  time: Date.now(),
  data: { turn, reason: { kind: 'completed' } },
})

const setArgs = (over = {}) => ({
  action: 'set',
  objective: 'Ship the drift guard',
  done_when: 'node check.mjs is green',
  ...over,
})

// ================================================================== the fold ==

await check('a human message becomes the baseline; guard context does not move it', () => {
  const { fold, foldInTurn } = mount()
  const state = fold([guardContext('notice'), human('Fix the parser.')])
  assert.equal(state.baseline.text, 'Fix the parser.')
})
await check('guard context records the one-shot ask mark for the request', () => {
  const { fold, foldInTurn } = mount()
  const request = human('Do A.')
  const state = fold([request, step(), guardContext('drift-guard: no contract')])
  assert.equal(state.askedAnchorAtTurn, request.seq, 'the mark is the request key, not a step count')
})
await check('the ask mark is per request, so a new request can be asked again', () => {
  const { fold, foldInTurn } = mount()
  const first = human('Do A.')
  const second = human('Do B instead.', 2)
  const state = fold([
    first, step(), guardContext('drift-guard: no contract'),
    turnEnd(), turnStart(2), second,
  ])
  assert.equal(state.askedAnchorAtTurn, first.seq, 'the earlier mark survives until a new ask')
  const after = fold([step(2), guardContext('drift-guard: no contract')], state)
  assert.equal(after.askedAnchorAtTurn, second.seq, 'a new request gets its own ask')
})
await check('a later human message supersedes the earlier baseline', () => {
  const { fold, foldInTurn } = mount()
  const state = fold([human('Do A.'), turnEnd(), turnStart(2), human('Do B instead.', 2)])
  assert.equal(state.baseline.text, 'Do B instead.')
})
await check('steps and turn are tracked', () => {
  const { fold, foldInTurn } = mount()
  const state = fold([step(1), step(1), step(2)])
  assert.equal(state.steps, 3)
  assert.equal(state.turn, 2)
})
await check('a contract commit records every field with revision 1', () => {
  const { fold, foldInTurn } = mount()
  const state = foldInTurn([step(), toolCall('drift_anchor', setArgs({
    must_deliver: ['core', 'tests'],
    must_preserve: ['public API'],
    out_of_scope: ['redesign'],
    main_paths: ['src'],
    user_decisions: ['keep it local'],
    open_direction_decisions: ['sync later?'],
    step_budget: 9,
  }))])
  const c = state.contract
  assert.equal(c.revision, 1)
  assert.equal(c.objective, 'Ship the drift guard')
  assert.deepEqual(c.mustDeliver, ['core', 'tests'])
  assert.deepEqual(c.mustPreserve, ['public API'])
  assert.deepEqual(c.outOfScope, ['redesign'])
  assert.deepEqual(c.mainPaths, ['src'])
  assert.deepEqual(c.userDecisions, ['keep it local'])
  assert.deepEqual(c.openDirectionDecisions, ['sync later?'])
  assert.equal(c.budget, 9)
})
await check('a second commit bumps the revision and clears the coverage ledger', () => {
  const { fold, foldInTurn } = mount()
  const state = foldInTurn([
    step(), toolCall('drift_anchor', setArgs({ must_deliver: ['core'] })),
    toolCall('drift_anchor', { action: 'coverage', item: 'core', state: 'complete' }),
    toolCall('drift_anchor', setArgs({ objective: 'Ship it properly', must_deliver: ['core', 'docs'] })),
  ])
  assert.equal(state.contract.revision, 2)
  assert.deepEqual(state.coverage, {}, 'coverage verdicts about the old set must not survive')
})
await check('action "get" never rewrites the contract', () => {
  const { fold, foldInTurn } = mount()
  const state = foldInTurn([toolCall('drift_anchor', setArgs({ objective: 'A' })),
    toolCall('drift_anchor', { action: 'get' }),
  ])
  assert.equal(state.contract.objective, 'A')
  assert.equal(state.contract.revision, 1)
})
await check('a malformed commit is ignored, not half-applied', () => {
  const { fold, foldInTurn } = mount()
  assert.equal(foldInTurn([toolCall('drift_anchor', { action: 'set', objective: 'A' })]).contract, null)
})
await check('unparseable arguments are ignored rather than throwing', () => {
  const { fold, foldInTurn } = mount()
  const state = foldInTurn([
    { type: 'tool/call', seq: nextSeq(), time: 1, data: { callId: 'c', name: 'drift_anchor', arguments: '{"action":' } },
    { type: 'tool/call', seq: nextSeq(), time: 2, data: { callId: 'c2', name: 'other', arguments: 'nope' } },
  ])
  assert.equal(state.contract, null)
})
await check('the log\'s string arguments are what carries the contract across turns', () => {
  // Regression: folding `arguments` as an object instead of parsing the log's
  // JSON string made every commitment evaporate at the turn boundary.
  const { fold, foldInTurn } = mount()
  const state = fold([
    turnStart(), human('Fix the login bug.'), step(), toolCall('drift_anchor', setArgs()),
    turnEnd(), turnStart(2), human('carry on', 2), step(2),
  ])
  // The commitment survives as history; it is NOT enforced against the new
  // request — exactly the per-turn scoping that the live run exposed as missing.
  assert.equal(state.contract, null, 'a new request starts with no contract of its own')
  assert.equal(state.contractTurn, null)
  assert.equal(state.contractHistory.length, 1)
  assert.equal(state.contractHistory[0].objective, 'Ship the drift guard')
  assert.deepEqual(unfinishedItems(state), [], 'a stale contract gates nothing')
})
await check('uninteresting events keep the same reference', () => {
  const { fold, projection } = mount()
  const state = fold([human('Do A.')])
  const ignored = { type: 'assistant/message', seq: nextSeq(), time: 1, data: { message: { content: [] } } }
  assert.equal(projection.apply(state, ignored), state)
})
await check('persisted state round-trips through the schema', () => {
  const { fold, foldInTurn, projection } = mount()
  const state = foldInTurn([
    step(),
    toolCall('drift_anchor', setArgs({ must_deliver: ['a'] })),
    toolCall('drift_anchor', { action: 'coverage', item: 'a', state: 'partial' }),
  ])
  const parsed = parseState(JSON.parse(JSON.stringify(state)))
  assert.deepEqual(parsed, state)
})
await check('garbage persisted state falls back to a clean state', () => {
  const clean = parseState({ steps: 'nope', contract: 7, coverage: 3 })
  assert.equal(clean.contract, null)
  assert.equal(clean.steps, 0)
  assert.deepEqual(clean.coverage, {})
})
await check('a coverage verdict for an unknown item is dropped by the schema', () => {
  const clean = parseState({ coverage: { a: 'complete', b: 'nonsense' } })
  assert.deepEqual(clean.coverage, { a: 'complete' })
})

// ================================================================== the gates ==

await check('coverage: complete and waived count as delivered', () => {
  const { fold, foldInTurn } = mount()
  const state = foldInTurn([toolCall('drift_anchor', setArgs({ must_deliver: ['a', 'b', 'c'] })),
    toolCall('drift_anchor', { action: 'coverage', item: 'a', state: 'complete' }),
    toolCall('drift_anchor', { action: 'coverage', item: 'b', state: 'waived' }),
    toolCall('drift_anchor', { action: 'coverage', item: 'c', state: 'partial' }),
  ])
  const unfinished = unfinishedItems(state)
  assert.equal(unfinished.length, 1)
  assert.equal(unfinished[0].item, 'c')
  assert.equal(unfinished[0].verdict, 'partial')
})
await check('coverage: an item with no verdict is unreported, not complete', () => {
  const { fold, foldInTurn } = mount()
  const state = foldInTurn([toolCall('drift_anchor', setArgs({ must_deliver: ['a'] }))])
  assert.deepEqual(unfinishedItems(state), [{ item: 'a', verdict: 'unreported' }])
})
await check('coverage: no must-deliver items means nothing is unfinished', () => {
  const { fold, foldInTurn } = mount()
  const state = foldInTurn([toolCall('drift_anchor', setArgs())])
  assert.deepEqual(unfinishedItems(state), [])
})

await check('posture: no contract is unknown', () => {
  const { fold, foldInTurn } = mount()
  assert.equal(derivePosture(fold([])), 'unknown')
})
await check('posture: a contract with nothing pending is aligned', () => {
  const { fold, foldInTurn } = mount()
  assert.equal(derivePosture(foldInTurn([toolCall('drift_anchor', setArgs())])), 'aligned')
})
await check('posture: a drift report with no decision is drift-pending', () => {
  const { fold, foldInTurn } = mount()
  const state = foldInTurn([toolCall('drift_anchor', setArgs()),
    toolCall('drift_report', { action: 'report', reason: 'scope-expansion', description: 'also refactor X' }),
  ])
  assert.equal(derivePosture(state), 'drift-pending')
})
await check('posture: an approval with no new contract is baseline-update-pending', () => {
  const { fold, foldInTurn } = mount()
  const state = foldInTurn([toolCall('drift_anchor', setArgs()),
    toolCall('drift_report', { action: 'report', reason: 'scope-expansion', description: 'also refactor X' }),
    toolCall('drift_report', { action: 'decide', decision: 'approve' }),
  ])
  assert.equal(derivePosture(state), 'baseline-update-pending',
    'an approved direction that was never committed must not read as aligned')
})
await check('posture: committing the new contract settles it back to aligned', () => {
  const { fold, foldInTurn } = mount()
  const state = foldInTurn([toolCall('drift_anchor', setArgs()),
    toolCall('drift_report', { action: 'report', reason: 'scope-expansion', description: 'also refactor X' }),
    toolCall('drift_report', { action: 'decide', decision: 'approve' }),
    toolCall('drift_anchor', setArgs({ objective: 'Ship it plus the refactor' })),
  ])
  assert.equal(derivePosture(state), 'aligned')
  assert.equal(state.contract.revision, 2)
})
await check('posture: a rejection settles the drift without a new contract', () => {
  const { fold, foldInTurn } = mount()
  const state = foldInTurn([toolCall('drift_anchor', setArgs()),
    toolCall('drift_report', { action: 'report', reason: 'scope-expansion', description: 'x' }),
    toolCall('drift_report', { action: 'decide', decision: 'reject' }),
  ])
  assert.equal(derivePosture(state), 'aligned')
})
await check('drift reports are counted and the last one is kept', () => {
  const { fold, foldInTurn } = mount()
  const state = foldInTurn([toolCall('drift_report', { action: 'report', reason: 'architecture-shift', description: 'first' }),
    toolCall('drift_report', { action: 'report', reason: 'data-model-change', description: 'second' }),
  ])
  assert.equal(state.driftCount, 2)
  assert.equal(state.drift.reason, 'data-model-change')
  assert.equal(state.drift.description, 'second')
})

await check('deferral markers: English phrasing is detected', () => {
  assert.ok(deferralMarkers('I built a minimal version for now.').length >= 2)
  assert.ok(deferralMarkers('The rest is deferred to a follow-up.').length >= 2)
  assert.ok(deferralMarkers('This part is not implemented yet.').length >= 1)
})
await check('deferral markers: Chinese phrasing is detected', () => {
  // One pattern deliberately covers every Chinese marker, so a single hit is
  // the expected result — the point is that the language is covered at all.
  assert.ok(deferralMarkers('先做一个精简版，其余的后续再说。').length >= 1)
  assert.ok(deferralMarkers('这部分暂未实现，留待下一步。').length >= 1)
})
await check('deferral markers: ordinary progress text is not flagged', () => {
  assert.equal(deferralMarkers('Tests pass and the module is wired.').length, 0)
})
await check('deferral detection is off by default and records nothing', () => {
  // Measured decision: three live runs produced three false positives of the
  // same kind (the guard's own policy text, a README excerpt, and the guard's
  // opening line quoted back), so the fold stays inert unless a deployment
  // opts back in.
  const { fold, foldInTurn } = mount()
  const state = foldInTurn([assistant('I implemented a minimal version for now.'), assistant('Same again.')])
  assert.equal(state.deferrals.length, 0, 'the default must record nothing')
})
await check('deferral detection records when explicitly enabled', () => {
  const { fold, foldInTurn } = mount({ reportDeferrals: true })
  const state = foldInTurn([assistant('I implemented a minimal version for now.')])
  assert.ok(state.deferrals.length >= 1, 'the opt-in path still works')
  assert.equal(new Set(state.deferrals).size, state.deferrals.length, 'markers must not duplicate')
})
await check('deferral recording is scoped to the request', () => {
  const { fold } = mount({ reportDeferrals: true })
  const first = turnStart()
  const state = fold([
    first, human('Fix the parser.'),
    assistant('I implemented a minimal version for now.'),
    turnEnd(), turnStart(2), human('Now do something else.', 2),
  ])
  assert.equal(state.deferrals.length, 0, 'a new request is not stained by the previous one')
})
await check('deferral recording does not fire on discussion about deferring', () => {
  const { fold, foldInTurn } = mount({ reportDeferrals: true })
  const state = foldInTurn([
    assistant('I added a deferral detector to the plugin. It flags phrases like minimal version and for now.'),
  ])
  assert.equal(state.deferrals.length, 0, 'explaining the rule is not breaking it')
})

// =============================================================== answer mapping ==

await check('option guard: the two default directions are always present', () => {
  const presented = withDefaultOptions([{ label: 'Do it in two passes' }])
  const labels = presented.map(option => option.label)
  assert.equal(presented.length, 3)
  assert.ok(labels.includes('Approve the direction change'))
  assert.ok(labels.includes('Stay within the current scope'))
})
await check('option guard: a model relabelling cannot remove a default', () => {
  const presented = withDefaultOptions([
    { label: 'Approve the direction change' },
    { label: 'Stay within the current scope' },
  ])
  assert.equal(presented.length, 2, 'dedupe by label must not duplicate a default')
})
await check('answer mapping: free text is a revision carrying the user\'s own words', () => {
  const mapped = mapDriftAnswer([], '  do it but keep the API  ', withDefaultOptions([]))
  assert.equal(mapped.decision, 'revise')
  assert.equal(mapped.note, 'do it but keep the API')
})
await check('answer mapping: the default approve label maps to approve', () => {
  assert.equal(mapDriftAnswer(['Approve the direction change'], undefined, withDefaultOptions([])).decision, 'approve')
})
await check('answer mapping: the default reject label maps to reject', () => {
  assert.equal(mapDriftAnswer(['Stay within the current scope'], undefined, withDefaultOptions([])).decision, 'reject')
})
await check('answer mapping: a chosen model option is a revision, never a rejection', () => {
  const presented = withDefaultOptions([{ label: 'Two passes' }])
  const mapped = mapDriftAnswer(['Two passes'], undefined, presented)
  assert.equal(mapped.decision, 'revise')
  assert.equal(mapped.note, 'Two passes')
})
await check('answer mapping: no selection throws instead of guessing', () => {
  assert.throws(() => mapDriftAnswer([], undefined, withDefaultOptions([])), /without a selection/)
})
await check('answer mapping: several selections throw', () => {
  assert.throws(
    () => mapDriftAnswer(['Approve the direction change', 'Stay within the current scope'], undefined, withDefaultOptions([])),
    /exactly one/,
  )
})
await check('answer mapping: an unknown label throws instead of recording a rejection', () => {
  assert.throws(
    () => mapDriftAnswer(['Do something else entirely'], undefined, withDefaultOptions([])),
    /not one of the presented options/,
  )
})

// ================================================================== the tools ==

await check('the plugin registers two tools, one section, one context, two listeners', () => {
  const { host } = mount()
  assert.deepEqual(host.registered.tools.map(t => t.name).sort(), ['drift_anchor', 'drift_report'])
  assert.equal(host.registered.sections.length, 1)
  assert.equal(host.registered.contexts.length, 1)
  assert.equal(host.registered.listeners.get('tools/post-execute').length, 1)
  assert.equal(host.registered.listeners.get('agent/turn-stopping').length, 1)
})
await check('both tool schemas are inside the enforced JSON Schema subset', () => {
  const { host } = mount()
  for (const definition of host.registered.tools) {
    assertSchema(definition.parameters, `${definition.name}.parameters`)
    assertSchema(definition.output.schema, `${definition.name}.output`)
  }
})
await check('every declared output property is required', () => {
  const { host } = mount()
  for (const definition of host.registered.tools) {
    const schema = definition.output.schema
    assert.deepEqual([...schema.required].sort(), Object.keys(schema.properties).sort(), definition.name)
  }
})

await check('drift_anchor refuses "set" without a direct human turn', async () => {
  // A root agent with an open turn that carries no human message: the contract
  // is not the agent's to write on its own.
  const roots = []
  const { call, sessionFor } = mount(undefined, roots)
  const agent = { session: sessionFor([turnStart(), guardContext('a guard notice, not a human')]), id: 'a' }
  roots.push(agent)
  const error = await rejection(() => call('drift_anchor', setArgs(), { agent }))
  assert.match(error?.message ?? '', /direct human turn/)
})
await check('drift_anchor refuses "set" outright for a delegated agent', async () => {
  const roots = []
  const { call, sessionFor } = mount(undefined, roots)
  const agent = { session: sessionFor([turnStart(), human('Fix it.')]), id: 'child' }
  const error = await rejection(() => call('drift_anchor', setArgs(), { agent }))
  assert.match(error?.message ?? '', /delegated agent/)
})
await check('drift_anchor records the contract and defers the checklist', async () => {
  const roots = []
  const { call, sessionFor } = mount(undefined, roots)
  const agent = { session: sessionFor([turnStart(), human('Fix it.')]), id: 'a' }
  roots.push(agent)
  const { value, deferred } = await call('drift_anchor', setArgs({ must_deliver: ['core', 'tests'] }), { agent })
  assert.equal(value.action, 'set')
  assert.equal(value.contract.revision, 1)
  assert.equal(value.posture, 'aligned')
  assert.deepEqual(value.coverage.items, ['core [unreported]', 'tests [unreported]'])
  assert.equal(value.coverage.unreported, 2)
  assert.equal(value.unfinished.length, 2)
  assert.equal(deferred.length, 1, 'the contract must be recorded in the transcript')
  assert.match(deferred[0].content[0].text, /Coverage ledger opened for 2 item\(s\)/)
})
await check('drift_anchor rejects an incomplete "set"', async () => {
  const roots = []
  const { call, sessionFor } = mount(undefined, roots)
  const agent = { session: sessionFor([turnStart(), human('x')]), id: 'a' }
  roots.push(agent)
  const error = await rejection(() => call('drift_anchor', { action: 'set', objective: 'A' }, { agent }))
  assert.match(error?.message ?? '', /done_when is required/)
})
await check('drift_anchor rejects an unknown action', async () => {
  const roots = []
  const { call, sessionFor } = mount(undefined, roots)
  const agent = { session: sessionFor([turnStart(), human('x')]), id: 'a' }
  roots.push(agent)
  const error = await rejection(() => call('drift_anchor', { action: 'nope' }, { agent }))
  assert.match(error?.message ?? '', /action must be/)
})
await check('drift_anchor requires a calling agent', async () => {
  const { call } = mount()
  const error = await rejection(() => call('drift_anchor', { action: 'get' }, {}))
  assert.match(error?.message ?? '', /requires a calling agent/)
})
await check('drift_anchor "coverage" needs a contract first', async () => {
  const roots = []
  const { call, sessionFor } = mount(undefined, roots)
  const agent = { session: sessionFor([turnStart(), human('x')]), id: 'a' }
  roots.push(agent)
  const error = await rejection(() => call('drift_anchor', { action: 'coverage', item: 'core', state: 'complete' }, { agent }))
  assert.match(error?.message ?? '', /no contract is committed yet/)
})
await check('drift_anchor "coverage" refuses an item the contract never owed', async () => {
  const roots = []
  const { call, sessionFor } = mount(undefined, roots)
  const agent = { session: sessionFor([turnStart(), human('x')]), id: 'a' }
  roots.push(agent)
  await call('drift_anchor', setArgs({ must_deliver: ['core'] }), { agent })
  agent.session.push(toolCall('drift_anchor', setArgs({ must_deliver: ['core'] })))
  const error = await rejection(() => call('drift_anchor', { action: 'coverage', item: 'other', state: 'complete' }, { agent }))
  assert.match(error?.message ?? '', /is not one of the must-deliver items/)
})
await check('drift_anchor "coverage" rejects a nonsense verdict', async () => {
  const roots = []
  const { call, sessionFor } = mount(undefined, roots)
  const agent = { session: sessionFor([turnStart(), human('x')]), id: 'a' }
  roots.push(agent)
  const error = await rejection(() => call('drift_anchor', { action: 'coverage', item: 'core', state: 'mostly' }, { agent }))
  assert.match(error?.message ?? '', /state must be one of/)
})

await check('drift_report refuses a delegated agent', async () => {
  const roots = []
  const { call, sessionFor } = mount(undefined, roots)
  const agent = { session: sessionFor([turnStart(), human('x')]), id: 'child' }
  const error = await rejection(() => call('drift_report', {
    action: 'report', reason: 'scope-expansion', description: 'more',
  }, { agent }))
  assert.match(error?.message ?? '', /delegated agent/)
})
await check('drift_report validates the taxonomy', async () => {
  const roots = []
  const { call, sessionFor } = mount(undefined, roots)
  const agent = { session: sessionFor([turnStart(), human('x')]), id: 'a' }
  roots.push(agent)
  const error = await rejection(() => call('drift_report', {
    action: 'report', reason: 'made-up-reason', description: 'more',
  }, { agent }))
  assert.match(error?.message ?? '', /reason must be one of/)
})
await check('drift_report with no question channel refuses to decide for the user', async () => {
  const roots = []
  const { call, sessionFor } = mount(undefined, roots)
  const agent = { session: sessionFor([turnStart(), human('x')]), id: 'a' }
  roots.push(agent)
  const { value } = await call('drift_report', {
    action: 'report', reason: 'incomplete-delivery', description: 'ship less',
  }, { agent })
  assert.equal(value.decision, 'unanswered')
  assert.match(value.outcome, /No question channel is available/)
})

/** A host whose question service returns one scripted answer. */
function mountWithAnswer(answer, config) {
  const roots = []
  const host = fakeHost(roots)
  const asked = []
  const baseGet = host.ctx.get
  host.ctx.get = (key) => {
    if (key === 'userQuestions') {
      return {
        ask: async (request) => {
          asked.push(request)
          return answer
        },
      }
    }
    return baseGet(key)
  }
  apply(host.ctx, config)
  const projection = host.projectionOf()
  const log = []
  const session = {
    __state: projection.init(),
    snapshotEvents: () => log,
    push(event) {
      log.push(event)
      session.__state = projection.apply(session.__state, event)
      return event
    },
  }
  const agent = { session, id: 'a' }
  roots.push(agent)
  const definition = host.registered.toolsByName.get('drift_report')
  const run = async (args) => {
    const deferred = []
    const value = await definition.execute(args, {
      agent, name: 'drift_report', signal: undefined, deferContext: message => deferred.push(message),
    })
    return { value, deferred }
  }
  return { agent, session, run, asked, host }
}

await check('drift_report asks with the defaults always appended', async () => {
  const { run, asked } = mountWithAnswer({ answers: [{ id: 'x', selected: ['Approve the direction change'] }] }, { autoDrift: false })
  const { value } = await run({
    action: 'report',
    reason: 'incomplete-delivery',
    description: 'ship a subset',
    options: [{ label: 'Only the parser' }],
  })
  assert.equal(asked.length, 1)
  const labels = asked[0].questions[0].options.map(option => option.label)
  assert.equal(labels.length, 3, 'model option plus both defaults')
  assert.ok(labels.includes('Stay within the current scope'))
  assert.equal(value.decision, 'approve')
  assert.match(value.outcome, /Commit the new contract/)
})
await check('drift_report records the decision as deferred context', async () => {
  const { run } = mountWithAnswer({ answers: [{ id: 'x', selected: [], custom: 'do it in two passes' }] }, { autoDrift: false })
  const { value, deferred } = await run({
    action: 'report', reason: 'scope-expansion', description: 'more',
  })
  assert.equal(value.decision, 'revise')
  assert.equal(value.note, 'do it in two passes')
  assert.equal(deferred.length, 1)
  assert.match(deferred[0].content[0].text, /decision: revise \(do it in two passes\)/)
})
await check('drift_report returns "unanswered" for an uninterpretable answer and records nothing', async () => {
  const { run } = mountWithAnswer({ answers: [{ id: 'x', selected: [], custom: '' }] }, { autoDrift: false })
  const { value, deferred } = await run({
    action: 'report', reason: 'scope-expansion', description: 'more',
  })
  assert.equal(value.decision, 'unanswered')
  assert.match(value.outcome, /could not be interpreted/)
  assert.equal(deferred.length, 0, 'an uninterpretable answer must not become durable state')
})
await check('drift_report stops when the question service throws', async () => {
  const roots = []
  const host = fakeHost(roots)
  const baseGet = host.ctx.get
  host.ctx.get = key => (key === 'userQuestions'
    ? { ask: async () => { throw new Error('cancelled') } }
    : baseGet(key))
  apply(host.ctx, {})
  const projection = host.projectionOf()
  const session = { __state: projection.init(), snapshotEvents: () => [], push() {} }
  const agent = { session, id: 'a' }
  roots.push(agent)
  const definition = host.registered.toolsByName.get('drift_report')
  const value = await definition.execute(
    { action: 'report', reason: 'scope-expansion', description: 'more' },
    { agent, name: 'drift_report', deferContext() {} },
  )
  assert.equal(value.decision, 'unanswered')
})

// ============================================================ the live gates ==

/** Drive one agent through the post-execute and turn-stopping listeners. */
async function drive(config) {
  const roots = []
  const { host, projection, listener } = mount(config, roots)
  const log = [turnStart(), human('Fix the login bug.')]
  const session = {
    __state: log.reduce((current, event) => projection.apply(current, event), projection.init()),
    snapshotEvents: () => log,
    push(event) {
      log.push(event)
      session.__state = projection.apply(session.__state, event)
      return event
    },
  }
  const agent = { session, id: 'a' }
  roots.push(agent)
  const steered = []
  // Real steering enters the session as a message, which is exactly how the
  // one-shot ask mark becomes durable state; a double that only records the
  // call would hide that.
  agent.steer = (message) => {
    steered.push(message)
    session.push({
      type: 'user/message',
      seq: (seq += 1),
      time: Date.now(),
      data: { role: 'user', content: message.content, source: message.source, turn: session.__state.turn },
    })
  }
  const postExecute = listener('tools/post-execute')
  const turnStopping = listener('agent/turn-stopping')
  const commit = async (args) => {
    const definition = host.registered.toolsByName.get('drift_anchor')
    const value = await definition.execute(args, { agent, name: 'drift_anchor', deferContext() {} })
    session.push(toolCall('drift_anchor', args))
    return value
  }
  const report = async (args) => {
    const definition = host.registered.toolsByName.get('drift_report')
    const value = await definition.execute(args, { agent, name: 'drift_report', deferContext() {} })
    session.push(toolCall('drift_report', args))
    return value
  }
  const coverage = async (item, state) => {
    const definition = host.registered.toolsByName.get('drift_anchor')
    const args = { action: 'coverage', item, state }
    const value = await definition.execute(args, { agent, name: 'drift_anchor', deferContext() {} })
    session.push(toolCall('drift_anchor', args))
    return value
  }
  /** Fold `count` steps through post-execute and return the last decision. */
  const advance = async (count, name = 'read') => {
    let last
    for (let index = 0; index < count; index += 1) {
      session.push(step())
      last = await postExecute({ name, agent }, {}, () => Promise.resolve({ kind: 'enter', messages: [] }))
    }
    return last
  }
  return { host, projection, session, agent, steered, commit, report, coverage, advance, turnStopping, postExecute }
}

await check('gate: an unfinished item is steered at turn end', async () => {
  const d = await drive({})
  await d.commit(setArgs({ must_deliver: ['core', 'tests'] }))
  d.turnStopping({ agent: d.agent })
  assert.equal(d.steered.length, 1)
  assert.match(d.steered[0].content[0].text, /must-deliver items that are not proven complete/)
  assert.match(d.steered[0].content[0].text, /- core: unreported/)
})
await check('gate: a fully reported contract closes without a steer', async () => {
  const d = await drive({})
  await d.commit(setArgs({ must_deliver: ['core'] }))
  await d.coverage('core', 'complete')
  d.turnStopping({ agent: d.agent })
  assert.equal(d.steered.length, 0, 'a complete delivery must be able to close')
})
await check('gate: the unfinished steer is bounded by maxCheckpointsPerTurn', async () => {
  const d = await drive({ maxCheckpointsPerTurn: 1 })
  await d.commit(setArgs({ must_deliver: ['core'] }))
  d.turnStopping({ agent: d.agent })
  d.turnStopping({ agent: d.agent })
  d.turnStopping({ agent: d.agent })
  assert.equal(d.steered.length, 1)
})
await check('gate: blockUnfinished=false leaves the completeness gate off', async () => {
  const d = await drive({ blockUnfinished: false })
  await d.commit(setArgs({ must_deliver: ['core'] }))
  d.turnStopping({ agent: d.agent })
  assert.equal(d.steered.length, 0)
})
await check('gate: no contract is asked for exactly once', async () => {
  const d = await drive({ askAnchorAt: 2 })
  await d.advance(2)
  d.turnStopping({ agent: d.agent })
  assert.equal(d.steered.length, 1, 'the one-shot ask fires at the mark')
  assert.match(d.steered[0].content[0].text, /no committed contract/)
  d.turnStopping({ agent: d.agent })
  assert.equal(d.steered.length, 1, 'and never again')
})
await check('gate: no contract is not asked before the configured mark', async () => {
  const d = await drive({ askAnchorAt: 4 })
  await d.advance(2)
  d.turnStopping({ agent: d.agent })
  assert.equal(d.steered.length, 0)
})
await check('gate: the step budget forces a checkpoint message', async () => {
  const d = await drive({ stepBudget: 3 })
  await d.commit(setArgs({ must_deliver: ['core'] }))
  const silent = await d.advance(2)
  assert.equal(silent.additionalContexts, undefined, 'before the budget nothing is injected')
  const atBudget = await d.advance(1)
  assert.equal(atBudget.additionalContexts?.length, 1)
  assert.match(atBudget.additionalContexts[0].content[0].text, /step budget is spent/)
})
await check('gate: checkpoint messages stop at the lifetime ceiling', async () => {
  const d = await drive({ stepBudget: 1, maxCheckpointMessages: 2 })
  await d.commit(setArgs({ must_deliver: ['core'] }))
  await d.advance(1)
  await d.advance(1)
  const beyond = await d.advance(1)
  assert.equal(beyond.additionalContexts, undefined, 'the message ceiling holds')
})
await check('gate: a downstream block still carries the checkpoint', async () => {
  const d = await drive({ stepBudget: 1 })
  await d.commit(setArgs({ must_deliver: ['core'] }))
  await d.advance(1)
  d.session.push(step())
  const blocked = await d.postExecute({ name: 'read', agent: d.agent }, {}, () =>
    Promise.resolve({ kind: 'block', feedback: 'denied', additionalContexts: undefined }))
  assert.equal(blocked.kind, 'block')
  assert.equal(blocked.feedback, 'denied')
  assert.equal(blocked.additionalContexts.length, 1)
})
await check('gate: the budget checkpoint names the unfinished items', async () => {
  const d = await drive({ stepBudget: 2 })
  await d.commit(setArgs({ must_deliver: ['core'] }))
  const result = await d.advance(2)
  assert.match(result.additionalContexts[0].content[0].text, /Unfinished must-deliver items:/)
  assert.match(result.additionalContexts[0].content[0].text, /- core: unreported/)
})
await check('gate: a finished ledger stops the budget checkpoint asking again', async () => {
  // Live-run regression: a long request that completed every item and recorded
  // every verdict was still nagged with "the step budget is spent" on each
  // further step, because the checkpoint never consulted the ledger. It asked
  // the agent to audit work that was already accounted for — pure noise, and
  // noise that trains the reader to ignore the guard.
  const d = await drive({ stepBudget: 2, maxCheckpointMessages: 3 })
  await d.commit(setArgs({ must_deliver: ['core'] }))
  const atBudget = await d.advance(2)
  assert.equal(atBudget.additionalContexts?.length, 1, 'the unfinished ledger legitimately triggers it')
  await d.coverage('core', 'complete')
  const afterDone = await d.advance(1)
  assert.equal(afterDone.additionalContexts, undefined, 'a finished ledger owes no audit')
  const later = await d.advance(1)
  assert.equal(later.additionalContexts, undefined, 'and it stays silent')
})
await check('gate: a waived-only ledger is finished too', async () => {
  const d = await drive({ stepBudget: 2 })
  await d.commit(setArgs({ must_deliver: ['a', 'b'] }))
  await d.advance(2)
  await d.coverage('a', 'complete')
  await d.coverage('b', 'waived')
  const afterDone = await d.advance(1)
  assert.equal(afterDone.additionalContexts, undefined, 'waived counts as delivered, so nothing is owed')
})

await check('gate: a new request does not inherit the previous request\'s message spend', async () => {
  // Live-run regression: the checkpoint memory was keyed on the contract, so a
  // turn that already spent its message ceiling starved the next request.
  const d = await drive({ stepBudget: 1, maxCheckpointMessages: 2 })
  await d.commit(setArgs({ must_deliver: ['core'] }))
  const first = await d.advance(1)
  assert.equal(first.additionalContexts?.length, 1, 'the first request spends allowance')
  // A new request arrives and commits its own contract with its own item.
  d.session.push(turnEnd())
  d.session.push(turnStart(2))
  d.session.push(human('Now do something else.', 2))
  await d.commit(setArgs({ objective: 'The second request', must_deliver: ['other'] }))
  const second = await d.advance(1)
  assert.equal(second.additionalContexts?.length, 1, 'the new request gets its own allowance')
})
await check('gate: steps from an earlier request do not count against the new budget', async () => {
  // Live-run regression: the budget used the whole-session step count, so it
  // was permanently over budget and the checkpoint fired on every turn.
  const d = await drive({ stepBudget: 5 })
  await d.advance(40)
  d.session.push(turnEnd())
  d.session.push(turnStart(2))
  d.session.push(human('A fresh request.', 2))
  await d.commit(setArgs({ must_deliver: ['core'] }))
  const early = await d.advance(2)
  assert.equal(early.additionalContexts, undefined, 'the new request starts with a full budget')
})
await check('gate: an unfinished item from an earlier request gates nothing', async () => {
  const d = await drive({})
  await d.commit(setArgs({ must_deliver: ['core'] }))
  d.session.push(turnEnd())
  d.session.push(turnStart(2))
  d.session.push(human('A different request.', 2))
  d.turnStopping({ agent: d.agent })
  assert.equal(d.steered.length, 0, 'the stale contract must not block the new request')
})

await check('posture: a stale contract reads as unknown, not aligned', () => {
  // Direct guard against "any contract counts". The previous request's contract
  // must be kept as history but NOT be in force, so a mutation that treats any
  // contract as in force turns this posture into 'aligned'.
  const { fold } = mount()
  const state = fold([
    turnStart(), human('Fix the parser.'), step(),
    toolCall('drift_anchor', setArgs()),
    turnEnd(), turnStart(2), human('Something else entirely.', 2),
  ])
  assert.equal(state.contractHistory.length, 1, 'the earlier contract is kept as history')
  assert.ok(state.contract === null || state.contractTurn !== state.turnKey, 'and is not in force')
  assert.equal(derivePosture(state), 'unknown', 'the new request has no contract of its own')
})
await check('an assistant record from another producer is not read as the agent', () => {
  const { fold } = mount()
  const state = fold([
    turnStart(), human('Fix the parser.'),
    {
      type: 'assistant/message',
      seq: nextSeq(),
      time: Date.now(),
      data: {
        turn: 1,
        step: 1,
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'I implemented a minimal version for now.' }],
          source: { kind: 'some-other-plugin' },
        },
        stream: [],
      },
    },
  ])
  assert.equal(state.deferrals.length, 0, 'only the model\'s own words count')
})
await check('gate: the same contract text in a new request still gets a checkpoint', async () => {
  // Direct guard against keying the checkpoint memory on the contract: a new
  // request that commits an identical contract is a NEW spend window. Both
  // requests owe an item, so under the correct keying both may checkpoint; the
  // buggy keying sees an unchanged contractSeq and suppresses the second one.
  const d = await drive({ stepBudget: 1, maxCheckpointMessages: 2 })
  const same = setArgs({ objective: 'Identical work', must_deliver: ['core'] })
  await d.commit(same)
  const first = await d.advance(1)
  assert.equal(first.additionalContexts?.length, 1, 'first request gets a checkpoint')
  d.session.push(turnEnd())
  d.session.push(turnStart(2))
  d.session.push(human('Do the identical thing again.', 2))
  await d.commit(same)
  const second = await d.advance(1)
  assert.equal(second.additionalContexts?.length, 1, 'the identical contract in a new request is a new window')
})

// ============================================================ prompt assembly ==

await check('the dynamic context is empty before a baseline exists', () => {
  const { host } = mount()
  const text = host.registered.contexts[0].text({ scope: { session: {} } })
  assert.equal(text, '')
})
await check('the dynamic context states the baseline, contract, coverage and posture', () => {
  const roots = []
  const { host, projection } = mount(undefined, roots)
  const session = {
    __state: projection.init(),
    snapshotEvents: () => [],
  }
  session.__state = projection.apply(session.__state, turnStart())
  session.__state = projection.apply(session.__state, human('Fix the login bug.'))
  session.__state = projection.apply(session.__state, step())
  session.__state = projection.apply(session.__state, toolCall('drift_anchor', setArgs({
    must_deliver: ['core'], must_preserve: ['public API'], user_decisions: ['stay local'],
  })))
  const text = host.registered.contexts[0].text({ scope: { session } })
  assert.match(text, /frozen by drift-guard/)
  assert.match(text, /must deliver: core/)
  assert.match(text, /must preserve: public API/)
  assert.match(text, /settled user decisions \(never re-ask, never silently reverse\): stay local/)
  assert.match(text, /coverage: core \[unreported\]/)
  assert.match(text, /posture: aligned/)
})
await check('the static policy forbids shipping a subset and names the tools', () => {
  const { host } = mount()
  const text = host.registered.sections[0].text
  assert.match(text, /Deliver the whole contract, not a labelled subset/)
  assert.match(text, /drift_anchor/)
  assert.match(text, /drift_report/)
  assert.match(text, /Difficulty, tedium, or length is never a reason to shrink the job/)
})

// ===================================================== full-auto resolution ==
// The user asked not to be interrupted. Auto mode decides only when the change
// is mechanically defensible, so every escalation path below is a gate that must
// keep working — an auto path that resolves one of these is silent drift.

/** Run one automatic resolution against a contract that owes two items. */
function autoCase(callArgs, stateOverrides = {}) {
  const roots = []
  const host = fakeHost(roots)
  const asked = []
  const baseGet = host.ctx.get
  host.ctx.get = key => (key === 'userQuestions'
    ? { ask: async (request) => { asked.push(request); return { answers: [{ id: 'x', selected: [], custom: '' }] } } }
    : baseGet(key))
  apply(host.ctx, { autoDrift: true, mutationBudget: 0.5 })
  const projection = host.projectionOf()
  let state = projection.init()
  for (const event of [turnStart(), human('Fix the login bug. Keep it local.'), step()]) {
    state = projection.apply(state, event)
  }
  state = projection.apply(state, toolCall('drift_anchor', setArgs({ must_deliver: ['a', 'b'] })))
  const session = { __state: { ...state, ...stateOverrides }, snapshotEvents: () => [] }
  const agent = { session, id: 'a' }
  roots.push(agent)
  const definition = host.registered.toolsByName.get('drift_report')
  const deferred = []
  return definition.execute(callArgs, { agent, name: 'drift_report', deferContext: m => deferred.push(m) })
    .then(value => ({ value, asked: asked.length, deferred }))
}

await check('auto: a cited extension resolves without asking the user', async () => {
  const { value, asked, deferred } = await autoCase({
    action: 'report',
    reason: 'scope-expansion',
    description: 'also cover the parser',
    basis: ['Fix the login bug.'],
    adds_deliverables: ['parser'],
  })
  assert.equal(value.decision, 'approve', 'a verbatim quote licenses the extension')
  assert.equal(asked, 0, 'and the user is not interrupted')
  assert.match(value.note, /^auto:/)
  assert.match(deferred[0].content[0].text, /WITHOUT asking you/)
  assert.match(deferred[0].content[0].text, /Fix the login bug\./, 'the quote is shown back')
})
await check('auto: a forged citation escalates instead of resolving', async () => {
  const { value, asked } = await autoCase({
    action: 'report',
    reason: 'scope-expansion',
    description: 'also rewrite the database layer',
    basis: ['also rewrite the database layer'],
  })
  assert.equal(asked, 1, 'a quote absent from the original request must escalate')
  assert.notEqual(value.decision, 'approve')
})
await check('auto: no citation at all escalates', async () => {
  const { asked } = await autoCase({
    action: 'report',
    reason: 'architecture-shift',
    description: 'swap the storage engine',
  })
  assert.equal(asked, 1)
})
await check('auto: a scope REDUCTION is never self-approved, even with a citation', async () => {
  const { value, asked } = await autoCase({
    action: 'report',
    reason: 'incomplete-delivery',
    description: 'ship only item a for now',
    basis: ['Fix the login bug.'],
    drops_deliverables: ['b'],
  })
  assert.equal(asked, 1, 'shrinking the job always asks')
  assert.notEqual(value.decision, 'approve')
})
await check('auto: dropping a deliverable escalates even without naming a reason', async () => {
  const { asked } = await autoCase({
    action: 'report',
    reason: 'scope-expansion',
    description: 'narrow what is owed',
    basis: ['Fix the login bug.'],
    drops_deliverables: ['b'],
  })
  assert.equal(asked, 1, 'the ledger owes b, so removing it is a reduction')
})
await check('auto: exceeding the cumulative budget escalates', async () => {
  const { asked } = await autoCase({
    action: 'report',
    reason: 'scope-expansion',
    description: 'add two more items to a two-item contract',
    basis: ['Fix the login bug.'],
    adds_deliverables: ['c', 'd'],
  })
  assert.equal(asked, 1, '2 additions against a 2-item contract exceeds a 0.5 budget')
})
await check('auto: a spent budget stays spent for the next decision', async () => {
  const { asked } = await autoCase({
    action: 'report',
    reason: 'scope-expansion',
    description: 'one more small item',
    basis: ['Fix the login bug.'],
    adds_deliverables: ['c'],
  }, { mutationRatio: 0.5 })
  assert.equal(asked, 1, 'the prior spend is what pushes it over')
})
await check('auto: off means every report asks the user', async () => {
  const roots = []
  const host = fakeHost(roots)
  const asked = []
  const baseGet = host.ctx.get
  let getCalls = []
  host.ctx.get = key => {
    getCalls.push(key)
    return key === 'userQuestions'
      ? { ask: async (request) => { asked.push(request); return { answers: [{ id: 'x', selected: [], custom: '' }] } } }
      : baseGet(key)
  }
  apply(host.ctx, { autoDrift: false })
  const projection = host.projectionOf()
  let state = projection.init()
  for (const event of [turnStart(), human('Fix the login bug.'), step()]) state = projection.apply(state, event)
  const session = { __state: state, snapshotEvents: () => [] }
  const agent = { session, id: 'a' }
  roots.push(agent)
  const value = await host.registered.toolsByName.get('drift_report').execute({
    action: 'report',
    reason: 'scope-expansion',
    description: 'also cover the parser',
    basis: ['Fix the login bug.'],
  }, { agent, name: 'drift_report', deferContext() {} })
  // What matters is that nothing self-resolved: with autoDrift off the tool must
  // route through the user, never approve on its own.
  assert.notEqual(value.decision, 'approve', 'with autoDrift off nothing self-resolves')
  assert.equal(value.note, '', 'and it carries no automatic note')
})

// ==================================================================== report ==

if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed:`)
  for (const failure of failures) console.error(`- ${failure}`)
  process.exitCode = 1
} else {
  console.log('\nall checks passed')
}
