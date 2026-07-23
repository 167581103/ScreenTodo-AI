'use strict';

// 从单次 Agent run 的工具轨迹中提取弹窗请求。
// trace 属于 run 返回值，因此并行判读之间天然隔离。
function popupRequestsFromTrace(trace) {
  if (!Array.isArray(trace)) return [];
  return trace
    .filter(t => t && t.name === 'show_popup')
    .map(t => ({
      item: {
        title: String(t.args?.title || '').trim().slice(0, 80),
        reason: String(t.args?.reason || '').trim().slice(0, 240),
        context: String(t.args?.context || '').trim().slice(0, 500),
      },
    }))
    .filter(t => t.item.title);
}

function shouldRecordRejected(result, popupCount, legacyItemCount) {
  if (popupCount > 0) return false;
  return !result?.suggest || legacyItemCount === 0;
}

module.exports = { popupRequestsFromTrace, shouldRecordRejected };
