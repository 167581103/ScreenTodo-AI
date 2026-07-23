// 用户气泡展示 HTML：蓝字 mention。供渲染层与单测共用（纯函数，无 DOM 依赖）。
// 注意：此处不做 DOMPurify；渲染层在注入前仍须 sanitize。

export function escapeHtmlText(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * @param {string} content Agent 侧纯文本（可能含尾部「引用提示」）
 * @param {string} [html] 持久化的展示 HTML（优先）
 * @returns {string} 可注入用户气泡的 HTML（仍建议再 sanitize）
 */
export function formatUserMessageHtml(content, html) {
  if (html) return String(html);
  const raw = String(content || '');
  if (/class\s*=\s*["']mention["']/.test(raw)) return raw;

  const hintRe = /\n\n（引用提示：(.+)）\s*$/;
  const m = raw.match(hintRe);
  let body = raw;
  const labels = [];
  if (m) {
    body = raw.slice(0, m.index);
    for (const part of m[1].split('；')) {
      const i = part.indexOf('：');
      const names = (i >= 0 ? part.slice(i + 1) : part).split('、').map(s => s.trim()).filter(Boolean);
      labels.push(...names);
    }
  }
  let escaped = escapeHtmlText(body).replace(/\n/g, '<br>');
  labels.sort((a, b) => b.length - a.length);
  for (const label of labels) {
    const esc = escapeHtmlText(label);
    if (!esc) continue;
    escaped = escaped.replace(esc, `<span class="mention" contenteditable="false">${esc}</span>`);
  }
  return escaped;
}
