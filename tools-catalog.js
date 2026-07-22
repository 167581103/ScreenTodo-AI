// tools-catalog.js — 对话 Agent 可访问工具的「可配置目录」
// 单一事实来源:前端「工具」面板从这里读,未来 MCP / 本地脚本 / 官方连接器也统一归到这四类。
//
// 分类(key → 展示):
//   builtin   内置工具 —— 对话 Agent 开箱即用的核心,直接对接本机上下文感知
//   local     本地工具 —— 本机工作记忆 / 待办读写(由 built-in 拆分出来的领域能力)
//   mcp       MCP 工具 —— 通过 Model Context Protocol 接入的外部服务器(预留)
//   connectors 官方连接器 —— 腾讯系官方连接器(企业微信 / TAPD / 腾讯文档等)暴露的能力(预留)
//
// 每类「是否启用」由 config.tools.sources[KEY].enabled 控制;未配置时取 DEFAULT_ENABLED。

'use strict';

const CATEGORIES = {
  builtin: {
    label: '内置工具',
    desc: '对话 Agent 开箱即用的核心能力，直接对接本机上下文感知与 Screenpipe。',
    tools: [
      { name: 'get_more_context', label: '获取上下文', desc: '获取当前屏幕 / 指定窗口的最近内容，理解"刚才发生了什么"。', status: 'active' },
    ],
  },
  local: {
    label: '本地工具',
    desc: '本机工作记忆存取。待办 (todo) 的增/删/查由本地 vault 脚本提供。',
    tools: [
      { name: 'list_todos', label: '列出待办', desc: '列出 / 统计已捕获的待办，回答"今天有多少待办"。', status: 'active' },
      { name: 'search_captured', label: '搜索记忆', desc: '按关键词在已捕获的工作记忆中搜索，如"有没有关于 XX 的记录"。', status: 'active' },
      { name: 'save_todo', label: '记录待办', desc: '把一件事记成待办，写入本地 vault。', status: 'active' },
    ],
  },
  mcp: {
    label: 'MCP 工具',
    desc: '通过 Model Context Protocol 接入的外部服务器工具(预留位)。',
    tools: [],
  },
  connectors: {
    label: '官方连接器',
    desc: '腾讯系官方连接器(企业微信 / TAPD / 腾讯文档等)暴露的能力(预留位)。',
    tools: [],
  },
};

// 未显式配置时的默认启用状态:内置 + 本地默认开;MCP / 连接器默认关(还没接入)。
const DEFAULT_ENABLED = { builtin: true, local: true, mcp: false, connectors: false };

// 读取 config.tools.sources,回填每个分类的 enabled 与各工具的可见性。
// 返回结构(供前端「工具」面板直接渲染):
//   [{ key, label, desc, enabled, tools:[{name, desc, status}] }]
function getCatalog(config) {
  const src = (config && config.tools && config.tools.sources) || {};
  return Object.keys(CATEGORIES).map((key) => {
    const cat = CATEGORIES[key];
    const conf = src[key] || {};
    const enabled = conf.enabled !== undefined ? !!conf.enabled : (DEFAULT_ENABLED[key] !== false);
    return {
      key,
      label: cat.label,
      desc: cat.desc,
      enabled,
      tools: (cat.tools || []).map((t) => Object.assign({}, t)),
    };
  });
}

// 校验 / 规整来源开关:只保留已知分类,过滤未知 key,缺省补默认值。
function normalizeSources(input) {
  const out = {};
  const src = input && typeof input === 'object' ? input : {};
  for (const key of Object.keys(CATEGORIES)) {
    const v = src[key];
    out[key] = { enabled: v && v.enabled !== undefined ? !!v.enabled : (DEFAULT_ENABLED[key] !== false) };
  }
  return out;
}

module.exports = { CATEGORIES, DEFAULT_ENABLED, getCatalog, normalizeSources };
