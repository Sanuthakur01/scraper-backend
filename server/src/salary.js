// Reads a job's salary text, as each site writes it, into lakhs per year (LPA):
//   Naukri     "15-25 Lacs PA", "8 Lacs PA"
//   LinkedIn   "₹4L - ₹8L (Glassdoor Est.)", "₹600,000.00/yr - ₹2,200,000.00/yr"
//   Indeed     "₹4,33,250–₹9,00,000 / year", "₹30,000–₹40,000 / month"
//   Glassdoor  "₹65L (Employer provided)", "₹9L - ₹30L (Employer provided)"
// Returns { min, max, estimate } (LPA; one figure gives min = max, "up to 10" gives min null; estimate =
// a Glassdoor estimate, not the employer's figure), or null when there is no salary or it can't be read
// safely:
//   - "Not disclosed" and the like
//   - plain rupees with no "per year" or "per month" ("₹50,000 - ₹70,000"): could be either
//   - hourly pay
//   - every figure under ₹1 lakh a year, or any over ₹5 crore: a placeholder, not a package (e.g. one
//     company posts every job as "50,000 PA")

const UNIT = { cr: 1e7, crore: 1e7, crores: 1e7, lpa: 1e5, l: 1e5, lac: 1e5, lacs: 1e5, lakh: 1e5, lakhs: 1e5, k: 1e3, t: 1e3 };
const LAKH = 1e5;

export function parseSalary(text) {
  const t = String(text ?? '').toLowerCase().replace(/₹|inr|rs\.?/g, ' ');
  if (!t.trim() || /not disclosed|negotiable|competitive|as per|best in|not specified/.test(t)) return null;
  if (/hour|\/hr\b|per hr/.test(t)) return null;
  const monthly = /month|\/mo\b|\bpm\b|p\.m\./.test(t);
  const yearly = /year|\/yr\b|\bpa\b|p\.a\.|annum|annual|lpa/.test(t);

  const parts = [...t.matchAll(/(\d[\d,]*(?:\.\d+)?)\s*(crores?|cr|lakhs?|lacs?|lac|lpa|l|k|t)?(?![a-z])/g)].map((m) => ({
    value: Number(m[1].replace(/,/g, '')),
    unit: m[2] ?? null,
  }));
  const numbers = parts.filter((p) => Number.isFinite(p.value) && p.value > 0).slice(0, 2);
  if (!numbers.length) return null;
  // "15-25 Lacs PA": the unit written once applies to both figures.
  const shared = numbers.at(-1).unit;
  const rupees = numbers.map((p) => p.value * (UNIT[p.unit ?? shared] ?? 1));
  const inUnits = numbers.some((p) => p.unit ?? shared);
  // Plain rupees need a period; lakhs and crores are yearly unless it says otherwise.
  if (!monthly && !yearly && !inUnits) return null;
  const perYear = rupees.map((r) => (monthly ? r * 12 : r));
  const [min, max] = [Math.min(...perYear), Math.max(...perYear)];
  if (max < LAKH || max > 500 * LAKH) return null;
  const lpa = (r) => Math.round((r / LAKH) * 100) / 100;
  const upTo = /up ?to/.test(t) && perYear.length === 1;
  return { min: upTo ? null : lpa(min), max: lpa(max), estimate: /est\.|estimate/.test(t) };
}
