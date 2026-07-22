// segment.js — 几何窗口分割(预处理层增强,架构层,不判价值)
// 用 OCR text_json 的归一化坐标块做空间聚类,把"整屏糊锅"切成空间独立的区域,
// 让语义层能分别判读、不再跨窗口拼接。纯几何,不依赖图像/OpenCV/OS 无障碍树,跨平台。
// 见 docs/screen-segmentation.md。

// 从 text_json(数组或 JSON 字符串)解析出归一化词块。失败返回 []。
function parseBoxes(textJson) {
  let arr;
  if (Array.isArray(textJson)) arr = textJson;
  else { try { arr = JSON.parse(textJson || '[]'); } catch (e) { return []; } }
  if (!Array.isArray(arr)) return [];
  return arr.map(b => {
    const x = +b.left, y = +b.top, w = +b.width, h = +b.height;
    if (![x, y, w, h].every(Number.isFinite) || w <= 0 || h <= 0) return null;
    const text = (b.text || '').trim();
    if (!text) return null;
    return { x, y, w, h, cx: x + w / 2, cy: y + h / 2, text };
  }).filter(Boolean);
}

// 并查集
function makeDSU(n) {
  const p = Array.from({ length: n }, (_, i) => i);
  const find = (i) => (p[i] === i ? i : (p[i] = find(p[i])));
  return { find, union: (a, b) => { p[find(a)] = find(b); } };
}

// 把词块聚成区域。返回 [{x0,y0,x1,y1,area,n,text}], 按面积降序。
function segmentBoxes(boxes, opts = {}) {
  if (boxes.length < 2) {
    if (!boxes.length) return [];
    const b = boxes[0];
    return [{ x0: b.x, y0: b.y, x1: b.x + b.w, y1: b.y + b.h, area: b.w * b.h, n: 1, text: b.text }];
  }
  const heights = boxes.map(b => b.h).sort((a, b) => a - b);
  const medH = heights[Math.floor(heights.length / 2)] || 0.02;
  const V_GAP = (opts.vGapFactor || 2.2) * medH;   // 垂直邻近(约几行内)
  const H_GAP = opts.hGap || 0.06;                 // 水平投影间隙(屏宽比例)

  const dsu = makeDSU(boxes.length);
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i], b = boxes[j];
      const vgap = Math.abs(a.cy - b.cy);
      const hgap = Math.max(0, Math.max(a.x, b.x) - Math.min(a.x + a.w, b.x + b.w));
      if (vgap < V_GAP && hgap < H_GAP) dsu.union(i, j);
    }
  }
  const groups = {};
  boxes.forEach((b, i) => { const r = dsu.find(i); (groups[r] = groups[r] || []).push(b); });
  const minBlocks = opts.minBlocks || 2;
  return Object.values(groups)
    .filter(bs => bs.length >= minBlocks)
    .map(bs => {
      const x0 = Math.min(...bs.map(b => b.x)), y0 = Math.min(...bs.map(b => b.y));
      const x1 = Math.max(...bs.map(b => b.x + b.w)), y1 = Math.max(...bs.map(b => b.y + b.h));
      const text = bs.slice().sort((a, b) => (a.cy - b.cy) || (a.cx - b.cx)).map(b => b.text).join(' ');
      return { x0, y0, x1, y1, area: (x1 - x0) * (y1 - y0), n: bs.length, text };
    })
    .sort((a, b) => b.area - a.area);
}

// 主入口:传入一帧的 text_json → 返回区域文本数组(按面积降序,大区域在前)。
// 分割不出多区域(单区域/无坐标)时返回 null,调用方退回原始拼平文本(拿不准就保留)。
function segmentFrame(textJson) {
  const boxes = parseBoxes(textJson);
  if (boxes.length < 4) return null;              // 词块太少,不值得切
  const regions = segmentBoxes(boxes);
  if (regions.length < 2) return null;            // 只有一个区域 → 没切开,退回原文
  return regions.map(r => r.text);
}

module.exports = { segmentFrame, segmentBoxes, parseBoxes };
