// agent.js — 判读 Agent 内核(有工具、有界 ReAct)
// 一个 Agent、两个入口:后台 tick 自动喂屏幕(runOnScreen),前台对话主动问(runOnChat)。
// 同一套工具、同一个 ReAct 循环,只是初始 message 不同。
//
// 相比旧 judge.js 的单次无状态调用,这里 Agent 可以在信息不全时**自主调用工具补上下文再判**
// (标准 DeepSeek function calling)。循环有界(maxSteps),防止无限调用烧 token。
//
// 用法:
//   const agent = require('./agent.js')(CONFIG, log, tools);
//   const r = await agent.runOnScreen(screenText);  // → { suggest, items:[...], _steps, _usage }
//   const r = await agent.runOnChat(userMsg, history);
//
// tools: { name: { def, run } }  由调用方(daemon)注入。
//   def = OpenAI/DeepSeek function schema(告诉模型工具长啥样)
//   run = async (args) => string  实际执行,返回喂回模型的文本

const JUDGE_PROMPT = `你是屏幕监控 Agent。用户发来一段当前屏幕的 OCR 文本,你判读并返回与 chancguo(郭辰,用户本人)有关的待办。

【捕获规则】
只捕与 chancguo 有关的客观事实——别人对其要求、指派、等待其产出、或其自己写的 Todo。
- 私聊中对方对 chancguo 的要求(如"提单给我""帮我看下")→捕
- 群聊中 @chancguo 或明确指派→捕
- 群聊"你们/大家/各位/@所有人"向全体广播且未 @chancguo → 不捕(群体任务≠个人待办)
- 纯他人互聊、闲聊、寒暄→不捕
- 自己写的 Todo 列表→捕
- AI 助手(元宝/豆包)给的建议→捕;纯生成/娱乐→不捕
- WorkBuddy 排障自语("验证健康/重启/dump脚本")→不捕

【反幻觉铁律 — 违反即错】
- @ 谁就是给谁。@ 列表没有 chancguo/郭辰,则不是指派给他 → suggest=false。
- 禁止编造锚点:除非原文真的 @了 chancguo 或点名"郭辰/你(单数指 chancguo)",否则不许在 reason 写"指派 chancguo/需 chancguo 参与"。
- 话题属于 chancguo 领域 ≠ 指派给他。

【上下文不全时,先取上下文再判 — 重要】
- 若文本里出现指代词("这个/它/上面那条/这条")但看不到被指代的对象,或消息明显是某个对话的片段而缺少前文,**不要凭空猜测、不要硬判**。
- 此时应调用 get_more_context 工具,拉取该来源(app)最近的更多帧/前文,补全"这个"到底指什么,再做判断。
- 例:看到"辰,这个今天生效了吗"却不知道"这个"指什么 → 调 get_more_context 拉企业微信前文 → 可能发现引用的是"妙思二创上线" → 据此判出准确待办。
- 补全后仍无法确定与 chancguo 的关系,则 suggest=false,不要编造。

【宁滥勿缺】确定相关时倾向捕,漏比多严重。弱信号:"记得做/回头/待跟进/ddl/跟进/复盘/对齐/评审/排期/同步"、告警/异常/决定/结论。

【输出】判读完成时,输出且仅输出一份 JSON(不要额外文字):
{"suggest":true,"items":[{"title":"简短动宾≤20字","reason":"为什么相关≤40字","context":"原文片段≤50字"}]}
无待办则 {"suggest":false}。
注意:需要更多上下文时调用工具,不要直接输出 JSON;信息足够时才输出 JSON。`;

module.exports = function createAgent(CONFIG, log, tools) {
  log = log || (() => {});
  tools = tools || {};
  const MAX_STEPS = (CONFIG.agent && CONFIG.agent.maxSteps) || 3; // ReAct 最多轮数(含首判)
  const toolDefs = Object.values(tools).map((t) => t.def).filter(Boolean);

  // 单次 LLM 调用。allowTools 决定是否带 tools(对话末轮可强制不带工具、逼它出结论)。
  async function call(messages, allowTools) {
    const body = {
      model: CONFIG.deepseek.model,
      messages,
      temperature: 0.2,
    };
    if (allowTools && toolDefs.length) {
      body.tools = toolDefs;
      body.tool_choice = 'auto';
    } else {
      body.response_format = { type: 'json_object' }; // 末轮:强制出 JSON
    }
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 40000);
    try {
      const r = await fetch(CONFIG.deepseek.apiBase.replace(/\/$/, '') + '/chat/completions', {
        method: 'POST', signal: ac.signal,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${CONFIG.deepseek.apiKey}` },
        body: JSON.stringify(body),
      });
      const d = await r.json();
      const u = d.usage || {};
      const hit = u.prompt_cache_hit_tokens || u.prompt_tokens_details?.cached_tokens || 0;
      const total = u.prompt_tokens || 0;
      const out = u.completion_tokens || 0;
      if (total > 0) log(`[cache] 命中 ${hit}/${total} (${(hit / total * 100).toFixed(0)}%) 输出${out}`);
      return { msg: d.choices?.[0]?.message || {}, usage: { hit, total, out } };
    } finally { clearTimeout(t); }
  }

  function safeParse(s) {
    try { return JSON.parse(s); } catch (e) {
      const m = String(s || '').match(/\{[\s\S]*\}/);
      if (m) { try { return JSON.parse(m[0]); } catch (e2) {} }
      return { suggest: false };
    }
  }

  // 有界 ReAct 循环:messages 已含 system + 首条 user。返回最终 JSON 判读。
  async function react(messages) {
    let steps = 0;
    const usage = { hit: 0, total: 0, out: 0, calls: 0 };
    while (steps < MAX_STEPS) {
      const lastStep = steps === MAX_STEPS - 1; // 末轮不再给工具,强制出 JSON
      const { msg, usage: u } = await call(messages, !lastStep);
      usage.hit += u.hit; usage.total += u.total; usage.out += u.out; usage.calls++;
      steps++;

      const calls = msg.tool_calls || [];
      if (calls.length && !lastStep) {
        // 模型要调工具:执行,把结果喂回,继续循环
        messages.push({ role: 'assistant', content: msg.content || '', tool_calls: calls });
        for (const c of calls) {
          const name = c.function?.name;
          let args = {}; try { args = JSON.parse(c.function?.arguments || '{}'); } catch (e) {}
          let result = '(工具不存在)';
          if (tools[name]) {
            try { result = await tools[name].run(args); } catch (e) { result = '工具执行出错: ' + e.message; }
          }
          log(`[tool] ${name}(${JSON.stringify(args).slice(0, 80)}) → ${String(result).length}字`);
          messages.push({ role: 'tool', tool_call_id: c.id, content: String(result).slice(0, 4000) });
        }
        continue; // 带着工具结果再判
      }
      // 没调工具:这是最终判读
      const j = safeParse(msg.content);
      j._steps = steps; j._usage = usage;
      return j;
    }
    return { suggest: false, _steps: steps, _usage: usage };
  }

  // 入口一:后台 tick 自动判读屏幕文本
  async function runOnScreen(screenText) {
    return react([
      { role: 'system', content: JUDGE_PROMPT },
      { role: 'user', content: '当前屏幕内容:\n' + screenText },
    ]);
  }

  // 入口二:前台对话(以后接 AGUI)。history 为既往对话 messages。
  async function runOnChat(userMsg, history) {
    const messages = [{ role: 'system', content: JUDGE_PROMPT }];
    if (Array.isArray(history)) messages.push(...history);
    messages.push({ role: 'user', content: userMsg });
    return react(messages);
  }

  return { runOnScreen, runOnChat, PROMPT: JUDGE_PROMPT };
};
