/** Models: how each provider is behaving right now, how each model has done across all runs, and a speed test. */
import { PageHeader } from "../components/ui.tsx";
import { ProviderHealth } from "../components/ProviderHealth.tsx";
import { ModelLeaderboard } from "../components/ModelLeaderboard.tsx";
import { SpeedTest } from "../components/SpeedTest.tsx";

export function ModelsPage() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <PageHeader title="Models" subtitle="Live provider health from every agent's model calls, every model compared across all runs, and a quick speed test." />
      <ProviderHealth />
      <ModelLeaderboard />
      <SpeedTest />
    </div>
  );
}
