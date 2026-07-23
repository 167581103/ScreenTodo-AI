import { useCallback, useEffect, useRef, useState } from 'react';
import type { SuggestionItem } from './types';
import { md } from './md';

const AUTO_IGNORE_MS = 20_000;

export default function SuggestionApp() {
  const [item, setItem] = useState<SuggestionItem | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const handledRef = useRef(false);

  useEffect(() => window.orb.onSuggestion(next => {
    handledRef.current = false;
    setItem(next);
  }), []);

  useEffect(() => {
    if (!item) return;

    const resize = () => {
      const height = (cardRef.current?.scrollHeight || 144) + 16;
      window.orb.resizePopup(height);
    };
    const frame = requestAnimationFrame(resize);
    const observer = cardRef.current ? new ResizeObserver(resize) : null;
    if (cardRef.current) observer?.observe(cardRef.current);

    const timer = window.setTimeout(() => {
      if (!handledRef.current) {
        handledRef.current = true;
        window.orb.ignore(item);
      }
    }, AUTO_IGNORE_MS);

    return () => {
      cancelAnimationFrame(frame);
      observer?.disconnect();
      clearTimeout(timer);
    };
  }, [item]);

  const act = useCallback((action: 'add' | 'ignore') => {
    if (!item || handledRef.current) return;
    handledRef.current = true;
    if (action === 'add') window.orb.addTodo(item);
    else window.orb.ignore(item);
  }, [item]);

  const fromAgent = item?.trigger === 'agent-tool';

  return (
    <main className="suggestion-shell" aria-live="polite">
      <section className="suggestion-card" ref={cardRef}>
        <header className="suggestion-head">
          <span className="suggestion-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 18h6M10 22h4M12 2a7 7 0 0 0-4 12.7c.6.5 1 1.3 1 2.1h6c0-.8.4-1.6 1-2.1A7 7 0 0 0 12 2Z" />
            </svg>
          </span>
          <span className="suggestion-eyebrow">
            {fromAgent ? 'Agent 发现了这件事' : '发现一个可能的待办'}
          </span>
          {fromAgent && <span className="suggestion-source">Agent</span>}
        </header>

        <div className="suggestion-body">
          <h1>{item?.title || '正在读取建议…'}</h1>
          {item?.reason && (
            <div className="suggestion-reason" dangerouslySetInnerHTML={{ __html: md(item.reason) }} />
          )}
          {item?.context && (
            <div className="suggestion-context">
              <strong>屏幕原文</strong>
              <span>{item.context}</span>
            </div>
          )}
        </div>

        <footer className="suggestion-actions">
          <button className="secondary" type="button" disabled={!item} onClick={() => act('ignore')}>
            忽略
          </button>
          <button className="primary" type="button" disabled={!item} onClick={() => act('add')}>
            添加待办
          </button>
        </footer>
      </section>
    </main>
  );
}
