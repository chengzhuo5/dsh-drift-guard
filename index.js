/**
 * Drift Guard — a dependency-free Host plugin for a Harness profile.
 *
 * Two failure modes, same shape: the agent quietly replaces what was asked for
 * with something more convenient.
 *
 * 1. **Drift.** A session starts from an explicit request, hits a problem, and
 *    silently substitutes whatever it is currently fixing. Nothing notices,
 *    because the objective lives only as one user message near the start of a
 *    long transcript, and the agent's own notes are free to redefine "done".
 * 2. **Shrinking the job.** The agent ships a labelled subset and calls it
 *    finished — "a minimal version", "deferred to a follow-up". Nothing
 *    notices either, because the missing part was never written down as
 *    something that was owed.
 *
 * Lineage: the contract model (baseline with constraints, must-preserve
 * behaviour, settled decisions), the drift taxonomy, the posture state machine
 * including its `baseline-update-pending` window, the answer-mapping
 * discipline, and the child-agent escalation rule are modelled on
 * `dsh-requirements-alignment` (MIT) after a source-level comparison. The
 * completeness mechanism is this plugin's own.
 *
 * Advisory everywhere except the gates: enrichment of the next request, never
 * a veto, so the guard cannot deadlock a session that is legitimately working.
 *
 * @module @local/dsh-drift-guard
 */

// ---------------------------------------------------------------- constants --

/** Closed steps after the contract is committed before a checkpoint is forced. */
const DEFAULT_STEP_BUDGET = 30

/** Forced checkpoints allowed per turn, so the guard itself cannot spin. */
const DEFAULT_MAX_CHECKPOINTS_PER_TURN = 2

/** Checkpoint messages allowed across one contract's lifetime, so the guard cannot become noise. */
const DEFAULT_MAX_CHECKPOINT_MESSAGES = 3

/** Bound on the verbatim baseline carried into the prompt, in characters. */
const BASELINE_MAX_CHARS = 2000

/** `notice` summaries are a one-line account; the harness bound is mirrored locally to stay dependency-free. */
const SUMMARY_MAX_CHARS = 120

/** Projection key owned by this plugin. */
const PROJECTION_KEY = 'driftGuard'

/** Model-facing contract tool. */
const ANCHOR_TOOL = 'drift_anchor'

/** Model-facing tool that records a cross-session lesson. */
const LESSON_TOOL = 'drift_lesson'

/** Model-facing read-only view of the stored lessons. */
const LESSONS_TOOL = 'drift_lessons'

/** Model-facing direction-change tool. */
const DRIFT_TOOL = 'drift_report'

/**
 * Model-facing read-only occupancy tool.
 *
 * Occupancy is exposed as a tool rather than injected as prompt text so the
 * prompt stays byte-stable: anything that changes inside the system prompt sits
 * at the front of the request and invalidates the provider's cached prefix.
 */
const USAGE_TOOL = 'drift_context_usage'

/** No parameters: reading occupancy has nothing to configure. */
const USAGE_PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  properties: {},
}

/** Occupancy reading. `available: false` carries the reason instead of a guess. */
const USAGE_VALUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['available', 'why', 'usedTokens', 'contextWindow', 'remainingTokens', 'percent', 'projected', 'summary', 'note'],
  properties: {
    available: { type: 'boolean', description: 'False when no trustworthy reading exists.' },
    why: { type: 'string', description: 'Why no reading exists. Empty when a reading is available: keep it out of the output in that case, which the declared optional wrapper allows.' },
    usedTokens: { type: 'number', description: 'Prompt-side tokens the next request would cost.' },
    contextWindow: { type: 'number' },
    remainingTokens: { type: 'number' },
    percent: { type: 'number' },
    projected: { type: 'boolean', description: 'True when this is the projected (not sampled) figure.' },
    summary: { type: 'string' },
    note: { type: 'string' },
  },
}

/** Closed-step mark at which an agent that never committed a contract is asked once. */
const DEFAULT_ASK_ANCHOR_AT = 2

/** Plugin name, tool source kind, and prompt-section prefix. */
import {
  LESSONS_FILE,
  LESSON_TRIGGERS,
  LESSON_TRIGGER_NAMES,
  activeLessons,
  lessonsForTriggers,
  loadLessons,
  recordLesson,
  renderLessons,
  renderReminder,
  triggersForCall,
} from './lessons.js'

export const name = 'drift-guard'

/**
 * Optional services: the plugin stays inactive in a profile lacking any of them
 * instead of throwing at load.
 */
export const inject = ['sessionProjections', 'systemPrompt', 'tools', 'agents']

/**
 * Finite drift taxonomy. A drift candidate is a *direction-level* change, never
 * a code-quality opinion. `incomplete-delivery` is the entry this plugin adds:
 * shipping a labelled subset of what the contract owed.
 */
const DRIFT_REASONS = [
  'scope-expansion',
  'constraint-conflict',
  'behavior-change',
  'architecture-shift',
  'data-model-change',
  'compatibility-change',
  'assumption-invalidated',
  'user-direction-change',
  'incomplete-delivery',
]

/** The two options the user must always be able to choose, whatever the model offers. */
const DEFAULT_DRIFT_OPTIONS = [
  {
    label: 'Approve the direction change',
    description: 'Updates the requirement baseline; the new direction is recorded and the work continues.',
  },
  {
    label: 'Stay within the current scope',
    description: 'Keeps the requirement baseline unchanged; find another approach or stop.',
  },
]

/** The default option that means "approve" and the one that means "reject". */
const APPROVE_LABEL = DEFAULT_DRIFT_OPTIONS[0].label
const REJECT_LABEL = DEFAULT_DRIFT_OPTIONS[1].label

/** Coverage verdicts for one must-deliver item. */
const COVERAGE_STATES = ['complete', 'partial', 'missing', 'waived']

// ============================ RSI SELF-TUNABLE POLICY (BEGIN) ================
// The ONLY region a self-improvement loop is allowed to rewrite. Everything in
// here is a THRESHOLD OR A FLAG: a number or boolean that changes behaviour
// without changing the meaning of the mechanism. That restriction is what makes
// self-modification auditable - the guard can tune its own sensitivity, but it
// can never redefine what counts as drift, weaken a gate, or touch the ledger.
//
// Enforcement lives in rsi.mjs and core.json:
//   - core.json pins the SHA-256 of every mechanism function below.
//   - The file outside this region is hashed too, so nothing else may move.
//   - An edit that changes any pinned hash is REJECTED, not warned about.
const POLICY = {
  stepBudget: 30,
  // Steps granted per plan item when a budget is derived from a todo list.
  budgetStepsPerItem: 4,
  // Steps withheld from a derived budget so the commit is not what gets cut.
  commitReserveSteps: 3,
  // Steps after which a long turn with no todo list at all is asked to plan.
  planBySteps: 8,
  maxCheckpointsPerTurn: 2,
  maxCheckpointMessages: 3,
  askAnchorAt: 2,
  reportDeferrals: false,
  mutationBudget: 0.5,
}
// ============================= RSI SELF-TUNABLE POLICY (END) =================

/** The verdicts that mean "a human agreed to ship without this". */
const AUTHORIZED_VERDICTS = ['complete', 'waived']

/** Mechanism functions a self-improvement loop must never rewrite. */
const FROZEN_CORE_NAMES = [
  'citedBasis',
  'autoResolution',
  'derivePosture',
  'unfinishedItems',
  'renderContract',
  'renderBaseline',
  'validateDriftArgs',
  'validateAnchorArgs',
]

/**
 * Reasons whose automatic resolution is a scope REDUCTION. Never self-approved,
 * even in full-auto mode: dropping a deliverable is the failure mode the ledger
 * exists to catch, and no citation can authorize it because the user never asked
 * for less.
 */
const REDUCING_REASONS = ['incomplete-delivery', 'constraint-conflict']

/**
 * Upper bound on the cumulative share of the contract that automatic decisions
 * may add before every further decision escalates to the user.
 *
 * The measure is a RATIO, not a count. Dividing by the current deliverable count
 * lets a larger contract absorb more individual additions, so "just one more
 * item" cannot accumulate without bound. Deliberately structural rather than a
 * semantic drift score: semantic scoring was measured to have no discriminative
 * power (see README), while counting declared items is exact.
 */
const DEFAULT_MUTATION_BUDGET = 0.5

// ------------------------------------------------------ automatic resolution --

/**
 * Gate A - citation authorization.
 *
 * Every self-resolved scope extension must quote the ORIGINAL request verbatim.
 * Quotes are checked as literal substrings of the baseline text, which the agent
 * cannot rewrite. Drifting therefore requires forging a quotation, and a forged
 * quotation is a visible failure rather than a silent one.
 */
function citedBasis(basis, baseline) {
  if (baseline === null || baseline.text.length === 0) return undefined
  const accepted = []
  for (const quote of basis) {
    const needle = quote.trim()
    if (needle.length < 3) continue
    if (baseline.text.includes(needle)) accepted.push(needle)
  }
  return accepted.length === 0 ? undefined : accepted
}

/** Human-readable reason a decision could not be self-resolved. */
function escalationReason(kind) {
  if (kind === 'reducing') {
    return 'this would REDUCE what the contract owes, and the user never asked for less'
  }
  if (kind === 'no-citation') {
    return 'no supplied quote appears verbatim in the original request, so this is a new goal rather '
      + 'than a licensed extension'
  }
  return 'the cumulative automatic-change budget for this request is spent'
}

/**
 * Gates B and C for one automatic resolution.
 *
 * B - scope may only grow: dropping a previously owed item is a reduction and
 *     escalates. Exact set membership, no judgement.
 * C - cumulative mutation budget as a RATIO of the contract's size.
 */
function autoResolution(state, resolved, args) {
  if (REDUCING_REASONS.includes(args.reason)) return { kind: 'reducing' }
  const contract = state.contract
  const added = strings(args.adds_deliverables)
  const dropped = strings(args.drops_deliverables)
  if (contract !== null && dropped.length > 0) {
    const owed = contract.mustDeliver.filter(item => dropped.includes(item))
    if (owed.length > 0) return { kind: 'reducing' }
  }
  const accepted = citedBasis(strings(args.basis), state.baseline)
  if (accepted === undefined) return { kind: 'no-citation' }
  const size = Math.max(1, contract?.mustDeliver.length ?? 1)
  const delta = added.length / size
  const prior = Number.isFinite(state.mutationRatio) ? state.mutationRatio : 0
  if (prior + delta > resolved.mutationBudget) return { kind: 'over-budget' }
  return { kind: 'allow', accepted, mutationDelta: delta }
}

/**
 * Deferral-phrase detection. **Off by default**, and this is a measured
 * decision rather than a conservative one.
 *
 * Three live runs produced three false positives of the same kind: the guard's
 * own policy text, a README excerpt, and the guard's opening line quoted back
 * in conversation were each read as the agent announcing that it would ship
 * less. Every rule added to suppress that class was bypassed by the next piece
 * of real prose. The conclusion matches the one `dsh-trajectory-anchor` reached
 * by measurement for its own statistical channels: prose-level signals about
 * intent have no discriminative power, because the corpus that matters is full
 * of text *discussing* the very thing being detected.
 *
 * Kept in the source, and switchable with `reportDeferrals: true`, for anyone
 * who wants to re-measure it on their own corpus. It only ever recorded; it
 * never gated anything, so leaving it off removes noise and no capability.
 */
const DEFERRAL_MARKERS = [
  // An explicit deferral.
  /\bdefer(?:red|ring)?\b/i,
  /\b(?:todo|fixme)\b\s*[::]/i,
  /\bnot (?:yet )?(?:implemented|wired|covered|handled|finished|done)\b/i,
  /\bunimplemented\b/i,
  // A named reduced deliverable.
  /\bminimal (?:version|implementation|viable product|effort)\b/i,
  /\b(?:a|one) (?:quick|small|simple) (?:version|pass|implementation)\b/i,
  /\bstub(?:bed)?\b/i,
  /\bplaceholder\b/i,
  /\bskeleton\b/i,
  /\bscaffold(?:ed|ing)?\b/i,
  // A deferral schedule.
  /\bfor now\b/i,
  /\b(?:later|follow[- ]?up|next (?:iteration|pass|step|time|phase|round))\b/i,
  /\bout of scope for (?:now|this|the moment)\b/i,
  /\b(?:rest|remainder|remaining work|the others?) (?:can|will|should) (?:come|follow|be done)\b/i,
  // Chinese equivalents: an explicit deferral, an unimplemented state, a named
  // reduced deliverable, or a deferral schedule.
  /(?:暂时|暂未|暂不|先不|先只|留待|以后再|先这样)/,
  /(?:未实现|尚未实现|没有实现|待实现|未完成|没有完成|未覆盖|没覆盖)/,
  /(?:简化版|精简版|最小实现|最小版本|占位|占位符|骨架|脚手架|桩|先做一个)/,
  /(?:后续|稍后|下一步|下一轮|下一版|下一步再做)/,
]

/**
 * Verbs that mark a sentence as a report of the agent's own work. A deferral is
 * recorded only when one of these sits in the same sentence as the marker, so
 * talk *about* deferring — the guard explaining itself, a rule being restated —
 * is not read as an announcement. Weakening this to a blacklist of
 * "meta" words was tried and failed: any keyword list long enough to catch
 * every explanation also swallows real announcements.
 */
const WORK_VERBS = /(?:\b(?:implement(?:ed|ing|s)?|built|build(?:ing)?|wrote|writ(?:ing|ten)|creat(?:ed|ing)|made|making|added|add(?:ing)?|ship(?:ped|ping)?|fix(?:ed|ing)?|updat(?:ed|ing)|refactor(?:ed|ing)?|defer(?:red|ring)?|stub(?:bed)?|scaffold(?:ed|ing)?|le(?:ft|aving)|skip(?:ped|ping)?|finish(?:ed|ing)?|cover(?:ed|ing)?)\b|(?:实现|做|完成|覆盖|处理|写|改|加|搭|留|跳过|提交|交付))/i

// ------------------------------------------------------------------- config --

/** Resolve and validate the row config. Misconfiguration fails loud at load. */
export function resolveConfig(config) {
  const raw = config ?? {}
  const resolved = {
    stepBudget: raw.stepBudget ?? POLICY.stepBudget,
    maxCheckpointsPerTurn: raw.maxCheckpointsPerTurn ?? POLICY.maxCheckpointsPerTurn,
    maxCheckpointMessages: raw.maxCheckpointMessages ?? POLICY.maxCheckpointMessages,
    askAnchorAt: raw.askAnchorAt ?? POLICY.askAnchorAt,
    requireCoverage: raw.requireCoverage ?? true,
    blockUnfinished: raw.blockUnfinished ?? true,
    reportDeferrals: raw.reportDeferrals ?? POLICY.reportDeferrals,
    autoDrift: raw.autoDrift ?? true,
    mutationBudget: raw.mutationBudget ?? POLICY.mutationBudget,
    // Where cross-session lessons live. Defaults to the working directory, which
    // is where a human would look for it.
    lessonsFile: raw.lessonsFile ?? LESSONS_FILE,
  }
  for (const key of ['stepBudget', 'askAnchorAt']) {
    const value = resolved[key]
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new Error(`drift-guard: ${key} must be an integer >= 1, got ${String(value)}`)
    }
  }
  for (const key of ['maxCheckpointsPerTurn', 'maxCheckpointMessages']) {
    const value = resolved[key]
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`drift-guard: ${key} must be a non-negative safe integer, got ${String(value)}`)
    }
  }
  for (const key of ['requireCoverage', 'blockUnfinished', 'reportDeferrals', 'autoDrift']) {
    if (typeof resolved[key] !== 'boolean') {
      throw new Error(`drift-guard: ${key} must be a boolean, got ${typeof resolved[key]}`)
    }
  }
  if (typeof resolved.lessonsFile !== 'string' || resolved.lessonsFile.length === 0) {
    throw new Error('drift-guard: lessonsFile must be a non-empty path')
  }
  return resolved
}

// ------------------------------------------------------------------ helpers --

/** Truncate a `notice` summary to the harness bound. */
function boundSummary(text) {
  const oneLine = text.replace(/\s+/g, ' ').trim()
  return oneLine.length <= SUMMARY_MAX_CHARS ? oneLine : `${oneLine.slice(0, SUMMARY_MAX_CHARS - 1)}…`
}

/** Cap the verbatim baseline without inventing content. */
function capBaseline(text) {
  const trimmed = text.trim()
  if (trimmed.length <= BASELINE_MAX_CHARS) return trimmed
  return `${trimmed.slice(0, BASELINE_MAX_CHARS)}\n… (${trimmed.length - BASELINE_MAX_CHARS} more characters omitted by drift-guard)`
}

/** Prefer a direct request over a greeting preamble, without rewriting either. */
const REQUEST_MARKER = /\b(please|can you|could you|i want|i need|help me|add|fix|build|create|implement|refactor|investigate|explain|write|update|remove|check|review|complete|fully|entire|whole)\b/i

/** The text blocks of one message, joined. */
function textOf(message) {
  if (typeof message?.content === 'string') return message.content
  if (!Array.isArray(message?.content)) return ''
  return message.content
    .filter(block => block?.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('\n')
}

/** Whether a `user/message` event is host-attested human input rather than plugin-injected context. */
function isHumanMessage(event) {
  return event?.type === 'user/message' && event.data?.source?.kind === 'user'
}

/** The substantive request inside a captured baseline, or the whole text. */
function primaryRequest(text) {
  const paragraphs = text.split(/\n{2,}/).map(part => part.trim()).filter(part => part.length > 0)
  return paragraphs.find(part => REQUEST_MARKER.test(part)) ?? text
}

/** Normalize an optional string-or-array argument into a trimmed, de-duplicated string list. */
function strings(value) {
  const list = Array.isArray(value) ? value : typeof value === 'string' ? [value] : []
  const seen = new Set()
  const out = []
  for (const item of list) {
    if (typeof item !== 'string') continue
    const trimmed = item.trim()
    if (trimmed.length === 0 || seen.has(trimmed)) continue
    seen.add(trimmed)
    out.push(trimmed)
  }
  return out
}

/** Sentence-level split, so one meta sentence cannot clear a real deferral elsewhere in the message. */
function sentences(text) {
  return text
    .split(/(?<=[.!?;])\s+|\n+/)
    .map(part => part.trim())
    .filter(part => part.length > 0)
}

/**
 * The deferral markers found in one piece of the agent's own text.
 *
 * A sentence counts only when it carries a deferral marker AND reads as a
 * report of work (`WORK_VERBS`); anything else is discussion about deferring.
 */
function deferralMarkers(text) {
  const found = new Set()
  for (const sentence of sentences(text)) {
    if (!WORK_VERBS.test(sentence)) continue
    for (const pattern of DEFERRAL_MARKERS) {
      if (pattern.test(sentence)) found.add(String(pattern))
    }
  }
  return [...found]
}

// ------------------------------------------------------------- state shapes --

/** The empty contract. */
function emptyContract() {
  return {
    revision: 0,
    objective: '',
    doneWhen: '',
    mustDeliver: [],
    mustPreserve: [],
    outOfScope: [],
    mainPaths: [],
    userDecisions: [],
    openDirectionDecisions: [],
    budget: null,
    atStep: 0,
    atTime: 0,
  }
}

/** The all-zero projection state. */
function initialState() {
  return {
    /**
     * Cross-session lessons, read once when the session's projection is created
     * and then held. `lessonsText` is rendered at the SAME moment and never
     * recomputed, which is what keeps the injected bytes identical for the whole
     * session: it sits at the front of every request, and a value that moved would
     * invalidate the provider's cached prompt prefix on every step.
     */
    lessons: [],
    lessonsText: '',
    baseline: null,
    baselineSeq: null,
    /**
     * Identity of the current turn's request. A request is the human message
     * that launched the turn, so the baseline's seq IS the turn key. Every
     * per-request fact below is scoped to it.
     */
    turnKey: null,
    contract: null,
    contractSeq: null,
    /** `contractSeq` of the turn the active contract was committed in. */
    contractTurn: null,
    /** Contracts from earlier requests, newest first. Kept for context, never enforced. */
    contractHistory: [],
    coverage: {},
    coverageSeq: null,
    deferrals: [],
    deferralSeq: null,
    driftCount: 0,
    drift: null,
    driftSeq: null,
    decision: null,
    decisionSeq: null,
    steps: 0,
    turn: 0,
    /** Cumulative share of the contract added by automatic decisions. */
    mutationRatio: 0,
    /** Closed steps taken within the current request, reset by a new baseline. */
    stepsThisTurn: 0,
  /** Tool calls made in the turn in progress. Resets the stall streak when > 0. */
  toolsThisTurn: 0,
  /** Consecutive turn endings that used no tool at all. Cleared by any tool call. */
  stalledTurns: 0,
    /**
     * The turn key the guard itself asked for a contract in. `null` means it
     * has not asked yet; recording the key keeps the ask one-shot WITHOUT
     * depending on plugin memory, so a restarted process does not nag a
     * session (or a request) it already asked about.
     */
    askedAnchorAtTurn: null,
  }
}

/** Validate a persisted contract, discarding a shape this version cannot read. */
function parseContract(value) {
  if (typeof value !== 'object' || value === null) return null
  const raw = value
  if (typeof raw.objective !== 'string' || typeof raw.doneWhen !== 'string') return null
  if (!Number.isFinite(raw.atStep)) return null
  return {
    revision: Number.isSafeInteger(raw.revision) && raw.revision >= 1 ? raw.revision : 1,
    objective: raw.objective,
    doneWhen: raw.doneWhen,
    mustDeliver: strings(raw.mustDeliver),
    mustPreserve: strings(raw.mustPreserve),
    outOfScope: strings(raw.outOfScope),
    mainPaths: strings(raw.mainPaths),
    userDecisions: strings(raw.userDecisions),
    openDirectionDecisions: strings(raw.openDirectionDecisions),
    budget: Number.isSafeInteger(raw.budget) && raw.budget >= 1 ? raw.budget : null,
    atStep: raw.atStep,
    atTime: Number.isFinite(raw.atTime) ? raw.atTime : 0,
  }
}

/** Validate the coverage ledger. */
function parseCoverage(value) {
  if (typeof value !== 'object' || value === null) return {}
  const out = {}
  for (const [item, verdict] of Object.entries(value)) {
    if (typeof verdict !== 'string' || !COVERAGE_STATES.includes(verdict)) continue
    out[item] = verdict
  }
  return out
}

/**
 * Validate persisted projection state before it seeds a fold. Stands in for the
 * unit's `stateSchema` without a runtime dependency: a mismatched shape is
 * discarded rather than forward-applied into garbage.
 */
function parseState(value) {
  if (typeof value !== 'object' || value === null) return initialState()
  const raw = value
  const candidateBaseline = raw.baseline
  const baseline = typeof candidateBaseline === 'object' && candidateBaseline !== null
    && typeof candidateBaseline.text === 'string'
    ? { text: candidateBaseline.text, turn: Number.isFinite(candidateBaseline.turn) ? candidateBaseline.turn : 0 }
    : null
  const count = (input, fallback) => (Number.isFinite(input) && input >= 0 ? input : fallback)
  const optionalText = input => (typeof input === 'string' ? input : null)
  const candidateDrift = raw.drift
  const candidateDecision = raw.decision
  return {
    // Kept verbatim across a persistence round-trip: the rendered text is what was
    // injected, and re-rendering it later could produce different bytes.
    lessons: Array.isArray(raw.lessons) ? raw.lessons : [],
    lessonsText: typeof raw.lessonsText === 'string' ? raw.lessonsText : '',
    baseline,
    baselineSeq: Number.isFinite(raw.baselineSeq) ? raw.baselineSeq : null,
    turnKey: Number.isFinite(raw.turnKey) ? raw.turnKey : null,
    contract: parseContract(raw.contract),
    contractSeq: Number.isFinite(raw.contractSeq) ? raw.contractSeq : null,
    contractTurn: Number.isFinite(raw.contractTurn) ? raw.contractTurn : null,
    contractHistory: Array.isArray(raw.contractHistory)
      ? raw.contractHistory.map(entry => (typeof entry === 'object' && entry !== null && typeof entry.objective === 'string'
        ? { objective: entry.objective, atStep: Number.isFinite(entry.atStep) ? entry.atStep : 0 }
        : null)).filter(entry => entry !== null)
      : [],
    coverage: parseCoverage(raw.coverage),
    coverageSeq: Number.isFinite(raw.coverageSeq) ? raw.coverageSeq : null,
    deferrals: strings(raw.deferrals),
    deferralSeq: Number.isFinite(raw.deferralSeq) ? raw.deferralSeq : null,
    driftCount: count(raw.driftCount, 0),
    drift: typeof candidateDrift === 'object' && candidateDrift !== null
      && typeof candidateDrift.description === 'string'
      ? {
        reason: DRIFT_REASONS.includes(candidateDrift.reason) ? candidateDrift.reason : 'assumption-invalidated',
        description: candidateDrift.description,
        requiredChange: optionalText(candidateDrift.requiredChange),
        at: count(candidateDrift.at, 0),
      }
      : null,
    driftSeq: Number.isFinite(raw.driftSeq) ? raw.driftSeq : null,
    decision: typeof candidateDecision === 'object' && candidateDecision !== null
      && ['approve', 'reject', 'revise'].includes(candidateDecision.decision)
      ? {
        decision: candidateDecision.decision,
        note: optionalText(candidateDecision.note),
        at: count(candidateDecision.at, 0),
      }
      : null,
    decisionSeq: Number.isFinite(raw.decisionSeq) ? raw.decisionSeq : null,
    steps: count(raw.steps, 0),
    turn: count(raw.turn, 0),
    mutationRatio: Number.isFinite(raw.mutationRatio) && raw.mutationRatio >= 0 ? raw.mutationRatio : 0,
    stepsThisTurn: count(raw.stepsThisTurn, 0),
    toolsThisTurn: count(raw.toolsThisTurn, 0),
    stalledTurns: count(raw.stalledTurns, 0),
    askedAnchorAtTurn: Number.isFinite(raw.askedAnchorAtTurn) ? raw.askedAnchorAtTurn : null,
  }
}

/**
 * Whether the active contract belongs to the current request. A contract
 * committed in an earlier turn describes work that request asked for; it must
 * not gate, budget, or be enforced against the current one.
 */
function contractInForce(state) {
  if (state.contract === null) return false
  return state.turnKey !== null && state.contractTurn === state.turnKey
}

/** The closed steps spent inside the current request. */
function stepsInTurn(state) {
  return state.stepsThisTurn
}

/**
 * Derive the alignment posture:
 *
 * 1. a drift candidate with no newer decision            -> `drift-pending`
 * 2. an approve/revise decision, with no newer contract   -> `baseline-update-pending`
 * 3. otherwise the contract decides `aligned` / `unknown`
 *
 * (2) is the subtle one: while it holds, the OLD contract is still in force and
 * the fold must not report `aligned` against it — a session interrupted in that
 * window must resume knowing the new direction was approved but not committed.
 */
function derivePosture(state) {
  const inForce = contractInForce(state)
  if (state.drift !== null) {
    const decided = state.decision !== null && (state.decisionSeq ?? -1) > (state.driftSeq ?? -1)
    if (!decided) return 'drift-pending'
  }
  if (state.decision !== null && state.decision.decision !== 'reject') {
    const recorded = inForce && (state.contractSeq ?? -1) > (state.decisionSeq ?? -1)
    if (!recorded) return 'baseline-update-pending'
  }
  return inForce ? 'aligned' : 'unknown'
}

/**
 * The must-deliver items that are not proven delivered. An item with no verdict
 * counts as unreported, because silence is not evidence of completion.
 *
 * A contract from an earlier request returns nothing: it describes work that
 * request asked for, and the current request is not accountable for it.
 */
function unfinishedItems(state) {
  if (!contractInForce(state)) return []
  const contract = state.contract
  if (contract.mustDeliver.length === 0) return []
  const out = []
  for (const item of contract.mustDeliver) {
    const verdict = state.coverage[item]
    if (verdict !== undefined && AUTHORIZED_VERDICTS.includes(verdict)) continue
    out.push({ item, verdict: verdict ?? 'unreported' })
  }
  return out
}

// ------------------------------------------------------------ the projection --

/** Materialize a contract from validated tool arguments, bumping the revision. */
function contractFromArgs(args, atStep, atTime, previous) {
  const prior = previous ?? emptyContract()
  return {
    revision: prior.revision + 1,
    objective: args.objective.trim(),
    doneWhen: args.done_when.trim(),
    mustDeliver: strings(args.must_deliver),
    mustPreserve: strings(args.must_preserve),
    outOfScope: strings(args.out_of_scope),
    mainPaths: strings(args.main_paths),
    userDecisions: strings(args.user_decisions),
    openDirectionDecisions: strings(args.open_direction_decisions),
    budget: Number.isSafeInteger(args.step_budget) && args.step_budget >= 1 ? args.step_budget : null,
    atStep,
    atTime,
  }
}

/**
 * Parse a durable `tool/call` event's arguments. The log stores a call's
 * arguments as the model's raw JSON **string** (`session-format-*` lists
 * `arguments` among the string-typed fields); parsing into an object happens
 * later, in the dispatch layer. Folding has to parse it here — reading the
 * string as an object silently drops every commitment, which is exactly the
 * bug this guard exists to catch, in itself.
 */
function argsOf(event) {
  const raw = event?.data?.arguments
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw)
      return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed : undefined
    } catch {
      return undefined
    }
  }
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? raw : undefined
}

/**
 * The `driftGuard` projection unit: a pure fold over human input, contract and
 * coverage calls, drift reports, the agent's own text, and step boundaries.
 *
 * The baseline is the human message that launched the current turn rather than
 * the session's very first message: "the original request" is only meaningful
 * per instruction, and a later instruction legitimately supersedes an earlier
 * one. What the guard adds is that the baseline is frozen while the turn runs,
 * cannot be replaced by the agent, and is re-stated on every request.
 */
function projectionDefinition(options = {}) {
  const reportDeferrals = options.reportDeferrals === true
  return {
    key: PROJECTION_KEY,
    stateVersion: 1,
    stateSchema: { parse: parseState },
    init: () => {
      // Lessons are read and rendered ONCE here, at projection creation, and the
      // resulting text is held for the session. Recomputing it later would move
      // bytes at the front of every request, which is exactly what invalidates a
      // cached prompt prefix.
      const base = initialState()
      if (typeof options.loadLessons !== 'function') return base
      try {
        const lessons = activeLessons(options.loadLessons())
        return { ...base, lessons, lessonsText: renderLessons(lessons) }
      } catch {
        // A malformed store must not take the guard down with it. The tools report
        // the real error when someone tries to write; until then the session runs
        // exactly as it would with no lessons at all.
        return base
      }
    },
    apply: (state, event) => {
      switch (event.type) {
        case 'user/message': {
          // A stall streak belongs to the request it happened in.
          if (event.data?.source?.kind === 'user') state = { ...state, stalledTurns: 0 }
          // The guard's own ask for a contract is recorded so it happens once
          // per request rather than once per step.
          if (event.data?.source?.kind === name) {
            if (state.askedAnchorAtTurn === state.turnKey) return state
            return { ...state, askedAnchorAtTurn: state.turnKey }
          }
          // Guard-injected context carries its own source kind, so only
          // host-attested human input can move the baseline.
          if (!isHumanMessage(event)) return state
          const body = textOf(event.data).trim()
          if (body.length === 0) return state
          // A new human message starts a NEW request. Everything that belongs
          // to the request — its contract, its coverage ledger, its deferral
          // findings, its guard ask — is scoped to it. The superseded contract
          // is kept as history for context, never for enforcement.
          const superseded = state.contract !== null && state.contractTurn !== event.seq
            ? [{ objective: state.contract.objective, atStep: state.contract.atStep }, ...state.contractHistory].slice(0, 4)
            : state.contractHistory
          return {
            ...state,
            baseline: { text: capBaseline(body), turn: state.turn },
            baselineSeq: event.seq,
            turnKey: event.seq,
            contract: state.contractTurn === event.seq ? state.contract : null,
            contractSeq: state.contractTurn === event.seq ? state.contractSeq : null,
            contractTurn: state.contractTurn === event.seq ? state.contractTurn : null,
            contractHistory: superseded,
            coverage: state.contractTurn === event.seq ? state.coverage : {},
            coverageSeq: state.contractTurn === event.seq ? state.coverageSeq : null,
            deferrals: [],
            deferralSeq: null,
            stepsThisTurn: 0,
          }
        }
        case 'turn/start': {
          return { ...state, toolsThisTurn: 0 }
        }
        case 'turn/end': {
          // The turn is over. A turn that called no tool at all is a bare ending;
          // any tool call clears the streak, so ordinary concluding turns - which
          // always followed real work - never count.
          if (state.toolsThisTurn > 0) return { ...state, stalledTurns: 0 }
          return { ...state, stalledTurns: state.stalledTurns + 1 }
        }
        case 'step/start':
          return {
            ...state,
            steps: state.steps + 1,
            stepsThisTurn: state.stepsThisTurn + 1,
            turn: event.data.turn ?? state.turn,
          }
        case 'assistant/message': {
          // The agent's own words are the earliest signal that it intends to
          // ship less than the contract owes. Recording the marker makes the
          // reason a fact the guard can name later instead of an inference.
          // It is watched for the current request whether or not a contract has
          // been committed yet — an announced shortfall before the contract is
          // written is exactly the case worth catching.
          if (state.baseline === null) return state
          // Only the model's own words. An assistant record forwarded from
          // another producer (a plugin notice, a relayed child) is not this
          // agent announcing a shortfall, and reading it as one is how the
          // guard came to flag its own explanation.
          const origin = event.data?.message?.source?.kind
          if (origin !== undefined && origin !== 'model') return state
          // Deferral-phrase detection is off by default (see DEFERRAL_MARKERS):
          // three live runs produced three false positives, because real text is
          // full of prose *discussing* shortfalls. The fold stays inert unless a
          // deployment opts back in.
          if (!reportDeferrals) return state
          const body = textOf(event.data?.message).trim()
          if (body.length === 0) return state
          const found = deferralMarkers(body)
          if (found.length === 0) return state
          const merged = [...state.deferrals]
          for (const marker of found) if (!merged.includes(marker)) merged.push(marker)
          if (merged.length === state.deferrals.length) return state
          return { ...state, deferrals: merged, deferralSeq: event.seq }
        }
        case 'tool/call': {
          // Counted before any filtering: what matters is that a tool ran, not
          // which one. A guard tool call is still the agent doing something.
          state = { ...state, toolsThisTurn: state.toolsThisTurn + 1, stalledTurns: 0 }
          const name = event.data?.name
          if (name !== ANCHOR_TOOL && name !== DRIFT_TOOL) return state
          const args = argsOf(event)
          if (args === undefined) return state

          if (name === ANCHOR_TOOL) {
            if (args.action === 'coverage') {
              const item = typeof args.item === 'string' ? args.item.trim() : ''
              if (item.length === 0 || !COVERAGE_STATES.includes(args.state)) return state
              // A coverage verdict only means something for the request it was
              // taken in.
              if (!contractInForce(state)) return state
              return {
                ...state,
                coverage: { ...state.coverage, [item]: args.state },
                coverageSeq: event.seq,
              }
            }
            if (args.action !== 'set') return state
            if (typeof args.objective !== 'string' || args.objective.trim().length === 0) return state
            if (typeof args.done_when !== 'string' || args.done_when.trim().length === 0) return state
            // An agent with no human message in the turn has no turn key; such
            // a commit is refused by the tool, so the fold ignores it too.
            if (state.turnKey === null) return state
            return {
              ...state,
              contract: contractFromArgs(args, state.stepsThisTurn, event.time ?? 0, state.contract),
              contractSeq: event.seq,
              contractTurn: state.turnKey,
              // A revised contract restarts the coverage ledger: verdicts about
              // the old set of deliverables say nothing about the new one.
              coverage: {},
              coverageSeq: null,
            }
          }

          if (args.action === 'report') {
            if (typeof args.description !== 'string' || args.description.trim().length === 0) return state
            return {
              ...state,
              driftCount: state.driftCount + 1,
              drift: {
                reason: DRIFT_REASONS.includes(args.reason) ? args.reason : 'assumption-invalidated',
                description: args.description.trim(),
                requiredChange: typeof args.required_change === 'string' && args.required_change.trim().length > 0
                  ? args.required_change.trim()
                  : null,
                at: event.time ?? 0,
              },
              driftSeq: event.seq,
            }
          }
          if (args.action === 'decide' && ['approve', 'reject', 'revise'].includes(args.decision)) {
            return {
              ...state,
              // Gate C accounting: a self-resolved approval adds its share to the
              // cumulative ratio, so repeated small changes converge on the budget
              // instead of accumulating unnoticed.
              mutationRatio: typeof args.note === 'string' && args.note.startsWith('auto:')
                ? (Number.isFinite(state.mutationRatio) ? state.mutationRatio : 0)
                  + (strings(args.adds_deliverables).length / Math.max(1, state.contract?.mustDeliver.length ?? 1))
                : state.mutationRatio,
              decision: {
                decision: args.decision,
                note: typeof args.note === 'string' && args.note.trim().length > 0 ? args.note.trim() : null,
                at: event.time ?? 0,
              },
              decisionSeq: event.seq,
            }
          }
          return state
        }
        default:
          return state
      }
    },
    wire: {
      viewSchema: { parse: value => value },
      view: state => ({
        posture: derivePosture(state),
        revision: state.contract?.revision ?? 0,
        unfinished: unfinishedItems(state).length,
      }),
    },
  }
}

// ------------------------------------------------------------------ context --

/** Build one plugin-attributed user message. The runtime freezes what it accepts. */
/**
 * Current context occupancy, read from DSH's own token-meter projection.
 *
 * Deliberately NOT estimated here: DSH already measures this, and a second
 * estimator built from a different definition would disagree with the number the
 * user sees in the UI. `projectedTokens` is what the token meter itself calls
 * "what the NEXT request's prompt would cost"; `pressureTokens` is the fallback
 * when no surface movement has been sampled since the last reading.
 *
 * This is exposed ONLY through a read-only tool, never injected into the prompt.
 * A usage line inside the system prompt sits at the very front of the request,
 * so every time the number changed it would invalidate the provider's cached
 * prompt prefix and force the whole prefix to be re-processed; a figure that
 * changes as the window fills is exactly the case that invalidates it most
 * often. Keeping the prompt byte-stable is worth more than the unsolicited
 * reminder, so the agent asks when it wants to know.
 *
 * @returns structured occupancy, or a reason it is unavailable. Nothing is
 * invented: a fabricated number cannot be told apart from a measured one.
 */
function readContextUsage(ctx, agent) {
  const pressure = ctx.sessionProjections?.stateOf?.(agent.session, 'contextPressure')
  if (pressure === null || typeof pressure !== 'object') {
    return unavailable('no token-meter projection is registered in this composition')
  }
  const used = pressure.projectedTokens ?? pressure.pressureTokens
  if (typeof used !== 'number' || !Number.isFinite(used)) {
    return unavailable('the token meter has not reported a prompt size yet')
  }
  const window = pressure.contextWindow
  if (typeof window !== 'number' || !Number.isFinite(window) || window <= 0) {
    return {
      ...unavailable('the token meter has counted tokens but the model context window is not known yet'),
      usedTokens: used,
    }
  }
  const left = Math.max(0, window - used)
  return {
    available: true,
    usedTokens: used,
    contextWindow: window,
    remainingTokens: left,
    percent: Math.min(100, Math.round(used / window * 100)),
    why: '',
    projected: pressure.projectedTokens !== undefined,
    summary: `${formatTokens(used)} / ${formatTokens(window)} tokens used (${Math.min(100, Math.round(used / window * 100))}%)`,
    note: 'Once the window is compacted, earlier context - including the original request and this '
      + 'contract - may no longer be retrievable. If the remaining work cannot fit, say so plainly '
      + 'and say what will not fit, rather than quietly narrowing what you deliver.',
  }
}

/**
 * The unavailable shape. Every declared field is present so the output schema
 * stays a single flat object with nothing optional - a reading is either
 * trustworthy (`available: true`) or it is not, and the zeros below are a
 * sentinel that `available` disambiguates, never a claimed measurement.
 */
function unavailable(why) {
  return {
    available: false,
    why,
    usedTokens: 0,
    contextWindow: 0,
    remainingTokens: 0,
    percent: 0,
    projected: false,
    summary: '',
    note: '',
  }
}

/** Compact token counts. */
function formatTokens(value) {
  if (value < 1000) return String(value)
  if (value < 1_000_000) return `${(value / 1000).toFixed(1)}k`
  return `${(value / 1_000_000).toFixed(2)}M`
}

/** Build one injected context message. */
function contextMessage(text, form, summary) {
  return {
    id: `drift-guard-${globalThis.crypto.randomUUID()}`,
    role: 'user',
    content: [{ type: 'text', text }],
    source: form === 'notice'
      ? { kind: name, form: 'notice', summary: boundSummary(summary) }
      : { kind: name, form: 'instructions' },
  }
}

/** Model-facing statement of the frozen baseline. */
function renderBaseline(baseline) {
  if (baseline === null) return ''
  return [
    'Original request — frozen by drift-guard while this turn runs, verbatim and not open to re-interpretation:',
    '',
    primaryRequest(baseline.text),
    '',
    'Everything you do serves this text. Notice when your current sub-task stopped serving it.',
  ].join('\n')
}

/** Model-facing rendering of the contract, its coverage ledger, and the posture. */
function renderContract(state, budget, reportDeferrals = false) {
  const contract = state.contract
  const inForce = contractInForce(state)
  const lines = ['Committed contract for this task:']
  if (contract === null || !inForce) {
    if (contract !== null) {
      lines.push(`- stale: the contract below was committed for an earlier request and is not enforced against this one.`)
      lines.push(`- its objective was: ${contract.objective}`)
      lines.push(`- its deliverables were: ${contract.mustDeliver.length === 0 ? '(none declared)' : contract.mustDeliver.join('; ')}`)
    }
    lines.push(`- set a contract for the CURRENT request: call ${ANCHOR_TOOL} with action "set".`)
    lines.push('Only the user can widen a contract. Do not redefine the objective or the completion check to match what you ended up doing.')
    return lines.join('\n')
  }
  const used = Math.max(0, state.stepsThisTurn - contract.atStep)
  const cap = contract.budget ?? budget
  lines.push(`- revision: ${contract.revision}`)
  lines.push(`- objective: ${contract.objective}`)
  lines.push(`- done when: ${contract.doneWhen}`)
  if (contract.mustDeliver.length > 0) lines.push(`- must deliver: ${contract.mustDeliver.join('; ')}`)
  if (contract.mustPreserve.length > 0) lines.push(`- must preserve: ${contract.mustPreserve.join('; ')}`)
  if (contract.outOfScope.length > 0) lines.push(`- out of scope: ${contract.outOfScope.join('; ')}`)
  if (contract.mainPaths.length > 0) lines.push(`- main paths: ${contract.mainPaths.join('; ')}`)
  if (contract.userDecisions.length > 0) {
    lines.push(`- settled user decisions (never re-ask, never silently reverse): ${contract.userDecisions.join('; ')}`)
  }
  if (contract.openDirectionDecisions.length > 0) {
    lines.push(`- open direction items (not yet decided): ${contract.openDirectionDecisions.join('; ')}`)
  }
  lines.push(`- step budget: ${cap} closed steps, ${used} used`)
  if (contract.mustDeliver.length > 0) {
    const rows = contract.mustDeliver.map(item => `${item} [${state.coverage[item] ?? 'unreported'}]`)
    lines.push(`- coverage: ${rows.join('; ')}`)
  }
  lines.push(`- posture: ${derivePosture(state)}`)
  if (state.contractHistory.length > 0) {
    lines.push(`- earlier requests in this session (context only, not enforced): ${state.contractHistory.map(entry => entry.objective).join(' | ')}`)
  }
  if (reportDeferrals && state.deferrals.length > 0) {
    lines.push(
      `- deferral language detected in your own output (${state.deferrals.length} marker(s)): shipping a `
      + 'labelled subset is a direction change, not a completion',
    )
  }
  lines.push(
    'Only the user can widen this contract or accept a partial delivery. Do not redefine the objective or '
    + 'the completion check to match what you ended up doing, and do not call a labelled subset finished.',
  )
  return lines.join('\n')
}

/** The forced checkpoint: three explicit exits, never a bare "stay focused". */
function renderCheckpoint(state, budget, reportDeferrals = false) {
  const contract = state.contract
  const used = contract === null ? state.stepsThisTurn : Math.max(0, state.stepsThisTurn - contract.atStep)
  const cap = contract?.budget ?? budget
  const unfinished = unfinishedItems(state)
  const body = [
    'drift-guard checkpoint — the step budget is spent.',
    '',
    renderBaseline(state.baseline),
    '',
    renderContract(state, budget, reportDeferrals),
    '',
    `Closed steps since the contract was set: ${used} (budget ${cap}).`,
  ]
  if (unfinished.length > 0) {
    body.push('', 'Unfinished must-deliver items:')
    for (const entry of unfinished) body.push(`- ${entry.item}: ${entry.verdict}`)
  }
  body.push(
    '',
    'Stop and audit before the next call. Map your last actions back to the objective above and pick exactly one:',
    '1. Main line: state the next action that advances the deliverable directly, and do that.',
    `2. Direction change: the task genuinely needs more, less, or something else than the contract allows — report it with ${DRIFT_TOOL} and let the user decide before doing that work.`,
    '3. Stop: report what is blocked, what you tried, and what you need. Do not keep working on a sub-problem the request did not ask for.',
  )
  return body.join('\n')
}

/** The list of unfinished work that blocks a confident close. */
function renderUnfinished(state) {
  const unfinished = unfinishedItems(state)
  const lines = [
    'drift-guard: this turn is ending with must-deliver items that are not proven complete.',
    '',
    renderBaseline(state.baseline),
    '',
    renderContract(state, 0),    '',
    'Unfinished:',
  ]
  for (const entry of unfinished) lines.push(`- ${entry.item}: ${entry.verdict}`)
  lines.push(
    '',
    'Pick exactly one before you close:',
    `1. Finish it now, then record the verdict with ${ANCHOR_TOOL} action "coverage" state "complete" and cite the evidence.`,
    `2. Ask the user to accept the partial delivery: ${DRIFT_TOOL} with reason "incomplete-delivery". Only their answer authorizes shipping less.`,
    '3. Stop and report the incomplete state plainly. Do not describe a partial delivery as finished, and do not rename the remaining work as a follow-up you decided on your own.',
  )
  return lines.join('\n')
}

/**
 * Replace a bare continuation with something actionable.
 *
 * The loop's fuel is the auto-continuation arriving as a bare "continue", which the
 * agent answers with another bare "continue". The guard cannot change how that prompt is
 * generated, but it can put an instruction in front of it that names two concrete ways
 * out, so the next reply has something to act on.
 */
function renderStallDirective(stalled) {
  return [
    `drift-guard: ${stalled} turns in a row have ended without calling a single tool.`,
    '',
    'Saying you will continue is not continuing. Right now, do ONE of these:',
    '- call a tool and do one concrete thing, or',
    '- state plainly what is blocking you, and stop.',
    '',
    'Do not reply with another acknowledgement. A turn that ends without a tool call and',
    'without naming a blocker is the loop this message exists to break.',
  ].join('\n')
}

/**
 * Stop looping and hand the stall to the human.
 *
 * After this many bare turns the guard's own instruction has already failed to break the
 * cycle. Re-issuing it would just add the guard to the loop, so it reports once and stops:
 * the human can decide what the model cannot.
 */
function renderStallEscalation(stalled) {
  return [
    `drift-guard: escalating - ${stalled} consecutive turns ended with no tool call.`,
    '',
    'The guard already asked for a concrete action and it did not break the cycle, so it is',
    'not going to keep asking. This is reported rather than repeated.',
    '',
    'What the guard cannot do, and will not pretend to: it has no re-sampling, no logit',
    'handling and no stop-sequence control, so a degenerate token-level loop is beyond it.',
    'What it can tell you is the mechanical fact above. If the replies look like nonsense',
    'rather than like stalling, that is a sampling problem, not a drift problem.',
  ].join('\n')
}

/**
 * Ask for a lesson before the turn closes.
 *
 * The guard states WHAT it counted and stays silent about what it means. It cannot
 * distinguish an instructive failure from a typo, so it does not pretend to; the agent
 * knows, and the only part that reliably gets skipped is the act of writing it down.
 * Refusing is permitted and the turn still closes, because a recording requirement that
 * hard-blocks would be a gate wearing a request's name - and this is the mechanism whose
 * whole purpose is to keep endings possible.
 */
function renderLessonRequest(state, triggers) {
  const why = triggers
    .map(trigger => `- ${trigger}: ${LESSON_TRIGGERS[trigger] ?? ""}`)
    .join('\n')
  return [
    'drift-guard: this turn shows mechanical signs of thrashing, and nothing has been recorded.',
    '',
    `Observed: ${why}`,
    '',
    'The guard cannot tell whether what happened was instructive or just a typo, so it does not',
    'guess at the content. You are the only one who knows. Before closing, record it with',
    `${LESSON_TOOL} if there is something a future session should not have to re-learn: the`,
    'symptom (what actually went wrong) and the rule (what to do instead). Pick the trigger from',
    'the closed list that names the situation.',
    '',
    'If the friction was incidental and taught nothing, say so and close. An empty lesson is',
    'worse than none, because a store full of noise is a store nobody reads.',
  ].join('\n')
}

/** The one-shot prompt for a session that never committed a contract. */
function renderAnchorRequest(state) {
  return [
    'drift-guard: this task still has no committed contract, so nothing distinguishes the request from whatever you are currently doing.',
    '',
    renderBaseline(state.baseline),
    '',
    `Call ${ANCHOR_TOOL} with action "set" now — the objective, the check that proves completion, what must `
    + 'be delivered, and what must be preserved — or answer the user with what you have.',
  ].filter(part => part !== '').join('\n')
}

// -------------------------------------------------------------- host helpers --

/** Whether the open turn of a runtime-root agent contains host-attested human input. */
function hasDirectHumanInput(ctx, agent) {
  if (!isRootAgent(ctx, agent)) return false
  // oxlint-disable-next-line typescript/no-deprecated -- existing Session history read, mirroring dsh-tool-goal.
  const events = agent.session.snapshotEvents()
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event.type === 'turn/start') return false
    if (isHumanMessage(event)) return true
  }
  return false
}

/** Whether this agent is a runtime root (a delegated child is not). */
function isRootAgent(ctx, agent) {
  const roots = ctx.get('agents')?.roots?.()
  return Array.isArray(roots) && roots.includes(agent)
}

/** Inject steering without letting the guard read as a new user prompt. */
function steer(agent, text) {
  agent.steer(contextMessage(text, 'instructions'))
}

/** Resolve the projection state for one agent. */
function stateOf(ctx, agent) {
  return ctx.sessionProjections.stateOf(agent.session, PROJECTION_KEY)
}

/** The "you are a delegated agent" error both tools share. */
function delegatedRefusal(tool) {
  return new Error(
    `${tool} is not available to a delegated agent: a child agent has no human answerer, so it can neither `
    + 'commit a contract nor ask for a direction change. Include a "Requirement drift candidate" block in your '
    + 'final report instead — the reason, the current contract, the required change, and the decision you need '
    + 'from the parent. The parent owns user interaction.',
  )
}

// ------------------------------------------------------------ answer mapping --

/**
 * Present the model-supplied direction options PLUS the two defaults,
 * deduplicated by label. Whatever the model offers, the user always has the
 * literal approve / stay-in-scope options, so a "stay in scope" intent can
 * never be trapped inside a model-rewritten label and mis-recorded as a
 * direction change.
 */
function withDefaultOptions(options) {
  const labels = new Set(options.map(option => option.label))
  return [...options, ...DEFAULT_DRIFT_OPTIONS.filter(option => !labels.has(option.label))]
}

/** Validate model-supplied direction options (at most 3, distinct non-empty labels). */
function validateOptions(value) {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw new TypeError(`${DRIFT_TOOL}: options must be an array`)
  const out = []
  const seen = new Set()
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) {
      throw new TypeError(`${DRIFT_TOOL}: every option must be an object with a label`)
    }
    const label = typeof entry.label === 'string' ? entry.label.trim() : ''
    if (label.length === 0) throw new TypeError(`${DRIFT_TOOL}: every option needs a non-empty label`)
    if (seen.has(label)) throw new TypeError(`${DRIFT_TOOL}: duplicate option label "${label}"`)
    seen.add(label)
    const description = typeof entry.description === 'string' ? entry.description.trim() : ''
    out.push(description.length === 0 ? { label } : { label, description })
  }
  if (out.length > 3) {
    throw new TypeError(`${DRIFT_TOOL}: at most 3 options; the two default directions are always added`)
  }
  return out
}

/**
 * Map one user answer to a decision.
 *
 * - non-empty free text                      -> `revise`, note = the user's own words
 * - a selected default option                -> `approve` / `reject` by exact label
 * - a selected model-supplied option (a concrete alternative direction)
 *                                            -> `revise`, note = that label
 * - anything that cannot be interpreted reliably (no selection, several
 *   selections, or a label matching no presented option) throws: failing loud
 *   beats silently mis-recording the decision as a rejection.
 */
function mapDriftAnswer(selected, custom, presented) {
  if (typeof custom === 'string' && custom.trim().length > 0) {
    return { decision: 'revise', note: custom.trim() }
  }
  const picks = Array.isArray(selected) ? selected.filter(entry => typeof entry === 'string') : []
  if (picks.length === 0) {
    throw new Error('the question was answered without a selection — the decision cannot be inferred')
  }
  if (picks.length > 1) {
    throw new Error('multiple options were selected — a direction decision needs exactly one')
  }
  const label = picks[0]
  if (label === APPROVE_LABEL) return { decision: 'approve', note: null }
  if (label === REJECT_LABEL) return { decision: 'reject', note: null }
  if (presented.some(option => option.label === label)) return { decision: 'revise', note: label }
  throw new Error(`the selected answer "${label}" is not one of the presented options`)
}

// ------------------------------------------------------------- tool schemas --

const ANCHOR_DESCRIPTION =
  'Commit to a bounded, complete contract for the current task before exploring, and keep it in view. '
  + 'The guard keeps the user\'s original request verbatim and re-states it on every request; this contract '
  + 'records what you are actually accountable for. Set the objective, the single check that proves '
  + 'completion, every item that must be delivered, and what must be preserved. While the contract is open '
  + 'it is frozen for you: if the real work turns out to need more, less, or something else, that is a '
  + 'direction change the user owns — report it and get approval instead of rewriting the objective to match '
  + 'whatever you drifted into. Record a coverage verdict for each must-deliver item as you finish it; a '
  + 'partial or missing item is a direction change, not a completion, and needs the user\'s explicit '
  + 'acceptance. Re-issue action "set" only after the user agrees to a new direction, or use action "get" to '
  + 're-read the contract.'

const ANCHOR_PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  required: ['action'],
  properties: {
    action: {
      type: 'string',
      enum: ['set', 'get', 'coverage'],
      description: 'set commits or deliberately replaces the contract; get reads it; coverage records one must-deliver verdict.',
    },
    objective: {
      type: 'string',
      description: 'Required with action set: the bounded task in one or two sentences, naming the artifact.',
    },
    done_when: {
      type: 'string',
      description: 'Required with action set: the one observable check that proves this is finished; name the exact command to run or evidence to cite.',
    },
    must_deliver: {
      type: 'array',
      items: { type: 'string' },
      description: 'Strongly recommended with action set: every item that must exist for the request to count as done. Each gets a coverage verdict, and an unfinished one blocks a confident close.',
    },
    must_preserve: {
      type: 'array',
      items: { type: 'string' },
      description: 'Optional with action set: behaviour, formats, APIs, or interfaces that must stay unchanged.',
    },
    out_of_scope: {
      type: 'array',
      items: { type: 'string' },
      description: 'Optional with action set: work you will NOT do in this task, even if it looks related or broken.',
    },
    main_paths: {
      type: 'array',
      items: { type: 'string' },
      description: 'Optional with action set: file paths or directories carrying the deliverable.',
    },
    user_decisions: {
      type: 'array',
      items: { type: 'string' },
      description: 'Optional with action set: decisions the user already settled, so they are never re-asked or silently reversed.',
    },
    open_direction_decisions: {
      type: 'array',
      items: { type: 'string' },
      description: 'Optional with action set: direction items still awaiting a user decision.',
    },
    step_budget: {
      type: 'number',
      description: 'Optional with action set: closed steps allowed before the guard forces a checkpoint. Defaults to the configured budget.',
    },
    item: {
      type: 'string',
      description: 'Required with action coverage: the exact must-deliver item being reported on.',
    },
    state: {
      type: 'string',
      enum: COVERAGE_STATES,
      description: 'Required with action coverage: complete (done and verified), partial (some of it exists), missing (none of it), waived (the user accepted shipping without it).',
    },
    evidence: {
      type: 'array',
      items: { type: 'string' },
      description: 'Optional with action coverage: the paths or commands that prove the verdict. Echoed back to you so the claim stays attached to its proof.',
    },
  },
}

const ANCHOR_VALUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['action', 'posture', 'baseline', 'contract', 'coverage', 'unfinished', 'deferralSignals', 'steps', 'budget', 'remaining'],
  properties: {
    action: { type: 'string', enum: ['set', 'get', 'coverage'] },
    posture: { type: 'string', enum: ['unknown', 'aligned', 'drift-pending', 'baseline-update-pending'] },
    baseline: { type: 'string', description: 'The frozen original request; empty when none was captured.' },
    contract: {
      type: 'object',
      additionalProperties: false,
      required: [
        'revision', 'objective', 'done_when', 'must_deliver', 'must_preserve', 'out_of_scope',
        'main_paths', 'user_decisions', 'open_direction_decisions', 'budget', 'steps_used',
      ],
      properties: {
        revision: { type: 'number', description: '0 when no contract is committed.' },
        objective: { type: 'string', description: 'Empty when no contract is committed.' },
        done_when: { type: 'string' },
        must_deliver: { type: 'array', items: { type: 'string' } },
        must_preserve: { type: 'array', items: { type: 'string' } },
        out_of_scope: { type: 'array', items: { type: 'string' } },
        main_paths: { type: 'array', items: { type: 'string' } },
        user_decisions: { type: 'array', items: { type: 'string' } },
        open_direction_decisions: { type: 'array', items: { type: 'string' } },
        budget: { type: 'number', description: '0 means the configured default applies.' },
        steps_used: { type: 'number' },
      },
    },
    coverage: {
      type: 'object',
      additionalProperties: false,
      required: ['items', 'complete', 'partial', 'missing', 'unreported'],
      properties: {
        items: {
          type: 'array',
          items: { type: 'string' },
          description: 'One "item [verdict]" entry per must-deliver item.',
        },
        complete: { type: 'number' },
        partial: { type: 'number' },
        missing: { type: 'number' },
        unreported: { type: 'number' },
      },
    },
    unfinished: {
      type: 'array',
      items: { type: 'string' },
      description: 'Must-deliver items that are not proven delivered, as "item [verdict]".',
    },
    deferralSignals: { type: 'number', description: 'Deferral markers detected in the agent\'s own output.' },
    steps: { type: 'number' },
    budget: { type: 'number', description: '0 means no budget applies.' },
    remaining: { type: 'number' },
  },
}

const DRIFT_DESCRIPTION =
  'Report a direction-level change before you act on it, and let the user decide. Use it whenever what you '
  + 'are about to do would materially change the task: expanding or narrowing scope, conflicting with an '
  + 'explicit constraint, changing user-visible behaviour, shifting architecture or product shape, changing '
  + 'the data model, breaking compatibility, invalidating an assumption the plan rested on, following a '
  + 'direction the user just introduced, or shipping less than the contract owes (incomplete-delivery). '
  + 'Report it BEFORE the direction-changing work, never afterwards as a summary. The tool asks the user '
  + 'through the native question seam, records the exact decision, and returns it; after an approve or '
  + `revise, commit the new contract with ${ANCHOR_TOOL} action "set". Routine engineering choices — naming, `
  + 'file layout, an in-scope helper, a test file, a formatter — are yours: do not report those.'

const DRIFT_PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  required: ['action', 'reason', 'description'],
  properties: {
    action: {
      type: 'string',
      enum: ['report'],
      description: 'Only "report" is callable by the model; the user\'s answer is recorded automatically after the question.',
    },
    reason: {
      type: 'string',
      enum: DRIFT_REASONS,
      description: 'Required: the taxonomy entry that names why this is a direction change.',
    },
    description: {
      type: 'string',
      description: 'Required: what you intend to do that would change the direction, in one or two sentences.',
    },
    required_change: {
      type: 'string',
      description: 'Optional: what the contract would have to become. Echoed to the user and back to you.',
    },
    options: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['label'],
        properties: {
          label: { type: 'string' },
          description: { type: 'string' },
        },
      },
      description: 'Optional: up to 3 concrete alternative directions. The approve / stay-in-scope options are always added, so the user can never be trapped into a rewritten label.',
    },
  },
}

const DRIFT_VALUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['action', 'reason', 'description', 'decision', 'note', 'outcome'],
  properties: {
    action: { type: 'string', enum: ['report'] },
    reason: { type: 'string' },
    description: { type: 'string' },
    decision: { type: 'string', enum: ['approve', 'reject', 'revise', 'unanswered'] },
    note: { type: 'string', description: 'The user\'s exact choice (free text or selected label); empty for approve/reject.' },
    outcome: { type: 'string', description: 'What you must do next, in one line.' },
  },
}

// ---------------------------------------------------------- arg validation --
/**
 * Structural validation, because these tools are registered without
 * `defineTool`. The declared schema constrains the happy path; this guarantees
 * anything invalid fails with zero session pollution.
 */
function validateAnchorArgs(args) {
  if (typeof args !== 'object' || args === null) throw new TypeError(`${ANCHOR_TOOL}: arguments must be an object`)
  const raw = args
  if (raw.action === 'get') return { action: 'get' }
  if (raw.action === 'coverage') {
    const item = typeof raw.item === 'string' ? raw.item.trim() : ''
    if (item.length === 0) throw new TypeError(`${ANCHOR_TOOL}: item is required with action "coverage"`)
    if (!COVERAGE_STATES.includes(raw.state)) {
      throw new TypeError(`${ANCHOR_TOOL}: state must be one of ${COVERAGE_STATES.join('/')} with action "coverage"`)
    }
    return { action: 'coverage', item, state: raw.state, evidence: strings(raw.evidence) }
  }
  if (raw.action !== 'set') throw new TypeError(`${ANCHOR_TOOL}: action must be "set", "get", or "coverage"`)
  if (typeof raw.objective !== 'string' || raw.objective.trim().length === 0) {
    throw new TypeError(`${ANCHOR_TOOL}: objective is required with action "set"`)
  }
  if (typeof raw.done_when !== 'string' || raw.done_when.trim().length === 0) {
    throw new TypeError(`${ANCHOR_TOOL}: done_when is required with action "set"`)
  }
  if (raw.step_budget !== undefined && (!Number.isSafeInteger(raw.step_budget) || raw.step_budget < 1)) {
    throw new TypeError(`${ANCHOR_TOOL}: step_budget must be a positive safe integer`)
  }
  return {
    action: 'set',
    objective: raw.objective,
    done_when: raw.done_when,
    must_deliver: strings(raw.must_deliver),
    must_preserve: strings(raw.must_preserve),
    out_of_scope: strings(raw.out_of_scope),
    main_paths: strings(raw.main_paths),
    user_decisions: strings(raw.user_decisions),
    open_direction_decisions: strings(raw.open_direction_decisions),
    step_budget: raw.step_budget,
  }
}

/** Validate `drift_report` arguments before any durable state is written. */
function validateDriftArgs(args) {
  if (typeof args !== 'object' || args === null) throw new TypeError(`${DRIFT_TOOL}: arguments must be an object`)
  const raw = args
  if (raw.action !== 'report') throw new TypeError(`${DRIFT_TOOL}: action must be "report"`)
  if (!DRIFT_REASONS.includes(raw.reason)) {
    throw new TypeError(`${DRIFT_TOOL}: reason must be one of ${DRIFT_REASONS.join('/')}`)
  }
  if (typeof raw.description !== 'string' || raw.description.trim().length === 0) {
    throw new TypeError(`${DRIFT_TOOL}: description is required`)
  }
  const requiredChange = typeof raw.required_change === 'string' ? raw.required_change.trim() : ''
  return {
    action: 'report',
    reason: raw.reason,
    description: raw.description.trim(),
    required_change: requiredChange.length === 0 ? undefined : requiredChange,
    options: validateOptions(raw.options),
    // Gate inputs. Supplying them makes a self-resolved change possible; omitting
    // them simply escalates to the user, which is always safe.
    basis: strings(raw.basis),
    adds_deliverables: strings(raw.adds_deliverables),
    drops_deliverables: strings(raw.drops_deliverables),
  }
}

// ------------------------------------------------------------ tool results --

/**
 * Build the canonical tool value. `overrides` lets a `set` or `coverage` call
 * report the state its own call has just committed, which the projection has
 * not folded yet at call time.
 */
function anchorValue(action, state, resolved, overrides = {}) {
  const contract = overrides.contract !== undefined ? overrides.contract : state.contract
  const coverage = overrides.coverage !== undefined ? { ...state.coverage, ...overrides.coverage } : state.coverage
  // A contract committed by this very call is in force for the current request,
  // even though the projection has not folded the call yet.
  const contractTurn = overrides.contractTurn !== undefined ? overrides.contractTurn : state.contractTurn
  const view = { ...state, contract, coverage, contractTurn }
  const budget = contract?.budget ?? resolved.stepBudget
  const used = contract === null ? 0 : Math.max(0, state.stepsThisTurn - contract.atStep)
  const items = contract === null ? [] : contract.mustDeliver.map(item => `${item} [${coverage[item] ?? 'unreported'}]`)
  const unfinished = unfinishedItems(view)
  const tally = { complete: 0, partial: 0, missing: 0, unreported: 0 }
  for (const item of contract?.mustDeliver ?? []) {
    const verdict = coverage[item]
    if (verdict === 'complete' || verdict === 'waived') tally.complete += 1
    else if (verdict === 'partial') tally.partial += 1
    else if (verdict === 'missing') tally.missing += 1
    else tally.unreported += 1
  }
  return {
    action,
    posture: derivePosture(view),
    baseline: state.baseline === null ? '' : primaryRequest(state.baseline.text),
    contract: {
      revision: contract?.revision ?? 0,
      objective: contract?.objective ?? '',
      done_when: contract?.doneWhen ?? '',
      must_deliver: contract?.mustDeliver ?? [],
      must_preserve: contract?.mustPreserve ?? [],
      out_of_scope: contract?.outOfScope ?? [],
      main_paths: contract?.mainPaths ?? [],
      user_decisions: contract?.userDecisions ?? [],
      open_direction_decisions: contract?.openDirectionDecisions ?? [],
      budget: contract?.budget ?? 0,
      steps_used: used,
    },
    coverage: { items, ...tally },
    unfinished: unfinished.map(row => `${row.item} [${row.verdict}]`),
    deferralSignals: state.deferrals.length,
    steps: state.steps,
    budget,
    remaining: Math.max(0, budget - used),
  }
}

// --------------------------------------------------------------------- apply --

/**
 * The pure helpers are exported for the offline self-check (`check.mjs`), which
 * runs without a Harness: the fold, the posture derivation, the answer mapping,
 * and the option guard are the parts where a silent mistake is most expensive,
 * so they are tested directly rather than only through `apply()`.
 */
export {
  projectionDefinition,
  derivePosture,
  unfinishedItems,
  withDefaultOptions,
  mapDriftAnswer,
  deferralMarkers,
  parseState,
  searchOutcome,
  deriveBudget,
  outstandingPlan,
  BUDGET_STEPS_PER_ITEM,
  COMMIT_RESERVE_STEPS,
  anchorValue,
  POLICY,
  FROZEN_CORE_NAMES,
}

/** Tools whose whole purpose is to settle a fact the model does not already hold. */
const SEARCH_TOOL = /^(web_search|web_fetch|fetch|mcp__[a-z0-9_]*__(web_)?(search|fetch))$/i

/**
 * Classify one search tool's result: did the lookup actually happen?
 *
 * This is the only unambiguous signal in this whole area. "Which claim needs an
 * external source" is a semantic question - measured in this project at 6.2%
 * precision, below chance - so the guard does NOT ask it. "The lookup failed" is a
 * fact, and the evidence that it matters is measured: of the 15 sessions in the
 * real logs that searched at all, 10 had a search fail, and the reply often simply
 * carried on.
 *
 * The status line is what web_fetch writes, verified against real logs:
 *   `Fetched <url> (HTTP 404)\n\nExternal web content follows. ...`
 * That framing sentence appears in EVERY fetch result - success or failure - so it
 * is emphatically not an error word. Only the leading status counts, which is why
 * the test insists a bare "404" further down the page is not a failure.
 *
 * @returns {{status: 'ok'|'failed'|'irrelevant'}}
 */
function searchOutcome(toolName, text) {
  const tool = String(toolName ?? '')
  if (!SEARCH_TOOL.test(tool)) return { status: 'irrelevant' }
  const body = typeof text === 'string' ? text : ''
  // Nothing came back at all. An empty answer is not an answer.
  if (body.trim().length === 0) return { status: 'failed', reason: 'empty result' }
  const fetched = /^\s*Fetched\s+\S+\s+\(HTTP (\d{3})\)/i.exec(body)
  if (fetched !== null) {
    const code = Number(fetched[1])
    if (code >= 400) return { status: 'failed', reason: `HTTP ${code}` }
    return { status: 'ok' }
  }
  if (/(^|\n)\s*(Error|Fetch failed|search failed)\b/i.test(body)) {
    return { status: 'failed', reason: 'error reported' }
  }
  if (/\bETIMEDOUT|ECONNREFUSED|ENOTFOUND|ECONNRESET|socket hang up|timed out\b/i.test(body)) {
    return { status: 'failed', reason: 'network error' }
  }
  return { status: 'ok' }
}

/**
 * Pull the text out of one post-execute result without assuming its exact shape.
 *
 * The precise `ToolExecutionResult` field layout was not verified here, and getting
 * it wrong would fail silently - a lesson already paid for twice in this project.
 * So every plausible carrier is tried, and the first non-empty string wins.
 */
function resultText(result) {
  if (typeof result === 'string') return result
  if (result === undefined || result === null) return ''
  for (const candidate of [result.text, result.value, result.message, result.error, result.reason]) {
    if (typeof candidate === 'string' && candidate.length > 0) return candidate
  }
  const content = result.content ?? result.message?.content
  if (Array.isArray(content)) {
    return content
      .map(part => (typeof part === 'string' ? part : typeof part?.text === 'string' ? part.text : ''))
      .join('')
  }
  return ''
}

/** Steps granted per plan item, mirroring POLICY.budgetStepsPerItem. */
const BUDGET_STEPS_PER_ITEM = 4
/** Steps withheld so the commit is not the thing that gets cut, mirroring POLICY. */
const COMMIT_RESERVE_STEPS = 3
/** A plan item marked like this is an answer, not a silent drop. */
const WAIVED_MARK = /\[waived\b/i

/**
 * A budget derived from the agent's own plan instead of a fixed number.
 *
 * Measured steps-per-item in the real logs: median 21, mean 73 - both describe
 * someone else's project, so they are not the coefficient. What is defensible is
 * the SHAPE: a budget that grows with the plan and always withholds a fixed
 * reserve. The reserve is the honest part - the guard cannot reserve steps from
 * outside, so it SUBTRACTS them from what the plan may consume, which is the only
 * mechanical way to keep the commit from being what gets cut.
 *
 * @returns {number|undefined} undefined when there is no plan to derive from.
 */
function deriveBudget(todos) {
  if (!Array.isArray(todos) || todos.length === 0) return undefined
  const granted = todos.length * BUDGET_STEPS_PER_ITEM - COMMIT_RESERVE_STEPS
  return Math.max(granted, COMMIT_RESERVE_STEPS + 1)
}

/**
 * The plan items the agent itself declared unfinished.
 *
 * It reads the same 'todos' projection the built-in todo_write tool feeds, so the
 * guard holds the agent to its own words rather than to an opinion of its own. A
 * waived marker in the content counts as an answer: the point is that nothing
 * closes SILENTLY, not that everything must be finished.
 */
function outstandingPlan(todos) {
  if (!Array.isArray(todos)) return []
  return todos.filter(item => {
    const status = item?.status
    if (status === 'completed') return false
    const content = String(item?.content ?? '')
    if (WAIVED_MARK.test(content)) return false
    return true
  })
}

/** Read the agent's plan, or undefined when this composition has no todo unit. */
function planOf(ctx, agent) {
  try {
    const todos = ctx.sessionProjections?.stateOf?.(agent?.session, 'todos')
    return Array.isArray(todos) ? todos : undefined
  } catch {
    // A composition without the todo unit must not take the guard down.
    return undefined
  }
}

/**
 * The plan is the agent's own; closing with it unfinished is measured behaviour.
 *
 * 19 of the 49 real sessions that wrote a todo list (39%) closed with items still
 * pending or in progress. The list already existed - what did not exist was
 * anything making it binding, because todo_write is a voluntary write.
 */
function renderPlanOutstanding(items) {
  const named = items.slice(0, 6).map(item => `- ${String(item?.content ?? '').slice(0, 90)}`)
  const more = items.length > named.length ? `- ...and ${items.length - named.length} more` : ''
  return [
    `drift-guard: closing with ${items.length} item(s) of your OWN plan unfinished.`,
    '',
    ...named,
    ...(more === '' ? [] : [more]),
    '',
    'You wrote this list. Nothing here is the guard opinion of the work - it is what you',
    'said was left. Two exits, both answers:',
    '- finish it, or',
    '- mark it waived with a reason and say why it is being dropped.',
    '',
    'This is not blocking the turn. It is refusing to let the list quietly stop meaning anything.',
  ].join('\n')
}

/** A long turn that never planned is the case the plan-first rule exists for. */
function renderPlanFirst(steps) {
  return [
    `drift-guard: ${steps} steps in and there is no task list.`,
    '',
    'On a turn this long, a list is what keeps the original request in view - and it is also',
    'the only thing that lets this guard hold you to a plan. Write one with todo_write, then',
    'carry on. This is asked once.',
  ].join('\n')
}

/**
 * Refuse to let a failed lookup pass as a settled fact.
 *
 * The guard does not judge which claims need a source - that is the semantic
 * question this project measured at 6.2% precision. It only reports what it saw:
 * the lookup came back with an error, and nothing has come back since. Both exits
 * are real answers; a silent third one is not.
 */
function renderSearchUnverified(reason) {
  return [
    `drift-guard: the last lookup failed (${reason}) and nothing has settled it since.`,
    '',
    'You may still be right - this is not a claim that the answer is wrong. It is a',
    'claim that it is UNVERIFIED, and the difference matters when the answer is about',
    'a version, an API, a flag or someone else\'s behaviour.',
    '',
    'Do one of these before closing:',
    '- retry, or fetch a different source, or',
    '- say plainly which part you could not verify, and what you are relying on instead.',
  ].join('\n')
}

/**
 * Install the guard.
 * @param {object} ctx - plugin context; registrations and listeners are scoped to it.
 * @param {object} [config] - the row config.
 */
export function apply(ctx, config) {
  const resolved = resolveConfig(config)

  ctx.sessionProjections.register(projectionDefinition({
    reportDeferrals: resolved.reportDeferrals,
    // Bound here rather than read inside the projection, so the projection stays a
    // pure fold: the store's location is configuration, not fold logic.
    loadLessons: () => loadLessons(resolved.lessonsFile),
  }))

  // Static policy: identical for every request, so it stays a stable prompt
  // prefix and never invalidates a reusable cache entry.
  ctx.systemPrompt.section({
    name: 'drift-guard:policy',
    order: ctx.systemPrompt.getSectionOrder('TOOL_GOAL') + 50,
    text: [
      '## Working on the user\'s original request',
      '',
      'The original request is frozen and shown again on every request. It does not change because you '
      + 'found a problem, a related bug, or a cleaner way to do things.',
      '',
      '### The contract',
      '',
      `Before exploring, commit a contract with ${ANCHOR_TOOL}: the objective, the one check that proves `
      + 'completion, every item that must be delivered, what must be preserved, and what is out of scope. '
      + 'While the contract is open it is frozen for you.',
      '',
      '### Complete delivery',
      '',
      'Deliver the whole contract, not a labelled subset of it. Each of these is a direction change, not a '
      + 'completion, and needs the user\'s explicit agreement first:',
      '',
      '- shipping "a minimal version", a stub, a placeholder, or a scaffold as the result;',
      '- deferring a must-deliver item to a follow-up, a later pass, or "next time";',
      '- leaving an item partially implemented while describing the task as finished.',
      '',
      'Difficulty, tedium, or length is never a reason to shrink the job, and "it would take a while" is '
      + 'not a reason to ask for less. When part of the work is genuinely blocked or genuinely optional, '
      + `report it with ${DRIFT_TOOL} (reason incomplete-delivery) and let the user decide — never decide on `
      + 'their behalf by quietly renaming the remainder.',
      '',
      `Record a coverage verdict with ${ANCHOR_TOOL} action "coverage" for each must-deliver item as you `
      + 'finish it, with the evidence that proves it. An unfinished item blocks the turn from closing with a '
      + 'confident report.',
      '',
      '### Direction changes',
      '',
      `A material change of direction — scope, constraints, user-visible behaviour, architecture, data model, `
      + `compatibility, an invalidated assumption, or a direction the user just introduced — is the user's `
      + `decision, not yours: report it with ${DRIFT_TOOL} before doing that work, not afterwards as a summary. `
      + 'Routine engineering choices are yours: naming, file layout, an in-scope helper, test placement, '
      + 'formatting. Do not re-ask settled decisions.',
      '',
      'When the guard injects a checkpoint, treat it as binding: answer it by returning to the main line, by '
      + 'asking the user to approve a direction change, or by stopping and reporting what is blocked. Do not '
      + 'answer it by continuing the sub-problem you were already in.',
    ].join('\n'),
  })

  // Dynamic context: the frozen baseline plus the live contract, coverage, and
  // posture. The assembly scope is the agent, whose session carries the state.
  ctx.systemPrompt.context({
    name: 'drift-guard',
    order: ctx.systemPrompt.getContextOrder('SUBAGENT_DELEGATION') + 20,
    text: (assemble) => {
      const agent = assemble?.scope
      if (agent?.session === undefined) return ''
      const state = stateOf(ctx, agent)
      if (state === undefined) return ''
      const parts = []
      // Lessons come first and are already rendered, so their bytes are the same
      // at every step of the session. Nothing occupancy-related is injected here,
      // on purpose: a value that moved would invalidate the provider's cached
      // prompt prefix. Read occupancy with USAGE_TOOL instead.
      if (typeof state.lessonsText === 'string' && state.lessonsText.length > 0) {
        parts.push(state.lessonsText)
      }
      if (state.baseline === null && state.contract === null) return parts.join('\n\n')
      if (state.baseline !== null) parts.push(renderBaseline(state.baseline))
      parts.push(renderContract(state, resolved.stepBudget))
      return parts.join('\n\n')
    },
  })

  ctx.tools.register({
    name: ANCHOR_TOOL,
    description: ANCHOR_DESCRIPTION,
    parameters: ANCHOR_PARAMETERS,
    output: {
      schema: ANCHOR_VALUE_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    presentCall: args => ({
      card: 'generic',
      title: args?.action === 'get'
        ? 'Read task contract'
        : args?.action === 'coverage' ? 'Record coverage' : 'Commit task contract',
      kind: args?.action === 'get' ? 'read' : 'other',
    }),
    execute(args, exec) {
      const agent = exec.agent
      if (agent === undefined) throw new Error(`${ANCHOR_TOOL} requires a calling agent`)
      if (args?.action === 'set' && !isRootAgent(ctx, agent)) throw delegatedRefusal(ANCHOR_TOOL)
      const requested = validateAnchorArgs(args)
      const state = stateOf(ctx, agent) ?? initialState()

      if (requested.action === 'coverage') {
        const contract = state.contract
        if (contract === null) {
          throw new Error(`${ANCHOR_TOOL}: no contract is committed yet, so there is nothing to report coverage for`)
        }
        if (contract.mustDeliver.length > 0 && !contract.mustDeliver.includes(requested.item)) {
          throw new Error(
            `${ANCHOR_TOOL}: "${requested.item}" is not one of the must-deliver items `
            + `(${contract.mustDeliver.join('; ')}). Report coverage for a declared item, or revise the contract first.`,
          )
        }
        const unauthorized = !AUTHORIZED_VERDICTS.includes(requested.state) && !hasDirectHumanInput(ctx, agent)
        const projected = { ...state, coverage: { ...state.coverage, [requested.item]: requested.state } }
        const value = anchorValue('coverage', state, resolved, {
          coverage: { [requested.item]: requested.state },
        })
        // The verdict is recorded either way — it is the agent's own claim, and
        // hiding it would only make the ledger lie. What it does not do is
        // authorize the shortfall: that still needs the user, so the result
        // carries the list and the exit paths.
        exec.deferContext(contextMessage(
          unauthorized
            ? `${renderUnfinished(projected)}\n\nNote: "${requested.item}" was recorded as ${requested.state}, `
              + 'but no human turn authorized any shortfall. Shipping less than the contract owes needs the '
              + `user's explicit agreement: report it with ${DRIFT_TOOL} (reason incomplete-delivery), or finish it.`
            : `drift-guard coverage recorded: ${requested.item} [${requested.state}]`
              + (requested.evidence.length === 0 ? '' : ` — evidence: ${requested.evidence.join('; ')}`),
          'notice',
          `coverage ${requested.item}: ${requested.state}`,
        ))
        return Promise.resolve(value)
      }

      if (requested.action === 'set' && !hasDirectHumanInput(ctx, agent)) {
        throw new Error(
          `${ANCHOR_TOOL} action "set" requires a direct human turn on a top-level agent: the contract the user `
          + 'asked for is not yours to widen. Report the change with ' + DRIFT_TOOL + ' (or ask_user_question for a '
          + 'scope question) and set the contract in the turn that carries the user\'s answer.',
        )
      }

      if (requested.action === 'set') {
        const contract = contractFromArgs(requested, state.steps, Date.now(), state.contract)
        // The contract must sit in the transcript right after the call that
        // created it, so a later compaction reads it as history rather than as a
        // claim the agent made up. The checklist rides with it, so the model
        // holds the full list rather than a summary of it.
        exec.deferContext(contextMessage(
          'drift-guard recorded this contract and will hold you to it:\n\n'
          + renderContract({ ...state, contract }, resolved.stepBudget)
          + '\n\n'
          + (contract.mustDeliver.length === 0
            ? 'No must-deliver items were declared. If this task owes more than one artifact, revise the '
              + 'contract so the completeness ledger can bound it.'
            : `Coverage ledger opened for ${contract.mustDeliver.length} item(s). Record each with `
              + `${ANCHOR_TOOL} action "coverage" as it is finished, and finish all of them before reporting done.`),
          'instructions',
        ))
        return Promise.resolve(anchorValue('set', state, resolved, { contract, contractTurn: state.turnKey }))
      }

      return Promise.resolve(anchorValue('get', state, resolved))
    },
  })

  ctx.tools.register({
    name: DRIFT_TOOL,
    description: DRIFT_DESCRIPTION,
    parameters: DRIFT_PARAMETERS,
    output: {
      schema: DRIFT_VALUE_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    presentCall: args => ({
      card: 'generic',
      title: `Report direction change: ${String(args?.reason ?? '')}`,
      kind: 'other',
    }),    async execute(args, exec) {
      const agent = exec.agent
      if (agent === undefined) throw new Error(`${DRIFT_TOOL} requires a calling agent`)
      const requested = validateDriftArgs(args)
      if (!isRootAgent(ctx, agent)) throw delegatedRefusal(DRIFT_TOOL)

      // Full-auto resolution. The user asked not to be interrupted, so this path
      // decides - but only when the change is mechanically defensible: it is not a
      // reduction, it quotes the original request verbatim, and the cumulative
      // automatic-change budget is not spent. Anything else falls through to the
      // question, so auto mode can never silently shrink the job.
      if (resolved.autoDrift && !hasDirectHumanInput(ctx, agent)) {
        const state = stateOf(ctx, agent) ?? initialState()
        const verdict = autoResolution(state, resolved, requested)
        if (verdict.kind === 'allow') {
          const prior = Number.isFinite(state.mutationRatio) ? state.mutationRatio : 0
          const ratio = prior + verdict.mutationDelta
          exec.deferContext(contextMessage([
            'drift-guard resolved a direction change WITHOUT asking you:',
            `- reason: ${requested.reason}`,
            `- what it will do: ${requested.description}`,
            requested.required_change === undefined ? '' : `- contract change: ${requested.required_change}`,
            `- authorized by the original request, quoted verbatim: ${verdict.accepted.join(' | ')}`,
            `- cumulative automatic-change ratio after this: ${(ratio * 100).toFixed(0)}%`,
            `- next: commit the new contract with ${ANCHOR_TOOL} action "set"`,
          ].filter(line => line !== '').join('\n'), 'notice',
          `auto-resolved ${requested.reason}: ${requested.description}`))
          return {
            action: 'report',
            reason: requested.reason,
            description: requested.description,
            decision: 'approve',
            note: `auto: ${verdict.accepted.length} quote(s); ratio ${(ratio * 100).toFixed(0)}%`,
            outcome: 'Resolved automatically from a verbatim quote of the original request. Commit the '
              + `new contract with ${ANCHOR_TOOL} action "set", then continue.`,
          }
        }
        exec.deferContext(contextMessage(
          `drift-guard could NOT resolve this automatically and is asking you: ${escalationReason(verdict.kind)}.\n`
          + `- reason: ${requested.reason}\n- what it wants to do: ${requested.description}`,
          'notice',
          `escalated ${requested.reason}: ${verdict.kind}`,
        ))
      }

      const presented = withDefaultOptions(requested.options)
      const userQuestions = ctx.get('userQuestions')
      if (userQuestions?.ask === undefined) {
        return {
          action: 'report',
          reason: requested.reason,
          description: requested.description,
          decision: 'unanswered',
          note: '',
          outcome: 'No question channel is available in this composition, so the user could not be asked. '
            + 'Stop and report the direction change in your final message instead of deciding it yourself.',
        }
      }
      const question = {
        id: `${DRIFT_TOOL}-${globalThis.crypto.randomUUID().slice(0, 8)}`,
        header: 'Direction change',
        question: `This would change the task direction: ${requested.description} (reason: ${requested.reason}). How should I proceed?`,
        options: presented.map(option => (
          option.description === undefined
            ? { label: option.label }
            : { label: option.label, description: option.description }
        )),
      }
      if (requested.required_change !== undefined) {
        question.detail = `Required contract change: ${requested.required_change}`
      }

      let mapped
      try {
        const answer = await userQuestions.ask({ questions: [question], agent, signal: exec.signal })
        const first = Array.isArray(answer?.answers) ? answer.answers[0] : undefined
        mapped = mapDriftAnswer(first?.selected, first?.custom, presented)
      } catch (error) {
        // Record nothing: an uninterpretable answer must never become a decision.
        return {
          action: 'report',
          reason: requested.reason,
          description: requested.description,
          decision: 'unanswered',
          note: '',
          outcome: `The answer could not be interpreted (${error.message}). Ask the user again before proceeding.`,
        }
      }

      const outcome = mapped.decision === 'approve'
        ? `Approved. Commit the new contract with ${ANCHOR_TOOL} action "set", then continue on the new direction.`
        : mapped.decision === 'reject'
          ? 'Rejected. Stay within the current contract and adjust your approach.'
          : `Revised to: "${mapped.note}". Commit the new contract with ${ANCHOR_TOOL} action "set", then continue.`
      // The decision rides the tool result as deferred context, so it is durable
      // even when the question UI or the model's next step fails.
      exec.deferContext(contextMessage(
        'drift-guard recorded a direction decision:\n'
        + `- reason: ${requested.reason}\n`
        + `- description: ${requested.description}\n`
        + (requested.required_change === undefined ? '' : `- required change: ${requested.required_change}\n`)
        + `- decision: ${mapped.decision}${mapped.note === null ? '' : ` (${mapped.note})`}\n`
        + `- next: ${outcome}`,
        'instructions',
      ))
      return {
        action: 'report',
        reason: requested.reason,
        description: requested.description,
        decision: mapped.decision,
        note: mapped.note ?? '',
        outcome,
      }
    },
  })
  ctx.tools.register({
    name: USAGE_TOOL,
    description: 'Read the CURRENT context occupancy: how much of the model context window the next request would use, and how much is left. Read-only, no arguments. Occupancy is deliberately NOT injected into your prompt, because a value that changes inside the system prompt sits at the front of the request and invalidates the provider\'s cached prompt prefix. Call this when you want to know how much room remains before compaction, especially if the contract still owes substantial work. It reports available:false with a reason rather than inventing a number when DSH\'s token meter has not measured the prompt yet.',
    parameters: USAGE_PARAMETERS,
    output: {
      schema: USAGE_VALUE_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    presentCall: () => ({ card: 'generic', title: 'Read context occupancy', kind: 'read' }),
    isReadOnly: () => true,
    async execute(_args, exec) {
      const agent = exec.agent
      if (agent === undefined) throw new Error(`${USAGE_TOOL} requires a calling agent`)
      return readContextUsage(ctx, agent)
    },
  })
  /**
   * Record a lesson. This is how the guard stops re-learning the same thing every
   * session: the entry outlives the session that produced it.
   */
  ctx.tools.register({
    name: LESSON_TOOL,
    description: 'Record a LESSON so it survives this session: a mistake that was actually made, or a practice that actually worked, plus the situation that should bring it back. The store is append-only - a wrong lesson is retired by recording a later one that supersedes it, never by editing or deleting. Use this the moment you notice you repeated a mistake, or found a way of working worth repeating. Triggers are a closed list; pick the one naming the situation, do not invent one.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['symptom', 'rule', 'trigger'],
      properties: {
        symptom: { type: 'string', description: 'What actually went wrong (or right), concretely enough that a future reader recognises it happening again.' },
        rule: { type: 'string', description: 'What to do instead, written as an instruction to a future self.' },
        trigger: {
          type: 'string',
          enum: LESSON_TRIGGER_NAMES,
          description: Object.entries(LESSON_TRIGGERS).map(([key, text]) => key + ': ' + text).join(' | '),
        },
        trigger_note: { type: 'string', description: 'Optional: anything the trigger name does not capture about when this applies.' },
        supersedes: { type: 'string', description: 'Optional: the id of an earlier lesson this one replaces. The old entry stays in the store, marked superseded, so text already injected elsewhere does not move.' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'trigger', 'stored', 'note'],
        properties: {
          id: { type: 'string' },
          trigger: { type: 'string' },
          stored: { type: 'number', description: 'How many lessons the store now holds in total.' },
          note: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    presentCall: () => ({ card: 'generic', title: 'Record a lesson', kind: 'other' }),
    async execute(args, exec) {
      const agent = exec.agent
      if (agent === undefined) throw new Error(`${LESSON_TOOL} requires a calling agent`)
      if (!isRootAgent(ctx, agent)) throw delegatedRefusal(LESSON_TOOL)
      const record = recordLesson(resolved.lessonsFile, args, Date.now())
      const total = loadLessons(resolved.lessonsFile).lessons.length
      return {
        id: String(record.id),
        trigger: String(record.trigger),
        stored: total,
        note: 'Recorded. It is injected at the start of FUTURE sessions, not this one: the injected block '
          + 'is rendered once per session and held, so the prompt prefix stays byte-identical and a cached '
          + 'prefix is not invalidated mid-conversation.',
      }
    },
  })

  /** Read the stored lessons without changing anything. */
  ctx.tools.register({
    name: LESSONS_TOOL,
    description: 'Read the stored cross-session lessons, including which are still active and which a later entry has superseded. Read-only, no arguments.',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['total', 'active', 'triggers', 'lessons'],
        properties: {
          total: { type: 'number' },
          active: { type: 'number' },
          triggers: { type: 'string', description: 'The closed set of trigger names.' },
          lessons: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['id', 'trigger', 'symptom', 'rule', 'active'],
              properties: {
                id: { type: 'string' },
                trigger: { type: 'string' },
                symptom: { type: 'string' },
                rule: { type: 'string' },
                active: { type: 'boolean', description: 'False once a later lesson supersedes it. Superseded entries are kept so injected text never has to move.' },
                supersededBy: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    presentCall: () => ({ card: 'generic', title: 'Read stored lessons', kind: 'read' }),
    isReadOnly: () => true,
    async execute() {
      const store = loadLessons(resolved.lessonsFile)
      const active = new Set(activeLessons(store).map(lesson => lesson.id))
      return {
        total: store.lessons.length,
        active: active.size,
        triggers: LESSON_TRIGGER_NAMES.join(', '),
        lessons: store.lessons.map(lesson => ({
          id: String(lesson.id),
          trigger: String(lesson.trigger),
          symptom: String(lesson.symptom),
          rule: String(lesson.rule),
          active: active.has(lesson.id),
          ...lesson.supersededBy === undefined ? {} : { supersededBy: String(lesson.supersededBy) },
        })),
      }
    },
  })

  /**
   * Per-agent guard memory: checkpoint dedupe within a turn, the forced-steer
   * count, and the lifetime message ceiling. Plugin memory is a derived cache —
   * the durable facts live in the projection.
   */
  const memory = new WeakMap()

  /** The current guard memory for one agent, or a fresh entry. */
  function entryFor(agent) {
    return memory.get(agent) ?? {
      turnKey: null,
      contractSeq: null,
      atStep: -1,
      messages: 0,
      steers: 0,
      // Friction evidence. Every field is a COUNT of something the event stream
      // states outright - never a judgement about whether a call went well, which
      // a passive observer has no way to make.
      calls: new Map(),
      writes: new Map(),
      history: [],
      lessonRecorded: false,
      // Request-scoped, and cleared by any successful lookup: what matters is
      // whether the LAST attempt to settle an external fact actually landed.
      searchFailed: false,
      searchReason: '',
      searchReminded: false,
    }
  }

  /** How many times one identical call may repeat before it counts as thrashing. */
  const REPEAT_CALL_LIMIT = 2
  /** How many times one file may be written in a turn before it counts as thrashing. */
  const REPEAT_WRITE_LIMIT = 3
  /** Steps after which an unfinished turn is worth recording something about. */
  const LONG_TURN_LIMIT = 20
  /** Consecutive tool-free turn endings before the guard supplies a real instruction. */
  const STALL_INTERVENE_AT = 2
  /** ...and before it stops looping and hands the stall to the human instead. */
  const STALL_ESCALATE_AT = 4

  /**
   * Which lesson triggers this turn's own mechanics justify.
   *
   * All three are counts, not opinions: the same call twice, one file written
   * three times, a twenty-step turn. A guard cannot know whether a failure was
   * instructive - only the agent knows that - so it does not try. What it can do
   * is notice that this turn involved thrashing and then insist the agent record
   * whatever it learned, which is the part that would otherwise be skipped.
   */
  function frictionForTurn(entry, state) {
    const fired = new Set()
    for (const count of entry.calls?.values() ?? []) {
      if (count >= REPEAT_CALL_LIMIT) fired.add('repeated-call')
    }
    for (const count of entry.writes?.values() ?? []) {
      if (count >= REPEAT_WRITE_LIMIT) fired.add('before-editing-tests')
    }
    const steps = Number.isFinite(state?.stepsThisTurn) ? state.stepsThisTurn : 0
    if (steps >= LONG_TURN_LIMIT) fired.add('long-turn')
    return fired
  }

  /**
   * A fresh per-turn record. atStep and messages go back to their defaults,
   * exactly as budgetCheckpoint's own new-request branch does: carrying them over
   * made the guard believe a checkpoint had already been sent at this step, which
   * silently suppressed the first one of the new request.
   */
  function rebaseForTurn(turnKey) {
    return {
      turnKey,
      contractSeq: null,
      atStep: -1,
      messages: 0,
      steers: 0,
      calls: new Map(),
      writes: new Map(),
      history: [],
      lessonRecorded: false,
      searchFailed: false,
      searchReason: '',
      searchReminded: false,
      planReminded: false,
      planFirstAsked: false,
    }
  }

  /** A stable key for one call, so repetitions of the SAME call are visible. */
  function callKey(exec) {
    const args = typeof exec?.data?.arguments === 'string' ? exec.data.arguments : ''
    return `${exec?.name ?? ''} ${args}`.slice(0, 400)
  }

  /**
   * Raise a stored lesson when the call in front of us matches its trigger.
   *
   * Deliberately NOT a gate: it adds a message and never blocks. The user chose a
   * reminder over enforcement, and a reminder that halts work would be a gate
   * wearing a reminder's name.
   *
   * Each lesson is raised at most once per agent, because a reminder that repeats
   * on every matching call is noise, and noise is what teaches a reader to ignore
   * reminders.
   */
  function lessonReminder(ctx2, exec, entryFor2) {
    const agent = exec?.agent
    if (agent === undefined || agent.session === undefined) return undefined
    const state = stateOf(ctx2, agent)
    if (state === undefined || !Array.isArray(state.lessons) || state.lessons.length === 0) return undefined
    const args = argsOf(exec) ?? {}
    const fired = triggersForCall(exec.name, args, state, entryFor2(agent).history ?? [])
    const due = lessonsForTriggers(state.lessons, fired)
    if (due.length === 0) return undefined
    const entry = entryFor2(agent)
    const raised = entry.lessonsRaised ?? new Set()
    const fresh = due.filter(lesson => !raised.has(lesson.id))
    if (fresh.length === 0) return undefined
    const next = new Set(raised)
    for (const lesson of fresh) next.add(lesson.id)
    memory.set(agent, { ...entry, lessonsRaised: next })
    const trigger = [...fired].find(name => fresh.some(lesson => lesson.trigger === name)) ?? fresh[0].trigger
    return contextMessage(
      fresh.map(lesson => renderReminder(lesson, lesson.trigger)).join('\n\n'),
      'notice',
      `lesson(s) ${fresh.map(lesson => lesson.id).join(',')} matched ${trigger}`,
    )
  }

  // Enrich, never veto. Post-execute sees every accepted call, including ones a
  // later listener denies, so the checkpoint cannot be starved by policy.
  ctx.on('tools/post-execute', async (exec, result, next) => {
    // Friction evidence is accumulated here, because this is the only hook that
    // sees every accepted call. Counting only: the guard never inspects whether a
    // call SUCCEEDED, which it cannot know, but it can see the same call twice and
    // the same file written three times.
    if (exec?.agent !== undefined) {
      const state = stateOf(ctx, exec.agent)
      const entry = entryFor(exec.agent)
      const current = entry.turnKey === state?.turnKey ? entry : rebaseForTurn(state?.turnKey ?? null)
      const calls = new Map(current.calls)
      const key = callKey(exec)
      calls.set(key, (calls.get(key) ?? 0) + 1)
      const writes = new Map(current.writes)
      const target = String(argsOf(exec)?.file_path ?? argsOf(exec)?.path ?? '')
      if (target !== '') writes.set(target, (writes.get(target) ?? 0) + 1)
      // The same calls, in order, so the reminder path and the friction path agree
      // on what "repeated" means instead of each inventing its own idea.
      const history = [...(current.history ?? []), [exec.name, argsOf(exec) ?? {}]].slice(-40)
      // Did the lookup actually land? The classification is a fact about the tool
      // result, not a judgement about the claim - see searchOutcome.
      const outcome = searchOutcome(exec.name, resultText(result))
      const searchFailed = outcome.status === 'irrelevant'
        ? (current.searchFailed ?? false)
        : outcome.status === 'failed'
      const searchReason = outcome.status === 'failed' ? (outcome.reason ?? 'lookup failed') : ''
      memory.set(exec.agent, {
        ...current,
        calls,
        writes,
        history,
        searchFailed,
        searchReason: searchFailed ? searchReason : '',
        searchReminded: searchFailed ? (current.searchReminded ?? false) : false,
        // The agent recording a lesson is the point of the mechanism, so it is
        // tracked here rather than inferred later from the store's length.
        lessonRecorded: current.lessonRecorded || exec.name === LESSON_TOOL,
      })
    }
    const message = budgetCheckpoint(ctx, resolved, exec, memory, entryFor)
    const lesson = lessonReminder(ctx, exec, entryFor)
    const downstream = await next()
    const prepend = [message, lesson].filter(entry => entry !== undefined)
    if (prepend.length === 0) return downstream
    const additionalContexts = [...prepend, ...downstream.additionalContexts ?? []]
    if (downstream.kind === 'block') {
      return { kind: 'block', feedback: downstream.feedback, additionalContexts }
    }
    return { ...downstream, additionalContexts }
  })

  // The turn is about to close and the model owes no response. Two findings are
  // answered here, because this is the only mechanism that does not depend on
  // the model choosing to comply.
  ctx.on('agent/turn-stopping', ({ agent }) => {
    const state = stateOf(ctx, agent)
    if (state === undefined) return
    const stored = memory.get(agent)
    // An agent whose calls were never counted has NO entry yet, and entryFor
    // hands back a sentinel with turnKey null. Comparing that against the real
    // turn key made "sameRequest" false, which silently skipped the friction path
    // for exactly the turns that touched no tools. A missing entry means THIS
    // turn, rebased to zero - not a different request.
    const sameRequest = stored !== undefined && stored.turnKey === state.turnKey
    const entry = sameRequest ? stored : rebaseForTurn(state.turnKey)
    // The request — not the contract — is the boundary. Keying the memory on
    // the contract would let a contract replaced inside one turn reuse a spend
    // the current request already made.
    const steers = sameRequest ? entry.steers : 0
    if (steers >= resolved.maxCheckpointsPerTurn) return
    const spend = { turnKey: state.turnKey, contractSeq: state.contractSeq, atStep: entry.atStep, messages: entry.messages }

    // A run of turns that ended without using a tool at all. Measured on 194 real
    // logs: 278 such turn endings, longest run 157, driven by the bare
    // auto-continuation re-arming. The guard cannot stop that re-arming, but it can
    // make sure the next continuation carries something actionable rather than
    // being answered with another "继续。". Any tool call clears the streak, so a
    // normal concluding turn - which always followed real work - never trips this.
    // Checked BEFORE the contract-shaped gates below: stalling is orthogonal to
    // contracts, and it is most likely exactly when there is no contract at all.
    // The agent's own plan, before anything the guard believes. Checked ahead of the
    // contract gates because it is likewise orthogonal: whatever the contract says,
    // the agent already wrote down what it had not done. 39% of real sessions that
    // planned closed with items outstanding, so this is measured, not hypothetical.
    const todos = planOf(ctx, agent)
    const outstanding = outstandingPlan(todos)
    if (outstanding.length > 0 && entry.planReminded !== true) {
      memory.set(agent, { ...spend, steers: steers + 1, planReminded: true })
      steer(agent, renderPlanOutstanding(outstanding))
      return
    }
    // No plan at all on a long turn: the plan-first rule, asked once.
    const planSteps = Number.isFinite(state.stepsThisTurn) ? state.stepsThisTurn : 0
    if (todos === undefined && planSteps >= resolved.planBySteps && entry.planFirstAsked !== true) {
      memory.set(agent, { ...spend, steers: steers + 1, planFirstAsked: true })
      steer(agent, renderPlanFirst(planSteps))
      return
    }

    const stalled = Number.isFinite(state.stalledTurns) ? state.stalledTurns : 0
    // A failed lookup that nothing has settled since. Checked before the
    // contract-shaped gates for the same reason the stall check is: it is
    // orthogonal to contracts, and a wrong answer about the outside world is worse
    // than an imprecise plan.
    if (entry.searchFailed === true && entry.searchReminded !== true) {
      memory.set(agent, { ...spend, steers: steers + 1, searchReminded: true })
      steer(agent, renderSearchUnverified(entry.searchReason || 'lookup failed'))
      return
    }
    if (stalled >= STALL_ESCALATE_AT) {
      if (entry.stallEscalated === true) return
      memory.set(agent, { ...spend, steers: steers + 1, stallEscalated: true })
      steer(agent, renderStallEscalation(stalled))
      return
    }
    if (stalled >= STALL_INTERVENE_AT) {
      if (entry.stallIntervened === true) return
      memory.set(agent, { ...spend, steers: steers + 1, stallIntervened: true })
      steer(agent, renderStallDirective(stalled))
      return
    }

    // Completeness first: an unfinished must-deliver item is the more specific
    // and more serious finding, so it wins the one steer this turn allows.
    if (resolved.blockUnfinished) {
      const unfinished = unfinishedItems(state)
      if (unfinished.length > 0) {
        memory.set(agent, { ...spend, steers: steers + 1 })
        steer(agent, renderUnfinished(state))
        return
      }
    }

    if (!contractInForce(state)) {
      // A request with no contract of its own has nothing to hold the work to.
      // Ask once, at the configured mark, then let it run: an agent that refuses
      // to plan is not helped by force, and a periodic nag is exactly the noise
      // this discipline exists to avoid.
      if (state.stepsThisTurn < resolved.askAnchorAt) return
      if (state.askedAnchorAtTurn === state.turnKey) return
      memory.set(agent, { ...spend, steers: steers + 1 })
      steer(agent, renderAnchorRequest(state))
      return
    }

    const budget = state.contract.budget ?? resolved.stepBudget
    const used = Math.max(0, state.stepsThisTurn - state.contract.atStep)
    // Budget spent and the turn is closing with the checkpoint unanswered.
    if (used >= budget) {
      memory.set(agent, { ...spend, steers: steers + 1 })
      steer(agent, renderCheckpoint(state, resolved.stepBudget))
      return
    }

    // Last, and only if nothing more specific already spoke: a turn that thrashed
    // should leave a lesson behind. The guard states WHAT it counted and stays
    // silent about what it means, because it cannot tell an instructive failure
    // from a typo. It insists on the act of recording - the part that gets skipped
    // - exactly once, inside the same steer budget as everything else. Refusing is
    // allowed and the turn still closes: a recording requirement that hard-blocks
    // would be a gate wearing a request's name.
    // One request per turn, and the flag - not the steer count - is what enforces
    // it: the count is recomputed from the original entry on every call, so it
    // alone let a second call through while the cap was still two.
    if (!entry.lessonRecorded && !entry.lessonRequested) {
      const fired = frictionForTurn(entry, state)
      if (fired.size > 0) {
        memory.set(agent, { ...spend, steers: steers + 1, lessonRequested: true })
        steer(agent, renderLessonRequest(state, [...fired]))
      }
    }
  })
}

/**
 * The checkpoint to attach to this call, or undefined. It rides the call path
 * the model is already reading, so it cannot be missed; it is emitted at most
 * once per closed step, and at most {@link DEFAULT_MAX_CHECKPOINT_MESSAGES} per
 * committed contract.
 */
function budgetCheckpoint(ctx, resolved, exec, memory, entryFor) {
  const agent = exec.agent
  if (agent === undefined) return undefined
  const state = stateOf(ctx, agent)
  if (state === undefined) return undefined
  const entry = entryFor(agent)
  // A new request — and a contract committed inside it — starts a fresh
  // allowance. Keying on the request rather than the contract keeps the
  // message ceiling from being spent twice inside one turn.
  const seen = entry.turnKey === state.turnKey
    ? entry
    : { turnKey: state.turnKey, contractSeq: state.contractSeq, atStep: -1, messages: 0, steers: 0 }

  if (!contractInForce(state)) {
    if (exec.name === ANCHOR_TOOL) return undefined
    if (state.stepsThisTurn !== resolved.askAnchorAt) return undefined
    if (state.askedAnchorAtTurn === state.turnKey) return undefined
    if (seen.atStep === state.stepsThisTurn) return undefined
    memory.set(agent, { ...seen, atStep: state.stepsThisTurn })
    return contextMessage(renderAnchorRequest(state), 'notice', `no contract at step ${state.stepsThisTurn}`)
  }

  const budget = state.contract.budget ?? resolved.stepBudget
  const used = Math.max(0, state.stepsThisTurn - state.contract.atStep)
  if (used < budget) return undefined
  // A checkpoint asks the agent to audit progress. When every must-deliver item
  // already carries an authorizing verdict there is nothing left to audit, and
  // asking anyway is pure noise — the kind that trains the reader to ignore the
  // guard. (The turn-stopping gate has always had this guard; the message path
  // was missing it, so a long but *finished* request was nagged on every
  // further step.)
  if (unfinishedItems(state).length === 0) return undefined
  if (seen.messages >= resolved.maxCheckpointMessages || seen.atStep === state.stepsThisTurn) return undefined
  memory.set(agent, { ...seen, atStep: state.stepsThisTurn, messages: seen.messages + 1 })
  return contextMessage(
    renderCheckpoint(state, resolved.stepBudget),
    'notice',
    `contract budget spent: ${used}/${budget} steps`,
  )
}
