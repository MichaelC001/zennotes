/** Lazy TextMate/Oniguruma engine. Loaded only when at least one custom language is enabled. */
import {
  INITIAL,
  Registry,
  parseRawGrammar,
  type IGrammar,
  type IRawGrammar,
  type StateStack,
} from "vscode-textmate";
import {
  createOnigScanner,
  createOnigString,
  loadWASM,
} from "vscode-oniguruma";
import onigWasmDataUrl from "vscode-oniguruma/release/onig.wasm?url";
import {
  normalizeCodeFenceTag,
  type CustomCodeLanguage,
} from "@shared/custom-code-languages";
import type {
  CodeHighlightToken,
  CodeTokenKind,
} from "./custom-code-languages";

export interface EngineLoadedLanguage {
  definition: CustomCodeLanguage;
  grammar: IGrammar;
}

const LINE_TIME_LIMIT_MS = 20;
let onigReady: Promise<void> | null = null;

function ensureOniguruma(): Promise<void> {
  if (!onigReady) {
    const marker = ';base64,';
    const markerIndex = onigWasmDataUrl.indexOf(marker);
    if (!onigWasmDataUrl.startsWith('data:application/wasm') || markerIndex < 0) {
      return Promise.reject(new Error('The embedded Oniguruma WASM is invalid.'));
    }
    const binary = atob(onigWasmDataUrl.slice(markerIndex + marker.length));
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    onigReady = loadWASM(bytes);
  }
  return onigReady;
}

export async function buildTextMateRegistry(
  definitions: readonly CustomCodeLanguage[],
  throwOnLoadError = false,
): Promise<Map<string, EngineLoadedLanguage>> {
  const enabledDefinitions = definitions.filter(
    (definition) =>
      definition.enabled && !definition.error && !!definition.grammar,
  );
  if (enabledDefinitions.length === 0) return new Map();

  await ensureOniguruma();
  const rawByScope = new Map<string, IRawGrammar>();
  for (const definition of enabledDefinitions) {
    rawByScope.set(
      definition.scopeName,
      parseRawGrammar(definition.grammar, `${definition.id}.tmLanguage.json`),
    );
  }
  const registry = new Registry({
    onigLib: Promise.resolve({ createOnigScanner, createOnigString }),
    loadGrammar: async (scopeName) => rawByScope.get(scopeName) ?? null,
  });
  const byAlias = new Map<string, EngineLoadedLanguage>();
  for (const definition of enabledDefinitions) {
    if (!rawByScope.has(definition.scopeName)) continue;
    try {
      const grammar = await registry.loadGrammar(definition.scopeName);
      if (!grammar) continue;
      const loaded = { definition, grammar };
      for (const alias of definition.aliases) {
        byAlias.set(normalizeCodeFenceTag(alias), loaded);
      }
    } catch (error) {
      if (throwOnLoadError) throw error;
      // A malformed runtime regex leaves this language plain-text. Structural
      // import failures are reported by the main process in Settings.
    }
  }
  return byAlias;
}

export function tokenizeWithGrammar(
  grammar: IGrammar,
  source: string,
): CodeHighlightToken[] {
  const output: CodeHighlightToken[] = [];
  let lineOffset = 0;
  let state: StateStack | null = INITIAL;
  const lines = source.split("\n");
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex];
    const result = grammar.tokenizeLine(line, state, LINE_TIME_LIMIT_MS);
    if (result.stoppedEarly) return [];
    state = result.ruleStack;
    for (const token of result.tokens) {
      const kind = kindForScopes(token.scopes);
      if (!kind || token.endIndex <= token.startIndex) continue;
      pushMerged(output, {
        from: lineOffset + token.startIndex,
        to: lineOffset + Math.min(token.endIndex, line.length),
        kind,
      });
    }
    lineOffset += line.length + (lineIndex < lines.length - 1 ? 1 : 0);
  }
  return output;
}

function pushMerged(
  tokens: CodeHighlightToken[],
  next: CodeHighlightToken,
): void {
  const previous = tokens[tokens.length - 1];
  if (previous && previous.kind === next.kind && previous.to === next.from) {
    previous.to = next.to;
  } else {
    tokens.push(next);
  }
}

function kindForScopes(scopes: readonly string[]): CodeTokenKind | null {
  const scope = scopes.join(" ").toLowerCase();
  if (/invalid|illegal/.test(scope)) return "invalid";
  if (/comment/.test(scope)) return "comment";
  if (/string|regexp|quoted/.test(scope)) return "string";
  if (/constant\.numeric|\bnumber\b/.test(scope)) return "number";
  if (/constant\.language|constant\.character|support\.constant/.test(scope)) {
    return "atom";
  }
  if (/keyword|storage\.(?:type|modifier)/.test(scope)) return "keyword";
  if (
    /entity\.name\.(?:class|type|namespace)|support\.(?:class|type)/.test(scope)
  ) {
    return "type";
  }
  if (/entity\.name\.function|support\.function/.test(scope)) return "function";
  if (/entity\.name\.tag/.test(scope)) return "tag";
  if (/entity\.other\.attribute-name/.test(scope)) return "attribute";
  if (
    /variable\.other\.(?:property|member)|meta\.object-literal\.key/.test(scope)
  ) {
    return "property";
  }
  if (/variable|entity\.name\.variable/.test(scope)) return "variable";
  if (/keyword\.operator|\boperator\b/.test(scope)) return "operator";
  if (/punctuation/.test(scope)) return "punctuation";
  if (/meta\.|entity\.name\.section/.test(scope)) return "meta";
  return null;
}
