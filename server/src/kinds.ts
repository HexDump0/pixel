/** What a tool call is doing, by tool name. No imports: the dashboard uses it too. */
export type Kind = "shell" | "read" | "edit" | "task" | "web" | "other";

const KINDS: Record<string, Kind> = {
  bash: "shell",
  read: "read",
  grep: "read",
  glob: "read",
  list: "read",
  lsp: "read",
  edit: "edit",
  write: "edit",
  patch: "edit",
  multiedit: "edit",
  apply_patch: "edit",
  todowrite: "edit",
  task: "task",
  webfetch: "web",
  websearch: "web",
};
export const kindOf = (tool: string): Kind => KINDS[tool] ?? "other";
