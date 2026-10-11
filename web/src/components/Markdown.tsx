/** Render untrusted markdown (agent output, reports) safely. */
import { useMemo } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";

export function Markdown({ text, className = "" }: { text: string; className?: string }) {
  const html = useMemo(() => DOMPurify.sanitize(marked.parse(text, { async: false, gfm: true, breaks: false }) as string), [text]);
  return <div className={`prose-pixel ${className}`} dangerouslySetInnerHTML={{ __html: html }} />;
}
