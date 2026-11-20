import { useMemo } from "react";
import { GaugeIcon } from "lucide-react";
import type { CpuPhase } from "@mobile-dev/shared/cpu.ts";
import type { DisplayFpsSample } from "@mobile-dev/shared/display-fps.ts";
import type { ZoomState } from "../../performance/types";
import { TRACK_HEIGHT } from "../../performance/constants";
import { PerformanceAreaChart } from "./PerformanceAreaChart";
import { TrackLabel } from "./TrackLabel";
import { CursorIndicator } from "./CursorIndicator";
import { createFpsSeries } from "./fpsSeries";

const colors = { stroke: "#22c55e", fillStart: "#22c55e", fillEnd: "#166534" };
type Props = {
  samples: DisplayFpsSample[]; phase: CpuPhase; error: string; supported: boolean; platform: "ios" | "android";
  zoomState: ZoomState; onZoomChange: (state: ZoomState) => void; onZoomOut: () => void; onRetry: () => void;
};
function format(value: number | null) { return value === null ? "—" : value.toFixed(1); }

export function DisplayFpsTrack({ samples, phase, error, supported, platform, zoomState, onZoomChange, onZoomOut, onRetry }: Props) {
  const series = useMemo(() => createFpsSeries(samples), [samples]);
  const current = format(phase === "failed" ? null : series.current);
  const average = format(series.average);
  const maximum = format(series.maximum);
  const minimum = format(series.minimum);
  const metrics = [
    { label: "Current", value: current },
    { label: "Avg / Max", value: `${average} / ${maximum}` },
    { label: "Min", value: minimum },
  ];
  let message = "开始监控以测量显示更新。";
  if (supported === false) message = "显示帧率需要已配对的 iOS 真机。";
  else if (phase === "connecting") message = "正在连接显示计数器…";
  else if (phase === "recording") message = "正在等待完整的 FPS 间隔…";
  if (error) message = error;
  const showMessage = series.current === null || phase === "failed";
  const source = platform === "android" ? "FrameTimeline actual display frames; delayed frames update their original interval." : "Core Animation 显示计数器。需 iOS 17.4+ 的实体配对设备。";
  const title = `${source} Includes all apps and system UI. Quiet screens can report zero. FPS measures updates, not refresh rate; it cannot identify the cause of a drop.`;
  return <div role="region" aria-label="显示 FPS" className="group flex flex-row" style={{ height: TRACK_HEIGHT }}>
    <TrackLabel label="显示 FPS" icon={<GaugeIcon className="size-4 text-green-500" />} metrics={metrics} title={title} />
    <div className="relative h-full min-w-0 flex-1 border-b border-border">
      <PerformanceAreaChart data={series.data} zoomState={zoomState} onZoomChange={onZoomChange} onZoomOut={onZoomOut}
        chartColors={colors} gradientId="displayFpsGradient" tooltipPostfix="FPS" curveType="linear" />
      {showMessage && <div role={error ? "alert" : "status"} className="absolute inset-0 flex items-center justify-center gap-2 bg-background/90 px-4 text-xs text-muted-foreground">
        <span>{message}</span>{phase === "failed" && <button className="shrink-0 text-green-500" onClick={onRetry}>重试 FPS</button>}
      </div>}
      <CursorIndicator />
    </div>
  </div>;
}
