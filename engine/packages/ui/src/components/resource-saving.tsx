import { useId, useSyncExternalStore } from "react";
import { LeafIcon, RotateCwIcon } from "lucide-react";
import type { ResourceSavingStore } from "../resource-saving";
import { Button } from "./ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import { Switch } from "./ui/switch";

export function ResourceSaving({ store }: { store: ResourceSavingStore }) {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const id = useId();
  if (state.visible === false) return null;
  const disabled = state.disabled || state.loading || state.busy || state.value === undefined;
  const enabled = state.value?.enabled ?? true;
  return <Popover onOpenChange={open => { if (open) void store.load(); }}>
    <PopoverTrigger asChild><Button variant="ghost" size="icon" disabled={state.disabled || state.busy} aria-label="资源节省" title={enabled ? "资源节省开启" : "资源节省关闭"} className={enabled ? "text-emerald-600 dark:text-emerald-400" : "text-muted-foreground"}><LeafIcon /></Button></PopoverTrigger>
    <PopoverContent side="top" align="end" className="w-72 space-y-3 p-4 text-sm" aria-label="资源节省">
      <div className="flex items-center justify-between gap-3"><label htmlFor={id} className="font-medium">保存资源</label><Switch id={id} checked={enabled} disabled={disabled} onCheckedChange={value => void store.change(value)} /></div>
      <p className="text-xs text-muted-foreground">减少后台服务和内存占用。按设备保存，默认启用。</p>
      <p className="text-xs text-muted-foreground">{state.value?.restartRequired ? "重启此设备以应用已保存的设置。运行中的应用将关闭。" : state.value?.running ? "已保存的设置已在此设备启动时生效。" : "此设备下次启动时生效。"}</p>
      {state.value?.restartRequired && <Button variant="outline" size="sm" disabled={disabled} onClick={() => void store.restartDevice()}><RotateCwIcon />重启后生效</Button>}
      {state.busy && <p className="text-xs text-muted-foreground" role="status">Applying…</p>}
      {state.error && <p className="text-xs text-destructive" role="alert">{state.error}</p>}
    </PopoverContent>
  </Popover>;
}
