/** Format micropaise for honest UI display (1 INR = 100_000 micropaise). */
export function formatMicropaiseDisplay(
  micropaise: number,
  symbol = "₹",
): string {
  const n = Math.max(0, Math.floor(micropaise));
  if (n === 0) return `${symbol}0`;
  const rupees = n / 100_000;
  if (rupees >= 1) {
    const rounded = Math.round(rupees * 100) / 100;
    return `${symbol}${rounded % 1 === 0 ? rounded.toFixed(0) : rounded.toFixed(2)}`;
  }
  if (rupees >= 0.01) {
    return `${symbol}${rupees.toFixed(4).replace(/0+$/, "").replace(/\.$/, "")}`;
  }
  // Sub-paise: show as fractional paise for clarity
  const paise = n / 1000;
  return `${paise.toFixed(1)}p`;
}

export function micropaiseToRupees(micropaise: number): number {
  return Math.max(0, micropaise) / 100_000;
}
