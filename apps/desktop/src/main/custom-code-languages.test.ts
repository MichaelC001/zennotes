import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  customCodeLanguageRevealTarget,
  deleteCustomCodeLanguage,
  ensureCustomCodeLanguagesDir,
  getCustomCodeLanguagesDir,
  installCustomCodeLanguage,
  listCustomCodeLanguages,
  updateCustomCodeLanguage,
} from "./custom-code-languages";

const GLEAM_GRAMMAR = JSON.stringify({
  name: "Gleam",
  scopeName: "source.gleam",
  patterns: [{ match: "\\b(?:fn|let)\\b", name: "keyword.control.gleam" }],
});

let tempConfig: string;
const originalConfigDir = process.env.ZENNOTES_CONFIG_DIR;

beforeEach(async () => {
  tempConfig = await mkdtemp(join(tmpdir(), "zen-languages-"));
  process.env.ZENNOTES_CONFIG_DIR = tempConfig;
});

afterEach(async () => {
  if (originalConfigDir === undefined) delete process.env.ZENNOTES_CONFIG_DIR;
  else process.env.ZENNOTES_CONFIG_DIR = originalConfigDir;
  await rm(tempConfig, { recursive: true, force: true });
});

describe("custom code languages (main)", () => {
  it("installs, lists, updates, reveals, and removes a language pack", async () => {
    const dir = await ensureCustomCodeLanguagesDir();
    expect(existsSync(join(dir, "README.md"))).toBe(true);

    await installCustomCodeLanguage({
      fileName: "gleam.tmLanguage.json",
      grammar: GLEAM_GRAMMAR,
      id: "gleam",
      name: "Gleam",
      aliases: ["gleam", "gleam-lang"],
    });

    const folder = join(getCustomCodeLanguagesDir(), "gleam");
    expect(
      JSON.parse(await readFile(join(folder, "manifest.json"), "utf8")),
    ).toMatchObject({
      id: "gleam",
      enabled: true,
      aliases: ["gleam", "gleam-lang"],
    });
    expect((await listCustomCodeLanguages())[0]).toMatchObject({
      id: "gleam",
      scopeName: "source.gleam",
      grammar: GLEAM_GRAMMAR,
    });
    expect(await customCodeLanguageRevealTarget("gleam")).toBe(
      join(folder, "grammar.tmLanguage.json"),
    );

    await updateCustomCodeLanguage({
      id: "gleam",
      enabled: false,
      aliases: ["gleam", "gl"],
    });
    expect((await listCustomCodeLanguages())[0]).toMatchObject({
      enabled: false,
      aliases: ["gleam", "gl"],
    });

    await deleteCustomCodeLanguage("../gleam");
    expect(existsSync(folder)).toBe(true);
    await deleteCustomCodeLanguage("gleam");
    expect(existsSync(folder)).toBe(false);
  });

  it("prevents built-in aliases and collisions between custom languages", async () => {
    await expect(
      installCustomCodeLanguage({
        fileName: "fake.tmLanguage.json",
        grammar: GLEAM_GRAMMAR,
        id: "javascript",
        name: "Fake JavaScript",
        aliases: [],
      }),
    ).rejects.toThrow("reserved");

    await installCustomCodeLanguage({
      fileName: "gleam.tmLanguage.json",
      grammar: GLEAM_GRAMMAR,
      id: "gleam",
      name: "Gleam",
      aliases: ["gl"],
    });
    await expect(
      installCustomCodeLanguage({
        fileName: "other.tmLanguage.json",
        grammar: GLEAM_GRAMMAR.replaceAll("gleam", "other"),
        id: "other",
        name: "Other",
        aliases: ["gl"],
      }),
    ).rejects.toThrow("already used");
  });

  it("surfaces hand-edited broken packs without loading their grammar", async () => {
    const dir = await ensureCustomCodeLanguagesDir();
    const installed = await installCustomCodeLanguage({
      fileName: "gleam.tmLanguage.json",
      grammar: GLEAM_GRAMMAR,
      id: "gleam",
      name: "Gleam",
      aliases: [],
    });
    expect(installed.error).toBeUndefined();
    await writeFile(join(dir, "gleam", "grammar.tmLanguage.json"), "{broken");

    expect((await listCustomCodeLanguages())[0]).toMatchObject({
      id: "gleam",
      enabled: false,
      grammar: "",
      error: "This file is not valid JSON.",
    });
  });
});
