/** In-process pub/sub used to push live updates to dashboard websockets. */
type Listener = (msg: BusMessage) => void;

export interface BusMessage {
  /** Run the message belongs to, or "*" for fleet-wide updates. */
  run: string;
  type: string;
  data: unknown;
}

const listeners = new Set<Listener>();

export function publish(run: string, type: string, data: unknown) {
  const msg = { run, type, data };
  for (const l of listeners) {
    try {
      l(msg);
    } catch (e) {
      console.error("bus listener failed", e);
    }
  }
}

export function subscribe(l: Listener) {
  listeners.add(l);
  return () => listeners.delete(l);
}
