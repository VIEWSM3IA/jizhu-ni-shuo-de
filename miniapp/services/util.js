const pad = n => String(n).padStart(2, '0');
const formatDate = iso => {
  const d = new Date(iso);
  return `${d.getMonth()+1} 月 ${d.getDate()} 日 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const shareTitle = c => {
  const text = `🔒 ${c.creator_alias} 把话放这了：${c.statement}`;
  return [...text].slice(0, 32).join('');
};
const splitGraphemes = text => {
  if (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function') {
    return Array.from(new Intl.Segmenter('zh', { granularity: 'grapheme' }).segment(text), x => x.segment);
  }
  const chars = [...text], out = [];
  let markPattern;
  try { markPattern = new RegExp('\\p{M}', 'u'); } catch { /* Older JS engines lack Unicode property escapes. */ }
  const cp = ch => ch.codePointAt(0);
  const isExtend = ch => {
    const n = cp(ch);
    return (markPattern && markPattern.test(ch)) ||
      (n >= 0x0300 && n <= 0x036f) || (n >= 0x1ab0 && n <= 0x1aff) ||
      (n >= 0x1dc0 && n <= 0x1dff) || (n >= 0x20d0 && n <= 0x20ff) ||
      (n >= 0xfe20 && n <= 0xfe2f) || (n >= 0xfe00 && n <= 0xfe0f) ||
      (n >= 0xe0100 && n <= 0xe01ef) || (n >= 0x1f3fb && n <= 0x1f3ff) ||
      (n >= 0x0900 && n <= 0x0903) || (n >= 0x093a && n <= 0x094f) ||
      (n >= 0x0951 && n <= 0x0957) || (n >= 0x0962 && n <= 0x0963);
  };
  const isRegionalIndicator = ch => {
    const n = cp(ch);
    return n >= 0x1f1e6 && n <= 0x1f1ff;
  };
  for (let i = 0; i < chars.length; i++) {
    let grapheme = chars[i];
    if (isRegionalIndicator(chars[i]) && i + 1 < chars.length && isRegionalIndicator(chars[i + 1])) grapheme += chars[++i];
    while (i + 1 < chars.length && isExtend(chars[i + 1])) grapheme += chars[++i];
    while (i + 2 < chars.length && chars[i + 1] === '\u200d') {
      grapheme += chars[++i] + chars[++i];
      while (i + 1 < chars.length && isExtend(chars[i + 1])) grapheme += chars[++i];
    }
    out.push(grapheme);
  }
  return out;
};
const resultShareTitle = c => {
  const suffix = '」——那天大家是这么说的';
  const budget = 32 - [...suffix].length - 1;
  if ([...c.statement].length <= budget) return `「${c.statement}${suffix}`;
  let statement = '', used = 0;
  for (const grapheme of splitGraphemes(c.statement)) {
    const size = [...grapheme].length;
    if (used + size > budget - 1) break;
    statement += grapheme;
    used += size;
  }
  return `「${statement}…${suffix}`;
};
const requestId = () => `${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
module.exports = { formatDate, shareTitle, resultShareTitle, requestId };
