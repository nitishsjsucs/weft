// Test ids for the wave 4 routine gallery (w4-parity-admin). Plain strings with no app imports, so the e2e specs
// import this file directly.
export const W4_GALLERY_TID = {
  gallery: "routine-gallery-w4",
  row: (id: string) => `routine-gallery-row-${id}`,
  card: (id: string) => `routine-gallery-card-${id}`,
  counts: (id: string) => `routine-decision-counts-${id}`,
} as const;
