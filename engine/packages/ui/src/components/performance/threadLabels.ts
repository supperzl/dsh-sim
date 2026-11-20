const iosThreadLabels = new Map([
  ["hades", "Hermes 垃圾回收"],
  ["com.apple.NSURLConnectionLoader", "网络加载器"],
]);

export function threadLabel(name: string, number: number, platform: "ios" | "android"): string {
  if (name === "") return `Unnamed thread #${number}`;
  if (platform === "ios") {
    const role = iosThreadLabels.get(name);
    if (role !== undefined) return role;
  }
  return name;
}
