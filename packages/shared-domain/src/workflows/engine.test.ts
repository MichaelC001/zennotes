import { describe, expect, it } from 'vitest'
import { planWorkflow } from './engine'
import { bindParams, nodeDef } from './nodes'
import type {
  NoteSet,
  PlanContext,
  RunPlan,
  VaultReader,
  Workflow,
  WorkflowNote,
  WorkflowStatement,
  WorkflowStep
} from './types'

/* -------------------------------------------------------------------------- */
/*  Fixture                                                                   */
/* -------------------------------------------------------------------------- */

const MINUTE = 60_000
const HOUR = 3_600_000
const DAY = 86_400_000

/** Fixed clock: every `since`/`{{date}}` assertion below is written against it. */
const NOW = Date.UTC(2026, 6, 28, 12, 0, 0)

function note(
  path: string,
  title: string,
  folder: string,
  tags: string[],
  frontmatter: Record<string, string>,
  age: number
): WorkflowNote {
  return {
    path,
    title,
    folder,
    tags,
    frontmatter,
    createdAt: NOW - age - 30 * DAY,
    updatedAt: NOW - age
  }
}

const NOTES: WorkflowNote[] = [
  note('inbox/Dune.md', 'Dune', 'inbox', ['book', 'book/scifi'], {
    rating: '5',
    status: 'finished',
    finished: '2024-02-01'
  }, DAY),
  note('inbox/Neuromancer.md', 'Neuromancer', 'inbox', ['book/scifi'], {
    rating: '4',
    status: 'finished'
  }, 3 * DAY),
  note('inbox/Ulysses.md', 'Ulysses', 'inbox', ['book'], {
    rating: '2',
    status: 'abandoned'
  }, 40 * DAY),
  note('inbox/Draft.md', 'Draft', 'inbox', ['book'], { rating: '10', status: 'reading' }, 2 * HOUR),
  note('inbox/projects/Compiler.md', 'Compiler', 'inbox/projects', ['project'], {
    status: 'active'
  }, 2 * DAY),
  note('inbox/projects/Engine.md', 'Engine', 'inbox/projects', ['project/workflows'], {
    status: 'active'
  }, 10 * DAY),
  note('archive/Old Note.md', 'Old Note', 'archive', [], {}, 100 * DAY),
  note('inbox/Meeting.md', 'Meeting', 'inbox', ['meeting'], { attendees: 'ada, alan' }, 5 * HOUR),
  note('inbox/Recipe.md', 'Recipe', 'inbox', ['recipe'], {}, 6 * DAY),
  note('inbox/Pipes.md', 'Pipes | Tubes', 'inbox', ['note'], { rating: '3' }, 8 * DAY)
]

const BODIES: Record<string, string> = {
  'inbox/Dune.md': 'Spice must flow across Arrakis.',
  'inbox/Neuromancer.md': 'The sky above the port.',
  'inbox/Ulysses.md': 'Stately, plump Buck Mulligan.',
  'inbox/Draft.md': 'todo: finish this',
  'inbox/projects/Compiler.md': 'parser, codegen, and a linker',
  'inbox/projects/Engine.md': 'the workflow ENGINE plans, it never writes',
  'archive/Old Note.md': 'archived long ago',
  'inbox/Meeting.md': 'ada and alan met about arrakis',
  'inbox/Recipe.md': 'flour, water, salt',
  'inbox/Pipes.md': 'pipes and tubes'
}

interface FakeVault {
  reader: VaultReader
  /** Every `readBody` call, in order, so tests can assert on caching. */
  reads: string[]
}

interface ReaderOptions {
  notes?: WorkflowNote[]
  current?: WorkflowNote | null
  selection?: WorkflowNote[]
  listThrows?: boolean
  bodyThrows?: boolean
}

function makeVault(options: ReaderOptions = {}): FakeVault {
  const reads: string[] = []
  const notes = options.notes ?? NOTES
  const reader: VaultReader = {
    listNotes: async () => {
      if (options.listThrows) throw new Error('vault offline')
      return [...notes]
    },
    readBody: async (path: string) => {
      reads.push(path)
      if (options.bodyThrows) throw new Error('unreadable')
      return BODIES[path] ?? ''
    }
  }
  if (options.current !== undefined) reader.current = () => options.current ?? null
  if (options.selection !== undefined) reader.selection = () => options.selection ?? []
  return { reader, reads }
}

function makeCtx(reader: VaultReader, extra: Partial<PlanContext> = {}): PlanContext {
  return { reader, now: NOW, ...extra }
}

/* -------------------------------------------------------------------------- */
/*  Workflow builders (bound through the real registry, not by hand)          */
/* -------------------------------------------------------------------------- */

function step(kind: string, tokens: string[] = [], line = 1): WorkflowStep {
  const def = nodeDef(kind)
  if (!def) return { kind, args: {}, line }
  return { kind, args: bindParams(def, tokens, line).args, line }
}

function stmt(
  name: string | null,
  input: string | null,
  steps: WorkflowStep[],
  line = 1
): WorkflowStatement {
  return { name, input, steps, line }
}

function workflow(statements: WorkflowStatement[], id = 'test'): Workflow {
  return {
    id,
    name: 'Test',
    description: '',
    trigger: { type: 'manual' },
    // The engine plans what it is handed; the draft rule is enforced by the
    // caller (see `isRunnable`), so the fixture is a workflow that may run.
    status: 'active',
    statements,
    meta: {}
  }
}

/** Plan a single pipeline named `out`, the shape most cases below need. */
async function planPipeline(steps: WorkflowStep[], options: ReaderOptions = {}): Promise<RunPlan> {
  const { reader } = makeVault(options)
  return planWorkflow(workflow([stmt('out', null, steps)]), makeCtx(reader))
}

function titles(notes: NoteSet | undefined): string[] {
  return (notes ?? []).map((item) => item.title)
}

async function outTitles(steps: WorkflowStep[], options: ReaderOptions = {}): Promise<string[]> {
  const plan = await planPipeline(steps, options)
  return titles(plan.wires.out)
}

/* -------------------------------------------------------------------------- */
/*  Sources                                                                   */
/* -------------------------------------------------------------------------- */

describe('sources', () => {
  it('`all` puts every note on the wire', async () => {
    expect(await outTitles([step('all')])).toHaveLength(10)
  })

  it('`folder` matches the folder and everything under it', async () => {
    expect(await outTitles([step('folder', ['inbox'])])).toHaveLength(9)
    expect(await outTitles([step('folder', ['inbox/projects'])])).toEqual(['Compiler', 'Engine'])
  })

  it('`tag` sees nested tags, the way the tag tree does', async () => {
    // Neuromancer is only tagged `book/scifi`, and still belongs to `book`.
    expect(await outTitles([step('tag', ['#book'])])).toEqual([
      'Dune',
      'Neuromancer',
      'Ulysses',
      'Draft'
    ])
  })

  it('`search` matches titles and bodies, case-insensitively', async () => {
    expect(await outTitles([step('search', ['arrakis'])])).toEqual(['Dune', 'Meeting'])
  })

  it('`search` does not read a body when the title already matched', async () => {
    const vault = makeVault()
    await planWorkflow(
      workflow([stmt('out', null, [step('search', ['dune'])])]),
      makeCtx(vault.reader)
    )
    expect(vault.reads).not.toContain('inbox/Dune.md')
  })

  it('`current` uses the reader callback', async () => {
    expect(await outTitles([step('current')], { current: NOTES[3] })).toEqual(['Draft'])
    expect(await outTitles([step('current')], { current: null })).toEqual([])
  })

  it('`selection` uses the reader callback', async () => {
    const selection = [NOTES[0], NOTES[8]]
    expect(await outTitles([step('selection')], { selection })).toEqual(['Dune', 'Recipe'])
  })

  it('warns instead of failing when current/selection are unavailable', async () => {
    const plan = await planPipeline([step('current')])
    expect(titles(plan.wires.out)).toEqual([])
    expect(plan.diagnostics).toHaveLength(1)
    expect(plan.diagnostics[0].severity).toBe('warning')

    const other = await planPipeline([step('selection')])
    expect(titles(other.wires.out)).toEqual([])
    expect(other.diagnostics[0].severity).toBe('warning')
  })

  it('reports a reader that cannot list notes', async () => {
    const plan = await planPipeline([step('all')], { listThrows: true })
    expect(titles(plan.wires.out)).toEqual([])
    expect(plan.diagnostics[0].message).toContain('could not list notes')
  })
})

/* -------------------------------------------------------------------------- */
/*  Filters                                                                   */
/* -------------------------------------------------------------------------- */

describe('where', () => {
  it('compares numerically when both sides are numbers', async () => {
    // A string compare would drop `10`, which sorts before `4`.
    expect(await outTitles([step('all'), step('where', ['rating', '>=', '4'])])).toEqual([
      'Dune',
      'Neuromancer',
      'Draft'
    ])
  })

  it('compares text case-insensitively when a side is not a number', async () => {
    expect(await outTitles([step('all'), step('where', ['status', '=', 'FINISHED'])])).toEqual([
      'Dune',
      'Neuromancer'
    ])
    expect(await outTitles([step('all'), step('where', ['status', '!=', 'finished'])])).toHaveLength(
      8
    )
  })

  it('treats a missing field as blank rather than zero', async () => {
    // Notes with no `rating` must not compare as 0 and slip through `> 0`.
    expect(await outTitles([step('all'), step('where', ['rating', '>', '0'])])).toEqual([
      'Dune',
      'Neuromancer',
      'Ulysses',
      'Draft',
      'Pipes | Tubes'
    ])
  })

  it('supports the pseudo-fields, and matches folder exactly', async () => {
    expect(await outTitles([step('all'), step('where', ['title', 'contains', 'pipes'])])).toEqual([
      'Pipes | Tubes'
    ])
    expect(
      await outTitles([step('all'), step('where', ['path', 'matches', '^inbox/projects'])])
    ).toEqual(['Compiler', 'Engine'])
    // `where folder` is exact, unlike the `folder` source and the `in` filter.
    expect(await outTitles([step('all'), step('where', ['folder', '=', 'inbox'])])).toHaveLength(7)
    expect(
      await outTitles([step('all'), step('where', ['updated', '>', String(NOW - 4 * HOUR)])])
    ).toEqual(['Draft'])
  })

  it('reports an invalid regex and matches nothing', async () => {
    const plan = await planPipeline([step('all'), step('where', ['title', 'matches', '[unclosed'])])
    expect(titles(plan.wires.out)).toEqual([])
    expect(plan.diagnostics[0].severity).toBe('error')
    expect(plan.diagnostics[0].message).toContain('not a valid pattern')
  })
})

describe('filters', () => {
  it('`tagged` and `not-tagged` follow the tag hierarchy', async () => {
    expect(await outTitles([step('all'), step('tagged', ['#project'])])).toEqual([
      'Compiler',
      'Engine'
    ])
    expect(await outTitles([step('all'), step('not-tagged', ['#book'])])).toHaveLength(6)
  })

  it('`in` narrows to a folder subtree', async () => {
    expect(await outTitles([step('all'), step('in', ['inbox/projects'])])).toEqual([
      'Compiler',
      'Engine'
    ])
  })

  it('`matching` globs over the path, with * stopping at a separator', async () => {
    expect(await outTitles([step('all'), step('matching', ['inbox/*.md'])])).toHaveLength(7)
    expect(await outTitles([step('all'), step('matching', ['inbox/**/*.md'])])).toHaveLength(9)
    expect(await outTitles([step('all'), step('matching', ['**/Old*.md'])])).toEqual(['Old Note'])
  })

  it('`contains` reads bodies and ignores case', async () => {
    expect(await outTitles([step('all'), step('contains', ['codegen'])])).toEqual(['Compiler'])
    expect(await outTitles([step('all'), step('contains', ['engine plans'])])).toEqual(['Engine'])
  })

  it('`since` is relative to ctx.now, with m meaning minutes', async () => {
    expect(await outTitles([step('all'), step('since', ['7d'])])).toEqual([
      'Dune',
      'Neuromancer',
      'Draft',
      'Compiler',
      'Meeting',
      'Recipe'
    ])
    expect(await outTitles([step('all'), step('since', ['180m'])])).toEqual(['Draft'])
    // 2w reaches back past Engine (10d) and Pipes (8d), but not Ulysses (40d).
    expect(await outTitles([step('all'), step('since', ['2w'])])).toHaveLength(8)
  })
})

/* -------------------------------------------------------------------------- */
/*  Order and shape                                                           */
/* -------------------------------------------------------------------------- */

describe('order', () => {
  it('sorts numerically, descending on request', async () => {
    expect(
      await outTitles([step('tag', ['#book']), step('sort', ['rating', 'desc'])])
    ).toEqual(['Draft', 'Dune', 'Neuromancer', 'Ulysses'])
  })

  it('sorts ascending by default', async () => {
    expect(await outTitles([step('tag', ['#book']), step('sort', ['title'])])).toEqual([
      'Draft',
      'Dune',
      'Neuromancer',
      'Ulysses'
    ])
  })

  it('is stable, so ties keep their incoming order', async () => {
    expect(await outTitles([step('tag', ['#book']), step('sort', ['status'])])).toEqual([
      'Ulysses',
      'Dune',
      'Neuromancer',
      'Draft'
    ])
  })

  it('`limit` truncates and never goes negative', async () => {
    expect(await outTitles([step('tag', ['#book']), step('limit', ['2'])])).toEqual([
      'Dune',
      'Neuromancer'
    ])
    expect(await outTitles([step('tag', ['#book']), step('limit', ['0'])])).toEqual([])
  })

  it('`dedupe` collapses repeated paths, keeping the first', async () => {
    const duplicated = [NOTES[0], NOTES[8], NOTES[0]]
    expect(await outTitles([step('all'), step('dedupe')], { notes: duplicated })).toEqual([
      'Dune',
      'Recipe'
    ])
  })
})

describe('shape', () => {
  it('`union` appends the other wire without duplicating paths', async () => {
    const { reader } = makeVault()
    const plan = await planWorkflow(
      workflow([
        stmt('books', null, [step('tag', ['#book'], 1)], 1),
        stmt('projects', null, [step('folder', ['inbox/projects'], 2)], 2),
        stmt('both', 'books', [step('union', ['projects'], 3)], 3)
      ]),
      makeCtx(reader)
    )
    expect(titles(plan.wires.both)).toEqual([
      'Dune',
      'Neuromancer',
      'Ulysses',
      'Draft',
      'Compiler',
      'Engine'
    ])
  })

  it('`union` with itself is a no-op', async () => {
    const { reader } = makeVault()
    const plan = await planWorkflow(
      workflow([
        stmt('books', null, [step('tag', ['#book'], 1)], 1),
        stmt('same', 'books', [step('union', ['books'], 2)], 2)
      ]),
      makeCtx(reader)
    )
    expect(titles(plan.wires.same)).toHaveLength(4)
  })

  it('`subtract` removes by path', async () => {
    const { reader } = makeVault()
    const plan = await planWorkflow(
      workflow([
        stmt('books', null, [step('tag', ['#book'], 1)], 1),
        stmt('scifi', null, [step('tag', ['#book/scifi'], 2)], 2),
        stmt('rest', 'books', [step('subtract', ['scifi'], 3)], 3)
      ]),
      makeCtx(reader)
    )
    expect(titles(plan.wires.rest)).toEqual(['Ulysses', 'Draft'])
  })

  it('reports an unknown wire and leaves the set alone', async () => {
    const plan = await planPipeline([step('tag', ['#book']), step('union', ['ghosts'])])
    expect(titles(plan.wires.out)).toHaveLength(4)
    expect(plan.diagnostics[0].message).toContain('unknown wire `ghosts`')
  })
})

/* -------------------------------------------------------------------------- */
/*  Mutations                                                                 */
/* -------------------------------------------------------------------------- */

describe('mutations', () => {
  it('emits one op per note and passes the set through', async () => {
    const plan = await planPipeline([
      step('tag', ['#book']),
      step('add-tag', ['#starred']),
      step('archive')
    ])
    expect(plan.ops).toHaveLength(8)
    expect(plan.ops[0]).toEqual({ kind: 'add-tag', path: 'inbox/Dune.md', tag: 'starred' })
    expect(plan.ops[4]).toEqual({ kind: 'archive', path: 'inbox/Dune.md' })
    expect(titles(plan.wires.out)).toHaveLength(4)
  })

  it('shapes set / remove-tag / move / apply-template / trash', async () => {
    const plan = await planPipeline([
      step('tag', ['#recipe']),
      step('set', ['status', 'cooked']),
      step('remove-tag', ['#recipe']),
      step('move', ['archive/kitchen/']),
      step('apply-template', ['review']),
      step('trash')
    ])
    expect(plan.ops).toEqual([
      { kind: 'set-frontmatter', path: 'inbox/Recipe.md', field: 'status', value: 'cooked' },
      { kind: 'remove-tag', path: 'inbox/Recipe.md', tag: 'recipe' },
      { kind: 'move', path: 'inbox/Recipe.md', to: 'archive/kitchen' },
      { kind: 'apply-template', path: 'inbox/Recipe.md', template: 'review' },
      { kind: 'trash', path: 'inbox/Recipe.md' }
    ])
  })

  it('shapes append / prepend and expands note fields', async () => {
    const plan = await planPipeline([
      step('tag', ['#recipe']),
      step('append', ['reviewed', '{{date}}']),
      step('prepend', ['#', '{{title}}'])
    ])
    expect(plan.ops).toEqual([
      { kind: 'append', path: 'inbox/Recipe.md', text: 'reviewed 2026-07-28' },
      { kind: 'prepend', path: 'inbox/Recipe.md', text: '# Recipe' }
    ])
  })

  it('expands rename patterns per note and keeps unknown placeholders visible', async () => {
    const plan = await planPipeline([
      step('tag', ['#meeting']),
      step('rename', ['"{{title}} {{finished}} {{titel}}"'])
    ])
    expect(plan.ops).toEqual([
      { kind: 'rename', path: 'inbox/Meeting.md', to: 'Meeting {{finished}} {{titel}}' }
    ])
  })
})

/* -------------------------------------------------------------------------- */
/*  Render                                                                    */
/* -------------------------------------------------------------------------- */

describe('render', () => {
  it('builds a markdown table from the columns arg', async () => {
    const plan = await planPipeline([
      step('tag', ['#book']),
      step('render', ['table', 'title,', 'rating']),
      step('clipboard')
    ])
    expect(plan.ops[0]).toEqual({
      kind: 'clipboard',
      text: [
        '| title | rating |',
        '| --- | --- |',
        '| Dune | 5 |',
        '| Neuromancer | 4 |',
        '| Ulysses | 2 |',
        '| Draft | 10 |'
      ].join('\n')
    })
  })

  it('escapes a pipe inside a table cell', async () => {
    const plan = await planPipeline([
      step('all'),
      step('where', ['title', 'contains', 'tubes']),
      step('render', ['table', 'title']),
      step('clipboard')
    ])
    expect(plan.ops[0]).toEqual({
      kind: 'clipboard',
      text: ['| title |', '| --- |', '| Pipes \\| Tubes |'].join('\n')
    })
  })

  it('renders list, links and count', async () => {
    const list = await planPipeline([
      step('tag', ['#book/scifi']),
      step('render', ['list']),
      step('clipboard')
    ])
    expect(list.ops[0]).toEqual({ kind: 'clipboard', text: '- Dune\n- Neuromancer' })

    const links = await planPipeline([
      step('tag', ['#book/scifi']),
      step('render', ['links']),
      step('clipboard')
    ])
    expect(links.ops[0]).toEqual({ kind: 'clipboard', text: '- [[Dune]]\n- [[Neuromancer]]' })

    const count = await planPipeline([
      step('tag', ['#book']),
      step('render', ['count']),
      step('clipboard')
    ])
    expect(count.ops[0]).toEqual({ kind: 'clipboard', text: '4' })
  })

  it('does not change the notes flowing through it', async () => {
    const plan = await planPipeline([
      step('tag', ['#book']),
      step('render', ['count']),
      step('archive')
    ])
    expect(plan.ops).toHaveLength(4)
    expect(titles(plan.wires.out)).toHaveLength(4)
  })
})

/* -------------------------------------------------------------------------- */
/*  Sinks                                                                     */
/* -------------------------------------------------------------------------- */

describe('sinks', () => {
  it('`write` uses the rendered text', async () => {
    const plan = await planPipeline([
      step('tag', ['#book/scifi']),
      step('render', ['list']),
      step('write', ['"Reading Log.md"'])
    ])
    expect(plan.ops).toEqual([
      { kind: 'write-note', path: 'Reading Log.md', text: '- Dune\n- Neuromancer' }
    ])
  })

  it('`write-section` carries the heading', async () => {
    const plan = await planPipeline([
      step('tag', ['#book/scifi']),
      step('render', ['count']),
      step('write-section', ['"Reading Log.md"', '"Finished"'])
    ])
    expect(plan.ops).toEqual([
      { kind: 'write-section', path: 'Reading Log.md', heading: 'Finished', text: '2' }
    ])
  })

  it('a consumesText sink falls back to a links rendering', async () => {
    const plan = await planPipeline([step('tag', ['#book/scifi']), step('clipboard')])
    expect(plan.ops).toEqual([{ kind: 'clipboard', text: '- [[Dune]]\n- [[Neuromancer]]' }])
  })

  it('`create-each` creates one empty note per item, defaulting to .md', async () => {
    const plan = await planPipeline([
      step('tag', ['#book/scifi']),
      step('create-each', ['"reviews/{{title}} {{date}}"'])
    ])
    expect(plan.ops).toEqual([
      { kind: 'create-note', path: 'reviews/Dune 2026-07-28.md', body: '' },
      { kind: 'create-note', path: 'reviews/Neuromancer 2026-07-28.md', body: '' }
    ])
  })

  it('`notify` expands {{count}}, and falls back to the rendered text', async () => {
    const withMessage = await planPipeline([
      step('tag', ['#book']),
      step('notify', ['Found', '{{count}}', 'books', 'on', '{{date}}'])
    ])
    expect(withMessage.ops).toEqual([
      { kind: 'notify', message: 'Found 4 books on 2026-07-28' }
    ])

    const fromRender = await planPipeline([
      step('tag', ['#book']),
      step('render', ['count']),
      step('notify')
    ])
    expect(fromRender.ops).toEqual([{ kind: 'notify', message: '4' }])
  })
})

/* -------------------------------------------------------------------------- */
/*  Wires, ordering and fan-out                                               */
/* -------------------------------------------------------------------------- */

describe('wires', () => {
  it('keys named statements by name and terminal ones by #line', async () => {
    const { reader } = makeVault()
    const plan = await planWorkflow(
      workflow([
        stmt('books', null, [step('tag', ['#book'], 1)], 1),
        stmt(null, 'books', [step('limit', ['1'], 5), step('archive', [], 5)], 5)
      ]),
      makeCtx(reader)
    )
    expect(Object.keys(plan.wires).sort()).toEqual(['#5', 'books'])
    expect(titles(plan.wires['#5'])).toEqual(['Dune'])
  })

  it('fans one wire out to two statements without disturbing it', async () => {
    const { reader } = makeVault()
    const plan = await planWorkflow(
      workflow([
        stmt('books', null, [step('tag', ['#book'], 1)], 1),
        stmt(null, 'books', [
          step('sort', ['rating', 'desc'], 2),
          step('limit', ['1'], 2),
          step('add-tag', ['#top'], 2)
        ], 2),
        stmt(null, 'books', [step('where', ['rating', '<', '4'], 3), step('add-tag', ['#meh'], 3)], 3)
      ]),
      makeCtx(reader)
    )
    expect(titles(plan.wires.books)).toEqual(['Dune', 'Neuromancer', 'Ulysses', 'Draft'])
    expect(plan.ops).toEqual([
      { kind: 'add-tag', path: 'inbox/Draft.md', tag: 'top' },
      { kind: 'add-tag', path: 'inbox/Ulysses.md', tag: 'meh' }
    ])
  })

  it('runs statements in dependency order, not file order', async () => {
    const { reader } = makeVault()
    const plan = await planWorkflow(
      workflow([
        stmt('good', 'books', [step('where', ['rating', '>=', '4'], 1)], 1),
        stmt('books', null, [step('tag', ['#book'], 2)], 2)
      ]),
      makeCtx(reader)
    )
    expect(titles(plan.wires.good)).toEqual(['Dune', 'Neuromancer', 'Draft'])
  })

  it('reports a cycle instead of looping forever', async () => {
    const { reader } = makeVault()
    const plan = await planWorkflow(
      workflow([
        stmt('a', 'b', [step('limit', ['1'], 1)], 1),
        stmt('b', 'a', [step('limit', ['1'], 2)], 2)
      ]),
      makeCtx(reader)
    )
    expect(plan.diagnostics).toHaveLength(2)
    expect(plan.diagnostics[0].message).toContain('cycle')
    expect(plan.wires.a).toEqual([])
    expect(plan.wires.b).toEqual([])
    expect(plan.ops).toEqual([])
  })

  it('skips a statement whose input wire does not exist', async () => {
    const { reader } = makeVault()
    const plan = await planWorkflow(
      workflow([stmt('out', 'ghosts', [step('archive', [], 1)], 1)]),
      makeCtx(reader)
    )
    expect(plan.ops).toEqual([])
    expect(plan.diagnostics[0].message).toContain('unknown wire `ghosts`')
  })
})

/* -------------------------------------------------------------------------- */
/*  Compose                                                                   */
/* -------------------------------------------------------------------------- */

const CHILD = workflow(
  [stmt('seen', null, [step('tag', ['#meeting'], 1), step('add-tag', ['#seen'], 1)], 1)],
  'child'
)

describe('call', () => {
  it('merges child ops in order and namespaces child wires', async () => {
    const { reader } = makeVault()
    const plan = await planWorkflow(
      workflow([
        stmt(null, null, [
          step('tag', ['#recipe'], 1),
          step('add-tag', ['#before'], 1),
          step('call', ['child'], 1),
          step('add-tag', ['#after'], 1)
        ], 1)
      ]),
      makeCtx(reader, { resolve: (id) => (id === 'child' ? CHILD : null) })
    )
    expect(plan.ops).toEqual([
      { kind: 'add-tag', path: 'inbox/Recipe.md', tag: 'before' },
      { kind: 'add-tag', path: 'inbox/Meeting.md', tag: 'seen' },
      { kind: 'add-tag', path: 'inbox/Recipe.md', tag: 'after' }
    ])
    expect(Object.keys(plan.wires).sort()).toEqual(['#1', 'child.seen'])
    expect(titles(plan.wires['child.seen'])).toEqual(['Meeting'])
  })

  it('skips a draft child instead of running it', async () => {
    // The top-level draft rule is the caller's (`isRunnable`); a called child
    // never passes through the caller, so the engine has to ask again. The
    // parent's own steps still run on either side of the skipped call.
    const draft: Workflow = { ...CHILD, status: 'draft' }
    const { reader } = makeVault()
    const plan = await planWorkflow(
      workflow([
        stmt(null, null, [
          step('tag', ['#recipe'], 1),
          step('add-tag', ['#before'], 1),
          step('call', ['child'], 1),
          step('add-tag', ['#after'], 1)
        ], 1)
      ]),
      makeCtx(reader, { resolve: (id) => (id === 'child' ? draft : null) })
    )
    expect(plan.ops).toEqual([
      { kind: 'add-tag', path: 'inbox/Recipe.md', tag: 'before' },
      { kind: 'add-tag', path: 'inbox/Recipe.md', tag: 'after' }
    ])
    expect(plan.diagnostics[0].message).toBe('`call child` was skipped: that workflow is a draft')
    expect(plan.wires['child.seen']).toBeUndefined()
  })

  it('reports a missing resolver rather than silently doing nothing', async () => {
    const plan = await planPipeline([step('tag', ['#recipe']), step('call', ['child'])])
    expect(plan.ops).toEqual([])
    expect(plan.diagnostics[0].message).toContain('needs a workflow resolver')
  })

  it('reports an unknown workflow id', async () => {
    const { reader } = makeVault()
    const plan = await planWorkflow(
      workflow([stmt('out', null, [step('tag', ['#recipe'], 1), step('call', ['nope'], 1)], 1)]),
      makeCtx(reader, { resolve: () => null })
    )
    expect(plan.diagnostics[0].message).toContain('unknown workflow `nope`')
    expect(titles(plan.wires.out)).toEqual(['Recipe'])
  })

  it('attributes a child diagnostic to the child', async () => {
    const broken = workflow(
      [stmt('out', null, [step('tag', ['#meeting'], 1), step('union', ['ghosts'], 1)], 1)],
      'child'
    )
    const { reader } = makeVault()
    const plan = await planWorkflow(
      workflow([stmt(null, null, [step('all', [], 1), step('call', ['child'], 1)], 1)]),
      makeCtx(reader, { resolve: () => broken })
    )
    expect(plan.diagnostics[0].message).toBe('child: unknown wire `ghosts`')
  })

  it('stops at maxDepth when a resolver builds a cycle at runtime', async () => {
    const loop: Workflow = workflow(
      [stmt(null, null, [
        step('tag', ['#recipe'], 1),
        step('add-tag', ['#round'], 1),
        step('call', ['loop'], 1)
      ], 1)],
      'loop'
    )
    const { reader } = makeVault()
    const plan = await planWorkflow(loop, makeCtx(reader, { resolve: () => loop, maxDepth: 2 }))
    // One pass per allowed level: the root plus two nested calls.
    expect(plan.ops).toHaveLength(3)
    const last = plan.diagnostics[plan.diagnostics.length - 1]
    expect(last.severity).toBe('error')
    expect(last.message).toContain('maxDepth')
  })

  it('stops at maxOps and still returns the partial plan', async () => {
    const { reader } = makeVault()
    const plan = await planWorkflow(
      workflow([stmt('out', null, [step('tag', ['#book'], 1), step('archive', [], 1)], 1)]),
      makeCtx(reader, { maxOps: 3 })
    )
    expect(plan.ops).toHaveLength(3)
    const last = plan.diagnostics[plan.diagnostics.length - 1]
    expect(last.message).toContain('maxOps')
  })
})

/* -------------------------------------------------------------------------- */
/*  Invariants                                                                */
/* -------------------------------------------------------------------------- */

describe('invariants', () => {
  it('plans no ops at all when no step mutates', async () => {
    const plan = await planPipeline([
      step('tag', ['#book']),
      step('sort', ['rating', 'desc']),
      step('limit', ['2']),
      step('render', ['list'])
    ])
    expect(plan.ops).toEqual([])
    expect(plan.irreversible).toEqual([])
  })

  it('lists only the ops that cannot be rolled back', async () => {
    const { reader } = makeVault()
    const plan = await planWorkflow(
      workflow([
        stmt(null, null, [step('tag', ['#recipe'], 1), step('archive', [], 1)], 1),
        stmt(null, null, [step('tag', ['#recipe'], 2), step('notify', ['done'], 2)], 2),
        stmt(null, null, [step('tag', ['#recipe'], 3), step('clipboard', [], 3)], 3)
      ]),
      makeCtx(reader)
    )
    expect(plan.ops).toHaveLength(3)
    expect(plan.irreversible.map((op) => op.kind)).toEqual(['notify', 'clipboard'])
  })

  it('reads a body at most once per path across the whole run', async () => {
    const vault = makeVault()
    await planWorkflow(
      workflow([
        stmt('a', null, [step('folder', ['inbox/projects'], 1), step('contains', ['parser'], 1)], 1),
        stmt('b', null, [step('folder', ['inbox/projects'], 2), step('contains', ['codegen'], 2)], 2)
      ]),
      makeCtx(vault.reader)
    )
    expect(vault.reads).toEqual(['inbox/projects/Compiler.md', 'inbox/projects/Engine.md'])
  })

  it('warns and keeps going when a body cannot be read', async () => {
    const plan = await planPipeline([step('all'), step('contains', ['anything'])], {
      notes: [NOTES[0]],
      bodyThrows: true
    })
    expect(titles(plan.wires.out)).toEqual([])
    expect(plan.diagnostics[0].severity).toBe('warning')
    expect(plan.diagnostics[0].message).toContain('could not read')
  })

  it('reports an unknown step kind without throwing', async () => {
    const plan = await planPipeline([step('tag', ['#book']), step('frobnicate')])
    expect(plan.diagnostics[0].message).toContain('unknown step `frobnicate`')
    expect(titles(plan.wires.out)).toHaveLength(4)
  })

  it('rejects a pipeline that opens with something other than a source', async () => {
    const plan = await planPipeline([step('limit', ['2'])])
    expect(plan.diagnostics[0].message).toContain('must start with a source')
    expect(plan.wires.out).toEqual([])
  })

  it('aborts the rest of a pipeline when a step is missing an arg', async () => {
    // `where` never bound its params, so `trash` must not run over the whole tag.
    const plan = await planPipeline([step('tag', ['#book']), step('where'), step('trash')])
    expect(plan.ops).toEqual([])
    expect(plan.diagnostics[0].message).toContain('`where` is missing field')
    expect(titles(plan.wires.out)).toHaveLength(4)
  })

  it('aborts a pipeline at a source that is not its head', async () => {
    // A source past the head would REPLACE the wire with a vault-wide query,
    // so the `trash` after it must never see that widened set.
    const plan = await planPipeline([
      step('tag', ['#recipe']),
      step('folder', ['inbox']),
      step('trash')
    ])
    expect(plan.ops).toEqual([])
    expect(plan.diagnostics[0].message).toBe(
      '`folder` is a source, so it can only start a pipeline'
    )
    expect(titles(plan.wires.out)).toEqual(['Recipe'])
  })

  it('aborts a statement whose input wire feeds a source', async () => {
    const { reader } = makeVault()
    const plan = await planWorkflow(
      workflow([
        stmt('books', null, [step('tag', ['#book'], 1)], 1),
        stmt(null, 'books', [step('all', [], 2), step('trash', [], 2)], 2)
      ]),
      makeCtx(reader)
    )
    expect(plan.ops).toEqual([])
    expect(plan.diagnostics[0].message).toBe(
      '`all` is a source, so it cannot read from wire `books`'
    )
    // The statement still publishes its wire, holding what it read upstream.
    expect(titles(plan.wires['#2'])).toHaveLength(4)
  })

  it('never mutates the notes the reader handed it', async () => {
    const snapshot = JSON.stringify(NOTES)
    await planPipeline([
      step('all'),
      step('contains', ['a']),
      step('sort', ['title', 'desc']),
      step('add-tag', ['#x'])
    ])
    expect(JSON.stringify(NOTES)).toBe(snapshot)
  })
})
