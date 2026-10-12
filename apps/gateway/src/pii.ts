/**
 * PII detection + redaction.
 * Each detector = regex to find candidates + optional validator (checksum)
 * to cut false positives. Order matters: longer / stricter patterns first.
 */

export type PiiType = "CREDIT_CARD" | "MEDICARE" | "TFN" | "PHONE_AU" | "EMAIL";
export type RedactionCounts = Partial<Record<PiiType, number>>;

const digitsOf = (s: string) => s.replace(/\D/g, "");

/** Luhn checksum used by all major card networks */
export function luhnValid(num: string): boolean {
  const d = digitsOf(num);
  if (d.length < 13 || d.length > 19) return false;
  let sum = 0;
  for (let i = 0; i < d.length; i++) {
    let n = Number(d[d.length - 1 - i]);
    if (i % 2 === 1) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
  }
  return sum % 10 === 0;
}

/** Australian Tax File Number: 9 digits, weighted sum divisible by 11 */
export function tfnValid(num: string): boolean {
  const d = digitsOf(num);
  if (d.length !== 9) return false;
  const w = [1, 4, 3, 7, 5, 8, 6, 9, 10];
  const sum = w.reduce((acc, wi, i) => acc + wi * Number(d[i]), 0);
  return sum % 11 === 0;
}

/** Medicare card number: 10 digits, starts 2-6, 9th digit is a checksum */
export function medicareValid(num: string): boolean {
  const d = digitsOf(num);
  if (d.length !== 10 || !/^[2-6]/.test(d)) return false;
  const w = [1, 3, 7, 9, 1, 3, 7, 9];
  const sum = w.reduce((acc, wi, i) => acc + wi * Number(d[i]), 0);
  return sum % 10 === Number(d[8]);
}

type Detector = { type: PiiType; pattern: RegExp; validate?: (m: string) => boolean };

export const detectors: Detector[] = [
  { type: "CREDIT_CARD", pattern: /\b(?:\d[ -]?){12,18}\d\b/g, validate: luhnValid },
  { type: "MEDICARE", pattern: /\b[2-6]\d{3}[ ]?\d{5}[ ]?\d\b/g, validate: medicareValid },
  {
    type: "PHONE_AU",
    // mobiles: 04xx xxx xxx / +61 4xx xxx xxx ; landlines: (0x) xxxx xxxx / 0x xxxx xxxx
    pattern: /(?:\+61[ ]?4\d{2}|\b04\d{2})[ -]?\d{3}[ -]?\d{3}\b|(?:\(0[2378]\)|\b0[2378])[ ]?\d{4}[ -]?\d{4}\b/g,
  },
  { type: "TFN", pattern: /\b\d{3}[ ]?\d{3}[ ]?\d{3}\b/g, validate: tfnValid },
  { type: "EMAIL", pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g },
];

export function redactText(text: string): { text: string; counts: RedactionCounts } {
  const counts: RedactionCounts = {};
  let out = text;
  for (const d of detectors) {
    out = out.replace(d.pattern, (match) => {
      if (d.validate && !d.validate(match)) return match;
      counts[d.type] = (counts[d.type] ?? 0) + 1;
      return `[${d.type}_REDACTED]`;
    });
  }
  return { text: out, counts };
}

/** Redact any JSON-serialisable value (args, structured results). */
export function redactValue<T>(value: T): { value: T; counts: RedactionCounts } {
  if (value === undefined || value === null) return { value, counts: {} };
  const { text, counts } = redactText(JSON.stringify(value));
  return { value: JSON.parse(text) as T, counts };
}

export function mergeCounts(...all: RedactionCounts[]): RedactionCounts {
  const out: RedactionCounts = {};
  for (const c of all) for (const [k, v] of Object.entries(c)) out[k as PiiType] = (out[k as PiiType] ?? 0) + (v ?? 0);
  return out;
}

export const totalRedactions = (c: RedactionCounts) => Object.values(c).reduce((a, b) => a + (b ?? 0), 0);
