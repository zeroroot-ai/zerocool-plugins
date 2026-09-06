// Fixture for the source-analysis task (zerocool-plugins#87).
//
// Two real vulnerabilities and one false positive, so the test can assert the
// task submits exactly two Findings and drops the noise.
const express = require("express")
const { exec } = require("child_process")

const app = express()
app.use(express.json())

// REAL 1: eval on request input (CWE-95).
app.post("/calc", (req, res) => {
  const result = eval(req.body.expression)
  res.json({ result })
})

// REAL 2: shell command built from request input (CWE-78).
app.get("/ping", (req, res) => {
  exec("ping -c 1 " + req.query.host, (err, out) => {
    res.type("text").send(err ? String(err) : out)
  })
})

// FALSE POSITIVE: eval on a constant. The generic eval rule matches; the
// value cannot be influenced by a caller, so the model must call it noise.
const FEATURE_FLAGS = eval("({ newCheckout: true })")

app.get("/flags", (_req, res) => res.json(FEATURE_FLAGS))

module.exports = app
