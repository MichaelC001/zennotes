import { describe, expect, it } from 'vitest'
import { NODE_DEFS } from './nodes'
import type { NodeDef } from './nodes'
import { parseWorkflow } from './parse'

/* -------------------------------------------------------------------------- */
/*  The documentation contract                                                */
/* -------------------------------------------------------------------------- */

// `description` and `example` are required by the type, so these tests are not
// there to catch a missing field in a checked build. They are there for the two
// ways one can still ship undocumented: a field present but empty, and an
// example that reads well but does not parse. Both would reach the completion
// popup, which is the only place most people will ever read this language.

/**
 * Wrap one example in the smallest file that could carry it.
 *
 * A source example is a whole statement (`books = tag #book`), because that is
 * how a pipeline opens and how the examples are written. Everything else is a
 * bare step, so it needs a wire in front of it: `notes = all` is the shortest
 * legal one and drags nothing else into the parse.
 */
function fileFor(def: NodeDef): string {
  const body = def.source ? def.example : `notes = all\nnotes | ${def.example}`
  return `---\nname: Example\n---\n\n${body}\n`
}

describe('every node in the registry is documented', () => {
  it.each(NODE_DEFS.map((def) => [def.kind, def] as const))(
    '`%s` says what it does and shows a line',
    (_kind, def) => {
      expect(def.description.trim()).not.toBe('')
      expect(def.example.trim()).not.toBe('')
    }
  )

  it('describes the step rather than repeating a parameter name', () => {
    for (const def of NODE_DEFS) {
      const words = def.description.trim().split(/\s+/)
      // A one-word "answer" is always the parameter name echoed back ("folder",
      // "tag"), which is the exact failure this documentation replaced.
      expect(words.length).toBeGreaterThan(4)
      for (const spec of def.params) expect(def.description.trim()).not.toBe(spec.name)
    }
  })

  it('writes a sentence, so the popup can end it where the author did', () => {
    for (const def of NODE_DEFS) {
      expect(def.description.trim().endsWith('.')).toBe(true)
      // House style: the long dash is never written anywhere in this project.
      // Escaped rather than typed, so this file cannot be the exception.
      expect(def.description).not.toContain('\u2014')
      expect(def.example).not.toContain('\u2014')
    }
  })

  it('names the verb in its own example', () => {
    for (const def of NODE_DEFS) {
      expect(def.example.split(/\s+/)).toContain(def.kind)
    }
  })
})

describe('every example is a line that actually parses', () => {
  it.each(NODE_DEFS.map((def) => [def.kind, def] as const))(
    '`%s` example parses with no errors',
    (_kind, def) => {
      const { workflow, diagnostics } = parseWorkflow(fileFor(def), 'example')
      expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([])
      // Parsing "cleanly" is not enough on its own: an unknown verb still lands
      // as a step. The example has to have produced a step of THIS kind.
      const kinds = workflow.statements.flatMap((statement) =>
        statement.steps.map((step) => step.kind)
      )
      expect(kinds).toContain(def.kind)
    }
  )

  it('binds every required parameter, so no example is a half-written line', () => {
    for (const def of NODE_DEFS) {
      const { workflow } = parseWorkflow(fileFor(def), 'example')
      const step = workflow.statements
        .flatMap((statement) => statement.steps)
        .find((candidate) => candidate.kind === def.kind)
      expect(step).toBeDefined()
      for (const spec of def.params) {
        if (!spec.required) continue
        expect(step && Object.prototype.hasOwnProperty.call(step.args, spec.name)).toBe(true)
      }
    }
  })
})
