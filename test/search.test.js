'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { matchesSearch } = require('../workspace-data');

test('搜索覆盖普通捕获字段', () => {
  assert.equal(matchesSearch({
    title: '回复安全机器人',
    context: '确认 screenpipe 文件来源',
  }, 'SCREENPIPE'), true);
});

test('搜索覆盖已拒记录的屏幕原文和场景', () => {
  assert.equal(matchesSearch({
    kind: 'rejected',
    screen: 'oneyli（李阳） OK',
    scene: { name: 'IM消息', why: '群聊成员列表' },
  }, 'oneyli'), true);
  assert.equal(matchesSearch({
    kind: 'rejected',
    screen: 'oneyli（李阳） OK',
  }, '不存在的名字'), false);
});
