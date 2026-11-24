# 纤图 SlimPic · 图片批量压缩工具

> 给图片瘦身，给项目减负。批量瘦身，画质无损。

把散图拖进窗口，或点「选择图片」多选 → **原地压缩覆盖原图**，文件名不变，适合处理不在项目目录里的图片。

需要给整个项目瘦身时，切到**文件夹模式**：选择一个图片文件夹递归扫描，先提示有多少张需要压缩（压缩过的自动跳过），一键压缩，**原地覆盖**，文件名不变，前端引用无需改动。

压缩引擎为开源 [slimdeer](https://github.com/heydeer/slimdeer)（MIT，Rust → WebAssembly）：每张图自动搜索最优质量（SSIMULACRA2 感知评分，效果对标 TinyPNG），全程本地运行，不上传任何图片。

![图片模式](docs/screenshot-files.png)
![扫描确认](docs/screenshot-review.png)
![压缩完成](docs/screenshot-done.png)

## 下载使用

到 [Releases](https://github.com/BaimingZhu/slimpic/releases/latest) 下载对应平台的包：

- **macOS**：`SlimPic-<版本>-arm64.dmg`（Apple Silicon）或 `SlimPic-<版本>-x64.dmg`（Intel）；未签名，首次打开需右键 → 打开。
- **Windows**：`SlimPic-<版本>-portable.exe`（便携版，无需安装，双击即用，可拷贝分发）。

各平台的包在对应系统上构建：macOS 用 `npm run dist:mac`，Windows 用 `npm run dist`。

### 图片模式（默认，原地覆盖）

1. 打开应用即可把图片拖进窗口（也可以混着拖，非图片会标为不支持），或点「选择图片」多选。
2. 确认清单与输出格式（保持原格式 / 转 WebP / 转 AVIF）。
3. 点「压缩 N 张」，完成后结果直接写回原文件，可点「打开文件夹」查看。

- 压缩结果原地覆盖原图，文件名不变；压缩后没有变小的图（如 1×1 PNG）保留原图，状态标记“已最优”。
- 重复压缩同一批图片不会让文件变大：没有更小就保留当前文件。
- 图片模式不读取跳过记录：每次都是你显式选中的那一批文件；压缩结果仍会记入跳过记录，之后用文件夹模式扫描同一目录会自动跳过。

### 文件夹模式（原地压缩）

1. 切到「文件夹模式」，**选择文件夹**（或直接把文件夹拖进窗口，会自动切换）。
2. 扫描后先看汇总：**待压缩 / 已压缩跳过 / 不支持 / 过大跳过**，下方是待压缩清单。
3. 选输出格式（默认保持原格式），点「开始压缩」。
4. 完成后显示每张图的压缩率与总节省体积；再次扫描同一目录时，压缩过的文件不再出现在待压缩列表。

### 功能细节

- **支持输入**：PNG（含 APNG 动图，保持动画）、JPEG。gif/svg/ico/webp/avif 等会列出并标记“不支持”。
- **输出格式**：保持原格式（PNG→PNG、JPEG→JPEG）/ 转 WebP / 转 AVIF。转换会生成同名 `.webp`/`.avif` 并删除原图，项目引用需改后缀；两种模式下转换后没有变小都会保留原图。目标同名文件已存在时报错跳过，绝不静默覆盖。AVIF 编码明显更慢。
- **只小不换**：压缩结果比原文件大时保留原图，标记“已最优”，同样计入跳过记录。
- **跳过记录**：按“绝对路径 + 文件大小/mtime/内容哈希”记在本机 `%APPDATA%/slimpic/compressed.json`。文件内容变了会自动重新进入待压缩列表。界面上可「强制重新压缩」或「清除跳过记录」。
- **安全写回**：先写同目录临时文件再原子替换，中途失败/取消不会损坏原图。
- **并发**：最多 4 个后台进程并行压缩，界面不卡；可随时取消（当前文件处理完即停）。
- **默认忽略目录**：`node_modules`、`.git`、`.svn`、`.hg` 与隐藏目录，可勾选包含。
- **尺寸限制**（与 slimdeer 浏览器版一致）：普通图 ≤40MP，APNG 合计 ≤30MP，AVIF 输出 ≤24MP，WebP 单边 ≤16383px；超限文件标记“过大跳过”。

## 开发

```bash
npm install        # 自动下载 slimdeer 官方预编译 wasm 到 vendor/slimdeer（无需 Rust）
npm run dev        # 开发模式（热更新）
npm run smoke      # Node 下直接验证 wasm 引擎
npm run e2e        # Playwright 驱动真实 Electron UI 的端到端测试（42 项断言，含图片模式与文件夹模式）
npm run dist       # 打包便携版 exe 到 release/
node scripts/make-icon.mjs <图片路径>   # 从一张图重新生成应用图标（build/icon.ico + icon.png）
```

技术栈：Electron 33 + Vue 3 + Vite（electron-vite）+ electron-builder。
压缩在 `utilityProcess` 子进程中执行 slimdeer 的 WebAssembly 构建（与 heydeer.ai 官网同一份二进制），主进程负责扫描、队列与写回：两种模式都是原子替换原图。

### 打包 macOS 版

代码本身跨平台（Electron + WebAssembly，无原生依赖），但 **electron-builder 的 mac 目标（.app/.dmg）只能在 macOS 上执行**，Windows 上无法直接产出。在一台 Mac 上：

```bash
git clone https://github.com/BaimingZhu/slimpic.git && cd slimpic
npm install          # 自动下载 slimdeer wasm
npm run dist:mac     # 产出 release/SlimPic-<版本>-arm64.dmg 和 -x64.dmg
```

- 同时产出 Apple Silicon（arm64）与 Intel（x64）两个 dmg。
- 未配置 Apple 开发者签名（`identity: null`），分发后首次打开需 **右键 → 打开**，或在「系统设置 → 隐私与安全性」中允许；若提示已损坏，执行 `xattr -cr /Applications/SlimPic.app`。
- 图标使用 `build/icon.icns`（`make-icon.mjs` 会从同一张图同时生成 .ico 与 .icns）。
- 没有 Mac 时可用 GitHub Actions 的 `macos-latest` runner 执行 `npm run dist:mac`。

若 Electron 下载慢，使用镜像：

```powershell
$env:ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
$env:ELECTRON_BUILDER_BINARIES_MIRROR="https://npmmirror.com/mirrors/electron-builder-binaries/"
npm run dist
```

## 许可证

本工具 MIT。slimdeer 及其依赖的许可证见 `vendor/slimdeer/LICENSE` 与 `vendor/slimdeer/THIRD_PARTY_LICENSES.txt`（随 exe 一起分发）。JPEG 输出基于 mozjpeg（Independent JPEG Group），AVIF 基于 libaom。