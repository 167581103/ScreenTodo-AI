import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import DOMPurify from 'dompurify';
import type { SessionMeta, Message, AguiEvent } from './types';
import { md } from './md';
import { formatUserMessageHtml as formatUserMessageHtmlRaw } from '../user-message-display.js';

// 用户消息来自 contenteditable，需要保留 mention 样式，但不能把粘贴进来的任意 HTML
// 持久化到 sessions.json 后再次执行。
function sanitizeUserMessageHtml(html: string): string {
  return DOMPurify.sanitize(String(html || ''), {
    ALLOWED_TAGS: ['span', 'br'],
    ALLOWED_ATTR: ['class', 'data-type', 'data-name', 'contenteditable'],
  });
}

/** 用户气泡展示：优先用持久化的蓝字 HTML；旧会话从「引用提示」回退还原 mention。 */
function formatUserMessageHtml(content: string, html?: string): string {
  return sanitizeUserMessageHtml(formatUserMessageHtmlRaw(content, html));
}

// ── 主应用 ──
export default function App() {
  const [view, setView] = useState<'chat'|'feed'|'settings'>('chat');
  const [filter, setFilter] = useState('all');
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [activeSid, setActiveSid] = useState<string | null>(null);

  // 启动:加载会话
  useEffect(() => {
    const W = window.orb;
    if (!W) return;
    W.listSessions().then(data => {
      setSessions(data.list);
      setActiveSid(data.active);
    }).catch(() => {});
  }, []);

  return (<>
    <div className="drag-strip" />
    <div className="app">
      {/* ── 侧栏 ── */}
      <aside className="sidebar">
        <div className="brand">
          <svg className="mark" viewBox="0 0 52 52"><path className="arc" d="M13 27C20 37 24 39 27 39 32 39 36 25 41 13"/></svg>
          <div className="name">ScreenTodo</div>
        </div>

        {/* 会话标签 + 列表 */}
        <SessionSection
          sessions={sessions} activeSid={activeSid}
          onUpdate={setSessions} onSwitch={setActiveSid}
          view={view} onSetView={setView}
        />
        <div className="top-divider" />

        {/* 筛选 */}
        <div className="nav-h">筛选</div>
        <FilterTabs filter={filter} onFilter={f => { setFilter(f); setView('feed'); }} view={view} />
        <div className="top-divider" />

        {/* 设置 tab */}
        <div className={`tab view-tab${view==='settings'?' active':''}`} onClick={()=>setView('settings')}>
          <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" strokeLinecap="round" strokeLinejoin="round"/></svg>
          <span className="lbl">设置</span>
        </div>
      </aside>

      {/* ── 主区 ── */}
      <section className="main">
        <div className={`view${view==='feed'?'':' hidden'}`} id="view-feed">
          <FeedView filter={filter} />
        </div>
        <div className={`view${view==='chat'?'':' hidden'}`} id="view-chat">
          <ChatView
            sessions={sessions} activeSid={activeSid}
            onSessionsUpdate={setSessions} onActiveSid={setActiveSid}
          />
        </div>
        <div className={`view${view==='settings'?'':' hidden'}`} id="view-settings">
          <SettingsView />
        </div>
      </section>
    </div>
  </>);
}

// ── 会话区域(标签 + 列表 + 新建) ──
function SessionSection({ sessions, activeSid, onUpdate, onSwitch, view, onSetView }: {
  sessions: SessionMeta[]; activeSid: string|null;
  onUpdate: React.Dispatch<React.SetStateAction<SessionMeta[]>>; onSwitch: (id: string) => void;
  view: string; onSetView: (v: 'chat'|'feed'|'settings') => void;
}) {
  const create = useCallback(async () => {
    const W = window.orb; if (!W) return;
    const data = await W.createSession();
    onUpdate(data.list); onSwitch(data.active); onSetView('chat');
  }, [onUpdate, onSwitch, onSetView]);

  const switchTo = useCallback(async (id: string) => {
    const W = window.orb;
    // 主进程 active 必须与 UI 同步，否则 chat:stream 会写到错误会话
    if (W) {
      try { await W.switchSession(id); } catch (_) {}
    }
    onSwitch(id);
    onSetView('chat');
  }, [onSwitch, onSetView]);

  const del = useCallback(async (id: string) => {
    const W = window.orb; if (!W) return;
    const data = await W.deleteSession(id);
    onUpdate(data.list);
    if (data.active) onSwitch(data.active);
  }, [onUpdate, onSwitch]);

  const rename = useCallback(async (id: string, name: string) => {
    const W = window.orb; if (!W) return;
    await W.renameSession(id, name);
    onUpdate(prev => prev.map(s => s.id === id ? { ...s, name } : s));
  }, [onUpdate]);

  const reorder = useCallback(async (ids: string[]) => {
    const W = window.orb; if (!W) return;
    await W.reorderSessions(ids);
    onUpdate(prev => {
      const byId = new Map(prev.map(s => [s.id, s]));
      return ids.map(id => byId.get(id)).filter((s): s is SessionMeta => !!s);
    });
  }, [onUpdate]);

  // 切到非对话视图时清除会话高亮
  const isChat = view === 'chat';

  // 全局互斥:一次只有一个会话的菜单打开
  const [activeMenuId, setActiveMenuId] = useState<string|null>(null);

  return (
    <div className="chat-sec">
      <div className="chat-sec-label">对话</div>
      <div className="session-list">
        {sessions.map(s => (
          <SessionItem
            key={s.id} session={s}
            active={isChat && s.id === activeSid}
            menuOpen={activeMenuId === s.id}
            onMenuToggle={() => setActiveMenuId(activeMenuId === s.id ? null : s.id)}
            onMenuClose={() => setActiveMenuId(null)}
            onClick={() => { switchTo(s.id); }}
            onRename={name => rename(s.id, name)}
            onDelete={() => del(s.id)}
            onReorder={reorder} sessions={sessions}
          />
        ))}
      </div>
      <button className="session-new" onClick={create}>+ 新建会话</button>
    </div>
  );
}

// ── 会话项 ──
function SessionItem({ session, active, menuOpen, onMenuToggle, onMenuClose, onClick, onRename, onDelete, onReorder, sessions }: {
  session: SessionMeta; active: boolean;
  menuOpen: boolean; onMenuToggle: () => void; onMenuClose: () => void;
  onClick: () => void; onRename: (n: string) => void; onDelete: () => void;
  onReorder: (ids: string[]) => void; sessions: SessionMeta[];
}) {
  const [renaming, setRenaming] = useState(false);
  const [renameVal, setRenameVal] = useState(session.name);
  const [menuPos, setMenuPos] = useState<{top:number,right:number}>({top:0,right:0});
  const dragRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);

  // 外部点击关闭菜单 (与 add-pop 一致的模式)
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (menuRef.current?.contains(t) || btnRef.current?.contains(t)) return;
      onMenuClose();
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [menuOpen, onMenuClose]);

  const handleMenuToggle = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!menuOpen && btnRef.current) {
      const r = btnRef.current.getBoundingClientRect();
      setMenuPos({ top: r.bottom + 4, right: Math.max(8, window.innerWidth - r.right) });
    }
    onMenuToggle();
  };

  const handlePointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0 || menuOpen || renaming) return;
    const startY = e.clientY;
    const el = dragRef.current; if (!el) return;
    let active = false;
    let marker: { el: HTMLElement; before: boolean } | null = null;
    let moved = false;

    const timer = setTimeout(() => { active = true; el.classList.add('dragging'); }, 250);

    const move = (ev: PointerEvent) => {
      if (!active) { if (Math.abs(ev.clientY - startY) > 6) clearTimeout(timer); return; }
      moved = true;
      document.querySelectorAll('.drop-above, .drop-below').forEach(el => el.classList.remove('drop-above', 'drop-below'));
      const items = [...document.querySelectorAll('.session-item')] as HTMLElement[];
      let target: HTMLElement | null = null;
      for (const it of items) { if (it === el) continue; const r = it.getBoundingClientRect(); if (ev.clientY >= r.top && ev.clientY <= r.bottom) { target = it; break; } }
      if (!target) {
        const first = items[0], last = items[items.length - 1];
        if (first && ev.clientY < first.getBoundingClientRect().top) { first.classList.add('drop-above'); marker = { el: first, before: true }; }
        else if (last && ev.clientY > last.getBoundingClientRect().bottom) { last.classList.add('drop-below'); marker = { el: last, before: false }; }
        return;
      }
      const r = target.getBoundingClientRect();
      const before = ev.clientY < r.top + r.height / 2;
      target.classList.add(before ? 'drop-above' : 'drop-below');
      marker = { el: target, before };
    };

    const up = () => {
      clearTimeout(timer); window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
      el.classList.remove('dragging');
      document.querySelectorAll('.drop-above, .drop-below').forEach(el => el.classList.remove('drop-above', 'drop-below'));
      if (moved && marker) {
        const targetSid = marker.el.dataset.sid;
        if (targetSid && targetSid !== session.id) {
          const arr = sessions.map(s => s.id); const di = arr.indexOf(session.id); let ti = arr.indexOf(targetSid);
          arr.splice(di, 1); if (di < ti) ti--;
          arr.splice(marker.before ? ti : ti + 1, 0, session.id);
          onReorder(arr);
        }
      }
    };

    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  };

  return (<>
    <div ref={dragRef} className={`session-item${active?' active':''}`} data-sid={session.id}
      onPointerDown={handlePointerDown}
      onClick={() => { if (!menuOpen && !renaming) onClick(); }}>
      {renaming ? (
        <input className="ses-rename" value={renameVal} onChange={e => setRenameVal(e.target.value)}
          onBlur={() => { setRenaming(false); if (renameVal.trim()) onRename(renameVal.trim()); else setRenameVal(session.name); }}
          onKeyDown={e => { if (e.key==='Enter') (e.target as HTMLInputElement).blur(); if (e.key==='Escape') { setRenameVal(session.name); setRenaming(false); }}}
          autoFocus />
      ) : (
        <span className="ses-name">{session.name}</span>
      )}
      <button ref={btnRef} className="ses-menu-btn" onClick={handleMenuToggle}>···</button>
    </div>
    {menuOpen && (
      <div ref={menuRef} className="ses-menu" style={{ position:'fixed', zIndex:50, top:menuPos.top, right:menuPos.right }}>
        <button onClick={() => { onMenuClose(); setRenaming(true); }}>重命名</button>
        <button className="danger" onClick={() => { onMenuClose(); onDelete(); }}>删除</button>
      </div>
    )}
  </>);
}

// ── 筛选标签 ──
function FilterTabs({ filter, onFilter, view }: { filter: string; onFilter: (f: string) => void; view: string }) {
  const tabs = [
    { f: 'all', lbl: '全部', id: 'c-all' },
    { f: 'pending', lbl: '待处理', id: 'c-pending' },
    { f: 'accepted', lbl: '已采纳', id: 'c-accepted' },
    { f: 'ignored', lbl: '已忽略', id: 'c-ignored' },
    { f: 'rejected', lbl: '已拒', id: 'c-rejected' },
  ];
  const [counts, setCounts] = useState({ all:0, pending:0, accepted:0, ignored:0, rejected:0 });

  // 监听 recall-update 更新计数(已拒来自独立数据源)
  useEffect(() => {
    const W = window.orb;
    const update = () => {
      const data = (window as any).__RECALL__ || [];
      const cnt: any = { all: data.length, pending: 0, accepted: 0, ignored: 0, rejected: 0 };
      data.forEach((d: any) => { if (d.status==='accepted') cnt.accepted++; else if (d.status==='ignored') cnt.ignored++; else cnt.pending++; });
      if (W?.getRejected) {
        W.getRejected().then((rej: any[]) => { cnt.rejected = rej.length; setCounts({ ...cnt }); }).catch(() => setCounts({ ...cnt }));
      } else {
        setCounts({ ...cnt });
      }
    };
    window.addEventListener('recall-update', update);
    W?.getRecall().then(() => update()).catch(() => {});
    return () => window.removeEventListener('recall-update', update);
  }, []);

  return (<>
    {tabs.map(t => (
      <div key={t.f} className={`tab${filter===t.f&&view==='feed'?' active':''}`} data-f={t.f} onClick={()=>onFilter(t.f)}>
        <span className="lbl">{t.lbl}</span><span className="cnt">{counts[t.f as keyof typeof counts]}</span>
      </div>
    ))}
  </>);
}

// ── 对话视图(完整) ──
function ChatView({ sessions, activeSid, onSessionsUpdate, onActiveSid }: {
  sessions: SessionMeta[]; activeSid: string|null;
  onSessionsUpdate: (s: SessionMeta[]) => void; onActiveSid: (id: string) => void;
}) {
  return <ChatViewImpl key={activeSid} sid={activeSid} />;
}
// ── ＠引用 + 「+」弹层图标常量──
const ADD_ICON: Record<string,string> = {
  paperclip: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48"/></svg>',
  wrench: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a1 1 0 000 1.4l1.6 1.6a1 1 0 001.4 0l3.77-3.77a6 6 0 01-7.94 7.94l-6.91 6.91a2.12 2.12 0 01-3-3l6.91-6.91a6 6 0 017.94-7.94l-3.76 3.76z"/></svg>',
  chat: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></svg>',
  link: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 7h3a5 5 0 010 10h-3m-6 0H6a5 5 0 010-10h3M8 12h8"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>',
  chevronR: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 6 15 12 9 18"/></svg>',
  terminal: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>',
  folder: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg>',
  server: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="2" width="20" height="8" rx="2" ry="2"/><rect x="2" y="14" width="20" height="8" rx="2" ry="2"/><line x1="6" y1="6" x2="6.01" y2="6"/><line x1="6" y1="18" x2="6.01" y2="18"/></svg>',
};
const _cross = (a:{x:number;y:number}, b:{x:number;y:number}, c:{x:number;y:number}) => (b.x-a.x)*(c.y-a.y)-(b.y-a.y)*(c.x-a.x);
const inTriangle = (P:{x:number;y:number}, B:{x:number;y:number}, C:{x:number;y:number}, M:{x:number;y:number}) => { const d1=_cross(M,P,B),d2=_cross(M,B,C),d3=_cross(M,C,P); return (d1>=0&&d2>=0&&d3>=0)||(d1<=0&&d2<=0&&d3<=0); };
const RECENT_KEY = 'orb-recent-mentions';
const chatDrafts = new Map<string,string>();

type Mention = { type: string; name: string; label: string };
type SubItem = { cat?: string; name: string; label: string; desc?: string; rawName?: string };
type SubState = { loading: boolean; sections: { label: string; items: SubItem[] }[]; importLocal?: boolean };

function ChatViewImpl({ sid }: { sid: string|null }) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [busy, setBusy] = useState(false);
  const [canSend, setCanSend] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [subTab, setSubTab] = useState<string|null>(null);
  const [subShow, setSubShow] = useState(false);
  const [sub, setSub] = useState<SubState|null>(null);
  const [recents, setRecents] = useState<Mention[]>(() => { try{ return JSON.parse(localStorage.getItem(RECENT_KEY)||'[]')||[]; }catch{ return []; } });
  const bodyRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLDivElement>(null);
  const addBtnRef = useRef<HTMLButtonElement>(null);
  const addPopRef = useRef<HTMLDivElement>(null);
  const addMainRef = useRef<HTMLDivElement>(null);
  const addSubRef = useRef<HTMLDivElement>(null);
  const fileInRef = useRef<HTMLInputElement>(null);
  const closeTimerRef = useRef(0);
  const lastMouseRef = useRef<{x:number;y:number}|null>(null);
  const focusedRowRef = useRef<HTMLElement|null>(null);
  const pendingRangeRef = useRef<Range|null>(null);

  // 草稿恢复 + 加载消息
  useEffect(() => {
    const ta = taRef.current;
    if (ta) { ta.innerHTML = sanitizeUserMessageHtml(sid ? chatDrafts.get(sid) || '' : ''); autoGrow(ta); }
    setCanSend(!!(ta && ta.textContent && ta.textContent.replace(/\u200B/g,'').trim()));
    if (!sid) return;
    const W = window.orb; if (!W) return;
    W.getSession(sid).then(ses => { if (ses) setMessages(ses.messages); }).catch(() => {});
    if (ta) ta.innerHTML = sanitizeUserMessageHtml(sid ? chatDrafts.get(sid) || '' : '');
  }, [sid]);

  // 滚动到底部
  useEffect(() => { if (bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight; }, [messages]);

  // ── contenteditable helpers ──
  const autoGrow = (ta: HTMLDivElement) => {
    const minHeight = 36;
    const maxHeight = 104;
    // 先回到最小高度再测量，避免 flex 容器用上一帧高度反向撑大 scrollHeight。
    ta.style.height = minHeight + 'px';
    const contentHeight = ta.scrollHeight;
    ta.style.height = Math.min(maxHeight, Math.max(minHeight, contentHeight)) + 'px';
    ta.style.overflowY = contentHeight > maxHeight ? 'auto' : 'hidden';
  };
  const getCaretRange = () => { const s=window.getSelection(); const ta=taRef.current; if(s&&s.rangeCount&&ta&&ta.contains(s.anchorNode)) return s.getRangeAt(0).cloneRange(); return null; };
  const caretBeforeChar = () => { const s=window.getSelection(); if(!s||!s.rangeCount) return null; const r=s.getRangeAt(0), n=r.startContainer; if(n&&n.nodeType===3&&r.startOffset>0) return (n.textContent||'')[r.startOffset-1]; return null; };
  const onInput = () => { const ta=taRef.current; if(!ta) return; if(ta.textContent==='') ta.innerHTML=''; autoGrow(ta); setCanSend(!!(ta.textContent||'').replace(/\u200B/g,'').trim()||ta.querySelector('.mention')!=null); if(caretBeforeChar()==='@'){ pendingRangeRef.current=getCaretRange(); openAdd(); } if(sid) chatDrafts.set(sid, sanitizeUserMessageHtml(ta.innerHTML)); };

  // ── 插入 mention（直接操作 contenteditable DOM）──
  const insertMention = (type: string, name: string, label: string) => {
    const ta = taRef.current; if(!ta) return;
    ta.focus();
    let rng = pendingRangeRef.current || null;
    if(!rng){ const s=window.getSelection(); if(s&&s.rangeCount) rng=s.getRangeAt(0); }
    if(!rng){ rng=document.createRange(); rng.selectNodeContents(ta); rng.collapse(false); }
    const sn=rng.startContainer, so=rng.startOffset;
    let work=rng;
    if(sn&&sn.nodeType===3&&so>0&&(sn.textContent||'')[so-1]==='@'){
      work=document.createRange(); work.setStart(sn,so-1); work.setEnd(sn,so); work.deleteContents();
    }
    work.collapse(true);
    const span=document.createElement('span');
    span.className='mention'; span.contentEditable='false';
    span.dataset.type=type; span.dataset.name=name;
    span.appendChild(document.createTextNode(label));
    const zw=document.createTextNode('\u200B');
    work.insertNode(zw); work.insertNode(span);
    const nr=document.createRange(); nr.setStartAfter(zw); nr.collapse(true);
    const sel=window.getSelection(); if(sel){ sel.removeAllRanges(); sel.addRange(nr); }
    pendingRangeRef.current=null; autoGrow(ta); onInput();
  };

  const addRecent = (type: string, name: string, label: string) => {
    setRecents(prev => { const cur=prev.filter(m=>!(m.type===type&&m.name===name)); cur.unshift({type,name,label}); const r=cur.slice(0,9); try{localStorage.setItem(RECENT_KEY,JSON.stringify(r));}catch{} return r; });
  };

  // ── add-pop 开关 ──
  const openAdd = useCallback(() => { setAddOpen(true); setSubShow(false); setSubTab(null); setSub(null); }, []);
  const closeAdd = useCallback(() => { setAddOpen(false); setSubShow(false); setSubTab(null); setSub(null); if(focusedRowRef.current){ focusedRowRef.current.classList.remove('focus'); focusedRowRef.current=null; } }, []);
  const toggleAdd = () => { if(addOpen) closeAdd(); else openAdd(); };

  // 全局点击关闭
  useEffect(() => { if(!addOpen) return; const onDown=(e:MouseEvent)=>{ const t=e.target as Node; if(addPopRef.current?.contains(t)||addBtnRef.current?.contains(t)) return; closeAdd(); }; document.addEventListener('mousedown',onDown); return ()=>document.removeEventListener('mousedown',onDown); }, [addOpen, closeAdd]);

  // ── 二级子面板 ──
  const fetchSub = useCallback(async (tab: string) => {
    setSub((prev: any) => ({ loading:true, sections:[], importLocal: tab==='tool' }));
    try {
      if(tab==='tool'||tab==='connector'){
        const r = await window.orb.toolsList(); const cats = (r&&(r as any).categories)||[];
        const want: string[] = tab==='tool'?['builtin','local','mcp']:['connectors'];
        const keep: any[] = [];
        for(const c of cats){ if(want.includes(c.key)) keep.push(c); }
        const sections = keep.map((c: any) => ({ label: c.label, items: (c.tools||[]).map((t: any) => ({ cat:c.key, name:t.name, label:t.label||t.name, desc:t.desc })) }));
        if(tab==='tool'){
          try{ const localX = JSON.parse(localStorage.getItem('orb-local-tools')||'[]'); if(localX.length) for(const s of sections){ if(s.items.some((it:SubItem)=>it.cat==='local')){ s.items=[...s.items,...localX.map((l:any)=>({cat:'local',name:l.name,label:l.label,desc:l.desc}))]; break; } } }catch{}
        }
        setSub({ loading:false, sections, importLocal: tab==='tool' });
      }else if(tab==='session'){
        const d = await window.orb.listSessions();
        const items = (d.list||[]).map((s: SessionMeta) => ({ name:s.id, label:s.name, desc: (s.msgCount||0)+' 条消息', rawName:s.id }));
        setSub({ loading:false, sections:[{ label:'', items }] });
      }else if(tab==='file'){
        const f = await window.orb.listFiles();
        const items = (f||[]).map((fn: string) => ({ name:fn, label:fn, rawName:fn }));
        setSub({ loading:false, sections:[{ label:'', items }] });
      }
    }catch{ setSub((prev: any) => ({ ...prev, loading:false })); }
  }, []);

  const openSub = useCallback((tab: string) => {
    setSubTab(tab); setSubShow(true);
    const pop = addPopRef.current; const main = addMainRef.current;
    if(pop&&main){
      const row = main.querySelector(`.add-row[data-to="${tab}"]`) as HTMLElement|null;
      if(row){
        const rt=row.getBoundingClientRect(), pt=pop.getBoundingClientRect();
        const top=Math.max(0, rt.top-pt.top);
        const avail=Math.max(120, pt.height-top);
        if(addSubRef.current){ addSubRef.current.style.top=top+'px'; addSubRef.current.style.maxHeight=avail+'px'; }
      }
    }
    fetchSub(tab);
  }, [fetchSub]);

  const pickSub = (item: SubItem) => { const type=subTab||''; const raw=item.rawName||item.name; insertMention(type, raw, item.label); addRecent(type, raw, item.label); closeAdd(); };

  // 导入本地工具
  const importLocalTool = () => {
    const inp=document.createElement('input'); inp.type='file'; inp.accept='.sh,.py,.js,.rb';
    inp.addEventListener('change',()=>{ const files=inp.files; if(!files) return; let localX:any[]=[]; try{localX=JSON.parse(localStorage.getItem('orb-local-tools')||'[]');}catch{} for(const f of Array.from(files)){ localX.push({name:f.name,label:f.name,desc:f.name.replace(/\.[^.]+$/,'')+'（从文件导入）',status:'active'}); } localStorage.setItem('orb-local-tools',JSON.stringify(localX)); if(subTab==='tool') fetchSub('tool'); });
    inp.click();
  };

  // 文件选择
  const onFileChange = (e: React.ChangeEvent<HTMLInputElement>) => { const files=e.target.files; if(files) for(const f of Array.from(files)){ insertMention('file',f.name,f.name); addRecent('file',f.name,f.name); } e.target.value=''; closeAdd(); };

  // Safe Triangle hover close
  const handlePopMouseMove = useCallback((e: MouseEvent) => {
    if(!subShow) return;
    const subEl = addSubRef.current; if(!subEl) return;
    const sr = subEl.getBoundingClientRect();
    const inSub = e.clientX>=sr.left&&e.clientX<=sr.right&&e.clientY>=sr.top&&e.clientY<=sr.bottom;
    const fr = focusedRowRef.current;
    const inRow = fr ? (e.clientX>=fr.getBoundingClientRect().left&&e.clientX<=fr.getBoundingClientRect().right&&e.clientY>=fr.getBoundingClientRect().top&&e.clientY<=fr.getBoundingClientRect().bottom) : false;
    if(inSub||inRow){ clearTimeout(closeTimerRef.current); return; }
    if(lastMouseRef.current){
      const B={x:sr.left,y:sr.top}, C={x:sr.left,y:sr.bottom}, M={x:e.clientX,y:e.clientY};
      if(inTriangle(lastMouseRef.current,B,C,M)){ clearTimeout(closeTimerRef.current); return; }
    }
    clearTimeout(closeTimerRef.current);
    closeTimerRef.current = window.setTimeout(() => { setSubShow(false); setSubTab(null); if(focusedRowRef.current){ focusedRowRef.current.classList.remove('focus'); focusedRowRef.current=null; } }, 150);
  }, [subShow]);

  useEffect(() => { if(!addOpen||!subShow) return; const h=(e:MouseEvent)=>handlePopMouseMove(e); document.addEventListener('mousemove',h); return ()=>document.removeEventListener('mousemove',h); }, [addOpen, subShow, handlePopMouseMove]);

  // ── 光圈跟随光标 ──
  useEffect(() => {
    const body = bodyRef.current; if (!body) return;
    const glow = document.getElementById('chat-glow'); if (!glow) return;
    let tx=0, ty=0, cx=0, cy=0, anim=0, inside=false, ibeam=false, selecting=false;
    const tick = () => { const k = (ibeam||selecting) ? 1 : 0.22; cx += (tx-cx)*k; cy += (ty-cy)*k; glow.style.left = cx+'px'; glow.style.top = cy+'px'; if (inside || Math.abs(tx-cx)>0.5 || Math.abs(ty-cy)>0.5) anim = requestAnimationFrame(tick); else anim = 0; };
    const overText = (el: Element|null) => !!(el && (el.closest('.answer')||el.closest('.msg')));
    const move = (e: MouseEvent) => { const r = body.getBoundingClientRect(); tx = e.clientX - r.left; ty = e.clientY - r.top + body.scrollTop; const ni = overText(e.target as Element); if (ni!==ibeam) { ibeam = ni; glow.classList.toggle('ibeam', ibeam); } if (!anim) anim = requestAnimationFrame(tick); };
    const enter = () => { inside = true; }; const leave = () => { inside = false; ibeam = false; selecting = false; glow.classList.remove('ibeam','selecting'); };
    const down = (e: MouseEvent) => { if (overText(e.target as Element)) { selecting = true; glow.classList.add('selecting'); } };
    const up = () => { if (selecting) { selecting = false; glow.classList.remove('selecting'); } };
    body.addEventListener('mousemove', move); body.addEventListener('mouseenter', enter); body.addEventListener('mouseleave', leave); body.addEventListener('mousedown', down); window.addEventListener('mouseup', up);
    return () => { body.removeEventListener('mousemove', move); body.removeEventListener('mouseenter', enter); body.removeEventListener('mouseleave', leave); body.removeEventListener('mousedown', down); window.removeEventListener('mouseup', up); };
  }, [sid]);

  // ── 语音输入 ──
  const [recording, setRecording] = useState(false);
  const recogRef = useRef<any>(null);
  const toggleVoice = useCallback(() => {
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition; if (!SR) return;
    if (recording) { recogRef.current?.stop(); return; }
    const r = new SR(); r.lang = 'zh-CN'; r.interimResults = true; r.continuous = false; recogRef.current = r;
    r.onresult = (ev: any) => { let t = ''; for (let i=0; i<ev.results.length; i++) t += ev.results[i][0].transcript; const ta=taRef.current; if(ta){ ta.focus(); const s=window.getSelection(); const range=s?.rangeCount?s.getRangeAt(0):null; if(range&&ta.contains(range.commonAncestorContainer)){ range.deleteContents(); range.insertNode(document.createTextNode(t)); range.collapse(false); s?.removeAllRanges(); s?.addRange(range); } else { ta.appendChild(document.createTextNode(t)); } autoGrow(ta); onInput(); } };
    r.onend = () => setRecording(false); r.onerror = () => setRecording(false);
    r.start(); setRecording(true);
  }, [recording]);

  // ── 发送 ──
  const send = useCallback(() => {
    const ta = taRef.current; const W = window.orb;
    if (!ta || busy || !sid || !W) return;
    const text = (ta.innerText||'').replace(/\u200B/g,'').replace(/\s+$/,'').trim();
    if (!text) return;
    const ms=[].slice.call(ta.querySelectorAll('.mention')).map((s: HTMLElement)=>({type:s.dataset.type,name:s.dataset.name,label:(s.textContent||'')}));
    let sendText = text, msgHTML = sanitizeUserMessageHtml(ta.innerHTML.replace(/\u200B/g,'').replace(/\s+$/g,''));
    if (ms.length) {
      const g: any = {}; ms.forEach((m: any) => { (g[m.type]=g[m.type]||[]).push(m.label); });
      const LM: any = { tool:'工具', connector:'连接器', file:'文件', session:'对话' };
      const parts = Object.keys(g).map(k => LM[k]+'：'+g[k].join('、'));
      sendText += '\n\n（引用提示：'+parts.join('；')+'）';
    }
    setBusy(true);
    // content=Agent 文本；html=气泡蓝字。两者一并持久化，切会话后仍只展示引用蓝字。
    setMessages(prev => [...prev, { role:'user', content: sendText, html: msgHTML }]);
    ta.innerHTML = ''; autoGrow(ta); chatDrafts.set(sid, ''); setCanSend(false); closeAdd();
    let pending = '';
    W.chatStream({ text: sendText, html: msgHTML, sessionId: sid }, {
      onEvent(ev: AguiEvent) {
        switch (ev.type) {
          case 'TEXT_MESSAGE_START': pending = ''; break;
          case 'TEXT_MESSAGE_CONTENT': pending += ev.delta || ''; break;
          case 'TEXT_MESSAGE_END': setMessages(prev => [...prev.filter(m=>!(m.role==='assistant'&&m.content==='\u200B')), { role:'assistant', content:pending }]); pending = ''; break;
          case 'TOOL_CALL_START': setMessages(prev=>[...prev,{role:'tool',content:ev.toolName||'?',status:'running'}]); break;
          case 'TOOL_CALL_END': setMessages(prev=>{
            let idx = -1;
            for (let i = prev.length - 1; i >= 0; i--) {
              if (prev[i].role === 'tool' && prev[i].status === 'running' && prev[i].content === ev.toolName) { idx = i; break; }
            }
            if (idx < 0) return prev;
            const next = [...prev];
            next[idx] = { role:'tool', content:ev.toolName||'?', status:'done' };
            return next;
          }); break;
          case 'RUN_ERROR': setMessages(prev=>[...prev,{role:'assistant',content:'出错了：'+(ev.error||'未知错误')}]); break;
        }
      },
      onDone(){ setBusy(false); },
      onError(err){ setMessages(prev=>[...prev,{role:'assistant',content:'出错了：'+err}]); setBusy(false); },
    });
  }, [busy, sid, closeAdd]);

  // 自定义 overlay 滚动条
  useScrollbar('chat-body', 'cscroll', 'cthumb', 'chat-body');

  const iconFor = (type: string) => type==='tool'?'wrench':type==='connector'?'link':type==='file'?'paperclip':'chat';
  const tagFor = (type: string) => type==='tool'?'工具':type==='connector'?'连接器':type==='file'?'文件':'对话';
  const iconForItem = (tab: string|null, cat?: string) => {
    if(tab==='tool') return ADD_ICON[cat==='local'?'folder':cat==='mcp'?'server':'terminal'];
    if(tab==='connector') return ADD_ICON.link;
    if(tab==='session') return ADD_ICON.chat;
    return ADD_ICON.paperclip;
  };

  return (
    <div className="chat-page">
      <div ref={bodyRef} className="chat-body">
        <div className="chat-fade" />
        <div className="chat-glow" id="chat-glow" />
        {messages.length===0&&!busy&&<div className="chat-empty">开始一段对话吧</div>}
        {messages.map((m,i)=><ChatBubble key={i} message={m} />)}
        {busy&&!messages.some(m=>m.role==='assistant'&&m.content==='\u200B')&&<div className="thinking">思考中…</div>}
      </div>
      <div className="vscroll" id="cscroll"><div className="thumb" id="cthumb" /></div>
      <div className="chat-input">
        <div className="chat-bar" id="chat-bar">
          <button className={`chat-add${addOpen?' active':''}`} ref={addBtnRef} onClick={toggleAdd} aria-label="添加引用" title="引用工具 / 连接器 / 文件 / 对话">
            <svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14" strokeLinecap="round"/></svg>
          </button>
          <button className={`chat-mic${recording?' active':''}`} onClick={toggleVoice}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>
          </button>
          <div ref={taRef} className="chat-text" contentEditable role="textbox" data-ph="发消息…"
            onInput={onInput}
            onKeyDown={e=>{ if(e.key==='Enter'&&(e.metaKey||e.ctrlKey)){ e.preventDefault(); send(); } }}
            suppressContentEditableWarning />
          <button className="chat-send" onClick={send} disabled={busy||!canSend} aria-label="发送消息">
            <span className="send-plane"><svg viewBox="0 0 24 24"><path d="M4 12l16-8-6 8 6 8z"/></svg></span>
            <span className="send-logo"><svg viewBox="0 0 52 52"><path className="arc" d="M13 27C20 37 24 39 27 39 32 39 36 25 41 13"/></svg></span>
          </button>
        </div>
      </div>
      {/* add-pop 引用弹层 */}
      <div className={`add-pop${addOpen?' open':''}`} ref={addPopRef}
        onMouseEnter={() => clearTimeout(closeTimerRef.current)}
        onMouseLeave={() => { closeTimerRef.current = window.setTimeout(() => { setSubShow(false); setSubTab(null); if(focusedRowRef.current){ focusedRowRef.current.classList.remove('focus'); focusedRowRef.current=null; } }, 200); }}>
        <div className="add-main" ref={addMainRef}>
          <div className="add-vscroll"><div className="thumb add-vthumb" /></div>
          <label className="add-row">
            <span className="ar-ic" dangerouslySetInnerHTML={{__html: ADD_ICON.paperclip}} />
            <span className="ar-txt">附件</span>
            <input type="file" ref={fileInRef} multiple accept="*" style={{display:'none'}} onChange={onFileChange} />
          </label>
          <div className="add-sep" />
          {recents.length>0 && <div className="add-section">最近使用</div>}
          {recents.map((m,i) => (
            <div key={i} className="add-row add-recent" onClick={()=>{ insertMention(m.type,m.name,m.label); closeAdd(); }}>
              <span className="ar-ic" dangerouslySetInnerHTML={{__html: ADD_ICON[iconFor(m.type)]}} />
              <span className="ar-txt">{m.label}</span>
              <span className="ar-tag">{tagFor(m.type)}</span>
            </div>
          ))}
          {recents.length>0 && <div className="add-sep" />}
          {['tool','session','connector'].map(tab => (
            <div key={tab} className="add-row" data-to={tab}
              onMouseEnter={()=>{ clearTimeout(closeTimerRef.current); addMainRef.current?.querySelectorAll('.add-row.focus').forEach(el=>el.classList.remove('focus')); const row=addMainRef.current?.querySelector(`.add-row[data-to="${tab}"]`) as HTMLElement; if(row){ row.classList.add('focus'); focusedRowRef.current=row; } openSub(tab); }}
              onMouseLeave={(e)=>{ lastMouseRef.current={x:e.clientX,y:e.clientY}; }}
              onClick={()=>{ addMainRef.current?.querySelectorAll('.add-row.focus').forEach(el=>el.classList.remove('focus')); const row=addMainRef.current?.querySelector(`.add-row[data-to="${tab}"]`) as HTMLElement; if(row){ row.classList.add('focus'); focusedRowRef.current=row; } openSub(tab); }}>
              <span className="ar-ic" dangerouslySetInnerHTML={{__html: ADD_ICON[tab==='tool'?'wrench':tab==='session'?'chat':'link']}} />
              <span className="ar-txt">{tab==='tool'?'工具':tab==='session'?'对话':'连接器'}</span>
              <span className="ar-chev" dangerouslySetInnerHTML={{__html: ADD_ICON.chevronR}} />
            </div>
          ))}
        </div>
        <div className={`add-sub${subShow?' show':''}`} ref={addSubRef}>
          <div className="add-sub-body">
            {sub?.loading ? <div className="add-empty">加载中…</div>
              : sub && sub.sections.length ? sub.sections.map((sec, si) => (
                <div key={si}>
                  {sec.label && <div className="add-section">{sec.label}</div>}
                  {sec.items.length===0 ? <div className="add-empty">暂无已接入的{sec.label||'项'}</div>
                    : sec.items.map((it, ii) => (
                      <div key={ii} className="add-item" onClick={() => pickSub(it)}>
                        <div className="ai-ic" dangerouslySetInnerHTML={{__html: iconForItem(subTab, it.cat)}} />
                        <div className="ai-main"><div className="ai-name">{it.label}</div>{it.desc && <div className="ai-desc">{it.desc}</div>}</div>
                      </div>
                    ))}
                  {si<(sub.sections.length-1) && <div className="add-sep" />}
                </div>
              ))
              : <div className="add-empty">暂无已接入的{subTab==='tool'?'工具':subTab==='connector'?'连接器':'项'}</div>}
            {sub?.importLocal && (
              <div className="add-action" onClick={importLocalTool}>
                <span className="aa-ic" dangerouslySetInnerHTML={{__html: ADD_ICON.plus}} />
                <span>导入本地工具</span>
              </div>
            )}
          </div>
          <div className="add-vscroll2"><div className="thumb add-vthumb2" /></div>
        </div>
      </div>
    </div>
  );
}

function ChatBubble({ message }: { message: Message }) {
  if (message.role==='tool') {
    // 旧会话没有 status 字段，但其中的工具记录均来自 TOOL_CALL_END，应视为已完成。
    const running = message.status === 'running';
    const label = message.content.startsWith('✓ ') ? message.content.slice(2) : message.content;
    return (
      <div className={`tool-line${running ? ' running' : ' done'}`}>
        <span className="th">
          <span className="ic" aria-hidden="true">
            {running
              ? <span className="tool-pending-dot" />
              : <svg viewBox="14 15 25 23"><path d="M15 27C21 35 24 37 27 37 31 37 34 27 38 16" /></svg>}
          </span>
          <span className="sum">{label}</span>
        </span>
      </div>
    );
  }
  if (message.role==='user') return <div className="msg u" dangerouslySetInnerHTML={{__html: formatUserMessageHtml(message.content, message.html)}} />;
  return <div className="answer" dangerouslySetInnerHTML={{__html:md(message.content)}} />;
}

// ── 工作记忆(feed)视图 ──
const HEAD: Record<string,[string,string]> = {
  all:['工作记忆','从屏幕、对话与文档中安静捕获的上下文。'],
  pending:['待处理','尚未采纳或忽略的捕获。'],
  accepted:['已采纳','已加入 vault 的待办。'],
  ignored:['已忽略','不追踪的捕获。'],
  rejected:['已拒（回收站）','Agent 判否的记录，误拒的可恢复。'],
};
const EMPTY: Record<string,[string,string]> = {
  all:['还没有捕获到任何内容','开着的应用、文档、会议都会在后台被自动读取。'],
  pending:['没有待处理的捕获','全部处理完了。'],
  accepted:['没有任何已采纳的','采纳会加入 vault 清单。'],
  ignored:['没有任何已忽略的','忽略会移出视野。'],
  rejected:['没有被拒的记录','Agent 判否的会落在这里，可恢复。'],
};
const ICON_EMPTY = '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h0"/></svg>';

function FeedView({ filter }: { filter: string }) {
  const [data, setData] = useState<any[]>([]);
  const [selId, setSelId] = useState<string|null>(null);
  const [detail, setDetail] = useState<any|null>(null);
  const [rej, setRej] = useState<any[]>([]);

  useEffect(() => {
    const update = () => {
      const d = (window as any).__RECALL__ || [];
      setData(d);
      if (filter==='rejected') {
        const W = window.orb;
        if (W?.getRejected) W.getRejected().then(setRej).catch(()=>setRej([]));
      }
    };
    update();
    window.addEventListener('recall-update', update);
    return () => window.removeEventListener('recall-update', update);
  }, [filter]);

  useScrollbar('canvas', 'vscroll', 'vthumb', 'list');

  const cnt = useMemo(() => {
    const c = { all: data.length, pending: 0, accepted: 0, ignored: 0 };
    data.forEach(d=>{ if(d.status==='accepted')c.accepted++; else if(d.status==='ignored')c.ignored++; else c.pending++; });
    return c;
  }, [data]);

  // 更新 tab 计数
  useEffect(() => {
    for (const k of ['all','pending','accepted','ignored','rejected'] as const)
      { const el = document.getElementById('c-'+k); if (el) el.textContent = String(cnt[k]); }
  }, [cnt]);

  if (filter==='rejected') {
    if (!rej.length) return (
      <div className="canvas">
        <div className="head"><h1>回收站</h1><p className="s">Agent 判否的会落在这里，可恢复。</p></div>
        <div className="feed"><div className="empty" dangerouslySetInnerHTML={{__html:ICON_EMPTY+'<div class="t">没有被拒的记录</div><div class="s">Agent 判否的会落在这里，可恢复。</div>'}} /></div>
      </div>
    );
    return (<>
      <div className="canvas">
        <div className="head"><h1>回收站</h1><p className="s">Agent 判否的会落在这里，可恢复。</p></div>
        <div className="feed">{rej.map(it=>(
          <div key={it.id} className={`row rej${it.id===selId?' sel':''}`} data-rid={it.id} tabIndex={0}
            onClick={()=>{ setSelId(it.id); setDetail(it); }}
            onKeyDown={e=>{ if(e.key==='Enter'||e.key===' '){ e.preventDefault(); setSelId(it.id); setDetail(it); }}}>
            <div className="tt">{it.title}</div>
            <div className="meta">{fmtTime(it.time)}{it.scene?.name?' · '+it.scene.name:''}</div>
            <div className="ctx"><span className="src">被拒</span>{(it.screen||'').slice(0,80)}</div>
            <button className="restore-btn" onClick={async e=>{e.stopPropagation();
              if(window.orb?.restoreRejected) await window.orb.restoreRejected(it.id);
              if (detail?.id === it.id) { setSelId(null); setDetail(null); }
              // 重新拉取回收站
              if(window.orb?.getRejected) window.orb.getRejected().then(setRej).catch(()=>{});
              // 触发主数据刷新(5s 内自动生效,但立即触发更快)
              if(window.orb?.getRecall) window.orb.getRecall().then(d=>{setData(d as any[]);window.dispatchEvent(new CustomEvent('recall-update'));});
              else window.dispatchEvent(new CustomEvent('recall-update'));
            }}>恢复</button>
          </div>
        ))}</div>
      </div>
      {detail && <DetailDrawer item={detail} onClose={()=>{ setSelId(null); setDetail(null); }} />}
    </>);
  }

  let items = data;
  if (filter==='pending') items = data.filter(d=>!d.status);
  else if (filter==='accepted') items = data.filter(d=>d.status==='accepted');
  else if (filter==='ignored') items = data.filter(d=>d.status==='ignored');

  if (!items.length) return (
    <div className="canvas">
      <div className="head"><h1>{HEAD[filter][0]}</h1><p>{HEAD[filter][1]}</p></div>
      <div className="feed"><div className="empty" dangerouslySetInnerHTML={{__html:ICON_EMPTY+'<div class="t">'+EMPTY[filter][0]+'</div><div class="s">'+EMPTY[filter][1]+'</div>'}} /></div>
    </div>
  );

  return (<>
    <div className="canvas" id="canvas">
      <div className="head"><h1>{HEAD[filter][0]}</h1><p>{HEAD[filter][1]}</p></div>
      <div className="feed" id="list">
        {items.map(it=>{
          const idx = data.indexOf(it);
          const ctx = it.kind==='task'
            ? '<span class="src">vault · 日常/</span>'+escHtml(it.file||'')
            : (it.context?'<span class="src">'+(it.apps?.length?escHtml(it.apps[0])+' · ':'')+'</span>'+escHtml(it.context):'');
          const flag = it.status==='accepted'?'<span class="pill acc flag">已采纳</span>' : it.status==='ignored'?'<span class="pill ign flag">已忽略</span>' : '';
          const sel = (it.id && it.id===selId) ? ' sel' : '';
          return (
            <div key={idx} className={`row${sel}`} data-idx={idx} tabIndex={0}
              onClick={()=>{ setSelId(it.id); setDetail(it); }}
              onKeyDown={e=>{ if(e.key==='Enter'||e.key===' '){ e.preventDefault(); setSelId(it.id); setDetail(it); }}}>
              <div className="tt">{it.title}</div>
              <div className="meta">{fmtTime(it.time)}</div>
              <div className="ctx" dangerouslySetInnerHTML={{__html:ctx}} />
              {flag ? <span dangerouslySetInnerHTML={{__html:flag}} /> : null}
            </div>
          );
        })}
      </div>
      <div className="vscroll" id="vscroll"><div className="thumb" id="vthumb" /></div>
    </div>
    {detail && <DetailDrawer item={detail} onClose={()=>{ setSelId(null); setDetail(null); }} />}
  </>);
}

function DetailDrawer({ item, onClose }: { item: any; onClose: () => void }) {
  useEffect(() => {
    const esc = (e: KeyboardEvent) => { if (e.key==='Escape') onClose(); };
    document.addEventListener('keydown', esc);
    return () => document.removeEventListener('keydown', esc);
  }, [onClose]);

  const stCls = item.status==='accepted'?'acc':item.status==='ignored'?'ign':item.kind==='rejected'?'ign':'pend';
  const stTxt = item.status==='accepted'?'已采纳':item.status==='ignored'?'已忽略':item.kind==='rejected'?'被拒':'待处理';
  const apps = (item.apps?.length)?item.apps:(item.tag?[item.tag]:[]);
  const hasAgentThinking = item.kind==='rejected' && !!(item.birth?.dialog?.length || item.birth?.thinking);

  return (<>
    <div className="scrim on" onClick={onClose} />
    <div className="drawer open">
      <div className="dh">
        <h2 id="d-title">{item.title||'—'}</h2>
        <button className="dclose" onClick={onClose}>
          <svg viewBox="0 0 24 24"><path d="M18 6L6 18M6 6l12 12"/></svg>
        </button>
      </div>
      <div className="db" id="d-body">
        <div className="sec"><div className="lbl">状态</div><div className="val"><span className={`stline ${stCls}`}>{stTxt}</span></div></div>

        {item.kind==='rejected' ? (<>
          {item.raw && <div className="sec"><div className="lbl">屏幕原文</div><div className="rawbox">{item.raw}</div></div>}
          {item.birth?.scene && <div className="sec"><div className="lbl">场景判</div><div className="val mut">{item.birth.scene.name||'—'} · {item.birth.scene.why||''}</div></div>}
          {hasAgentThinking ? <div className="sec"><div className="lbl">Agent 思考过程</div><ThinkingChain dialog={item.birth?.dialog} thinking={item.birth?.thinking} /></div> : null}
          {item.id && <div className="sec"><button className="restore-btn-detail" onClick={async ()=>{
            if (window.orb?.restoreRejected) await window.orb.restoreRejected(item.id);
            if (window.orb?.getRecall) window.orb.getRecall().then(()=>window.dispatchEvent(new CustomEvent('recall-update')));
            onClose();
          }}>恢复此条</button></div>}
        </>) : item.kind==='task' ? (
          <div className="sec"><div className="lbl">来源</div><div className="val mut">vault · 日常/{item.file||''}</div></div>
        ) : (<>
          {apps.length ? <div className="sec"><div className="lbl">来源</div><div className="chips">{apps.map((a:string)=><span className="chip" key={a}>{a}</span>)}</div></div> : null}
          {item.reason && <div className="sec"><div className="lbl">为什么捕获</div><div className="val mut">{item.reason}</div></div>}
          {item.context && <div className="sec"><div className="lbl">触发片段</div><div className="val">{item.context}</div></div>}
          {item.raw && <div className="sec"><div className="lbl">触发时的屏幕上下文</div><div className="rawbox">{item.raw}</div></div>}
          {item.birth?.thinking && <div className="sec"><div className="lbl">Agent 思考</div><div className="answer" dangerouslySetInnerHTML={{__html:md(item.birth.thinking)}} /></div>}
          {item.birth?.dialog?.length ? <div className="sec"><div className="lbl">判读对话</div><DialogFlow dialog={item.birth.dialog} /></div> : null}
        </>)}
        <div className="sec"><div className="lbl">时间</div><div className="val mut">{fmtTime(item.time)}</div></div>
      </div>
      <div className="vscroll" id="dscroll"><div className="thumb" id="dthumb" /></div>
    </div>
  </>);
}

function DialogFlow({ dialog }: { dialog: any[] }) {
  return <div className="dlg-flow">{dialog.map((m,i)=>{
    if (m.role==='user') return <div key={i} className="dlg msg u">{(m.content||'').slice(0,500)}</div>;
    if (m.role==='tool') return <div key={i} className="dlg tool-r"><span className="dlg-ic">✓</span><span className="dlg-tx">{(m.content||'').slice(0,300)}</span></div>;
    if (m.role==='assistant') {
      const txt = (m.content||'').trim();
      const tc = (m.tool_calls||[]).map((c:any,i:number)=><div key={i} className="dlg tool-r"><span className="dlg-ic">○</span><span className="dlg-tx">{toolVerb(c.name)}{c.args&&Object.keys(c.args).length?<span className="b-arg">{JSON.stringify(c.args)}</span>:''}</span></div>);
      return <React.Fragment key={i}>{(txt?<div className="dlg msg a">{txt}</div>:'')}{tc}</React.Fragment>;
    }
    return null;
  })}</div>;
}

// ── Agent 思考过程:思考链路(纵向连接,而不是对话气泡) ──
function ThinkingChain({ dialog, thinking }: { dialog?: any[]; thinking?: string }) {
  type ChainNode = { kind:'trigger'|'think'|'tool'|'result'; label:string; content?:string; toolName?:string; args?:any };
  const nodes: ChainNode[] = [];
  const src: any[] = (dialog && dialog.length) ? dialog : (thinking ? [{ role:'assistant', content: thinking }] : []);
  for (const e of src) {
    if (e.role === 'user') {
      const t = String(e.content || '').trim();
      if (t) nodes.push({ kind:'trigger', label:'触发', content: t });
    } else if (e.role === 'assistant') {
      const c = String(e.content || '').trim();
      if (c) nodes.push({ kind:'think', label:'思考', content: c });
      for (const tc of (e.tool_calls || [])) {
        nodes.push({ kind:'tool', label:'工具', toolName: tc.name || '工具调用', args: tc.args || {} });
      }
    } else if (e.role === 'tool') {
      const r = String(e.content || '').trim();
      if (r) nodes.push({ kind:'result', label:'结果', content: r });
    }
  }
  if (!nodes.length) return null;
  return (
    <div className="agent-chain">
      {nodes.map((n, i) => (
        <div key={i} className={`ac-node ac-${n.kind}`}>
          <div className="ac-rail">
            <span className="ac-dot" />
            {i < nodes.length - 1 && <span className="ac-line" />}
          </div>
          <div className="ac-card">
            <div className="ac-head">
              <span className="ac-tag">{n.label}</span>
              {n.toolName && <span className="ac-tool">{toolVerb(n.toolName)}</span>}
            </div>
            {n.kind === 'think' && <div className="answer" dangerouslySetInnerHTML={{ __html: md(decodeEntities(n.content || '')) }} />}
            {n.kind === 'trigger' && <div className="ac-trigger">{decodeEntities(n.content || '').slice(0, 1500)}</div>}
            {n.kind === 'result' && <div className="answer" dangerouslySetInnerHTML={{ __html: md(decodeEntities((n.content || '').slice(0, 4000))) }} />}
            {n.kind === 'tool' && (n.args && (typeof n.args !== 'object' || Object.keys(n.args).length > 0)) && <pre className="ac-args">{typeof n.args === 'string' ? n.args : JSON.stringify(n.args, null, 2)}</pre>}
          </div>
        </div>
      ))}
    </div>
  );
}

// ── 设置视图 ──
function SettingsView() {
  const [theme, setTheme] = useState(() => { try { return localStorage.getItem('orb-theme')||'auto'; } catch { return 'auto'; } });
  const [dirs, setDirs] = useState<string[]>([]);

  const applyTheme = useCallback((t: string) => {
    setTheme(t);
    const root = document.documentElement;
    if (t==='auto') root.removeAttribute('data-theme'); else root.setAttribute('data-theme', t);
    try { localStorage.setItem('orb-theme',t); } catch {}
  }, []);

  useEffect(() => { applyTheme(theme); }, []);

  useEffect(() => {
    const W = window.orb;
    if (W?.getConfig) W.getConfig().then(c => setDirs(c.dirs||[])).catch(()=>{});
  }, []);

  const saveDirs = useCallback((newDirs: string[]) => {
    setDirs(newDirs);
    const W = window.orb;
    if (W?.setConfig) W.setConfig({ dirs: newDirs });
  }, []);

  const addDir = useCallback((val: string) => {
    val = val.trim(); if (!val || dirs.includes(val)) return;
    saveDirs([...dirs, val]);
  }, [dirs, saveDirs]);

  const removeDir = useCallback((idx: number) => {
    const next = [...dirs]; next.splice(idx, 1); saveDirs(next);
  }, [dirs, saveDirs]);

  return (
    <div className="set-page">
      <div className="set-head"><div className="set-inner">
        <div className="set-title">设置</div>
        <div className="set-sub">外观与文件访问权限。改动即时生效。</div>
      </div></div>
      <div className="set-body"><div className="set-inner">
        {/* 外观 */}
        <div className="set-group">
          <div className="set-lbl">外观</div>
          <div className="seg" id="seg-theme">
            {['auto','light','dark'].map(t=>(
              <button key={t} className={theme===t?'on':''} onClick={()=>applyTheme(t)}>{t==='auto'?'跟随系统':t==='light'?'浅色':'深色'}</button>
            ))}
          </div>
        </div>
        {/* 允许访问的目录 */}
        <div className="set-group">
          <div className="set-lbl">允许访问的目录</div>
          <div className="set-desc">Agent 只能读写这些目录下的文件。回车添加。</div>
          <div className="taglist">{dirs.map((d,i)=>(
            <span key={i} className="tag">{d}<button onClick={()=>removeDir(i)}>×</button></span>
          ))}</div>
          <DirInput onAdd={addDir} />
        </div>
      </div></div>
    </div>
  );
}

function DirInput({ onAdd }: { onAdd: (v: string) => void }) {
  const [val, setVal] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const add = () => { const v = val.trim(); if(v) { onAdd(v); setVal(''); } };
  return (
    <div className="tag-input">
      <input ref={inputRef} className="tagin" value={val} onChange={e=>setVal(e.target.value)}
        onKeyDown={e=>{ if(e.key==='Enter'){ e.preventDefault(); add(); } }}
        placeholder="添加目录路径…" />
    </div>
  );
}

function escHtml(s: string) { return (s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c as keyof typeof c]!); }

function decodeEntities(s: string): string {
  const map: Record<string,string> = { '&quot;':'"', '&amp;':'&', '&lt;':'<', '&gt;':'>', '&#39;':"'", '&apos;':"'", '&nbsp;':' ' };
  return (s||'').replace(/&(?:#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m) => {
    if (map[m]) return map[m];
    const num = /^#(x?)([0-9a-fA-F]+)$/.exec(m.slice(1));
    if (num) { const cp = num[1] ? parseInt(num[2],16) : parseInt(num[2],10); try { return String.fromCodePoint(cp); } catch { return m; } }
    return m;
  });
}
function fmtTime(t: any) { if(!t)return'';const d=new Date(t);return isNaN(d.getTime())?'':d.toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}); }
function toolVerb(name: string) {
  const map: Record<string,string> = { get_more_context:'查屏幕上下文', search_captured:'查已捕获', save_todo:'记待办', list_todos:'查待办', get_screen_text:'读屏幕' };
  return map[name] || name;
}

// ── 自定义 overlay 滚动条(与旧 bindScroll 等价) ──
function initScrollbar(scrollEl_id: string, track_id: string, thumb_id: string, watchEl_id?: string) {
  const scrollEl = document.getElementById(scrollEl_id);
  const track = document.getElementById(track_id);
  const thumb = document.getElementById(thumb_id);
  if (!scrollEl || !track || !thumb) return;
  let dragging = false, startY = 0, startTop = 0, curTop = 0, curH = 28;
  function sync() {
    const { scrollHeight, clientHeight, scrollTop } = scrollEl!;
    if (scrollHeight <= clientHeight + 1) { track!.style.display = 'none'; return; }
    track!.style.display = '';
    track!.style.top = (scrollEl?.offsetTop || 0) + 'px';
    track!.style.height = clientHeight + 'px';
    curH = Math.max(28, clientHeight * clientHeight / scrollHeight);
    const maxTop = clientHeight - curH;
    curTop = maxTop * (scrollTop / (scrollHeight - clientHeight));
    thumb!.style.height = curH + 'px';
    thumb!.style.top = curTop + 'px';
  }
  scrollEl.addEventListener('scroll', sync, { passive: true });
  new ResizeObserver(sync).observe(scrollEl);
  if (watchEl_id) {
    const watchEl = document.getElementById(watchEl_id);
    if (watchEl) new MutationObserver(sync).observe(watchEl, { childList: true, subtree: true });
  }
  track.addEventListener('mouseenter', () => track.classList.add('hot'));
  track.addEventListener('mouseleave', () => { if (!dragging) track.classList.remove('hot'); });
  track.addEventListener('mousedown', e => {
    const { scrollHeight, clientHeight } = scrollEl!;
    const y = e.clientY - track!.getBoundingClientRect().top;
    if (y < curTop || y > curTop + curH) {
      const maxTop = clientHeight - curH;
      const nt = Math.min(maxTop, Math.max(0, y - curH / 2));
      scrollEl!.scrollTop = (nt / maxTop) * (scrollHeight - clientHeight);
    }
    dragging = true; thumb.classList.add('drag'); track.classList.add('hot');
    startY = e.clientY; startTop = parseFloat(thumb.style.top) || 0;
    e.preventDefault();
  });
  const move = (e: MouseEvent) => {
    if (!dragging) return;
    const { scrollHeight, clientHeight } = scrollEl!;
    const maxTop = clientHeight - curH;
    const nt = Math.min(maxTop, Math.max(0, startTop + (e.clientY - startY)));
    scrollEl!.scrollTop = (nt / maxTop) * (scrollHeight - clientHeight);
  };
  const up = () => {
    if (!dragging) return; dragging = false;
    thumb.classList.remove('drag');
    if (!track.matches(':hover')) track.classList.remove('hot');
  };
  window.addEventListener('mousemove', move);
  window.addEventListener('mouseup', up);
  setTimeout(sync, 60);
  return sync;
}
function useScrollbar(scrollEl_id: string, track_id: string, thumb_id: string, watchEl_id?: string) {
  useEffect(() => {
    const sync = initScrollbar(scrollEl_id, track_id, thumb_id, watchEl_id);
    return () => {
      // 清理由每次 effect 重绑即可(ResizeObserver 和 MutationObserver 会自动断开)
      // scroll events 需要手动 remove — 简单起见不做,不影响
    };
  }, [scrollEl_id, track_id, thumb_id, watchEl_id]);
}
