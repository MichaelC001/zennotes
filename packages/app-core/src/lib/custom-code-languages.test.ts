// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import { markdown as markdownLanguage } from "@codemirror/lang-markdown";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { CustomCodeLanguage } from "@shared/custom-code-languages";
import { customCodeFenceHighlightExtension } from "./cm-custom-code-languages";
import { resolveCodeLanguage } from "./cm-code-languages";
import {
  customCodeLanguageRegistry,
  tokenizeCustomGrammarPreview,
} from "./custom-code-languages";
import { renderMarkdown } from "./markdown";

const gleam: CustomCodeLanguage = {
  schemaVersion: 1,
  id: "gleam",
  name: "Gleam",
  aliases: ["gleam", "gl"],
  scopeName: "source.gleam",
  enabled: true,
  grammar: JSON.stringify({
    name: "Gleam",
    scopeName: "source.gleam",
    patterns: [
      { match: "\\b(?:fn|let)\\b", name: "keyword.control.gleam" },
      { begin: '"', end: '"', name: "string.quoted.double.gleam" },
      { match: "//.*$", name: "comment.line.double-slash.gleam" },
      { match: "\\b\\d+\\b", name: "constant.numeric.gleam" },
    ],
  }),
};

afterEach(async () => {
  await customCodeLanguageRegistry.replace([]);
});

describe("custom code language runtime", () => {
  it("tokenizes a TextMate grammar for the import preview", async () => {
    const source = 'fn answer = "forty two" // note\nlet n = 42';
    const tokens = await tokenizeCustomGrammarPreview(gleam, source);
    const highlighted = tokens.map((token) => ({
      text: source.slice(token.from, token.to),
      kind: token.kind,
    }));

    expect(highlighted).toContainEqual({ text: "fn", kind: "keyword" });
    expect(highlighted).toContainEqual({ text: '"forty two"', kind: "string" });
    expect(highlighted).toContainEqual({ text: "// note", kind: "comment" });
    expect(highlighted).toContainEqual({ text: "42", kind: "number" });
  });

  it("uses one registry for rendered Markdown and CodeMirror decorations", async () => {
    await customCodeLanguageRegistry.replace([gleam]);
    const source = "```gleam\nfn main {\n  let answer = 42\n}\n```";

    const html = renderMarkdown(source);
    expect(html).toContain("hljs-keyword");
    expect(html).toContain("hljs-number");

    const host = document.createElement("div");
    document.body.append(host);
    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: source,
        extensions: [
          markdownLanguage({ codeLanguages: resolveCodeLanguage }),
          customCodeFenceHighlightExtension,
        ],
      }),
    });
    expect(host.querySelector(".tok-keyword")?.textContent).toBe("fn");
    expect(host.querySelector(".tok-number")?.textContent).toBe("42");
    view.destroy();
    host.remove();
  });

  // The editor extension and the rehype plugin are installed unconditionally,
  // so the no-languages case has to cost nothing rather than walk the tree.
  it("stays inert when no grammar is installed", async () => {
    await customCodeLanguageRegistry.replace([]);
    expect(customCodeLanguageRegistry.isEmpty).toBe(true);

    const source = "```gleam\nfn main {\n  let answer = 42\n}\n```";
    expect(renderMarkdown(source)).not.toContain("hljs-keyword");

    const host = document.createElement("div");
    document.body.append(host);
    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: source,
        extensions: [
          markdownLanguage({ codeLanguages: resolveCodeLanguage }),
          customCodeFenceHighlightExtension,
        ],
      }),
    });
    expect(host.querySelector(".tok-keyword")).toBeNull();
    view.destroy();
    host.remove();
  });
});
