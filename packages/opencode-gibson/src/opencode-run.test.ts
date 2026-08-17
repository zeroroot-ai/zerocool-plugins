import assert from "node:assert/strict"
import test from "node:test"

import { opencodeArgs, parseOpencodeEvents } from "./opencode-run.js"

/**
 * The fixture below is REAL output, not a hand-written guess: it is what
 * `opencode run --format json --pure --dir . "say hi"` printed on opencode
 * 1.18.13. Hand-written fixtures are how a parser passes its own tests and
 * still fails against the tool it parses.
 */
const REAL_OUTPUT = [
  `{"type":"step_start","timestamp":1786987016649,"sessionID":"ses_fef461e36ffeDhqkkAtmFueEBd","part":{"id":"prt_010b9f1c6001paDxDDzq4VBUkd","messageID":"msg_010b9e473001iSke19fN799Qlo","sessionID":"ses_fef461e36ffeDhqkkAtmFueEBd","type":"step-start"}}`,
  `{"type":"text","timestamp":1786987017053,"sessionID":"ses_fef461e36ffeDhqkkAtmFueEBd","part":{"id":"prt_010b9f289001Uptk4cH3gToULB","messageID":"msg_010b9e473001iSke19fN799Qlo","sessionID":"ses_fef461e36ffeDhqkkAtmFueEBd","type":"text","text":"Hi there! 👋 How can I help you today?","time":{"start":1786987016841,"end":1786987017028}}}`,
  `{"type":"step_finish","timestamp":1786987017053,"sessionID":"ses_fef461e36ffeDhqkkAtmFueEBd","part":{"id":"prt_010b9f34b001k0BOWFDixPWMeb","reason":"stop","messageID":"msg_010b9e473001iSke19fN799Qlo","sessionID":"ses_fef461e36ffeDhqkkAtmFueEBd","type":"step-finish","tokens":{"total":9787,"input":8740,"output":23,"reasoning":0,"cache":{"write":0,"read":1024}},"cost":0}}`,
].join("\n")

test("parseOpencodeEvents reads a real run's text, session and accounting", () => {
  const run = parseOpencodeEvents(REAL_OUTPUT)
  assert.equal(run.text, "Hi there! 👋 How can I help you today?")
  assert.equal(run.sessionId, "ses_fef461e36ffeDhqkkAtmFueEBd")
  assert.equal(run.finishReason, "stop")
  assert.equal(run.tokens.total, 9787)
  assert.equal(run.tokens.output, 23)
  assert.equal(run.events, 3)
})

test("parseOpencodeEvents concatenates every text part in order", () => {
  const out = [
    `{"type":"text","sessionID":"s1","part":{"type":"text","text":"first "}}`,
    `{"type":"text","sessionID":"s1","part":{"type":"text","text":"second"}}`,
  ].join("\n")
  assert.equal(parseOpencodeEvents(out).text, "first second")
})

test("parseOpencodeEvents sums a multi-step run rather than keeping the last step", () => {
  // A real coding task is many steps. Reporting only the last step's tokens
  // would under-bill the mission by however many steps came before it.
  const out = [
    `{"type":"step_finish","sessionID":"s1","part":{"reason":"stop","tokens":{"total":100,"input":80,"output":20,"reasoning":0},"cost":0.5}}`,
    `{"type":"step_finish","sessionID":"s1","part":{"reason":"stop","tokens":{"total":300,"input":250,"output":50,"reasoning":0},"cost":1.25}}`,
  ].join("\n")
  const run = parseOpencodeEvents(out)
  assert.equal(run.tokens.total, 400)
  assert.equal(run.tokens.output, 70)
  assert.equal(run.cost, 1.75)
})

test("parseOpencodeEvents skips a non-JSON line instead of failing the run", () => {
  // A stray log line on stdout must not cost a mission node its result.
  const out = [
    `INFO  something opencode decided to print`,
    `{"type":"text","sessionID":"s1","part":{"type":"text","text":"kept"}}`,
  ].join("\n")
  const run = parseOpencodeEvents(out)
  assert.equal(run.text, "kept")
  assert.equal(run.events, 1)
})

test("parseOpencodeEvents ignores event types this version does not know", () => {
  const out = [
    `{"type":"tool","sessionID":"s1","part":{"type":"tool","name":"bash"}}`,
    `{"type":"text","sessionID":"s1","part":{"type":"text","text":"done"}}`,
  ].join("\n")
  const run = parseOpencodeEvents(out)
  assert.equal(run.text, "done")
  assert.equal(run.events, 2)
})

test("parseOpencodeEvents reports empty output distinguishably from unparsable output", () => {
  assert.equal(parseOpencodeEvents("").events, 0)
  assert.equal(parseOpencodeEvents("not json at all").events, 0)
  assert.equal(parseOpencodeEvents(`{"type":"step_start","sessionID":"s1"}`).events, 1)
})

test("opencodeArgs runs unattended, in the workspace, as JSON", () => {
  const args = opencodeArgs({ goal: "fix the build", dir: "/srv/work" })
  assert.deepEqual(args, ["run", "--format", "json", "--dir", "/srv/work", "--auto", "fix the build"])
})

test("opencodeArgs puts the goal last so it cannot swallow a flag", () => {
  // `message..` is a variadic positional: anything after it is more message.
  const args = opencodeArgs({
    goal: "fix the build",
    dir: "/srv/work",
    model: "gibson/default",
    sessionId: "ses_1",
  })
  assert.equal(args[args.length - 1], "fix the build")
  assert.ok(args.includes("--model") && args.includes("gibson/default"))
  assert.ok(args.includes("--session") && args.includes("ses_1"))
})

test("opencodeArgs omits model and session when unset", () => {
  const args = opencodeArgs({ goal: "g", dir: "." })
  assert.ok(!args.includes("--model"))
  assert.ok(!args.includes("--session"))
})
