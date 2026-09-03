const MICROPAISE_PER_INR = 100_000;

export function rupeesToMicropaise(rupees: number): number {
  if (!Number.isInteger(rupees) || rupees < 0) throw new Error("Use whole rupees");
  return rupees * MICROPAISE_PER_INR;
}

export function formatInrFromMicropaise(micropaise: number): string {
  const n = Math.max(0, Math.floor(micropaise || 0));
  const rupees = n / MICROPAISE_PER_INR;
  if (rupees >= 1) {
    return `₹${rupees.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
  }
  if (n === 0) return "₹0";
  return `₹${rupees.toFixed(4)}`;
}

export function formatCpm(cpmMicropaise: number): string {
  return `₹${Math.floor(cpmMicropaise / MICROPAISE_PER_INR)} CPM`;
}

export function formatPct(rate: number): string {
  return `${(rate * 100).toFixed(2)}%`;
}
