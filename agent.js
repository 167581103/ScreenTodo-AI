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

const fs = require('fs');
const path = require('path');

// —— Prompt 外部化 + 热更新 ——
// prompt 存在 prompts/*.md(用户可直接编辑),按文件 mtime 判断是否变化,变了就重载 →
// 改 prompt 无需重启,下次判读即生效。{{USER}} 占位符运行时替换为 config.user.name
// (个人身份在 config,不入 git;prompt 模板通用,可入 git)。
const PROMPT_DIR = path.join(__dirname, 'prompts');
const _pc = {};
function loadPrompt(name, ctx) {
  const file = path.join(PROMPT_DIR, name + '.md');
  try {
    const mt = fs.statSync(file).mtimeMs;
    if (!_pc[name] || _pc[name].mt !== mt) _pc[name] = { mt, raw: fs.readFileSync(file, 'utf8') };
    let s = _pc[name].raw.replace(/\{\{USER\}\}/g, (ctx && ctx.user) || '用户');
    s = s.replace(/\{\{VAULT_ROOT\}\}/g, (ctx && ctx.vault) || '');
    // 当天日期(判"历史内容 vs 新派活"的时间锚点)。按天粒度,当天内稳定,不破坏 API 前缀缓存。
    const _d = new Date();
    const _week = ['周日','周一','周二','周三','周四','周五','周六'][_d.getDay()];
    const _today = _d.getFullYear() + '-' + String(_d.getMonth() + 1).padStart(2, '0') + '-' + String(_d.getDate()).padStart(2, '0') + ' ' + _week;
    s = s.replace(/\{\{TODAY\}\}/g, _today);
    return s;
  } catch (e) { return '(prompt 文件缺失: ' + file + ')'; }
}

module.exports = function createAgent(CONFIG, log, tools) {
  log = log || (() => {});
  tools = tools || {};
  const MAX_STEPS = (CONFIG.agent && CONFIG.agent.maxSteps) || 6; // ReAct最多轮数(含首判)
  const toolDefs = Object.values(tools).map((t) => t.def).filter(Boolean);

  // 单次 LLM 调用。allowTools 决定是否带 tools。jsonOut=true 时末轮强制 JSON(判读用);
  // 对话模式 jsonOut=false → 自然语言回复。
  // onToken(可选):传了就走流式(SSE),每个 content 增量回调一次,同时累积 tool_calls 与 usage。
  async function call(messages, allowTools, jsonOut, onToken, tier = 'large') {
    // Hot-reload: re-read config.json model routing each call, no restart needed
    // tier='large'→heavy model (judge/tools); tier='small'→light model (scene classification/auto-rename etc.)
    let apiBase, apiKey, model;
    try {
      const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
      const ms = cfg.modelService;
      let provName;
      if (ms && typeof ms === 'object') {
        provName = ms[tier] || ms.large || 'deepseek';
      } else {
        provName = ms || 'deepseek';
      }
      const pr = cfg[provName] || cfg.deepseek || {};
      apiBase = pr.apiBase || cfg.deepseek.apiBase;
      apiKey  = pr.apiKey  || cfg.deepseek.apiKey;
      // 按 tier 选模型:large→modelLarge, small→modelSmall, 兜底 model
      if (tier === 'small' && pr.modelSmall) model = pr.modelSmall;
      else if (tier === 'large' && pr.modelLarge) model = pr.modelLarge;
      else model = pr.model || cfg.deepseek.model;
    } catch (_) {
      // fallback:读失败时用内存 CONFIG(不断 API 调用)
      apiBase = CONFIG.deepseek.apiBase;
      apiKey  = CONFIG.deepseek.apiKey;
      model   = CONFIG.deepseek.model;
    }
    const body = {
      model,
      messages,
      temperature: 0.2,
      stream: !!onToken,
    };
    if (allowTools && toolDefs.length) {
      body.tools = toolDefs;
      body.tool_choice = 'auto';
    } else if (jsonOut) {
      // 判读模式:不强制 response_format(让模型先写思考再出 JSON)。
      // 改为在 safeParse 里从"思考+JSON"混合文本中提取 JSON。
    }
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 40000);
    try {
      const r = await fetch(apiBase.replace(/\/$/, '') + '/chat/completions', {
        method: 'POST', signal: ac.signal,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(body),
      });
      if (!onToken) {
        const d = await r.json();
        if (d.error) log(`[api error] ${d.error.code}: ${d.error.message}`);
        if (!d.choices) log('[api unexpected response] ' + JSON.stringify(d).slice(0,200));
        const u = d.usage || {};
        const hit = u.prompt_cache_hit_tokens || u.prompt_tokens_details?.cached_tokens || 0;
        const total = u.prompt_tokens || 0;
        const out = u.completion_tokens || 0;
        if (total > 0) log(`[cache] 命中 ${hit}/${total} (${(hit / total * 100).toFixed(0)}%) 输出${out}`);
        return { msg: d.choices?.[0]?.message || {}, usage: { hit, total, out } };
      }
      // —— 流式 SSE 解析 ——
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      let content = '';
      const calls = [];
      const ensure = (i) => { while (calls.length <= i) calls.push({}); return calls[i]; };
      let usage = {};
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop();
        for (const raw of lines) {
          const s = raw.trim();
          if (!s.startsWith('data:')) continue;
          const jstr = s.slice(5).trim();
          if (jstr === '[DONE]') continue;
          let j; try { j = JSON.parse(jstr); } catch (e) { continue; }
          const d = j.choices?.[0]?.delta || {};
          if (d.content) { content += d.content; onToken(d.content); }
          if (d.tool_calls) {
            for (const tc of d.tool_calls) {
              // index 必须显式判断:DeepSeek 后续 delta 会省略 index,用 `|| 0`
              // 会把所有工具调用误并到 calls[0],导致 name/arguments 拼接成垃圾。
              const idx = typeof tc.index === 'number' ? tc.index : calls.length ? calls.length - 1 : 0;
              const c = ensure(idx);
              if (tc.id) c.id = tc.id;
              if (tc.function?.name) c.name = (c.name || '') + tc.function.name;
              if (tc.function?.arguments) c.args = (c.args || '') + tc.function.arguments;
            }
          }
          if (j.usage) usage = j.usage;
        }
      }
      const u = usage || {};
      const hit = u.prompt_cache_hit_tokens || u.prompt_tokens_details?.cached_tokens || 0;
      const total = u.prompt_tokens || 0;
      const out = u.completion_tokens || 0;
      if (total > 0) log(`[cache] 命中 ${hit}/${total} (${(hit / total * 100).toFixed(0)}%) 输出${out}`);
      if (calls.length) log('[stream tool_calls] ' + JSON.stringify(calls));
      const msg = {
        content,
        tool_calls: calls.length ? calls.map(c => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.args || '{}' } })) : undefined,
      };
      return { msg, usage: { hit, total, out } };
    } finally { clearTimeout(t); }
  }

  function safeParse(s) {
    try { return JSON.parse(s); } catch (e) {
      const m = String(s || '').match(/\{[\s\S]*\}/);
      if (m) { try { return JSON.parse(m[0]); } catch (e2) {} }
      return { suggest: false };
    }
  }

  // SSE 流式包装:仅 chat 路径使用,逐 token 发射 TEXT_MESSAGE 事件。
  async function callStream(messages, allowTools, jsonOut, messageId, emit) {
    let started = false;
    const onTok = (delta) => {
      if (!delta) return;
      if (!started) { started = true; emit('TEXT_MESSAGE_START', { messageId }); }
      emit('TEXT_MESSAGE_CONTENT', { messageId, delta });
    };
    const res = await call(messages, allowTools, jsonOut, onTok);
    if (started) emit('TEXT_MESSAGE_END', { messageId });
    return res;
  }

  // 有界 ReAct 循环:messages 已含 system + 首条 user。
  // jsonOut=true(判读)→ 返回解析后的 todo JSON;jsonOut=false(对话)→ 返回 {reply, ...}。
  // emit(可选):agui 事件回调,用于流式交互(仅对话且传入时启用)。
  // 把内部 messages 精简成"可回放的对话":去 system prompt(太大且无信息),
  // 保留 user(屏幕/用户问)/assistant(含思考文本+tool_calls)/tool(结果)。
  function buildDialog(msgs) {
    return msgs.filter(m => m.role !== 'system').map(m => {
      if (m.role === 'assistant') {
        const o = { role: 'assistant', content: m.content || '' };
        if (m.tool_calls && m.tool_calls.length) o.tool_calls = m.tool_calls.map(c => ({ name: c.function?.name, args: (()=>{try{return JSON.parse(c.function?.arguments||'{}')}catch(e){return{}}})() }));
        return o;
      }
      if (m.role === 'tool') return { role: 'tool', content: String(m.content).slice(0, 600) };
      return { role: m.role, content: String(m.content).slice(0, 1500) }; // user:屏幕文本可能大,截断
    });
  }

  async function react(messages, jsonOut, emit) {
    let steps = 0;
    const usage = { hit: 0, total: 0, out: 0, calls: 0 };
    const trace = []; // 工具调用轨迹(出生证用)
    if (emit) emit('RUN_STARTED', { runId: 'run_' + Date.now(), threadId: 'chat' });
    while (steps < MAX_STEPS) {
      const lastStep = steps === MAX_STEPS - 1; // 末轮不再给工具,逼出结论
      let msg, u;
      // 延迟发 START:只在真收到第一个文本 token 才开气泡,避免"纯工具调用轮"冒空气泡
      const messageId = 'm_' + Date.now() + '_' + steps;
      let started = false;
      const res = emit
        ? await callStream(messages, !lastStep, jsonOut, messageId, emit)
        : await call(messages, !lastStep, jsonOut);
      msg = res.msg; u = res.usage;
      usage.hit += u.hit; usage.total += u.total; usage.out += u.out; usage.calls++;
      steps++;

      const calls = msg.tool_calls || [];
      if (calls.length && !lastStep) {
        // 模型要调工具:执行,把结果喂回,继续循环
        messages.push({ role: 'assistant', content: msg.content || '', tool_calls: calls });
        for (const c of calls) {
          const name = c.function?.name;
          let args = {}; try { args = JSON.parse(c.function?.arguments || '{}'); } catch (e) {}
          if (emit) emit('TOOL_CALL_START', { toolCallId: c.id, toolName: name || '?', args });
          let result;
          if (tools[name]) {
            try { result = await tools[name].run(args); } catch (e) { result = '工具执行出错: ' + e.message; }
          } else {
            const avail = Object.keys(tools);
            result = `调用失败:工具 "${name}" 不存在。当前可用工具:${avail.length ? avail.join('、') : '(无)'}。请勿再调用不存在的工具;若无合适工具,请直接根据已知信息如实回答用户,不要编造。`;
          }
          log(`[tool] ${name}(${JSON.stringify(args).slice(0, 80)}) → ${String(result).length}字`);
          if (emit) emit('TOOL_CALL_END', { toolCallId: c.id, toolName: name || '?', args, result: String(result).slice(0, 4000) });
          trace.push({ name: name || '?', args, result: String(result).slice(0, 600) }); // 出生证用:工具轨迹
          messages.push({ role: 'tool', tool_call_id: c.id, content: String(result).slice(0, 4000) });
        }
        continue;
      }
      // 没调工具:最终结论
      if (jsonOut) {
        // 判读模式:模型输出"思考+JSON"混合。分离思考文本(存入对话回放)和 JSON 结论。
        const raw = msg.content || '';
        const jsonMatch = raw.match(/\{[\s\S]*\}/);
        const thinking = jsonMatch ? raw.slice(0, jsonMatch.index).replace(/<\/?思考>/g,'').trim() : raw.trim();
        // 模型有时会在自然语言思考中带示例对象或不完整 JSON；统一走容错解析，
        // 避免单个区域的格式问题中断整轮并行判读。
        const j = safeParse(jsonMatch ? jsonMatch[0] : raw);
        // 把思考文本塞回 messages 里 assistant 的 content(供 buildDialog 回放)
        if (thinking) messages[messages.length-1] = { ...messages[messages.length-1], content: thinking };
        j._steps = steps; j._usage = usage; j._trace = trace; j._dialog = buildDialog(messages);
        j._thinking = thinking; // 思考文本(出生证用)
        return j;
      }
      const reply = (msg.content || '').trim();
      if (reply) return { reply, _steps: steps, _usage: usage, _trace: trace, _dialog: buildDialog(messages) };
      // 对话模式拿到空回复(常见于:上一轮吐了过渡语+调工具,拿到结果后模型以为已说完)。
      // 追一条明确指令,逼它基于已有信息给用户一个完整答复,而不是留空。
      if (!lastStep) {
        messages.push({ role: 'user', content: '请基于上面的信息,直接给我一个完整的回答(不要再调用工具)。' });
        continue;
      }
      return { reply: '我查了下,没有找到相关内容。要不换个说法或告诉我更具体的信息?', _steps: steps, _usage: usage, _dialog: buildDialog(messages) };
    }
    return jsonOut ? { suggest: false, _steps: steps, _usage: usage, _dialog: buildDialog(messages) } : { reply: '我这边没能得出结论,要不再说一次?', _steps: steps, _usage: usage, _dialog: buildDialog(messages) };
  }

  const userName = (CONFIG.user && CONFIG.user.name) || 'chancguo(郭辰)';
  const vaultRoot = CONFIG.vaultRoot || '';

  // 前置闸门:轻量场景判。只判"这屏是什么场景、是否可能向 user 派活",不找具体待办。
  // 输入可只喂精简特征(头部片段),单次无工具调用,system prompt 固定高缓存 → 很便宜。
  // 返回 { scene, deliver, why }。deliver=false 的帧直接丢,不进重判读(省大头 token)。
  async function classifyScene(sceneText) {
    try {
      const { msg } = await call([
        { role: 'system', content: loadPrompt('scene', { user: userName }) },
        { role: 'user', content: '这一屏的内容:\n' + sceneText },
      ], false, true, null, 'small'); // 小模型做场景分类(极低成本,支持 JSON 输出)
      const j = safeParse(msg.content);
      return { scene: j.scene || '未知', deliver: j.deliver !== false, why: j.why || '' };
    } catch (e) {
      // 场景判失败 → 不阻断,默认放行进重判读(宁可多花,不漏)
      return { scene: '未知', deliver: true, why: '场景判失败,放行: ' + e.message };
    }
  }

  // 入口一:后台 tick 自动判读屏幕文本 → 返回 todo JSON。每次实时载入 prompts/judge.md(热更新)
  async function runOnScreen(screenText) {
    return react([
      { role: 'system', content: loadPrompt('judge', { user: userName }) },
      { role: 'user', content: '当前屏幕内容:\n' + screenText },
    ], true);
  }

  // 入口二:前台对话 → 返回自然语言回复。每次实时载入 prompts/chat.md(热更新)
  // emit(可选):传入则启用 agui 流式事件(主进程转发给渲染层)
  async function runOnChat(userMsg, history, emit) {
    const messages = [{ role: 'system', content: loadPrompt('chat', { user: userName }) }];
    if (Array.isArray(history)) messages.push(...history);
    // 用户上下文:文件系统根目录。作为 user 消息注入,而非系统 prompt,因为这是用户自有数据。
    if (vaultRoot) messages.push({ role: 'user', content: `我的文件都在 ${vaultRoot} 目录下。读写文件时路径以此为基准,不要拼绝对路径搞错大小写。` });
    messages.push({ role: 'user', content: userMsg });
    return react(messages, false, emit);
  }

  // Light task entry: single small-model call, no tools, returns plain text. For session auto-rename, intent classification etc.
  async function runLight(systemPrompt, userMsg) {
    const { msg } = await call([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMsg },
    ], false, false, null, 'small');
    return (msg.content || '').trim();
  }

  return { runOnScreen, runOnChat, classifyScene, runLight, get PROMPT() { return loadPrompt('judge', { user: userName }); } };
};
