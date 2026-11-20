import type { ReadResourceResult } from "@modelcontextprotocol/sdk/types.js";
import type { FrameRead } from "@mobile-dev/shared/stream.ts";
import { StopReconnectError } from "./reconnect.ts";

function serverTimings(metadata: unknown) {
  if (metadata == null || typeof metadata !== "object" || !("serverStartedAt" in metadata) || !("serverPreparedAt" in metadata)) {
    throw new StopReconnectError("插件返回的帧时序元数据缺失。");
  }
  const { serverStartedAt, serverPreparedAt } = metadata;
  if (typeof serverStartedAt !== "number" || Number.isFinite(serverStartedAt) === false || serverStartedAt <= 0
      || typeof serverPreparedAt !== "number" || Number.isFinite(serverPreparedAt) === false || serverPreparedAt < serverStartedAt) {
    throw new StopReconnectError("插件返回了无效的帧时序元数据。");
  }
  return { serverStartedAt, serverPreparedAt };
}

export function readFrame(result: ReadResourceResult): FrameRead {
  const image = result.contents.find(item => item.mimeType === "image/jpeg" && "blob" in item);
  if (image && "blob" in image) {
    const metadata = image._meta;
    const sequence = metadata?.sequence;
    const receivedAt = metadata?.receivedAt;
    const bytes = metadata?.bytes;
    const serverWaitMs = metadata?.serverWaitMs;
    if (typeof sequence !== "number" || Number.isSafeInteger(sequence) === false || sequence <= 0
        || typeof receivedAt !== "number" || Number.isFinite(receivedAt) === false || receivedAt <= 0
        || typeof bytes !== "number" || Number.isSafeInteger(bytes) === false || bytes <= 0 || bytes > 16 * 1024 * 1024
        || typeof serverWaitMs !== "number" || Number.isFinite(serverWaitMs) === false || serverWaitMs < 0) {
      throw new StopReconnectError("插件返回了无效的帧元数据。");
    }
    const timings = serverTimings(metadata);
    return { serverWaitMs, ...timings, frame: { sequence, receivedAt, bytes, data: image.blob } };
  }
  const status = result.contents.find(item => item.mimeType === "application/json" && "text" in item);
  if (status == null || !("text" in status)) throw new StopReconnectError("插件返回了无法读取的帧响应。");
  const message = JSON.parse(status.text);
  if (message.state === "failed") {
    const error = typeof message.error === "string" ? message.error : "模拟器捕获失败。";
    if (message.retryable === false) throw new StopReconnectError(error);
    throw new Error(error);
  }
  if (message.state !== "waiting" || typeof message.serverWaitMs !== "number" || Number.isFinite(message.serverWaitMs) === false || message.serverWaitMs < 0) {
    throw new StopReconnectError("插件返回了无效的帧状态。");
  }
  const timings = serverTimings(status._meta);
  if (message.connectionState != null && message.connectionState !== "connected" && message.connectionState !== "reconnecting") {
    throw new StopReconnectError("插件返回了无效的连接状态。");
  }
  return { serverWaitMs: message.serverWaitMs, connectionState: message.connectionState, ...timings };
}
