/** Desktop filesystem lifecycle for user-installed TextMate grammars. */
import { promises as fs } from "node:fs";
import * as fsSync from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import chokidar from "chokidar";
import {
  RESERVED_CODE_FENCE_TAGS,
  parseTextMateGrammar,
  validateCustomCodeLanguageManifest,
  type CustomCodeLanguage,
  type CustomCodeLanguageInstallInput,
  type CustomCodeLanguageManifest,
  type CustomCodeLanguageUpdateInput,
} from "@shared/custom-code-languages";
import { getConfigDir } from "./app-config";

const README = `# ZenNotes custom code languages

Each installed language has its own folder containing a manifest and a
self-contained TextMate JSON grammar. Use Settings → Editor → Languages to
install, edit, enable, disable, or remove languages safely.

\`\`\`
languages/
  gleam/
    manifest.json
    grammar.tmLanguage.json
\`\`\`
`;

export function getCustomCodeLanguagesDir(): string {
  return path.join(getConfigDir(), "languages");
}

function isSafeId(id: unknown): id is string {
  return typeof id === "string" && /^[a-z0-9][a-z0-9_+#-]{0,63}$/.test(id);
}

export async function ensureCustomCodeLanguagesDir(): Promise<string> {
  const dir = getCustomCodeLanguagesDir();
  await fs.mkdir(dir, { recursive: true });
  const readme = path.join(dir, "README.md");
  // Exclusive create instead of exists-then-write: `wx` makes the filesystem
  // answer "already there" atomically, so nothing lands in the gap between a
  // check and the write, and an existing README is never overwritten.
  await fs.writeFile(readme, README, { flag: "wx" }).catch(() => {});
  return dir;
}

export async function listCustomCodeLanguages(): Promise<CustomCodeLanguage[]> {
  const dir = getCustomCodeLanguagesDir();
  let entries: fsSync.Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const result: CustomCodeLanguage[] = [];
  for (const entry of entries) {
    if (
      !entry.isDirectory() ||
      entry.name.startsWith(".") ||
      !isSafeId(entry.name)
    )
      continue;
    const fallback: CustomCodeLanguage = {
      schemaVersion: 1,
      id: entry.name,
      name: entry.name,
      aliases: [entry.name],
      scopeName: `source.${entry.name}`,
      enabled: false,
      grammar: "",
    };
    try {
      const folder = path.join(dir, entry.name);
      const [manifestText, grammar] = await Promise.all([
        fs.readFile(path.join(folder, "manifest.json"), "utf8"),
        fs.readFile(path.join(folder, "grammar.tmLanguage.json"), "utf8"),
      ]);
      const rawManifest = JSON.parse(
        manifestText,
      ) as Partial<CustomCodeLanguageManifest>;
      const parsedGrammar = parseTextMateGrammar(grammar);
      const manifest = validateCustomCodeLanguageManifest(
        {
          id: String(rawManifest.id ?? entry.name),
          name: String(rawManifest.name ?? entry.name),
          aliases: Array.isArray(rawManifest.aliases)
            ? rawManifest.aliases.filter(
                (value): value is string => typeof value === "string",
              )
            : [entry.name],
          scopeName: parsedGrammar.scopeName,
          enabled: rawManifest.enabled !== false,
        },
        { reservedAliases: RESERVED_CODE_FENCE_TAGS },
      );
      if (manifest.id !== entry.name)
        throw new Error("The manifest id must match its folder name.");
      result.push({ ...manifest, grammar });
    } catch (error) {
      result.push({
        ...fallback,
        error:
          error instanceof Error
            ? error.message
            : "This language could not be loaded.",
      });
    }
  }
  result.sort((a, b) => a.name.localeCompare(b.name));
  return result;
}

export async function installCustomCodeLanguage(
  input: CustomCodeLanguageInstallInput,
): Promise<CustomCodeLanguage> {
  const dir = await ensureCustomCodeLanguagesDir();
  const parsed = parseTextMateGrammar(input.grammar);
  const existing = await listCustomCodeLanguages();
  const targetExists = existing.some((language) => language.id === input.id);
  if (targetExists && !input.replace)
    throw new Error(`A language with id “${input.id}” already exists.`);
  const manifest = validateCustomCodeLanguageManifest(
    {
      id: input.id,
      name: input.name,
      aliases: input.aliases,
      scopeName: parsed.scopeName,
      enabled: input.enabled !== false,
    },
    {
      reservedAliases: RESERVED_CODE_FENCE_TAGS,
      existing,
      replacingId: targetExists ? input.id : undefined,
    },
  );
  const target = path.join(dir, manifest.id);
  const stage = path.join(dir, `.${manifest.id}-${randomUUID()}.tmp`);
  const backup = path.join(dir, `.${manifest.id}-${randomUUID()}.bak`);
  await fs.mkdir(stage, { recursive: false });
  try {
    await Promise.all([
      fs.writeFile(
        path.join(stage, "manifest.json"),
        `${JSON.stringify(manifest, null, 2)}\n`,
      ),
      fs.writeFile(path.join(stage, "grammar.tmLanguage.json"), input.grammar),
    ]);
    if (targetExists) await fs.rename(target, backup);
    try {
      await fs.rename(stage, target);
    } catch (error) {
      if (targetExists) await fs.rename(backup, target).catch(() => {});
      throw error;
    }
    if (targetExists) await fs.rm(backup, { recursive: true, force: true });
  } finally {
    await fs.rm(stage, { recursive: true, force: true }).catch(() => {});
  }
  return { ...manifest, grammar: input.grammar };
}

export async function updateCustomCodeLanguage(
  input: CustomCodeLanguageUpdateInput,
): Promise<CustomCodeLanguage> {
  if (!isSafeId(input.id)) throw new Error("Invalid custom language id.");
  const languages = await listCustomCodeLanguages();
  const current = languages.find((language) => language.id === input.id);
  if (!current || current.error)
    throw new Error(`Custom language “${input.id}” is not available.`);
  const manifest = validateCustomCodeLanguageManifest(
    {
      id: current.id,
      name: input.name ?? current.name,
      aliases: input.aliases ?? current.aliases,
      scopeName: current.scopeName,
      enabled: input.enabled ?? current.enabled,
    },
    {
      reservedAliases: RESERVED_CODE_FENCE_TAGS,
      existing: languages,
      replacingId: current.id,
    },
  );
  const file = path.join(
    getCustomCodeLanguagesDir(),
    current.id,
    "manifest.json",
  );
  const temp = `${file}.${randomUUID()}.tmp`;
  await fs.writeFile(temp, `${JSON.stringify(manifest, null, 2)}\n`);
  await fs.rename(temp, file);
  return { ...manifest, grammar: current.grammar };
}

export async function deleteCustomCodeLanguage(id: string): Promise<void> {
  if (!isSafeId(id)) return;
  const dir = getCustomCodeLanguagesDir();
  const folder = path.join(dir, id);
  if (path.dirname(path.resolve(folder)) !== path.resolve(dir)) return;
  await fs.rm(folder, { recursive: true, force: true }).catch(() => {});
}

export async function customCodeLanguageRevealTarget(
  id?: string,
): Promise<string> {
  const dir = await ensureCustomCodeLanguagesDir();
  if (isSafeId(id)) {
    const grammar = path.join(dir, id, "grammar.tmLanguage.json");
    if (
      path.dirname(path.dirname(path.resolve(grammar))) === path.resolve(dir) &&
      fsSync.existsSync(grammar)
    ) {
      return grammar;
    }
  }
  return dir;
}

let watcher: ReturnType<typeof chokidar.watch> | null = null;

export function startWatchingCustomCodeLanguages(
  onChange: (languages: CustomCodeLanguage[]) => void,
): void {
  void watcher?.close();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const fire = (): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void listCustomCodeLanguages().then(onChange);
    }, 200);
  };
  watcher = chokidar.watch(getCustomCodeLanguagesDir(), {
    ignoreInitial: true,
    depth: 1,
    awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
  });
  watcher
    .on("add", fire)
    .on("change", fire)
    .on("unlink", fire)
    .on("addDir", fire)
    .on("unlinkDir", fire);
}
