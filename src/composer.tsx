import { UPLOAD_ACCEPT, UPLOAD_HINT } from "./read-user-file.ts";
import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { listProviders } from "./provider-api.ts";
import type { PublicProvider } from "./provider-api.ts";
import type { PendingFile } from "./read-user-file.ts";
import { ModelMenu } from "./model-menu.tsx";
import { VendorMark } from "./vendor-mark.tsx";
import { Glyph } from "./glyph.tsx";
import { createHistory, recordEdit, redoEdit, undoEdit, type EditHistory } from "./edit-history.ts";
import { sizeLabel } from "./page-count.ts";

export function Composer({
  value,
  placeholder,
  busy,
  onChange,
  onSubmit,
  onPickFile,
  appearance = "default",
  attachments = [],
  onRemoveAttachment,
  onStop,
  onOpenKnowledge,
}: {
  value: string;
  placeholder: string;
  busy: boolean;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onPickFile: (file: File) => void;
  appearance?: "default" | "harness";
  attachments?: PendingFile[];
  onRemoveAttachment?: (id: string) => void;
  onStop?: () => void;
  onOpenKnowledge?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [providers, setProviders] = useState<PublicProvider[]>([]);
  const [dropping, setDropping] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const pickerRef = useRef<HTMLDivElement>(null);
  const historyRef = useRef<EditHistory>(createHistory(value));
  const composingRef = useRef(false);
  const models = providers.filter((item) => item.role === "model");
  const active = models.find((item) => item.active) ?? models[0];
  const canSend = Boolean(value.trim()) || attachments.length > 0;

  const reload = () => {
    void listProviders().then(setProviders).catch(() => setProviders([]));
  };

  useEffect(() => {
    const timer = window.setTimeout(reload, 0);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    const area = areaRef.current;
    if (!area) return;
    area.style.height = "auto";
    area.style.height = `${Math.min(Math.max(area.scrollHeight, appearance === "harness" ? 72 : 58), 220)}px`;
  }, [value, appearance]);

  // Every value the composer shows becomes an undo step, including programmatic ones (send clears the
  // box, hints fill it), so Ctrl+Z can bring back a question that was deleted or sent by mistake.
  // IME composition (pinyin in progress) is skipped and recorded once the word is committed.
  useEffect(() => {
    if (composingRef.current) return;
    historyRef.current = recordEdit(historyRef.current, value, Date.now());
  }, [value]);

  // The model menu is a popover: a click anywhere outside it, or Esc, closes it.
  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (!pickerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const applyHistory = (step: typeof undoEdit) => {
    const result = step(historyRef.current);
    if (!result) return;
    historyRef.current = result.history;
    onChange(result.value);
    window.requestAnimationFrame(() => {
      const area = areaRef.current;
      if (!area) return;
      area.focus();
      const end = result.value.length;
      area.setSelectionRange(end, end);
    });
  };

  const toggleMenu = () => {
    const next = !open;
    if (next) reload();
    setOpen(next);
  };

  const takeFiles = (list: FileList | File[]) => {
    Array.from(list).forEach((file) => onPickFile(file));
  };

  return (
    <div
      className={dropping ? "composer-box dropping" : "composer-box"}
      ref={boxRef}
      onDragEnter={(event) => {
        event.preventDefault();
        setDropping(true);
      }}
      onDragOver={(event) => {
        event.preventDefault();
        setDropping(true);
      }}
      onDragLeave={(event) => {
        if (!boxRef.current?.contains(event.relatedTarget as Node)) setDropping(false);
      }}
      onDrop={(event) => {
        event.preventDefault();
        setDropping(false);
        takeFiles(event.dataTransfer.files);
      }}
    >
      {attachments.length > 0 ? (
        <ul className="attach-chips">
          {attachments.map((item) => (
            <li key={item.id}>
              <Glyph name="file" />
              <span>
                <b>{item.name}</b>
                <small>{sizeLabel(item)}</small>
              </span>
              {onRemoveAttachment ? (
                <button type="button" aria-label={`移除 ${item.name}`} onClick={() => onRemoveAttachment(item.id)}>
                  <Glyph name="close" />
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      <textarea
        ref={areaRef}
        value={value}
        placeholder={placeholder}
        rows={3}
        aria-label="给专利技能的消息"
        onChange={(event) => onChange(event.target.value)}
        onCompositionStart={() => {
          composingRef.current = true;
        }}
        onCompositionEnd={(event) => {
          composingRef.current = false;
          historyRef.current = recordEdit(historyRef.current, event.currentTarget.value, Date.now());
        }}
        onKeyDown={(event) => {
          // Enter that confirms an IME candidate must not send the message.
          if (event.nativeEvent.isComposing || composingRef.current) return;
          const mod = event.ctrlKey || event.metaKey;
          if (mod && !event.altKey) {
            const key = event.key.toLowerCase();
            if (key === "z" && !event.shiftKey) {
              event.preventDefault();
              applyHistory(undoEdit);
              return;
            }
            if ((key === "z" && event.shiftKey) || key === "y") {
              event.preventDefault();
              applyHistory(redoEdit);
              return;
            }
          }
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            if (!busy && canSend) onSubmit();
          }
        }}
      />
      {dropping ? <div className="drop-hint">放开即可添加资料（PDF、Word、PPT、Excel、图片等）</div> : null}
      <div className="composer-tools">
        <label className="icon-btn" title={`上传资料：${UPLOAD_HINT}`}>
          <input
            type="file"
            multiple
            aria-label="上传资料（PDF、Word、PPT、图片等）"
            accept={UPLOAD_ACCEPT}
            onChange={(event) => {
              if (event.target.files) takeFiles(event.target.files);
              event.target.value = "";
            }}
          />
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.75"><path d="M12 5v14M5 12h14" /></svg>
        </label>
        {onOpenKnowledge ? (
          <button className="icon-btn" type="button" title="从知识库载入" onClick={onOpenKnowledge} aria-label="从知识库载入">
            <Glyph name="book" />
          </button>
        ) : null}
        <div className="model-picker" ref={pickerRef}>
          <button className="model-pill" type="button" aria-haspopup="dialog" aria-expanded={open} title="切换模型（点外面或按 Esc 关闭）" onClick={toggleMenu}>
            <VendorMark icon={active?.icon} name={active?.name} model={active?.model} website={active?.website} color={active?.iconColor} size={16} />
            {appearance === "harness" ? (active?.model || active?.name || "选择模型") : active ? active.name : "选择模型"}
            {appearance === "harness" ? <Glyph name="chevron" /> : <small>{active?.model || active?.protocol || ""}</small>}
          </button>
          <AnimatePresence>
          {open ? (
            <motion.div
              className="model-menu"
              initial={{ opacity: 0, y: 8, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 6, scale: 0.98 }}
              transition={{ type: "spring", stiffness: 460, damping: 32 }}
            >
              <ModelMenu providers={providers} onChanged={() => { reload(); setOpen(false); }} />
            </motion.div>
          ) : null}
          </AnimatePresence>
        </div>
        {busy && onStop ? (
          <motion.button className="send-btn stop-btn" type="button" onClick={onStop} aria-label="停止" whileTap={{ scale: 0.9 }}>
            <Glyph name="stop" />
          </motion.button>
        ) : (
          <motion.button className="send-btn" type="button" disabled={!canSend} onClick={onSubmit} aria-label="发送" whileTap={canSend ? { scale: 0.9 } : undefined}>
            {appearance === "harness" ? <Glyph name="arrow" /> : "发送"}
          </motion.button>
        )}
      </div>
    </div>
  );
}