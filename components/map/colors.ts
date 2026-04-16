const PALETTE = [
  "#0a7d38",
  "#d97706",
  "#2563eb",
  "#db2777",
  "#65a30d",
  "#9333ea",
  "#0d9488",
  "#dc2626",
];

let cursor = 0;
export function pickColor(): string {
  const c = PALETTE[cursor % PALETTE.length];
  cursor += 1;
  return c;
}
