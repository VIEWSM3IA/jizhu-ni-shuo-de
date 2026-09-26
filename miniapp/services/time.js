const MIN_OPEN_DELAY_MS = 10 * 60 * 1000;
const TONIGHT_GUARD_MS = 12 * 60 * 1000;
const MAX_TIMER_DELAY_MS = 2147483647;

function customIso(date, time) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '') || !/^\d{2}:\d{2}$/.test(time || '')) return '';
  const [year, month, day] = date.split('-').map(Number);
  const [hour, minute] = time.split(':').map(Number);
  const value = new Date(year, month - 1, day, hour, minute);
  if (value.getFullYear() !== year || value.getMonth() !== month - 1 || value.getDate() !== day || value.getHours() !== hour || value.getMinutes() !== minute) return '';
  return value.toISOString();
}

function canChooseTonight(now = new Date()) {
  const tonight = new Date(now);
  tonight.setHours(23, 59, 0, 0);
  return tonight.getTime() - now.getTime() >= TONIGHT_GUARD_MS;
}

function dueRefreshDelay(capsule, now = Date.now()) {
  if (!capsule || !['JOINABLE', 'SEALED'].includes(capsule.state)) return null;
  const opensAt = Date.parse(capsule.opens_at);
  if (!Number.isFinite(opensAt)) return null;
  return Math.min(Math.max(opensAt - now, 0), MAX_TIMER_DELAY_MS);
}

function graphemeCount(value) {
  if (typeof Intl !== 'undefined' && Intl.Segmenter) return [...new Intl.Segmenter('zh', { granularity: 'grapheme' }).segment(value)].length;
  return Array.from(value).length;
}

module.exports = { MIN_OPEN_DELAY_MS, customIso, canChooseTonight, dueRefreshDelay, graphemeCount };
