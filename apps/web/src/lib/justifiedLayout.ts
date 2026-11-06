/** Ordered frames with readable card widths. Artwork fits with object-fit: contain.
 * Incomplete rows stay compact; extreme ratios never squeeze neighbouring cards. */
export function justifiedLayout(ratios: number[], width: number, target = 260, gap = 16) {
  const available = Math.max(1, width);
  if (available < 456) return ratios.map(value => {
    const ratio = Number.isFinite(value) && value > 0 ? value : 1;
    return { width: available, height: Math.max(160, Math.min(420, available / ratio)) };
  });
  const minimum = Math.min(220, available);
  const result: { width: number; height: number }[] = [];
  let row: number[] = [];
  const rowWidth = (height: number) => row.reduce((sum, ratio) => sum + Math.max(minimum, ratio * height), 0) + gap * (row.length - 1);
  const flush = () => {
    let low = 0, high = target;
    for (let i = 0; i < 40; i++) {
      const height = (low + high) / 2;
      if (rowWidth(height) > available) high = height;
      else low = height;
    }
    row.forEach(ratio => result.push({ width: Math.max(minimum, ratio * low), height: low }));
    row = [];
  };
  for (const value of ratios) {
    const ratio = Number.isFinite(value) && value > 0 ? Math.min(value, available / target) : 1;
    if (row.length && rowWidth(target * .75) + gap + Math.max(minimum, ratio * target * .75) > available) flush();
    row.push(ratio);
    if (rowWidth(target) >= available) flush();
  }
  if (row.length) flush();
  return result;
}
