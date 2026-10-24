/** Line icons (24 px grid) used by the shell: crisp on every platform, unlike emoji. */
const PATHS = {
  home: "M3 11.5 12 4l9 7.5M5 10v10h5v-6h4v6h5V10",
  grid: "M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z",
  plus: "M12 5v14M5 12h14",
  box: "M3.5 8 12 3.5 20.5 8v8L12 20.5 3.5 16zM3.5 8 12 12.5 20.5 8M12 12.5v8",
  user: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4.5 20c.8-3.5 3.9-5.5 7.5-5.5s6.7 2 7.5 5.5",
  search: "M10.5 18a7.5 7.5 0 1 0 0-15 7.5 7.5 0 0 0 0 15zM16 16l5 5",
  arrow: "M5 12h14M13 6l6 6-6 6",
  chevron: "M9 6l6 6-6 6",
  close: "M6 6l12 12M18 6 6 18",
  heart: "M12 20.5s-7.5-4.6-7.5-10A4.3 4.3 0 0 1 12 7.8a4.3 4.3 0 0 1 7.5 2.7c0 5.4-7.5 10-7.5 10z",
  check: "M5 12.5 10 17 19 7",
  shield: "M12 3.5 5 6v5.5c0 4.5 3 7.6 7 9 4-1.4 7-4.5 7-9V6z",
} as const;
export type IconName = keyof typeof PATHS;

export function Icon({ name, filled = false, className = "icon" }: { name: IconName; filled?: boolean; className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill={filled ? "currentColor" : "none"} stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={PATHS[name]} />
    </svg>
  );
}
