'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { popupRequestsFromTrace, shouldRecordRejected } = require('../popup-trace');

test('只提取当前 run trace 中的 show_popup 调用', () => {
  const trace = [
    { name: 'get_more_context', args: { app: '企业微信' } },
    { name: 'show_popup', args: { title: ' 回复排期 ', reason: ' 对方正在等待 ', context: ' 原文 ' } },
  ];

  assert.deepEqual(popupRequestsFromTrace(trace), [{
    item: { title: '回复排期', reason: '对方正在等待', context: '原文' },
  }]);
});

test('不同 run 的 trace 不会互相消费', () => {
  const runA = popupRequestsFromTrace([{ name: 'show_popup', args: { title: '任务 A' } }]);
  const runB = popupRequestsFromTrace([{ name: 'show_popup', args: { title: '任务 B' } }]);

  assert.equal(runA.length, 1);
  assert.equal(runA[0].item.title, '任务 A');
  assert.equal(runB.length, 1);
  assert.equal(runB[0].item.title, '任务 B');
});

test('忽略空标题并限制模型输出长度', () => {
  const trace = [
    { name: 'show_popup', args: { title: '   ', reason: 'x' } },
    { name: 'show_popup', args: { title: 'a'.repeat(100), reason: 'b'.repeat(300), context: 'c'.repeat(600) } },
  ];
  const [popup] = popupRequestsFromTrace(trace);

  assert.equal(popup.item.title.length, 80);
  assert.equal(popup.item.reason.length, 240);
  assert.equal(popup.item.context.length, 500);
});

test('调用 show_popup 后不再把同一屏幕写进 rejected', () => {
  assert.equal(shouldRecordRejected({ suggest: false }, 1, 0), false);
  assert.equal(shouldRecordRejected({ suggest: false }, 0, 0), true);
  assert.equal(shouldRecordRejected({ suggest: true }, 0, 1), false);
});
