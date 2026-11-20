import { useState, useSyncExternalStore, type DragEvent } from "react";
import { UploadIcon } from "lucide-react";
import type { TraceSiftPanel } from "../tracesift-panel.ts";
import type { TraceSiftController } from "../tracesift-controller.ts";
import type { TraceSiftProfileType } from "@mobile-dev/shared/tracesift.ts";
import { TraceSiftCards } from "./tracesift-cards.tsx";

const options: { value: Extract<TraceSiftProfileType, "cpu" | "react">; title: string; detail: string; accepts: string; drop: string }[] = [
  { value: "cpu", title: "JavaScript CPU", detail: "查找慢函数与重型执行路径", accepts: ".json", drop: "选择 Chrome 性能剖析 .json 文件" },
  { value: "react", title: "React 组件", detail: "查找高开销提交、无效重渲染与级联更新", accepts: "React DevTools JSON", drop: "选择 React DevTools 性能剖析 .json 文件" },
];

// A dropped file arrives without a path and the local service reads from disk, so the pane asks the host for its own dialog.
function UploadPane({ controller, profileType, busy }: { controller: TraceSiftController; profileType: TraceSiftProfileType; busy: boolean }) {
  const [dragging, setDragging] = useState(false);
  const [dropNotice, setDropNotice] = useState("");
  const option = options.find(entry => entry.value === profileType) ?? options[0];

  const drop = (event: DragEvent<HTMLButtonElement>) => {
    event.preventDefault();
    setDragging(false);
    if (busy) return;
    const file = event.dataTransfer.files?.[0];
    if (!file) return;
    // Only some hosts expose a real path on the file; without one there is nothing to analyze.
    const path = (file as File & { path?: string }).path;
    if (typeof path === "string" && path !== "") { void controller.analyze(path, profileType); return; }
    setDropNotice(`${file.name} cannot be read from a drop here. Click to choose it from disk.`);
  };

  return <>
    <button
      type="button"
      className={`upload-pane${dragging && !busy ? " is-dragging" : ""}${busy ? " is-disabled" : ""}`}
      disabled={busy}
      onDragEnter={event => { event.preventDefault(); if (!busy) setDragging(true); }}
      onDragOver={event => event.preventDefault()}
      onDragLeave={() => setDragging(false)}
      onDrop={drop}
      onClick={() => { setDropNotice(""); void controller.pickAndAnalyze(profileType); }}
    >
      <span className="upload-icon"><UploadIcon /></span>
      <span className="upload-title">{option.title} profile</span>
      <span className="upload-detail">{option.drop}</span>
      <span className="browse-button">浏览文件</span>
    </button>
    {dropNotice && <p className="tracesift-notice" role="status">{dropNotice}</p>}
  </>;
}

function TraceSiftUpload({ controller, available }: { controller: TraceSiftController; available: boolean }) {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const [profileType, setProfileType] = useState<TraceSiftProfileType>("cpu");
  const analyzing = state.analyzing;

  return <main className="tracesift-upload">
    <div className="results-header">
      <div className="intro">
        <span className="eyebrow">TraceSift</span>
        <h1 className="results-title">分析性能分析文件</h1>
        <p>分析文件由本地 TraceSift 服务读取，不会离开这台机器。</p>
      </div>
    </div>

    {!available && <p className="tracesift-error" role="status">此宿主无法调用插件的 TraceSift 工具。</p>}

    <div className="profile-row">
      <div className="workflow-label"><span>1</span><strong>选择分析文件类型</strong></div>
      <div className="profile-options" role="radiogroup" aria-label="性能分析类型">
        {options.map(option => <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={profileType === option.value}
          disabled={Boolean(analyzing)}
          title={option.detail}
          className={`profile-chip${profileType === option.value ? " selected" : ""}`}
          onClick={() => setProfileType(option.value)}
        >
          {option.title}<em>{option.accepts}</em>
        </button>)}
      </div>
    </div>
    <p className="profile-detail">{options.find(option => option.value === profileType)?.detail}</p>

    <div className="workflow-label"><span>2</span><strong>添加你的分析文件</strong><small>本地处理，绝不上传。</small></div>
    {analyzing
      ? <p className="upload-analyzing" role="status">Analyzing {analyzing.name} with TraceSift…</p>
      : <UploadPane controller={controller} profileType={profileType} busy={!available} />}

    {state.error && <p className="tracesift-error" role="alert">{state.error}</p>}
  </main>;
}

export function TraceSiftView({ panel }: { panel: TraceSiftPanel }) {
  const { controller } = panel;
  const { available } = useSyncExternalStore(panel.subscribe, panel.getSnapshot);
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  if (state.analysis || state.explorer) return <TraceSiftCards controller={controller} onReset={controller.reset} />;
  return <TraceSiftUpload controller={controller} available={available} />;
}
