export function parseProbeFields(text: string): string[] {
  if (text === '') return [];
  if (!text.trimStart().startsWith('[')) return text.split(',');
  let value: unknown;
  try { value = JSON.parse(text); }
  catch { throw new Error('Use a JSON array of strings for exact Probe identities'); }
  if (!Array.isArray(value) || value.some(field => typeof field !== 'string')) {
    throw new Error('Probe identity arrays must contain strings only');
  }
  return value;
}
