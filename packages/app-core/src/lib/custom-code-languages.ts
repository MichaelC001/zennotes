/** Registry and UI token mapping shared by custom-language editor and preview highlighting. */
import {
  normalizeCodeFenceTag,
  type CustomCodeLanguage,
} from "@shared/custom-code-languages";
import type { EngineLoadedLanguage } from "./custom-code-language-engine";

export type CodeTokenKind =
  | "keyword"
  | "string"
  | "comment"
  | "number"
  | "atom"
  | "operator"
  | "type"
  | "tag"
  | "function"
  | "variable"
  | "property"
  | "punctuation"
  | "attribute"
  | "meta"
  | "invalid";

export interface CodeHighlightToken {
  from: number;
  to: number;
  kind: CodeTokenKind;
}

type CustomCodeLanguageEngine = typeof import("./custom-code-language-engine");

const MAX_BLOCK_CHARS = 200_000;

class CustomCodeLanguageRegistry {
  private byAlias = new Map<string, EngineLoadedLanguage>();
  private engine: CustomCodeLanguageEngine | null = null;
  private listeners = new Set<() => void>();
  private generation = 0;
  private cache = new Map<string, CodeHighlightToken[]>();
  revision = 0;

  async replace(definitions: readonly CustomCodeLanguage[]): Promise<void> {
    const generation = ++this.generation;
    const hasEnabledLanguage = definitions.some(
      (definition) =>
        definition.enabled && !definition.error && !!definition.grammar,
    );
    const engine = hasEnabledLanguage
      ? await import("./custom-code-language-engine")
      : null;
    const next = engine
      ? await engine.buildTextMateRegistry(definitions)
      : new Map<string, EngineLoadedLanguage>();
    if (generation !== this.generation) return;
    this.byAlias = next;
    this.engine = engine;
    this.cache.clear();
    this.revision++;
    for (const listener of this.listeners) listener();
  }

  resolve(tag: string): EngineLoadedLanguage | null {
    return this.byAlias.get(normalizeCodeFenceTag(tag)) ?? null;
  }

  tokenize(tag: string, source: string): CodeHighlightToken[] {
    const loaded = this.resolve(tag);
    if (!loaded || !this.engine || !source || source.length > MAX_BLOCK_CHARS)
      return [];
    const key = `${this.revision}\0${loaded.definition.id}\0${source}`;
    const cached = this.cache.get(key);
    if (cached) return cached;
    const tokens = this.engine.tokenizeWithGrammar(loaded.grammar, source);
    this.cache.set(key, tokens);
    while (this.cache.size > 48) {
      const oldest = this.cache.keys().next().value;
      if (typeof oldest !== "string") break;
      this.cache.delete(oldest);
    }
    return tokens;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

export const customCodeLanguageRegistry = new CustomCodeLanguageRegistry();

export async function tokenizeCustomGrammarPreview(
  definition: CustomCodeLanguage,
  source: string,
): Promise<CodeHighlightToken[]> {
  const engine = await import("./custom-code-language-engine");
  const registry = await engine.buildTextMateRegistry(
    [{ ...definition, enabled: true, error: undefined }],
    true,
  );
  const loaded = registry.get(
    normalizeCodeFenceTag(definition.aliases[0] ?? definition.id),
  );
  return loaded ? engine.tokenizeWithGrammar(loaded.grammar, source) : [];
}

export const EDITOR_TOKEN_CLASS: Record<CodeTokenKind, string> = {
  keyword: "tok-keyword",
  string: "tok-string",
  comment: "tok-comment",
  number: "tok-number",
  atom: "tok-atom",
  operator: "tok-operator",
  type: "tok-type",
  tag: "tok-tag",
  function: "tok-function",
  variable: "tok-variable",
  property: "tok-property",
  punctuation: "tok-punct",
  attribute: "tok-attr",
  meta: "tok-meta-code",
  invalid: "tok-invalid",
};

export const PREVIEW_TOKEN_CLASS: Record<CodeTokenKind, string> = {
  keyword: "hljs-keyword",
  string: "hljs-string",
  comment: "hljs-comment",
  number: "hljs-number",
  atom: "hljs-literal",
  operator: "hljs-operator",
  type: "hljs-type",
  tag: "hljs-tag",
  function: "hljs-title function_",
  variable: "hljs-variable",
  property: "hljs-property",
  punctuation: "hljs-punctuation",
  attribute: "hljs-attr",
  meta: "hljs-meta",
  invalid: "hljs-deletion",
};
