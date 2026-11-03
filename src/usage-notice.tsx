import { useEffect, useRef } from 'react';
import { NOTICE_SECTIONS, NOTICE_SUMMARY, NOTICE_TITLE, NOTICE_VERSION } from './site-info.ts';

/** Informational re-reading dialog; admission acknowledgement is enforced by the Worker. */
export function UsageNotice({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);
  return <dialog ref={ref} className="usage-notice" aria-labelledby="usage-notice-title" onCancel={event => { event.preventDefault(); onClose(); }}>
    <header><div><span className="notice-eyebrow">使用前请知悉</span><h2 id="usage-notice-title">{NOTICE_TITLE}</h2></div><button type="button" aria-label="关闭使用公告" onClick={onClose}>×</button></header>
    <p className="notice-summary">{NOTICE_SUMMARY}</p>
    <div className="notice-sections">{NOTICE_SECTIONS.map(section => <section key={section.title}><h3>{section.title}</h3><p>{section.text}</p></section>)}</div>
    <footer><small>公告版本：{NOTICE_VERSION}</small><button className="btn primary" type="button" onClick={onClose}>我已了解，返回工作台</button></footer>
  </dialog>;
}
