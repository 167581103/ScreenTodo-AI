'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { forcedToolForChat } = require('../chat-routing');

test('搜索意图强制调用 search_captured', () => {
  assert.equal(forcedToolForChat('搜一下oneyli'), 'search_captured');
  assert.equal(forcedToolForChat('调用工具搜一下 C'), 'search_captured');
  assert.equal(forcedToolForChat('再搜'), 'search_captured');
});

test('列表和屏幕问题路由到对应工具', () => {
  assert.equal(forcedToolForChat('今天有多少待办'), 'list_todos');
  assert.equal(forcedToolForChat('查一下刚才屏幕内容'), 'get_more_context');
  assert.equal(forcedToolForChat('你好'), '');
});
