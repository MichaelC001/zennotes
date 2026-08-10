import { getCM } from '@replit/codemirror-vim'
import type { EditorView } from '@codemirror/view'

/**
 * True while Vim is mid-sequence and the next keypress belongs to it: after
 * `f`/`t`/`r` awaiting their target character (`expectLiteralNext`), or with
 * any partial keys buffered (a count like `2`, a `g` prefix, a `"` register).
 * App-level single-key shortcuts must yield then, or they steal the operand:
 * `v f m` opened the context menu instead of jumping to the next `m`, and the
 * orphaned pending motion then swallowed the first key typed after the menu
 * closed (#568).
 */
export function vimAwaitsNextKey(view: EditorView | null | undefined): boolean {
  const vim = view ? getCM(view)?.state.vim : null
  if (!vim) return false
  return !!vim.expectLiteralNext || (vim.inputState?.keyBuffer.length ?? 0) > 0
}
