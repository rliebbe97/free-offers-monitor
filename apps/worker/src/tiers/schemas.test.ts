import { describe, it, expect } from 'vitest';
import { OfferExtractionSchema } from './schemas.js';

const VALID_BASE = {
  title: 'Free Pampers Sample Pack',
  destination_url: 'https://www.pampers.com/free-samples',
  shipping_cost: 0,
  restrictions: [],
  confidence: 0.9,
  is_excluded: false,
};

describe('OfferExtractionSchema', () => {
  it('accepts a well-formed extraction', () => {
    const result = OfferExtractionSchema.safeParse(VALID_BASE);
    expect(result.success).toBe(true);
  });

  it('rejects invalid category enum (e.g. "bundle" — that belongs to offer_type)', () => {
    const result = OfferExtractionSchema.safeParse({
      ...VALID_BASE,
      category: 'bundle',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.includes('category'))).toBe(true);
    }
  });

  it('accepts valid category enum values', () => {
    for (const c of ['baby_gear', 'formula', 'diapers', 'clothing', 'food', 'other']) {
      const result = OfferExtractionSchema.safeParse({ ...VALID_BASE, category: c });
      expect(result.success, `category=${c}`).toBe(true);
    }
  });

  it('rejects invalid offer_type enum', () => {
    const result = OfferExtractionSchema.safeParse({
      ...VALID_BASE,
      offer_type: 'mystery',
    });
    expect(result.success).toBe(false);
  });

  it('accepts null destination_url (extractor found no claim link in post)', () => {
    const result = OfferExtractionSchema.safeParse({
      ...VALID_BASE,
      destination_url: null,
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.destination_url).toBeNull();
  });

  it('coerces literal string "null" to null (Sonnet tool-use quirk)', () => {
    const result = OfferExtractionSchema.safeParse({
      ...VALID_BASE,
      destination_url: 'null',
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.destination_url).toBeNull();
  });

  it('coerces empty string destination_url to null', () => {
    const result = OfferExtractionSchema.safeParse({
      ...VALID_BASE,
      destination_url: '',
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.destination_url).toBeNull();
  });

  it('rejects missing destination_url (field is required, just nullable)', () => {
    const { destination_url: _omit, ...rest } = VALID_BASE;
    const result = OfferExtractionSchema.safeParse(rest);
    expect(result.success).toBe(false);
  });

  it('rejects non-URL string destination_url', () => {
    const result = OfferExtractionSchema.safeParse({
      ...VALID_BASE,
      destination_url: 'not a url',
    });
    expect(result.success).toBe(false);
  });

  it('rejects negative shipping_cost', () => {
    const result = OfferExtractionSchema.safeParse({
      ...VALID_BASE,
      shipping_cost: -1,
    });
    expect(result.success).toBe(false);
  });

  it('rejects out-of-range confidence', () => {
    const high = OfferExtractionSchema.safeParse({ ...VALID_BASE, confidence: 1.5 });
    const low = OfferExtractionSchema.safeParse({ ...VALID_BASE, confidence: -0.1 });
    expect(high.success).toBe(false);
    expect(low.success).toBe(false);
  });
});
