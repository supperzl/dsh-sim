import { useEffect, useId, useState, useSyncExternalStore } from "react";
import { AppWindowIcon, MapPinIcon, MinusIcon, MoonIcon, PlusIcon, RotateCwIcon, Settings2Icon, SmartphoneIcon, SunIcon } from "lucide-react";
import { contentSizes, networkConditions, networkPresets, type NetworkCondition } from "@mobile-dev/shared/device-settings.ts";
import { bindDeviceSettings, DeviceSettingsStore } from "../device-settings";
import { AppToolsStore, bindAppTools } from "../app-tools";
import { AppTools } from "./app-tools";
import { AnimatedHeight } from "./animated-height";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "./ui/base-select";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import { Switch } from "./ui/switch";
import { bindResourceSaving, ResourceSavingStore } from "../resource-saving";
import { ResourceSaving } from "./resource-saving";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/base-tabs";
import { ToggleGroup, ToggleGroupItem } from "./ui/toggle-group";

type Option = { value: string; label: string; short?: string };

const textSizeLabels = ["特小", "Small", "Medium", "Large", "特大", "2× large", "3× large", "辅助功能中", "辅助功能大", "辅助功能特大", "Accessibility 2× large", "Accessibility 3× large"];
const contentSizeOptions = contentSizes.map((value, index) => ({ value, label: textSizeLabels[index], short: textSizeLabels[index].replace("Accessibility", "AX") }));
const fontScaleOptions = (current: number) => [...new Set([0.7, 0.85, 1, 1.15, 1.3, 1.5, 1.75, 2, current])].sort((a, b) => a - b)
  .map(value => ({ value: String(value), label: `${Math.round(value * 100)}%${value === 1 ? " (Default)" : ""}`, short: `${Math.round(value * 100)}%` }));
const locationPresets = [
{ value: "beijing", city: "北京", label: "北京", latitude: 39.9042, longitude: 116.4074 },
  { value: "shanghai", city: "上海", label: "上海", latitude: 31.2304, longitude: 121.4737 },
  { value: "guangzhou", city: "广州", label: "广州", latitude: 23.1291, longitude: 113.2644 },
  { value: "shenzhen", city: "深圳", label: "深圳", latitude: 22.5431, longitude: 114.0579 },
  { value: "hangzhou", city: "杭州", label: "杭州", latitude: 30.2741, longitude: 120.1551 },
  { value: "chengdu", city: "成都", label: "成都", latitude: 30.5728, longitude: 104.0668 },
  { value: "wuhan", city: "武汉", label: "武汉", latitude: 30.5928, longitude: 114.3055 },
  { value: "xian", city: "西安", label: "西安", latitude: 34.3416, longitude: 108.9398 },
];
type Location = { latitude: number; longitude: number };
const presetFor = (location: Location) => locationPresets.find(entry => entry.latitude === location.latitude && entry.longitude === location.longitude);
const networkLabels: Record<NetworkCondition, string> = { normal: "正常", lte: "LTE", "3g": "3G", edge: "Edge", offline: "Offline" };
const rotationOptions = [{ value: "auto", label: "Auto" }, { value: "portrait", label: "Portrait" }, { value: "landscape", label: "Landscape" }];
// One right-hand column, so every control lines up.
const control = "w-38";

function SettingsSelect({ id, value, items, disabled, onChange }: { id: string; value: string; items: Option[]; disabled: boolean; onChange: (value: string) => void }) {
  return <Select items={items} value={value} disabled={disabled} onValueChange={next => { if (next !== null) onChange(next); }}>
    <SelectTrigger id={id} className={`${control} min-w-0`}><SelectValue /></SelectTrigger>
    <SelectContent align="start" alignItemWithTrigger={false} className="w-max min-w-(--anchor-width) max-w-(--available-width)"><SelectGroup>{items.map(item => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectGroup></SelectContent>
  </Select>;
}

// Steps through ordered options; the middle opens the full list to jump straight to a size.
function Stepper({ id, value, items, disabled, onChange }: { id: string; value: string; items: Option[]; disabled: boolean; onChange: (value: string) => void }) {
  const index = items.findIndex(item => item.value === value);
  const step = "h-full w-8 rounded-none text-muted-foreground hover:text-foreground focus-visible:z-10";
  return <div className={`${control} flex h-8 items-stretch rounded-lg border`}>
    <Button type="button" variant="ghost" size="icon-sm" className={`${step} rounded-l-lg`} aria-label="更小字体" disabled={disabled || index <= 0} onClick={() => onChange(items[index - 1].value)}><MinusIcon /></Button>
    <Select items={items} value={value} disabled={disabled} onValueChange={next => { if (next !== null) onChange(next); }}>
      <SelectTrigger id={id} title={items[index]?.label} className="min-w-0 flex-1 justify-center rounded-none border-0 border-x px-1 text-xs font-medium data-[size=default]:h-auto hover:bg-muted/50 focus-visible:z-10 [&>svg]:hidden">
        <span className="truncate">{items[index]?.short ?? items[index]?.label}</span>
      </SelectTrigger>
      <SelectContent align="center" alignItemWithTrigger={false} className="w-max min-w-(--anchor-width) max-w-(--available-width)"><SelectGroup>{items.map(item => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectGroup></SelectContent>
    </Select>
    <Button type="button" variant="ghost" size="icon-sm" className={`${step} rounded-r-lg`} aria-label="更大字体" disabled={disabled || index < 0 || index >= items.length - 1} onClick={() => onChange(items[index + 1].value)}><PlusIcon /></Button>
  </div>;
}

function Group({ label, children }: { label: string; children: React.ReactNode }) {
  return <section className="space-y-1 border-t pt-3 first:border-t-0 first:pt-0">
    <h3 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</h3>
    {children}
  </section>;
}

function Row({ label, htmlFor, id, children }: { label: string; htmlFor?: string; id?: string; children: React.ReactNode }) {
  return <div className="flex min-h-9 items-center justify-between gap-3">
    {htmlFor ? <label htmlFor={htmlFor}>{label}</label> : <span id={id}>{label}</span>}
    {children}
  </div>;
}

// The current state in two fixed lines, so changing a setting never moves the panel.
function StatusCard({ icon, name, detail, children }: { icon?: React.ReactNode; name: string; detail: string; children?: React.ReactNode }) {
  return <div className="flex items-center gap-2.5 rounded-lg border px-2.5 py-2">
    {icon}
    <div className="min-w-0 flex-1"><p className="truncate leading-5">{name}</p><p className="truncate text-xs leading-4 text-muted-foreground">{detail}</p></div>
    {children}
  </div>;
}

function Pills({ label, value, options, onSelect }: { label: string; value: string; options: readonly { value: string; label: string }[]; onSelect: (value: string) => void }) {
  return <ToggleGroup type="single" variant="outline" size="sm" spacing={1.5} aria-label={label} className="w-full flex-wrap" value={value} onValueChange={onSelect}>
    {options.map(option => <ToggleGroupItem key={option.value} value={option.value} className="h-6 rounded-full px-2.5 text-xs font-normal data-[state=on]:border-primary data-[state=on]:bg-primary data-[state=on]:text-primary-foreground">{option.label}</ToggleGroupItem>)}
  </ToggleGroup>;
}

const speed = (kbps: number) => kbps >= 1000 ? `${kbps / 1000} Mbps` : `${kbps} kbps`;

function describeNetwork(network: NetworkCondition | "custom", platform: "ios" | "android") {
  if (network === "custom") return platform === "ios" ? { name: "Custom throttle", detail: "Pick a condition to replace it." } : { name: "Your own proxy", detail: "Remove it to simulate a slower network." };
  const name = network === "normal" ? "全速" : network === "offline" ? "未连接" : `${speed(networkPresets[network].bandwidthKbps)} · ${networkPresets[network].latencyMs} ms`;
  // Baguette injects conditioning into apps as they launch; Android applies it right away.
  if (platform === "ios") return { name, detail: "Applies to new app launches." };
  return { name, detail: network === "normal" ? "Applies right away." : network === "offline" ? "Wi-Fi 和移动数据均已关闭。" : "本地开发服务器保持全速。" };
}

const networkOptions = networkConditions.map(condition => ({ value: condition, label: networkLabels[condition] }));

function NetworkGroup({ platform, network, store, appTools }: { platform: "ios" | "android"; network: NetworkCondition | "custom"; store: DeviceSettingsStore; appTools: AppToolsStore }) {
  const appState = useSyncExternalStore(appTools.subscribe, appTools.getSnapshot);
  const status = describeNetwork(network, platform);
  return <Group label="网络">
    <div className="space-y-3 pt-1">
      <Pills label="网络状况" value={network === "custom" ? "" : network} options={networkOptions} onSelect={value => {
        const condition = networkConditions.find(entry => entry === value);
        if (condition) void store.change({ setting: "network", value: condition });
      }} />
      <StatusCard name={status.name} detail={status.detail}>
        {/* iOS apps pick up a condition when they launch. */}
        {platform === "ios" && appTools.app && <Button type="button" variant="outline" size="xs" disabled={appState.busy !== null} onClick={() => void appTools.launch()}><RotateCwIcon />Relaunch</Button>}
      </StatusCard>
    </div>
  </Group>;
}

function describeLocation(location: Location | null | undefined, platform: "ios" | "android") {
  if (location === undefined) return { name: "未从此面板设置", detail: platform === "ios" ? "The simulator doesn't report its location." : "选择一个要模拟的地点。" };
  if (location === null) return { name: "未模拟位置", detail: "选择一个要模拟的地点。" };
  return { name: presetFor(location)?.label ?? "自定义位置", detail: `${location.latitude.toFixed(4)}, ${location.longitude.toFixed(4)}` };
}

const placeOptions = [...locationPresets.map(entry => ({ value: entry.value, label: entry.city })), { value: "custom", label: "Custom…" }];

// Keyed by device, so the coordinate form starts closed for each one.
function LocationGroup({ platform, location, store }: { platform: "ios" | "android"; location: Location | null | undefined; store: DeviceSettingsStore }) {
  const id = useId();
  const [customOpen, setCustomOpen] = useState(false);
  const [latitude, setLatitude] = useState("");
  const [longitude, setLongitude] = useState("");
  useEffect(() => {
    setLatitude(location ? String(location.latitude) : "");
    setLongitude(location ? String(location.longitude) : "");
  }, [location?.latitude, location?.longitude]);
  const place = describeLocation(location, platform);
  const preset = customOpen ? "custom" : location ? presetFor(location)?.value ?? "custom" : "";
  return <Group label="位置">
    <StatusCard icon={<MapPinIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />} name={place.name} detail={place.detail}>
      {/* Only the iOS simulator can drop a simulated location. */}
      {platform === "ios" && location !== null && <Button type="button" variant="ghost" size="xs" className="text-muted-foreground" onClick={() => { setCustomOpen(false); void store.change({ setting: "location", value: null }); }}>清除</Button>}
    </StatusCard>
    <div className="pt-1">
      <Pills label="Simulated place" value={preset} options={placeOptions} onSelect={value => {
        if (value === "custom" || value === "") { setCustomOpen(value === "custom"); return; }
        const entry = locationPresets.find(item => item.value === value);
        setCustomOpen(false);
        if (entry) void store.change({ setting: "location", value: { latitude: entry.latitude, longitude: entry.longitude } });
      }} />
    </div>
    {customOpen && <form className="flex items-end gap-2 pt-2" onSubmit={event => { event.preventDefault(); if (latitude.trim() && longitude.trim()) void store.change({ setting: "location", value: { latitude: Number(latitude), longitude: Number(longitude) } }); }}>
      <div className="min-w-0 flex-1 space-y-1"><label htmlFor={`${id}-latitude`} className="text-xs text-muted-foreground">Latitude</label><Input id={`${id}-latitude`} type="number" step="any" min={-90} max={90} required value={latitude} placeholder="37.3318" onChange={event => setLatitude(event.target.value)} /></div>
      <div className="min-w-0 flex-1 space-y-1"><label htmlFor={`${id}-longitude`} className="text-xs text-muted-foreground">Longitude</label><Input id={`${id}-longitude`} type="number" step="any" min={-180} max={180} required value={longitude} placeholder="-122.0312" onChange={event => setLongitude(event.target.value)} /></div>
      <Button type="submit" disabled={!latitude.trim() || !longitude.trim()}>Set</Button>
    </form>}
  </Group>;
}

export function DeviceSettings({ platform }: { platform: "ios" | "android" }) {
  const [store] = useState(() => new DeviceSettingsStore());
  const [resourceSaving] = useState(() => new ResourceSavingStore());
  const [appTools] = useState(() => new AppToolsStore());
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const appState = useSyncExternalStore(appTools.subscribe, appTools.getSnapshot);
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<"app" | "device">("app");
  const activeTab = appState.disabled ? "device" : tab;
  const id = useId();
  const settings = state.settings;
  const disabled = state.disabled;
  useEffect(() => { if (state.disabled) setOpen(false); }, [state.disabled]);
  useEffect(() => { setOpen(false); }, [state.deviceId]);
  return <div data-element="settings" className="ml-auto flex items-center" ref={element => { if (element) { bindDeviceSettings(element, store); bindAppTools(element, appTools); bindResourceSaving(element, resourceSaving); } }}>
    <ResourceSaving store={resourceSaving} />
    <Popover open={open} onOpenChange={value => {
      if (!value) { setOpen(false); return; }
      void appTools.load();
      const deviceId = store.getSnapshot().deviceId;
      if (store.getSnapshot().settings) { setOpen(true); void store.load(); }
      else void store.load().then(() => { if (store.getSnapshot().deviceId === deviceId && !store.getSnapshot().disabled) setOpen(true); });
    }}>
      <PopoverTrigger asChild><Button variant="ghost" size="icon" disabled={state.disabled} aria-label={`${platform === "ios" ? "iOS" : "Android"} device settings`} title="设备设置"><Settings2Icon /></Button></PopoverTrigger>
      <PopoverContent side="top" align="end" className="max-h-(--radix-popover-content-available-height) w-[360px] max-w-[calc(100vw-16px)] space-y-4 overflow-y-auto p-4 text-sm" aria-label="设备设置" onInteractOutside={event => { if (event.target instanceof Element && event.target.closest('[data-slot="select-content"]')) event.preventDefault(); }}>
        <Tabs value={activeTab} onValueChange={value => { setTab(value as "app" | "device"); if (value === "app") void appTools.load(); }} className="gap-4">
          <TabsList className="grid w-full grid-cols-2"><TabsTrigger value="app" disabled={appState.disabled}><AppWindowIcon />应用</TabsTrigger><TabsTrigger value="device"><SmartphoneIcon />设备</TabsTrigger></TabsList>
          <AnimatedHeight>
          <TabsContent value="app"><AppTools store={appTools} /></TabsContent>
          <TabsContent value="device" className="space-y-3">
        {settings && <fieldset disabled={disabled} className="space-y-3">
          <Group label="显示">
            {settings.appearance !== undefined && <Row label="外观" id={`${id}-appearance`}><Tabs value={settings.appearance} onValueChange={value => { if (value) void store.change({ setting: "appearance", value: value as "light" | "dark" | "auto" }); }}>
              {/* Android's third option leaves no room for icons. */}
              <TabsList aria-labelledby={`${id}-appearance`} className={control}>
                <TabsTrigger value="light" disabled={disabled}>{platform === "ios" && <SunIcon />}Light</TabsTrigger>
                <TabsTrigger value="dark" disabled={disabled}>{platform === "ios" && <MoonIcon />}Dark</TabsTrigger>
                {platform === "android" && <TabsTrigger value="auto" disabled={disabled}>Auto</TabsTrigger>}
              </TabsList>
            </Tabs></Row>}
            {settings.contentSize !== undefined && <Row label="文字大小" htmlFor={`${id}-text-size`}><Stepper id={`${id}-text-size`} value={settings.contentSize} items={contentSizeOptions} disabled={disabled} onChange={value => void store.change({ setting: "contentSize", value: value as typeof contentSizes[number] })} /></Row>}
            {settings.fontScale !== undefined && <Row label="文字大小" htmlFor={`${id}-text-size`}><Stepper id={`${id}-text-size`} value={String(settings.fontScale)} items={fontScaleOptions(settings.fontScale)} disabled={disabled} onChange={value => void store.change({ setting: "fontScale", value: Number(value) })} /></Row>}
            {settings.increaseContrast !== undefined && <Row label="增强对比度" htmlFor={`${id}-contrast`}><Switch id={`${id}-contrast`} checked={settings.increaseContrast} onCheckedChange={value => void store.change({ setting: "increaseContrast", value })} /></Row>}
            {settings.orientation !== undefined && <Row label="Rotation" htmlFor={`${id}-rotation`}><SettingsSelect id={`${id}-rotation`} value={settings.orientation} items={rotationOptions} disabled={disabled} onChange={value => void store.change({ setting: "orientation", value: value as "auto" | "portrait" | "landscape" })} /></Row>}
            {settings.statusBar !== undefined && <Row label="简化状态栏" htmlFor={`${id}-status-bar`}><Switch id={`${id}-status-bar`} checked={settings.statusBar === "clean"} onCheckedChange={value => void store.change({ setting: "statusBar", value: value ? "clean" : "live" })} /></Row>}
          </Group>
          {settings.network !== undefined && <NetworkGroup platform={platform} network={settings.network} store={store} appTools={appTools} />}
          {settings.locationSupported && <LocationGroup key={state.deviceId} platform={platform} location={settings.location} store={store} />}
        </fieldset>}
        <Group label="面板">
          <Row label="显示设备边框" htmlFor={`${id}-frame`}><Switch id={`${id}-frame`} checked={state.frame} onCheckedChange={value => store.toggleFrame(value)} /></Row>
        </Group>
        {state.error && <p className="whitespace-pre-wrap text-xs text-destructive" role="alert">{state.error}</p>}
          </TabsContent>
          </AnimatedHeight>
        </Tabs>
      </PopoverContent>
    </Popover>
  </div>;
}
