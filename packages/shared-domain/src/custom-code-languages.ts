/** Shared contract and validation for user-installed TextMate code languages. */

export const CUSTOM_CODE_LANGUAGE_SCHEMA_VERSION = 1;
export const CUSTOM_CODE_LANGUAGE_MAX_BYTES = 2 * 1024 * 1024;

/** Tags with app-defined behavior or bundled editor/preview grammars. */
export const RESERVED_CODE_FENCE_TAGS = [
  "javascript",
  "js",
  "jsx",
  "node",
  "nodejs",
  "typescript",
  "ts",
  "tsx",
  "python",
  "py",
  "python3",
  "rust",
  "rs",
  "go",
  "golang",
  "json",
  "jsonc",
  "cpp",
  "c++",
  "c",
  "cc",
  "cxx",
  "hpp",
  "h",
  "java",
  "html",
  "htm",
  "css",
  "sql",
  "mysql",
  "postgres",
  "postgresql",
  "sqlite",
  "xml",
  "svg",
  "yaml",
  "yml",
  "markdown",
  "md",
  "php",
  "bash",
  "sh",
  "shell",
  "zsh",
  "powershell",
  "ps1",
  "lua",
  "ruby",
  "rb",
  "swift",
  "kotlin",
  "scala",
  "r",
  "perl",
  "diff",
  "dockerfile",
  "ini",
  "toml",
  "makefile",
  "cql",
  "cassandra",
  "xhtml",
  "ecmascript",
  "jinja",
  "json5",
  "less",
  "liquid",
  "plsql",
  "sass",
  "scss",
  "webassembly",
  "wasm",
  "rss",
  "wsdl",
  "xsd",
  "apl",
  "pgp",
  "asciiarmor",
  "asterisk",
  "brainfuck",
  "cobol",
  "c#",
  "csharp",
  "cs",
  "clojure",
  "clojurescript",
  "cmake",
  "coffeescript",
  "coffee",
  "coffee-script",
  "lisp",
  "cypher",
  "cython",
  "crystal",
  "d",
  "dart",
  "dtd",
  "dylan",
  "ebnf",
  "ecl",
  "edn",
  "eiffel",
  "elm",
  "erlang",
  "esper",
  "factor",
  "fcl",
  "forth",
  "fortran",
  "f#",
  "fsharp",
  "gas",
  "gherkin",
  "graphql",
  "groovy",
  "haskell",
  "haxe",
  "hxml",
  "http",
  "idl",
  "json-ld",
  "jsonld",
  "julia",
  "livescript",
  "ls",
  "mirc",
  "mathematica",
  "modelica",
  "mumps",
  "mbox",
  "nginx",
  "nsis",
  "ntriples",
  "objective-c",
  "objectivec",
  "objc",
  "objective-c++",
  "objc++",
  "ocaml",
  "octave",
  "oz",
  "pascal",
  "pig",
  "plaintext",
  "properties",
  "protobuf",
  "pug",
  "jade",
  "puppet",
  "q",
  "rscript",
  "jruby",
  "macruby",
  "rake",
  "rbx",
  "sas",
  "scheme",
  "sieve",
  "smalltalk",
  "solr",
  "sml",
  "sparql",
  "sparul",
  "spreadsheet",
  "excel",
  "formula",
  "squirrel",
  "stylus",
  "stex",
  "latex",
  "tex",
  "systemverilog",
  "tcl",
  "textile",
  "tiddlywiki",
  "troff",
  "ttcn",
  "ttcn_cfg",
  "turtle",
  "vbnet",
  "vbscript",
  "velocity",
  "verilog",
  "vhdl",
  "xquery",
  "yacas",
  "z80",
  "mscgen",
  "msgenny",
  "vue",
  "php-template",
  "python-repl",
  "mermaid",
  "tikz",
  "jsxgraph",
  "function-plot",
  "functionplot",
] as const;

export interface CustomCodeLanguageManifest {
  schemaVersion: 1;
  id: string;
  name: string;
  aliases: string[];
  scopeName: string;
  enabled: boolean;
}

/** Renderer-ready language record returned by the host bridge. */
export interface CustomCodeLanguage extends CustomCodeLanguageManifest {
  grammar: string;
  error?: string;
}

export interface CustomCodeLanguageInstallInput {
  fileName: string;
  grammar: string;
  id: string;
  name: string;
  aliases: string[];
  enabled?: boolean;
  replace?: boolean;
}

export interface CustomCodeLanguageUpdateInput {
  id: string;
  name?: string;
  aliases?: string[];
  enabled?: boolean;
}

export interface ParsedTextMateGrammar {
  raw: Record<string, unknown>;
  name?: string;
  scopeName: string;
}

export interface CustomCodeLanguageValidationOptions {
  reservedAliases?: Iterable<string>;
  existing?: Iterable<Pick<CustomCodeLanguageManifest, "id" | "aliases">>;
  replacingId?: string;
}

export function normalizeCodeFenceTag(value: string): string {
  return value.trim().toLowerCase();
}

export function isValidCodeFenceTag(value: string): boolean {
  return /^[a-z0-9][a-z0-9_+#-]{0,63}$/.test(value);
}

export function parseTextMateGrammar(text: string): ParsedTextMateGrammar {
  if (
    new TextEncoder().encode(text).byteLength > CUSTOM_CODE_LANGUAGE_MAX_BYTES
  ) {
    throw new Error("Grammar files must be 2 MB or smaller.");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("This file is not valid JSON.");
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("The TextMate grammar must be a JSON object.");
  }
  const grammar = raw as Record<string, unknown>;
  const scopeName =
    typeof grammar.scopeName === "string" ? grammar.scopeName.trim() : "";
  if (!/^(?:source|text)\.[a-z0-9_.+-]+$/i.test(scopeName)) {
    throw new Error(
      'The grammar needs a valid scopeName such as "source.gleam".',
    );
  }
  if (!Array.isArray(grammar.patterns)) {
    throw new Error("The grammar needs a top-level patterns array.");
  }

  const unsupported = collectExternalIncludes(grammar, scopeName);
  if (unsupported.length > 0) {
    throw new Error(
      `This grammar depends on unsupported external scopes: ${unsupported.join(", ")}. ` +
        "The first release supports self-contained TextMate grammars.",
    );
  }
  return {
    raw: grammar,
    name:
      typeof grammar.name === "string" && grammar.name.trim()
        ? grammar.name.trim()
        : undefined,
    scopeName,
  };
}

export function validateCustomCodeLanguageManifest(
  input: Omit<CustomCodeLanguageManifest, "schemaVersion" | "scopeName"> & {
    scopeName: string;
  },
  options: CustomCodeLanguageValidationOptions = {},
): CustomCodeLanguageManifest {
  const id = normalizeCodeFenceTag(input.id);
  if (!isValidCodeFenceTag(id)) {
    throw new Error(
      "Fence tags must start with a letter or number and use only a-z, 0-9, _, +, #, or -.",
    );
  }
  const name = input.name.trim();
  if (!name || name.length > 80)
    throw new Error("Language names must be between 1 and 80 characters.");

  const aliases = Array.from(
    new Set([id, ...input.aliases.map(normalizeCodeFenceTag)].filter(Boolean)),
  );
  if (aliases.some((alias) => !isValidCodeFenceTag(alias))) {
    throw new Error("Every alias must be a valid fenced-code tag.");
  }
  if (aliases.length > 16)
    throw new Error("A language can have at most 16 fence-tag aliases.");

  const reserved = new Set(
    Array.from(options.reservedAliases ?? [], normalizeCodeFenceTag),
  );
  const reservedMatch = aliases.find((alias) => reserved.has(alias));
  if (reservedMatch)
    throw new Error(
      `The fence tag “${reservedMatch}” is reserved by ZenNotes.`,
    );

  for (const other of options.existing ?? []) {
    if (other.id === options.replacingId) continue;
    const occupied = new Set(
      [other.id, ...other.aliases].map(normalizeCodeFenceTag),
    );
    const conflict = aliases.find((alias) => occupied.has(alias));
    if (conflict)
      throw new Error(
        `The fence tag “${conflict}” is already used by another custom language.`,
      );
  }

  return {
    schemaVersion: CUSTOM_CODE_LANGUAGE_SCHEMA_VERSION,
    id,
    name,
    aliases,
    scopeName: input.scopeName,
    enabled: input.enabled,
  };
}

function collectExternalIncludes(
  grammar: Record<string, unknown>,
  ownScope: string,
): string[] {
  const found = new Set<string>();
  const seen = new Set<object>();
  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object" || seen.has(value as object))
      return;
    seen.add(value as object);
    if (Array.isArray(value)) {
      for (const child of value) visit(child);
      return;
    }
    const record = value as Record<string, unknown>;
    if (typeof record.include === "string") {
      const include = record.include.trim();
      if (
        include &&
        include !== "$self" &&
        include !== "$base" &&
        !include.startsWith("#") &&
        include !== ownScope &&
        !include.startsWith(`${ownScope}#`)
      ) {
        found.add(include.split("#")[0]);
      }
    }
    for (const child of Object.values(record)) visit(child);
  };
  visit(grammar);
  return Array.from(found).sort();
}
