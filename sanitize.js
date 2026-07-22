// sanitize.js — 录制层的通用输入清理(架构层)
//
// 分层边界(重要):
//   架构层(这里)只做**通用的结构化清理** —— 不枚举具体软件的 UI(那是 by-case),
//   不做"这条内容用户想不想要"的价值判断(那是用户层/提示词的事)。
//   原则:① 只按通用形态识别噪声 ② 拿不准就保留(宁可多花 token 也不漏关键内容)。
//
// 目前只做一件最无争议的事:去掉纯 UI 噪声行(孤立数字/角标/单字符),
// 这些在任何软件里都不是内容。不识别"会话列表""菜单栏"等具体形态。

// 通用噪声行:任何软件里都不承载信息的行,整行去掉。
function isNoiseLine(l) {
  if (!l) return true;
  if (/^\d{1,3}$/.test(l)) return true;        // 孤立数字(未读计数/角标)
  if (/^(99\+|\d+\+)$/.test(l)) return true;   // 未读角标 99+ / N+
  if (/^nil$/i.test(l)) return true;
  if (l.length === 1 && /[^\u4e00-\u9fa5\w]/.test(l)) return true; // 孤立符号
  return false;
}

// chrome 片段:承载工具自身 UI 的文本(如 Claw 所在的 WorkBuddy 界面),
// 从行内剥掉而非丢整帧 → 保留同屏浏览器/IM 里的真内容。
// 模式从 config.filter.chromePatterns 读,可配置,不硬编码具体软件。
function loadChromeRegex() {
  let patterns = [];
  try {
    const fs = require('fs'), path = require('path');
    const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
    patterns = (cfg.filter && cfg.filter.chromePatterns) || [];
  } catch (e) {}
  if (!patterns.length) return null;
  try { return new RegExp(patterns.join('|'), 'g'); } catch (e) { return null; }
}
const WB_CHROME = loadChromeRegex();

function stripWorkBuddyChrome(text) {
  return WB_CHROME ? text.replace(WB_CHROME, ' ') : text;
}

// 清洗单帧:① 剥掉 WorkBuddy 自身 UI 片段 ② 去通用噪声行。
// 绝不因"像导航态/像列表"就丢内容——那交给用户层提示词决定。
function sanitizeFrame(text) {
  const stripped = stripWorkBuddyChrome(String(text || ''));
  const lines = stripped.split(/\r?\n/).map((l) => l.trim());
  const kept = lines.filter((l) => l && !isNoiseLine(l));
  return kept.join('\n');
}

module.exports = { sanitizeFrame };
