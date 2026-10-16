/** Which proxy a run's (or a live test's) model calls go through, or none. Proxies are managed on the Models page. */
import { useQuery } from "@tanstack/react-query";
import { IconWorld, IconWorldOff } from "@tabler/icons-react";
import { api } from "../lib/api.ts";
import { keys as qk } from "../lib/query.ts";
import type { PublicProxy } from "../lib/types.ts";
import { IC_SM } from "./ui/bits.tsx";
import { Select } from "./ui/overlay.tsx";

export const useProxies = () => useQuery({ queryKey: qk.proxies, queryFn: api.proxies, staleTime: 30_000 });

/** Where a proxy comes out, from its last test: "Madurai, IN" (or its host when never tested). */
export const exitOf = (p: PublicProxy) => (p.test?.ok ? [p.test.city, p.test.country].filter(Boolean).join(", ") || p.test.ip || p.host : p.test ? "failing" : p.host);

/** `value`: "" = no proxy, else a proxy id. */
export function ProxySelect({ value, onChange, className }: { value: string; onChange: (v: string) => void; className?: string }) {
  const proxies = useProxies().data?.proxies ?? [];
  return (
    <Select
      className={className}
      label="Proxy"
      icon={value ? <IconWorld {...IC_SM} /> : <IconWorldOff {...IC_SM} />}
      value={value}
      onChange={onChange}
      options={[{ value: "", label: "No proxy", hint: "direct" }, ...proxies.map((p) => ({ value: p.id, label: p.name, hint: exitOf(p) }))]}
    />
  );
}
