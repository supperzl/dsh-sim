import { useSyncExternalStore } from "react";
import { ChartNoAxesCombinedIcon, CheckIcon, CopyIcon, MessageCircleIcon, UploadIcon } from "lucide-react";
import type { TraceSiftController } from "../tracesift-controller.ts";
import { findingName, formatMs, formatReactMs } from "@mobile-dev/shared/tracesift-labels.ts";
import type { TraceSiftAnalysis, TraceSiftCpuAnalysis } from "@mobile-dev/shared/tracesift.ts";
import { Button } from "./ui/button.tsx";
import { InfoPopover } from "./card-parts.tsx";
import { ReactFinding } from "./tracesift/react-contribution.tsx";
import { TaskFinding } from "./tracesift/task-contribution.tsx";
import { TraceSiftExplorer } from "./tracesift-explorer.tsx";

function cpuSummaryLine(analysis: TraceSiftCpuAnalysis): string {
  const { summary } = analysis;
  const count = analysis.cards.length;
  const tasks = count === 1 ? "task" : "tasks";
  if (summary.noLongTasks) {
    return `No long tasks; the busiest work was ${count} ${tasks} of ${formatMs(analysis.cards[0]?.durationMs ?? 0)} and under · ${formatMs(summary.totalMs)} total`;
  }
  // `taskCount` is absent from older TraceSift versions; the clause then drops out.
  const of = summary.taskCount === undefined ? "" : ` of ${summary.taskCount}`;
  return `${count} long ${tasks}${of} · ${formatMs(summary.totalMs)} total`;
}

function Reading({ analysis, controller, onReset }: { analysis: TraceSiftAnalysis; controller: TraceSiftController; onReset?: () => void }) {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const cpu = analysis.profileType === "cpu";
  const noun = cpu ? "task" : "commit";
  const format = cpu ? formatMs : formatReactMs;
  const cards = analysis.cards;
  const index = Math.max(0, cards.findIndex(entry => entry.id === state.selectedCard));
  const card = cards[index];
  const choose = (next: number) => controller.selectCard(cards[next].id);
  const summary = cpu
    ? cpuSummaryLine(analysis)
    : `${cards.length} slowest of ${analysis.summary.commitCount} commits · ${formatMs(analysis.summary.totalCommitRenderDurationMs)} rendering`;
  // Nothing records the profile's full length, so the timeline ends at the last finding (CPU: at least the measured total).
  let extent = cpu ? analysis.summary.totalMs : 0;
  for (const entry of cards) extent = Math.max(extent, entry.startMs + entry.durationMs);
  const position = (time: number) => extent > 0 ? Math.max(0, Math.min(100, time / extent * 100)) : 0;
  const overhead = cpu && analysis.summary.profilerOverheadMs ? ` ${formatMs(analysis.summary.profilerOverheadMs)} spent starting the profiler is not shown.` : "";
  const busy = Boolean(state.busyCard) || Boolean(state.handoffCard) || Boolean(state.openingExploreCard);
  const copied = card !== undefined && state.copiedCard === card.id;

  return <article className="recording-card tracesift-results" aria-label="TraceSift 发现">
    <header className="recording-header">
      <div className="recording-heading"><h2>{analysis.title}</h2><p>TraceSift · {summary}</p></div>
      <span className="recording-status">{cpu ? "CPU 性能剖析" : "React 性能分析"}</span>
      {onReset && <Button size="sm" variant="outline" onClick={onReset}><UploadIcon />新建性能分析</Button>}
    </header>
    <div className="recording-body">
      <div className="recording-charts tracesift-column">
        {card === undefined
          ? <p role="status">TraceSift 未发现可呈现为卡片的性能问题。</p>
          : analysis.profileType === "cpu"
            ? <TaskFinding key={card.id} card={analysis.cards[index]} rank={index + 1} kind={state.chartKind} onKind={controller.setChartKind} onFocus={nodeId => void controller.openExplore(card.id, nodeId)} />
            : <ReactFinding key={card.id} card={analysis.cards[index]} rank={index + 1} kind={state.chartKind} onKind={controller.setChartKind} onExplore={() => void controller.openExplore(card.id)} />}
      </div>
      <aside className="recording-sidebar" aria-label="发现与操作">
        {cards.length > 0 && <section className="recording-overview" aria-label="性能分析时间线">
          <div className="recording-section-heading"><h3>Profile</h3>
            <InfoPopover label="profile timeline">{cpu ? "每个标记是一个长任务，放置在其于性能分析中运行的位置。" : "每个标记是一次慢提交，放置在其于录制中发生的位置。"} Click one to open it.{overhead}</InfoPopover>
          </div>
          <div className="recording-overview-bar">
            {cards.map((entry, at) => <button key={entry.id} type="button" className="tracesift-mark" aria-current={at === index}
              aria-label={`${noun} ${at + 1}, ${format(entry.durationMs)} at ${formatMs(entry.startMs)}`}
              style={{ left: `${position(entry.startMs)}%`, width: `${position(entry.startMs + entry.durationMs) - position(entry.startMs)}%` }}
              onClick={() => choose(at)} />)}
          </div>
          <div className="recording-overview-labels"><span>0 s</span><span>{formatMs(extent)}</span></div>
        </section>}
        {cards.length > 0 && <section className="tracesift-list" aria-label={cpu ? "长任务" : "慢提交"}>
          <div className="recording-section-heading"><h3>{cpu ? "长任务" : "慢提交"}</h3>
            <InfoPopover label={cpu ? "long tasks" : "slow commits"}>{cpu ? "占用 JavaScript 线程时间最长的任务，最长的排在前面。" : "渲染耗时最长的提交，最慢的排在前面。圆点标记超出帧预算的提交。"}</InfoPopover>
          </div>
          {cards.map((entry, at) => <button key={entry.id} type="button" className="tracesift-list-row" aria-current={at === index} title={entry.pathline ?? entry.headline} onClick={() => choose(at)}>
            <span className="tracesift-list-rank">{at + 1}</span>
            <span className="tracesift-list-name">{findingName(entry)}</span>
            {"severity" in entry && (entry.severity === "high" || entry.severity === "medium") && <span className="tracesift-severity-dot" data-severity={entry.severity} title={entry.severity === "high" ? "Slow" : "超出预算"} />}
            <span className="tracesift-list-ms">{format(entry.durationMs)}</span>
          </button>)}
        </section>}
        {/* Every action reads from the server; hosts that do not let cards call it get the findings only. */}
        {card !== undefined && !state.canCallTools && <p className="recording-footnote" role="status">
          This app shows TraceSift's findings, but does not let the card investigate or explore them. Ask the agent to investigate one, for example “investigate {noun} #{index + 1}”.
        </p>}
        {card !== undefined && state.canCallTools && <div className="recording-actions">
          <Button disabled={!state.canInvestigate || busy} onClick={() => void controller.investigate(card.id)}
            title={state.canInvestigate ? `Hand this ${noun} to the chat to investigate` : "此聊天无法接收来自卡片的消息"}>
            <MessageCircleIcon />{state.busyCard === card.id ? "Starting…" : `Investigate ${noun} ${index + 1}`}
          </Button>
          <Button variant="outline" disabled={busy} onClick={() => void controller.openExplore(card.id)}>
            <ChartNoAxesCombinedIcon />{state.openingExploreCard === card.id ? "Opening…" : "Explore"}
          </Button>
          <Button variant="outline" disabled={busy} onClick={() => void controller.copyHandoff(card.id)}>
            {copied ? <CheckIcon /> : <CopyIcon />}{state.handoffCard === card.id ? "Copying…" : copied ? "Copied" : "复制交接信息"}
          </Button>
          {!state.canInvestigate && <p role="status">此宿主无法从这里向聊天发送消息。请改为让智能体按名称调查某个发现项。</p>}
        </div>}
        {state.error && <p className="recording-error" role="alert">{state.error}</p>}
        {state.notice && <p className="recording-footnote" role="status">{state.notice}</p>}
      </aside>
    </div>
  </article>;
}

export function TraceSiftCards({ controller, onReset }: { controller: TraceSiftController; onReset?: () => void }) {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);

  // The explorer replaces the card, which also unmounts the chart while the large payload is on screen.
  if (state.explorer) return <TraceSiftExplorer controller={controller} />;

  if (!state.analysis) return <article className="recording-card tracesift-results tracesift-pending">
    <p role="status">正在用 TraceSift 分析性能剖析数据…</p>
    {state.error && <p className="recording-error" role="alert">{state.error}</p>}
  </article>;

  return <Reading analysis={state.analysis} controller={controller} onReset={onReset} />;
}
