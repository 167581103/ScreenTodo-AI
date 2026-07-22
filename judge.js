// judge.js — 语义层(核心算法)
// 职责单一:干净屏幕文本 → todo 候选。这是整个 pipeline 里唯一花 token 的一层。
// 独立成模块后,PROMPT / 判读策略 / 换模型 都在这里改,不影响录制/预处理/去重/写入。
//
// 用法: const { judge, PROMPT } = require('./judge.js')(CONFIG, logFn);
//        const result = await judge(screenText);  // → { suggest, items:[{title,reason,context}] }

const PROMPT = `你是屏幕监控 Agent。每次发来一段当前屏幕的 OCR 文本，你判读并返回待办。

【捕获规则】
只捕与 chancguo(用户)有关的客观事实——别人对其要求、指派、等待其产出、或其自己写的 Todo。
- 私聊中对方对 chancguo 的要求(如"提单给我""帮我看下")→捕
- 群聊中 @chancguo 或明确指派→捕
- 群聊"你们/大家/各位/@所有人"向全体广播且未 @chancguo → **不捕**(群体任务≠个人待办)
- 纯他人互聊、闲聊、寒暄→不捕
- 自己写的 Todo 列表→捕(如"Todo: xxx 动作: xxx")
- AI 助手(元宝/豆包)给的建议→捕;纯生成/娱乐→不捕
- WorkBuddy 排障自语("验证健康/重启/dump脚本")→不捕

【反幻觉铁律 — 最重要,违反即错】
- @ 谁就是给谁。若消息里的 @ 列表是别人(如"@louismao @marisolxu @oneyli"),而**没有 @chancguo/@郭辰**,则这条**不是**指派给 chancguo → **必须 suggest=false**。
- **禁止编造锚点**:不许在 reason 里写"明确指派 chancguo/需 chancguo 参与"之类,除非原文真的 @了 chancguo 或点名"郭辰/你(单数明确指 chancguo)"。看不到 chancguo 的名字/@,就是与他无关。
- 话题属于 chancguo 领域(广告/互选/一口价等) ≠ 指派给 chancguo。别人 @别人讨论你熟悉的话题,也不捕。
- 判断顺序:先找"chancguo/郭辰"是否被 @ 或点名 → 没有就直接 false,不要再脑补关联。

【宁滥勿缺】不确定时倾向捕,漏比多严重。弱信号:"记得做/回头/待跟进/ddl/跟进/复盘/对齐/审评/排期/同步"、告警/异常/决定/结论。

输出 JSON(只此一份,无额外文字):
{"suggest":true,"items":[{"title":"简短动宾≤20字","reason":"为什么相关≤40字","context":"原文片段≤50字"}]}
无待办则 {"suggest":false}`;

// 工厂:注入 config(取 apiBase/apiKey/model) 与 log 函数(打印 cache 命中率)
module.exports = function createJudge(CONFIG, log) {
  log = log || (() => {});

  // 调 LLM 判读。messages 为完整 chat messages。返回解析后的 JSON 对象。
  async function judgeMessages(messages) {
    const body = {
      model: CONFIG.deepseek.model,
      messages,
      response_format: { type: 'json_object' },
      temperature: 0.2,
    };
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 30000);
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
      if (total > 0) log(`[cache] 命中 ${hit}/${total} (${(hit / total * 100).toFixed(0)}%)`);
      const content = d.choices?.[0]?.message?.content || '{}';
      return JSON.parse(content);
    } finally { clearTimeout(t); }
  }

  // 语义层主入口:传入干净屏幕文本,返回 todo 候选判读结果。
  async function judge(screenText) {
    return judgeMessages([
      { role: 'system', content: PROMPT },
      { role: 'user', content: screenText },
    ]);
  }

  return { judge, judgeMessages, PROMPT };
};
