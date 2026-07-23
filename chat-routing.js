'use strict';

function forcedToolForChat(text) {
  const s = String(text || '').trim();
  if (!s) return '';
  if (/(?:屏幕|刚才.{0,6}(?:消息|内容)|上下文)/i.test(s) && /(?:看|查|回顾|找)/i.test(s)) return 'get_more_context';
  if (/(?:待办|任务)/i.test(s) && /(?:今天|全部|待处理|多少|几个|列出|有哪些|最近)/i.test(s)) return 'list_todos';
  if (/(?:调用工具.{0,8}(?:搜|查)|搜一下|搜索|检索|查找|再搜|再查)/i.test(s)) return 'search_captured';
  return '';
}

module.exports = { forcedToolForChat };
