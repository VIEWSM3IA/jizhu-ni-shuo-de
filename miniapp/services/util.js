const pad = n => String(n).padStart(2, '0');
const formatDate = iso => {
  const d = new Date(iso);
  return `${d.getMonth()+1} 月 ${d.getDate()} 日 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const shareTitle = c => {
  const text = `🔒 ${c.creator_alias} 把话放这了：${c.statement}`;
  return [...text].slice(0, 32).join('');
};
const requestId = () => `${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
module.exports = { formatDate, shareTitle, requestId };
