// Validation rules used by both the browser (as a <script>) and server.js (via require).

const SHARED = {
  // "12.5" -> 1250, or NaN. Parses the string to avoid float rounding.
  parseCents(s) {
    const m = /^(\d{1,7})(?:\.(\d{1,2}))?$/.exec(String(s ?? '').trim());
    return m ? Number(m[1]) * 100 + Number((m[2] || '').padEnd(2, '0')) : NaN;
  },
  MAX: { groupName: 60, displayName: 40, description: 80 },
  MIN_PASSWORD: 6,
};

if (typeof module !== 'undefined') module.exports = SHARED;
