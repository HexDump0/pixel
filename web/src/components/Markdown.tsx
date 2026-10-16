/** Render untrusted markdown (agent output, reports) safely, with code blocks highlighted. */
import { useMemo } from "react";
import { Marked } from "marked";
import DOMPurify from "dompurify";
import { highlight } from "../lib/highlight.ts";

const marked = new Marked({
  gfm: true,
  breaks: false,
  renderer: {
    code({ text, lang }) {
      const l = (lang ?? "").split(/\s/)[0];
      return `<pre><code class="hljs${l ? ` language-${l.replace(/[^\w-]/g, "")}` : ""}">${highlight(text, l)}</code></pre>\n`;
    },
  },
});

export function Markdown({ text, className = "" }: { text: string; className?: string }) {
  const html = useMemo(() => DOMPurify.sanitize(marked.parse(text, { async: false }) as string), [text]);
  return <div className={`prose-pixel ${className}`} dangerouslySetInnerHTML={{ __html: html }} />;
}
