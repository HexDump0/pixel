import { readdirSync, readFileSync } from "node:fs";
import { join, basename } from "node:path";
import { config } from "./config.ts";
import { db } from "./db.ts";

export interface TemplateVersion {
  template_id: string;
  version: number;
  body: string;
  note: string | null;
  created_at: number;
}

/** Seed templates from ./templates/*.md the first time Pixel starts. */
export function seedTemplates() {
  const count = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM templates").get()!.n;
  if (count > 0) return;
  for (const f of readdirSync(config.templatesDir).filter((f) => f.endsWith(".md"))) {
    const id = basename(f, ".md");
    createTemplate(id, id, readFileSync(join(config.templatesDir, f), "utf8"), "Initial version");
  }
}

export function createTemplate(id: string, name: string, body: string, note?: string) {
  const now = Date.now();
  db.query("INSERT INTO templates (id, name, created_at) VALUES (?, ?, ?)").run(id, name, now);
  db.query("INSERT INTO template_versions (template_id, version, body, note, created_at) VALUES (?, 1, ?, ?, ?)").run(id, body, note ?? null, now);
}

export function addVersion(id: string, body: string, note?: string) {
  const v = latestVersion(id);
  if (!v) throw new Error(`no template ${id}`);
  if (v.body === body) return v;
  const version = v.version + 1;
  db.query("INSERT INTO template_versions (template_id, version, body, note, created_at) VALUES (?, ?, ?, ?, ?)").run(id, version, body, note ?? null, Date.now());
  return getVersion(id, version)!;
}

export const latestVersion = (id: string) =>
  db.query<TemplateVersion, [string]>("SELECT * FROM template_versions WHERE template_id = ? ORDER BY version DESC LIMIT 1").get(id);

export const getVersion = (id: string, version: number) =>
  db.query<TemplateVersion, [string, number]>("SELECT * FROM template_versions WHERE template_id = ? AND version = ?").get(id, version);

export function listTemplates() {
  return db
    .query<{ id: string; name: string; created_at: number; version: number; updated_at: number; runs: number }, []>(
      `SELECT t.id, t.name, t.created_at, MAX(v.version) AS version, MAX(v.created_at) AS updated_at,
              (SELECT COUNT(*) FROM runs r WHERE r.template_id = t.id) AS runs
       FROM templates t JOIN template_versions v ON v.template_id = t.id GROUP BY t.id ORDER BY t.name`,
    )
    .all();
}

export const listVersions = (id: string) =>
  db
    .query<TemplateVersion & { runs: number }, [string]>(
      `SELECT v.*, (SELECT COUNT(*) FROM runs r WHERE r.template_id = v.template_id AND r.template_version = v.version) AS runs
       FROM template_versions v WHERE template_id = ? ORDER BY version DESC`,
    )
    .all(id);

export const TEMPLATE_VARIABLES = ["run", "repo", "ref", "commit", "target", "workbase", "workbases", "scratch", "disk_gib", "machine", "date", "model", "previous_workbase"];

/** Tiny templating: {{var}} and {{#if var}}...{{/if}} (no nesting). */
export function render(body: string, vars: Record<string, string | undefined | null>) {
  let out = body.replace(/\{\{#if (\w+)\}\}\n?([\s\S]*?)\{\{\/if\}\}\n?/g, (_, k, inner) => (vars[k] ? inner : ""));
  out = out.replace(/\{\{(\w+)\}\}/g, (m, k) => (k in vars ? String(vars[k] ?? "") : m));
  return out;
}
