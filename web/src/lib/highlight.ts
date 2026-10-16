/** Syntax highlighting (highlight.js core with the languages audits meet), for code in markdown, files and tool output. */
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import c from "highlight.js/lib/languages/c";
import cmake from "highlight.js/lib/languages/cmake";
import cpp from "highlight.js/lib/languages/cpp";
import diff from "highlight.js/lib/languages/diff";
import go from "highlight.js/lib/languages/go";
import ini from "highlight.js/lib/languages/ini";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import makefile from "highlight.js/lib/languages/makefile";
import markdown from "highlight.js/lib/languages/markdown";
import python from "highlight.js/lib/languages/python";
import rust from "highlight.js/lib/languages/rust";
import shell from "highlight.js/lib/languages/shell";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";

for (const [name, lang] of Object.entries({ bash, c, cmake, cpp, diff, go, ini, javascript, json, makefile, markdown, python, rust, shell, sql, typescript, xml, yaml })) hljs.registerLanguage(name, lang);

const BY_EXT: Record<string, string> = {
  c: "c", h: "c", cc: "cpp", cpp: "cpp", cxx: "cpp", hpp: "cpp", hh: "cpp", hxx: "cpp",
  py: "python", rs: "rust", go: "go", js: "javascript", mjs: "javascript", cjs: "javascript", ts: "typescript", tsx: "typescript", jsx: "javascript",
  json: "json", yaml: "yaml", yml: "yaml", toml: "ini", ini: "ini", cfg: "ini", conf: "ini",
  sh: "bash", bash: "bash", zsh: "bash", md: "markdown", markdown: "markdown",
  xml: "xml", html: "xml", svg: "xml", sql: "sql", diff: "diff", patch: "diff", cmake: "cmake", mk: "makefile",
};
const BY_NAME: Record<string, string> = { makefile: "makefile", gnumakefile: "makefile", "cmakelists.txt": "cmake", dockerfile: "bash" };

/** The language for a file path, or null if it isn't one we highlight. */
export function langForPath(path: string) {
  const name = path.split("/").pop()!.toLowerCase();
  return BY_NAME[name] ?? BY_EXT[name.includes(".") ? name.split(".").pop()! : ""] ?? null;
}

const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** HTML for `code` in `lang` (a name or alias, e.g. from a ``` fence). Unknown or huge input comes back escaped, unhighlighted. */
export function highlight(code: string, lang?: string | null) {
  const l = lang?.toLowerCase().trim();
  if (code.length > 200_000 || !l || !hljs.getLanguage(l)) return escape(code);
  try {
    return hljs.highlight(code, { language: l, ignoreIllegals: true }).value;
  } catch {
    return escape(code);
  }
}

/** Highlighted HTML cut into lines, closing and reopening spans at each break, so lines can be numbered. */
export function htmlLines(html: string) {
  const out: string[] = [];
  const open: string[] = [];
  let line = "";
  for (const tok of html.split(/(<span[^>]*>|<\/span>|\n)/)) {
    if (!tok) continue;
    if (tok === "\n") {
      out.push(line + "</span>".repeat(open.length));
      line = open.join("");
    } else {
      if (tok.startsWith("<span")) open.push(tok);
      else if (tok === "</span>") open.pop();
      line += tok;
    }
  }
  out.push(line);
  return out;
}
