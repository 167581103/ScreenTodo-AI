import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { formatUserMessageHtml } from '../src/user-message-display.js';

describe('formatUserMessageHtml', () => {
  it('prefers persisted html chips', () => {
    const html = '<span class="mention" data-type="tool" data-name="get_more_context" contenteditable="false">获取上下文</span>(\'智研\')';
    assert.equal(
      formatUserMessageHtml("获取上下文('智研')\n\n（引用提示：工具：获取上下文）", html),
      html
    );
  });

  it('strips 引用提示 and rehydrates blue mention for legacy sessions', () => {
    const out = formatUserMessageHtml("获取上下文('智研')\n\n（引用提示：工具：获取上下文）");
    assert.equal(
      out,
      '<span class="mention" contenteditable="false">获取上下文</span>(\'智研\')'
    );
    assert.ok(!out.includes('引用提示'));
  });

  it('handles multiple mention labels from hint', () => {
    const out = formatUserMessageHtml('A 和 B\n\n（引用提示：工具：A、B）');
    assert.equal(
      out,
      '<span class="mention" contenteditable="false">A</span> 和 <span class="mention" contenteditable="false">B</span>'
    );
  });

  it('plain text without hint stays escaped text', () => {
    assert.equal(formatUserMessageHtml('hello <b>x</b>'), 'hello &lt;b&gt;x&lt;/b&gt;');
  });
});
