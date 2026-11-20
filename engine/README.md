# engine — dsh-sim 设备引擎源码

这是 dsh-sim 插件内置的设备引擎（面板 UI + 运行时服务端），从上游开源项目（MIT）引入并改为本项目的形态：

- `packages/mcp-app`：面板 UI（React/TSX，中文文案在组件里）
- `packages/ui`：通用组件（设置、位置预设、日志等）
- `packages/core`：运行时服务端（MCP、设备流、工具）
- `packages/shared`：共享类型与常量
- `tooling/`：构建面板用的脚本

构建（在仓库根目录）：

```bash
cd engine && npm install   # 首次
cd .. && npm run build     # 构建面板 -> 安装到 vendor/runtime/dist
```

本目录只保留构建所需的源码与许可证；上游的 CI、示例、网站、设计稿、agent 配置已移除。
