/**
 * Which API key a run or a live test uses for its model's provider: the provider's default, one of
 * its keys, or no key at all ("none", e.g. OpenCode Zen's free models or a server without auth).
 */
import { useQuery } from "@tanstack/react-query";
import { IconKey, IconKeyOff } from "@tabler/icons-react";
import { api } from "../lib/api.ts";
import { keys as qk } from "../lib/query.ts";
import { IC_SM } from "./ui/bits.tsx";
import { Select, type SelectOption } from "./ui/overlay.tsx";

export const NO_KEY = "none";

/** The providers agents can use, cached for the pickers. */
export const useProviders = () => useQuery({ queryKey: qk.providers, queryFn: api.providers, staleTime: 30_000 });

/** `value`: "" = the provider's default key, a key id, or NO_KEY. */
export function KeySelect({ model, value, onChange, field, className }: { model: string; value: string; onChange: (v: string) => void; field?: boolean; className?: string }) {
  const providers = useProviders();
  const pid = model.split("/")[0];
  const p = providers.data?.find((x) => x.id === pid);
  const keys = p?.keys ?? [];
  const fromSettings = p && !keys.length && p.via.some((v) => v === "env" || v === "auth.json");
  const options: SelectOption[] = [
    { value: "", label: keys.length ? `Default (${keys[0].name})` : fromSettings ? "From Settings" : "Default", hint: keys[0]?.hint ?? undefined },
    ...(keys.length > 1 ? keys.map((k) => ({ value: k.id, label: k.name, hint: k.status ? "failing" : (k.hint ?? undefined) })) : []),
    { value: NO_KEY, label: "No key", hint: "call without one" },
  ];
  return <Select field={field} className={className} label="API key" icon={value === NO_KEY ? <IconKeyOff {...IC_SM} /> : <IconKey {...IC_SM} />} value={value} onChange={onChange} options={options} />;
}
