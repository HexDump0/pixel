/** Models: how each provider is behaving right now, and how each model has done across all runs. */
import { PageHeader } from "../components/ui.tsx";
import { ProviderHealth } from "../components/ProviderHealth.tsx";
import { ModelLeaderboard } from "../components/ModelLeaderboard.tsx";

export function ModelsPage() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <PageHeader title="Models" subtitle="Live provider health from every agent's model calls, and every model compared across all runs." />
      <ProviderHealth />
      <ModelLeaderboard />
    </div>
  );
}
