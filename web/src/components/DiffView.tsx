/** Colourised `git show` output. */
const lineClass = (l: string) =>
  l.startsWith("+") && !l.startsWith("+++")
    ? "text-emerald-600 dark:text-emerald-400"
    : l.startsWith("-") && !l.startsWith("---")
      ? "text-red-600 dark:text-red-400"
      : l.startsWith("@@")
        ? "text-accent"
        : l.startsWith("diff ")
          ? "mt-2 font-semibold"
          : "";

export function DiffView({ patch }: { patch: string }) {
  return (
    <pre className="max-h-[70vh] overflow-auto rounded-md border border-zinc-200 p-3 font-mono text-xs whitespace-pre dark:border-zinc-800">
      {patch.split("\n").map((l, i) => (
        <div key={i} className={lineClass(l)}>
          {l || " "}
        </div>
      ))}
    </pre>
  );
}
