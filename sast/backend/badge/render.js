const COLORS = Object.freeze({
  A: '#2e8b57',
  B: '#5aa02c',
  C: '#d4a017',
  D: '#e8730c',
  F: '#c62828',
  'N/A': '#777',
  scanning: '#777',
  unknown: '#777',
});

const escapeXml = (value) => String(value).replace(/[&<>"']/g, (char) => ({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}[char]));

export const renderBadge = (value) => {
  const text = value || 'unknown';
  const width = Math.max(42, text.length * 8 + 14);
  const color = COLORS[text] ?? '#777';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${62 + width}" height="20" role="img" aria-label="security: ${escapeXml(text)}">` +
    `<rect width="62" height="20" fill="#555"/><rect x="62" width="${width}" height="20" fill="${color}"/>` +
    `<g fill="#fff" font-family="Verdana,sans-serif" font-size="11"><text x="8" y="14">security</text>` +
    `<text x="${62 + width / 2}" y="14" text-anchor="middle">${escapeXml(text)}</text></g></svg>`;
};
