# WordReview · Google 翻译生词本 + 手机闪卡 PWA

平时写代码在 `translate.google.com` 查完单词后，自动去噪记录下来，通过你自己的 **GitHub Secret Gist** 无缝同步到手机 PWA 闪卡 App，随时随地翻阅加深记忆。

## 项目结构

- `extension/`：Chrome 浏览器扩展（Manifest V3），无需打包即可直接加载
- `docs/`：移动端优先的 PWA 闪卡复习 App（可零成本托管在 GitHub Pages）
- `shared/`：采集过滤、防抖前缀合并、间隔重复与无冲突同步核心逻辑
- `tests/`：单元测试、QR 解码校验及 PC ↔ Gist ↔ 手机并发同步测试

---

## 3 步快速启用（约 3 分钟）

### 第 1 步：部署手机端 PWA（GitHub Pages）

1. 在 GitHub 上新建一个仓库（例如 `word_review`，**建议公开或使用 GitHub Pages 支持的仓库**；你的生词数据存在私有 Gist 里，不会放在这个仓库中）。
2. 把本项目代码推送到 GitHub：
   ```bash
   git init
   git add .
   git commit -m "init WordReview"
   git branch -M main
   git remote add origin https://github.com/<你的用户名>/word_review.git
   git push -u origin main
   ```
3. 打开仓库的 **Settings → Pages**：
   - **Source** 选择 `Deploy from a branch`，Branch 选择 `main`，目录选择 `/docs`，点击 **Save**（或直接启用自带的 GitHub Actions 工作流）。
   - 稍等 1 分钟后即可获得你的专属 PWA 网址，例如：`https://<你的用户名>.github.io/word_review/`。

### 第 2 步：加载 Chrome 扩展并绑定 GitHub Token

1. 打开 Chrome 地址栏输入 `chrome://extensions/`，开启右上角 **「开发者模式」**。
2. 点击 **「加载已解压的扩展程序」**，选择本项目的 `extension` 文件夹。
3. 点击浏览器右上角扩展图标 → 点设置 `⚙` 进入向导：
   - 点击 **「去 GitHub 生成 Token（已自动预填 gist 权限）」**，生成一个只带 `gist` 权限的 Token 并粘贴回来。
   - 点击 **「验证并自动关联词本」**，扩展会自动在你的账号下创建（或重连）一个名为 `word-review-vocab.json` 的 **Secret Gist**（仅你可见）。
   - 在第 2 步填入你的 GitHub Pages 网址，点击 **「保存并生成二维码」**。

### 第 3 步：手机扫码并添加到桌面

1. 用手机相机扫码（或直接用手机浏览器打开扩展里生成的配对链接），PWA 会自动把 Token 存入手机本地存储并清空地址栏。
2. **添加到手机主屏幕**即变成独立 App：
   - **iPhone (Safari)**：点底部「分享」图标 → **添加到主屏幕**。
   - **Android (Chrome)**：点击页面顶部「安装 App」按钮或浏览器菜单 → **安装应用 / 添加到主屏幕**。

---

## 为什么这套方案适合程序员查词？

1. **自动滤掉打字废词**：停止输入 2.2 秒才捕获；自动忽略像 `单词fu → 单词fu` 这类译文相同的查询；15 秒内将 `par`、`prams` 自动合并替换为最终词 `params`。
2. **中英双向查词统一归档**：无论是 `params → 参数` 还是 `单词 → word`，都会把英文词作为记忆正面。
3. **写代码高频词优先**：多次查过的词会自动累计 `查过 N 次`；即使曾标为「已掌握」，日后写代码忘掉又去查一次时会自动重新放回待复习队列。
4. **并发同步不丢数据**：PC 与手机均通过操作日志（`pendingOps` + `opId` 去重）先拉取最新 Gist 再合并写回，离线复习也不怕覆盖电脑新查的词。
5. **随时强制收藏**：偶尔想记住较长的报错短语或整句，在 Google 翻译页面右下角点 `★ 记入生词本` 或按 `Alt + S` 即可。

---

## 本地开发与验证

```bash
# 同步 shared/ 核心代码到 extension/ 和 docs/
npm run sync-shared

# 运行单元测试、QR 码解码校验与端到端同步测试
npm test

# 在本地预览手机 PWA（http://127.0.0.1:4173/）
npm run preview
```
