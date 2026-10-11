/** /api/templates: versioned prompt templates and live preview. */
import { getSettings } from "../settings.ts";
import { addVersion, createTemplate, getVersion, latestVersion, listTemplates, listVersions, render, TEMPLATE_VARIABLES } from "../templates.ts";
import { repoName, templateVars } from "../runs/index.ts";
import { get, HttpError, post, readJson } from "./router.ts";

get("/templates", () => listTemplates());

post("/templates", async ({ req }) => {
  const b = await readJson(req);
  const id = String(b.id ?? "").trim().toLowerCase().replace(/[^a-z0-9._-]/g, "-");
  if (!id) throw new HttpError(400, "template id required");
  if (latestVersion(id)) throw new HttpError(409, `template ${id} already exists`);
  createTemplate(id, b.name || id, b.body ?? "", b.note);
  return latestVersion(id);
});

get("/templates/:id", ({ params: { id } }) => {
  const versions = listVersions(id);
  if (!versions.length) throw new HttpError(404, `no template ${id}`);
  return { versions, variables: TEMPLATE_VARIABLES };
});
post("/templates/:id/versions", async ({ req, params: { id } }) => {
  const b = await readJson(req);
  return addVersion(id, b.body, b.note);
});
get("/templates/:id/versions/:v", ({ params: { id, v } }) => getVersion(id, Number(v)));

/** Render a template body for a hypothetical run, so the new-run form can show the exact prompt. */
post("/templates/preview", async ({ req }) => {
  const b = await readJson(req);
  const s = getSettings();
  const repo = b.repo || "https://github.com/example/example";
  const vars = templateVars({
    id: b.name || `${repoName(repo)}-${new Date().toISOString().slice(0, 10)}`,
    repo,
    ref: b.ref || null,
    commit_sha: null,
    model: b.model || s.defaultModel,
    size: JSON.stringify(s.sizePresets[b.size] ?? s.sizePresets[s.defaultSize]),
    parent_run: b.parentRun || null,
    started_at: null,
  });
  return { prompt: render(b.body ?? "", vars) };
});
