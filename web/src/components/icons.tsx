/** Stroke icons (24×24 grid), drawn with currentColor. */
const PATHS = {
  runs: "M3 6a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM3 9h18M8 14h3",
  activity: "M22 12h-4l-3 9L9 3l-3 9H2",
  search: "M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM20 20l-3.5-3.5",
  file: "M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9zM14 3v6h6M8 13h8M8 17h5",
  system: "M3 6a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM8 20h8M12 16v4",
  settings: "M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0M14 4v4M8 10v4M16 16v4",
  plus: "M12 5v14M5 12h14",
  edit: "M15.5 4.5l4 4L8 20H4v-4z",
  term: "M4 17l6-5-6-5M12 19h8",
  pause: "M9 5v14M15 5v14",
  play: "M7 4l13 8-13 8z",
  msg: "M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z",
  open: "M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5",
  x: "M6 6l12 12M18 6L6 18",
  stop: "M6 6h12v12H6z",
  book: "M4 19.5A2.5 2.5 0 0 1 6.5 17H20V3H6.5A2.5 2.5 0 0 0 4 5.5zM4 19.5A2.5 2.5 0 0 0 6.5 22H20v-5",
  logout: "M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9",
  next: "M5 12h14M13 6l6 6-6 6",
  chart: "M4 20V10M10 20V4M16 20v-7M22 20H2",
  gauge: "M12 14l4-4M3.3 17a9 9 0 1 1 17.4 0M12 14a1 1 0 1 0 0 .01",
};

export type IconName = keyof typeof PATHS;

export function Icon({ name, className }: { name: IconName; className?: string }) {
  return (
    <svg className={`i ${className ?? ""}`} viewBox="0 0 24 24" aria-hidden="true">
      <path d={PATHS[name]} />
    </svg>
  );
}
