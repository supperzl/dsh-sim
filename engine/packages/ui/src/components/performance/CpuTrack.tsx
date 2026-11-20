import React, { useCallback, useMemo, useState } from 'react';
import { LegendList } from '@legendapp/list/react';
import { CpuIcon } from 'lucide-react';
import type { ThreadHistory, ThreadOrder, ZoomState } from '../../performance/types';
import { PerformanceAreaChart } from './PerformanceAreaChart';
import { TrackLabel } from './TrackLabel';
import { ThreadRow } from './ThreadRow';
import { SIDEBAR_WIDTH, TRACK_HEIGHT } from '../../performance/constants';
import { CursorIndicator } from './CursorIndicator';
import type { CpuPhase, CpuSample } from '@mobile-dev/shared/cpu.ts';
import { createCpuSeries, formatCpu, orderCpuThreads, type CpuThreadSeries } from './cpuSeries';
import { NativeSelect, NativeSelectOption } from '../ui/native-select';

type CpuTrackProps = {
  samples: CpuSample[];
  threadHistory: ReadonlyMap<string, ThreadHistory>;
  threadOrder: ThreadOrder;
  onThreadOrderChange: (order: ThreadOrder) => void;
  platform: 'ios' | 'android';
  phase: CpuPhase;
  error: string | null;
  scrollElement: HTMLDivElement | null;
  zoomState: ZoomState;
  onZoomChange: (state: ZoomState) => void;
  onZoomOut: () => void;
};

export const CpuTrack: React.FC<CpuTrackProps> = ({
  samples,
  threadHistory,
  threadOrder,
  onThreadOrderChange,
  platform,
  phase,
  error,
  scrollElement,
  zoomState,
  onZoomChange,
  onZoomOut
}) => {
  const [isExpanded, setIsExpanded] = useState(false);
  const series = useMemo(() => {
    const result = createCpuSeries(samples);
    return result;
  }, [samples]);
  const threads = useMemo(() => {
    const sorted = orderCpuThreads(series.threads, threadHistory, threadOrder);
    return sorted;
  }, [series.threads, threadHistory, threadOrder]);
  const renderThread = useCallback(({ item: thread }: { item: CpuThreadSeries }) => {
    const history = threadHistory.get(thread.id);
    if (history === undefined) throw new Error(`Missing display history for CPU thread ${thread.id}.`);
    return <ThreadRow threadName={thread.name} threadId={thread.id} threadNumber={history.number}
      platform={platform} data={thread.data} running={thread.running} zoomState={zoomState}
      onZoomChange={onZoomChange} onZoomOut={onZoomOut} height={THREAD_HEIGHT} />;
  }, [threadHistory, platform, zoomState, onZoomChange, onZoomOut]);
  const current = formatCpu(series.current);
  const average = formatCpu(series.average);
  const maximum = formatCpu(series.maximum);
  const metrics = [
    { label: 'Current', value: current },
    { label: 'Avg / Max', value: `${average} / ${maximum}` },
    { label: 'Threads', value: String(series.threadCount) },
  ];
  let message = '在所选设备上打开应用以测量 CPU。100% = 单核。';
  if (phase === 'connecting') message = 'Connecting to the app’s CPU counters…';
  else if (phase === 'recording' && series.current === null) message = 'Measuring CPU usage…';
  if (error) message = error;
  const showMessage = samples.length < 2 || phase === 'failed';

  return (
    <>
      <div
        className="group flex flex-row"
        style={{ height: `${TRACK_HEIGHT}px` }}
      >
        <TrackLabel
          label="CPU"
          icon={<CpuIcon className="w-4 h-4 text-blue-500" />}
          metrics={metrics}
          title="CPU 使用率：100% 表示一个核心被完全占用。展开可查看各线程。"
          isExpanded={isExpanded}
          onToggle={() => setIsExpanded(value => value === false)}
        />
        <div className="min-w-0 flex-1 h-full relative border-b border-border">
          <PerformanceAreaChart
            data={series.process}
            zoomState={zoomState}
            onZoomChange={onZoomChange}
            onZoomOut={onZoomOut}
            tooltipPostfix="%"
          />
          {showMessage && (
            <div role={error ? 'alert' : 'status'} className="absolute inset-0 flex items-center justify-center px-4 text-xs text-muted-foreground bg-background/90">
              {message}
            </div>
          )}

          <CursorIndicator />
        </div>
      </div>
      {isExpanded && <div className="flex border-b border-border bg-muted/30">
        <div className="sticky left-0 z-[60] flex shrink-0 items-center gap-2 border-r border-border bg-background p-2" style={{ width: SIDEBAR_WIDTH }}>
          <label htmlFor="cpu-thread-order" className="text-[10px] text-muted-foreground">Sort</label>
          <NativeSelect id="cpu-thread-order" aria-label="线程顺序" size="sm" value={threadOrder}
            title="Activity: highest current CPU first; previously active threads stay above those with no recorded activity. First seen: stable recording order."
            className="min-w-0 flex-1 [&_select]:text-[11px]" onChange={event => {
              const order = event.target.value;
              if (order === 'activity' || order === 'first-seen') onThreadOrderChange(order);
            }}>
            <NativeSelectOption value="activity">Activity</NativeSelectOption>
            <NativeSelectOption value="first-seen">首次出现</NativeSelectOption>
          </NativeSelect>
        </div>
      </div>}
      {isExpanded && <LegendList data={threads} scrollElement={scrollElement} renderItem={renderThread} extraData={zoomState}
        keyExtractor={threadKey} getFixedItemSize={threadHeight} estimatedItemSize={THREAD_HEIGHT}
        drawDistance={THREAD_HEIGHT} maintainVisibleContentPosition={false} aria-label="CPU 线程" />}
    </>
  );
};

const THREAD_HEIGHT = TRACK_HEIGHT * 0.7;
const threadKey = (thread: CpuThreadSeries) => thread.id;
const threadHeight = () => THREAD_HEIGHT;
