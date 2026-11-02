import { useEffect, useState } from "react";
import { readPdf } from "./read-pdf.ts";
import { runPatentTurn } from "./skill-run.ts";
import { useStore } from "./store.tsx";
import { Composer } from "./composer.tsx";

export function Workbench() {
  const { state, dispatch, setView } = useStore();
  const [text, setText] = useState("");
  const [fileName, setFileName] = useState("粘贴材料.md");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [armed, setArmed] = useState("");

  useEffect(() => {
    if (!armed) return;
    const created = state.cases.find((item) => item.id === armed);
    if (!created) return;
    setArmed("");
    setView("case");
    void runPatentTurn({
      caseId: created.id,
      material: created.materialText,
      fileName: created.materialName,
      userText: "请按中国专利交底技能处理这份材料。",
      recordUser: false,
      dispatch,
    }).finally(() => setBusy(false));
  }, [armed, dispatch, setView, state.cases]);

  const submit = () => {
    if (text.trim().length < 8) {
      setError("请贴入技术材料，或上传 PDF。");
      return;
    }
    const id = `case-${Date.now().toString(36)}`;
    setError("");
    setBusy(true);
    dispatch({ type: "create-case", id, title: "", text, fileName, skill: true });
    setText("");
    setArmed(id);
  };

  const onPickFile = async (file: File) => {
    try {
      if (/\.pdf$/i.test(file.name) || file.type === "application/pdf") {
        const extracted = await readPdf(await file.arrayBuffer());
        if (extracted.trim().length < 8) {
          setError("这份 PDF 没有提取出文字。扫描件需要单独的文字识别，这里不会假装已经读完。");
          return;
        }
        setText(extracted);
        setFileName(file.name);
        setError("");
        return;
      }
      if (!/\.(txt|md|markdown)$/i.test(file.name)) {
        setError("目前读取 PDF、txt 和 md。Word 仍需要先另存为文本。");
        return;
      }
      setText(await file.text());
      setFileName(file.name);
      setError("");
    } catch {
      setError("文件没有读出来。");
    }
  };

  return (
    <div className="chat-frame">
      <div className="chat-scroll">
        <div className="chat-home-copy">
          <p className="kicker">中国专利交底技能</p>
          <h1>把材料交给当前模型</h1>
          <p className="lede">对话记录在上方展开，输入框固定在窗口底部。材料里对不上的句子会标成推断。</p>
        </div>
        {error ? <p className="form-error dock-note">{error}</p> : null}
        <p className="fine dock-note">当前文件：{fileName}</p>
      </div>
      <div className="composer-dock">
        <Composer value={text} placeholder="描述技术方案，或上传 PDF" busy={busy} onChange={setText} onSubmit={submit} onPickFile={(file) => void onPickFile(file)} />
      </div>
    </div>
  );
}
