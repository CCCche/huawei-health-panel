# 健康面板 Android 0.1

- **面板**在 App 内打开现有健康服务。请使用已有的面板账号登录。
- **原生摘要**使用同一登录会话读取近期健康数据，用 Jetpack Compose 和 COUI-Kit 展示圆环、睡眠和概况。Android 13 起可体验 COUI-Kit 跟手光。
- **同步**在点击「解密并同步」后请求 Root，调用本机已有的 AntiGem 同步脚本。同步完成后刷新面板。没有 Root 的设备仍可登录并查看已同步的数据。

首版依赖用户本机配置的环境和同步脚本，不将数据库、同步凭据或密钥打包到 APK，也不迁移现有定时任务。解密同步功能依赖外部脚本（默认占位路径，按实际环境配置）。

构建环境需要 JDK 21 和 Android SDK 37.1。运行 `./gradlew assembleDebug`，产物位于 `app/build/outputs/apk/debug/app-debug.apk`。

当前 ARM64 chroot 中的旧版 AAPT2 无法读取 SDK 37.1。本机已在 `.tooling` 中准备好通过 QEMU 运行的 Google AAPT2。从本目录重建可运行

```sh
ANDROID_HOME=/opt/antigem/android-sdk ./gradlew -Pandroid.aapt2FromMavenOverride="$PWD/.tooling/bin/aapt2" assembleDebug
```

## 0.4 打开应用自动同步

离线版（`offline` 模块，包名 `xyz.orachen.health.offline`）在原有手动/一键同步基础上，新增打开应用时自动同步能力：

- **冷启动与切回前台自动同步**：每次打开应用或从后台切回前台（15 秒防抖冷却）时，先立即展示本地已缓存的健康记录，同时在后台自动请求 Root（`su -M`）检查 `/data/data/com.huawei.health/databases/hihealth_003.db`；若数据库 `mtime` 与大小未变化，通过 `--if-changed` 快速跳过重复拷贝与解密；若有更新，则复用缓存密钥（或自动从内存重新恢复）完成解密与刷新。
- **开关控制与手动强制同步**：在「同步与导入 → 华为运动健康自动同步」中可随时开关「打开应用时自动同步」（默认开启）；顶部栏「同步」按钮支持随时强制重新拉取。
- **Android Keystore 安全缓存**：恢复的密钥通过 `AndroidKeyStore`（AES-256-GCM）加密缓存在应用私有 `noBackupFilesDir` 中，全程离线不入网。
- UI 使用 [COUI-Kit 0.0.1-alpha17](https://github.com/ItosEO/COUI-Kit)，其源代码采用 [MPL-2.0](https://www.mozilla.org/MPL/2.0/) 许可。

```sh
ANDROID_HOME=/opt/antigem/android-sdk ./gradlew -Pandroid.aapt2FromMavenOverride="$PWD/.tooling/bin/aapt2" :offline:testDebugUnitTest :offline:assembleDebug
```

该命令会自动使用 NDK 编译 `libhwh_keyrecover.so` 并生成 `offline/build/outputs/apk/debug/offline-debug.apk`，用于手动安装测试。正式公开分发前应使用维护者自己的发行签名。

## 0.6 网站同款面板 + 自动获取密钥与增量同步

`panel` 模块（`xyz.orachen.health.panel`）保留网站原版 HTML/CSS/JS、Liquid Glass 交互、Leaflet 离线地图及全套 Python 统计引擎（`dashboard_api.py` / `health_import.py` / `db.py`），并集成与 `offline` 模块相同的原生 Root 自动密钥恢复与解密能力：

- **打开应用自动同步与无变更跳过**：冷启动及切回前台（15 秒冷却防抖）时，立即显示本地数据并在后台通过 `su -M` 调用内置 `libhwh_keyrecover.so` 检查 `/data/data/com.huawei.health/databases/hihealth_003.db`；若源库 `mtime` 与大小未变则通过 `--if-changed` 直接跳过重复拷贝和解密；若有更新，则复用 `AndroidKeyStore`（AES-256-GCM）缓存的密钥（或在失效时从 `com.huawei.health:DaemonService` 内存自动恢复），在本地解密后通过 `local_panel.py` 执行非阻塞增量解析并原子替换 `panel.sqlite`，完成后自动刷新当前面板。
- **沉浸式状态栏与导航栏**：全屏 Edge-to-Edge 延展粉蓝柔和渐变与 OLED 纯黑背景至状态栏及手势条区域，自动注入安全区边距并与浅色/OLED 深色外观实时同步状态栏及导航栏图标明暗对比度。
- **长下拉自动增量刷新**：在主页顶部向下长拉触发 iOS 26 Liquid Glass 进度胶囊与原生触感反馈，松开即通过 `--if-changed` 快速增量检查并刷新最新健康数据。
- **原生图表拖动震动与高德在线地图底图**：通过 `VIBRATE` + `VibratorManager`（`USAGE_TOUCH`）提供与网页版一致的图表滑动与胶囊底栏拖动逐格震动；训练轨迹详情恢复高德矢量 / 高德暗黑 / 高德卫星 / ArcGIS 街景底图切换（仅放行白名单 HTTPS 地图瓦片域名，健康数据仍 100% 本地离线解析）。
- **Apple Health 风格首次使用指南**：首次进入提供 Root 授权、激活华为运动健康、自动同步/下拉刷新与本地 Keystore 安全说明，也可随时在「更多 → 首次使用指南」重新查看。
- **网站样式无缝融合**：「更多 → 华为运动健康自动同步」支持开关自动同步、查看密钥缓存状态、立即同步、强制重新获取密钥以及清除本地数据；手机端顶栏/桌面端状态胶囊可直接点击同步并实时显示解密进度。
- **保留手动导入**：未授予 Root 时仍可通过「手动导入本地数据库」导入快照与密钥。
- 本地 JavaScript 和样式来自已部署网站。地图采用 [Leaflet](https://leafletjs.com/) + 高德地图 / ArcGIS 公开 HTTPS 瓦片服务，对应许可证与原有玻璃界面库的许可证一同包含在 APK 中。

```sh
ANDROID_HOME=/opt/antigem/android-sdk ./gradlew -Pandroid.aapt2FromMavenOverride="$PWD/.tooling/bin/aapt2" :panel:testDebugUnitTest :panel:assembleDebug
```

生成 `panel/build/outputs/apk/debug/panel-debug.apk`，适用于 ARM64 的 Android 12 及以上设备。

## 0.9 界面精修、本地算法回退与图形性能升级

对应 [PROJECT_UPDATE_PLAN.md](../docs/PROJECT_UPDATE_PLAN.md) Milestone 1（`v0.9.0`）：

- **全局去滚动条与液态玻璃悬浮选择器**：禁用原生 WebView 与全部内层滚动容器的右侧滚动条，并将「准备度与洞察 → 运动负荷分类」原生下拉框替换为通用 Apple Health / Liquid Glass 悬浮弹窗选择器。
- **训练指数 `ⓘ` 指标讲解悬浮窗**：在摘要卡片与详情页大标题旁增加低饱和灰色 `ⓘ` 按钮，弹出实时高亮当前状态区间的 TSB / CTL / ATL / ACWR 说明窗。
- **心率详情折线视图切换**：心率详情支持在「范围胶囊」与「折线视图」间切换（单日展示连续分时心率曲线与静息参考线，多日展示均线与极值包络带，保留拖动读数与原生硬件触感反馈）。
- **昨夜生命体征三级本地回退算法**：当睡眠汇总缺失夜间心率/血氧或历史基线不足时，自动基于睡眠时间窗内的 `vitals_points` 连续采样截尾均值/中位数及近 30 天个人分位重建补充，并明确标明算法口径。
- **原版全量液态玻璃卡片视觉与触控高光还原**：保留全部卡片的完整液态玻璃材质与垂直滚动期间的跟手高光追踪效果，确保首页「准备度」卡片与其他功能卡片视觉完全一致。
- **ColorOS 风格「从哪来，回哪去」卡片容器展开与收回动效**：放弃 Android 预测式返回缩放，改为基于卡片原始几何区域与单表面统一缩放/圆角裁切（WAAPI GPU 合成）的双向容器变换：点击摘要、体能训练、浏览、所有健康数据或准备度卡片时从原卡片自然展开为全屏详情页；返回（页内返回钮或系统返回手势）时保持底层卡片状态与 `.no-anim-replay` 零动画重载并精准缩回原卡片位置。

## 0.9.5 数据导出与本地 MCP

在「更多 → 数据与密钥导出」选择已解密全量库、原始数据库快照或面板数据库，再通过系统文件选择器保存。全量库保留源快照的原始表，导出前执行 SQLite 完整性检查。原始快照对应华为运动健康的主数据库文件，尚未写入主文件的 WAL 事务可能要等源应用完成检查点后才能取得。SQLCipher 密钥可在二次确认后复制或保存为带 SQLCipher 4 用法的文本。

在「更多 → 本地 MCP 服务」启动服务、查看运行状态、配置端口及复制客户端 JSON。默认地址为 `http://127.0.0.1:18765/mcp`，每次请求都需要 `Authorization: Bearer <Token>`。经确认后可绑定当前局域网 IPv4。服务运行期间显示前台通知，可从通知停止。重置 Token 会停止服务并使旧凭据失效。

MCP 通过 Streamable HTTP 提供健康概览、每日摘要、单日明细、指标详情、训练列表与详情、睡眠和专业洞察。训练默认省略 GPS 和时间序列，可用 `include_series` 请求。心电图工具当前返回数据可用状态，待后续版本补充采集与入库。

## 0.9.6 体温、腕温与心电图

「浏览」可查看体温、腕温与心电图，心率详情也提供心电图入口。心电图记录支持缩放、读数及 CSV、PNG、PDF 导出。没有记录时可以查看明确标记的合成示例。腕温页面仅显示随记录导入的个人基线偏差。

- 已接入华为公开常量 `DATA_POINT_BODY_THERMOMETER = 2104` 的摄氏度点值。其他存储编码尚未证实，暂不换算。 [华为常量表](https://developer.huawei.com/consumer/en/doc/HMSCore-References/constant-values-0000001052541631/)
- 腕温和心电图可从现有的面板 SQLite 导入入口读取规范化记录。心电图波形统一存为 gzip 压缩的有符号小端 16 位微伏差值，首样本为绝对值。公开的 Health Kit 文档描述 ECG 记录与采样字段，仍需进一步核对手机端 `sample_sequence` 原始编码和标定。 [华为 ECG 记录](https://developer.huawei.com/consumer/en/doc/HMSCore-Guides/ecg-measurement-record-0000001131831084) [华为 ECG 采样明细](https://developer.huawei.com/consumer/en/doc/hmscore-guides/ecg-measurement-details-0000001131423786/)
- 本地既有快照中未找到专用 ECG 表及文档列出的体温点类型。名为 `hihealth_temp` 的表为空，仅凭表名无法确认其用途。
- 图表信息组织参考 Apple 的腕温和心电图说明，沿用本项目的面板视觉。 [腕温](https://support.apple.com/en-us/102674) [心电图](https://support.apple.com/en-us/120278)

从项目根目录验证合成数据链路：

```sh
PYTHONPATH=android-app/panel/src/main/python python3 -m unittest discover -s android-app/panel/src/test/python -v
```

## 1.0 稳定版发布

`:panel` `v1.0.0`（`versionCode = 22`）已作为首个公开发行版随主仓库发布：

- **容器变换转场与滚动交互稳定**：卡片打开/关闭采用 ColorOS 风格容器变换（源卡片与浮层 `sheet` 全程几何与不透明度交接），修复滚动手势监听作用域与过渡期间的闪烁问题。
- **底栏直达点击与拖拽手势**：移除按下即触发布局收缩的位移抖动，增强水平拖拽判定阈值，并放行卡片收起尾段对底栏的点击切换，避免“连点两下才切页”。
- **离线全本地数据链路 + 只读 MCP Server**：内置 Chaquopy Python 3.12 + SQLCipher 4 兼容解密同步引擎、高/低功耗生理指标与心电/睡眠/训练详情，并提供本机只读 `127.0.0.1` MCP 服务供 AI 客户端接入。

## 1.0.2 · Health Panel 更新

- 应用名称与自适应图标升级为 **`Health Panel`**，同步 `PanelMcpService` 通知与 `PanelMcpProtocol` 服务端版本号（`1.0.2`）。
- 卡片展开/收起容器变换改用 Web Animations API 合成器动画，优化 React 玻璃图层与 CSS 样式范围以提升过渡帧率。
- 心电图详情页新增拖动隐藏游标、单击显示采样竖线交互，并内置本地轻量单导联心电节律分类识别算法卡片。
