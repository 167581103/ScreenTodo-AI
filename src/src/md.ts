// 轻量同步 Markdown 渲染(与旧 chatPanel 的 md() 等价)
function esc(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
function inlineMd(s: string): string {
  return s
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '<a href="$2">$1</a>');
}
export function md(s: string): string {
  let t = esc(String(s || ''));
  const blocks: string[] = [];
  t = t.replace(/```([\s\S]*?)```/g, (_, code) => { blocks.push(code.replace(/^\n/, '')); return '\0CB' + (blocks.length - 1) + '\0'; });
  const lines = t.split('\n');
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const ln = lines[i];
    const cb = ln.match(/^\0CB(\d+)\0$/);
    if (cb) { out.push('<pre><code>' + blocks[+cb[1]] + '</code></pre>'); i++; continue; }
    if (/^\s*---+\s*$/.test(ln)) { out.push('<hr>'); i++; continue; }
    const hm = ln.match(/^(#{1,3})\s+(.*)$/);
    if (hm) { out.push('<h' + hm[1].length + '>' + inlineMd(hm[2]) + '</h' + hm[1].length + '>'); i++; continue; }
    if (/^\s*>\s?/.test(ln)) { const q: string[] = []; while (i < lines.length && /^\s*>\s?/.test(lines[i])) { q.push(inlineMd(lines[i].replace(/^\s*>\s?/, ''))); i++; } out.push('<blockquote>' + q.join('<br>') + '</blockquote>'); continue; }
    if (/^\s*\d+\.\s+/.test(ln)) { const items: string[] = []; while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) { items.push('<li>' + inlineMd(lines[i].replace(/^\s*\d+\.\s+/, '')) + '</li>'); i++; } out.push('<ol>' + items.join('') + '</ol>'); continue; }
    if (/^\s*[-*]\s+/.test(ln)) { const items: string[] = []; while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) { items.push('<li>' + inlineMd(lines[i].replace(/^\s*[-*]\s+/, '')) + '</li>'); i++; } out.push('<ul>' + items.join('') + '</ul>'); continue; }
    if (/^\s*$/.test(ln)) { i++; continue; }
    const para = [ln]; i++;
    while (i < lines.length && !/^\s*$/.test(lines[i]) && !/^(#{1,3}\s|>\s?|\s*[-*]\s|\s*\d+\.\s|\s*---+\s*$)/.test(lines[i]) && !/^\0CB\d+\0$/.test(lines[i])) { para.push(lines[i]); i++; }
    out.push('<p>' + para.map(inlineMd).join('<br>') + '</p>');
  }
  return out.join('');
}
