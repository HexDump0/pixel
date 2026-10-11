import { useState } from "react";
import { api } from "../lib/api.ts";
import { ErrorBox } from "../components/ui.tsx";

export function LoginPage({ onLogin }: { onLogin: () => void }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await api.login(password);
      onLogin();
    } catch (err: any) {
      setError(err.message);
    }
  };
  return (
    <form onSubmit={submit} className="card mx-auto mt-[18vh] flex max-w-xs flex-col gap-3">
      <div className="flex items-center gap-2 text-base font-semibold">
        <span style={{ width: 22, height: 22, borderRadius: 6, background: "var(--fg)", display: "grid", placeItems: "center" }}>
          <i style={{ width: 8, height: 8, background: "var(--bg)", borderRadius: 1 }} />
        </span>
        Pixel
      </div>
      <input className="input" type="password" autoFocus placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} />
      <ErrorBox error={error} />
      <button className="btn btn-primary justify-center" type="submit">
        Log in
      </button>
    </form>
  );
}
