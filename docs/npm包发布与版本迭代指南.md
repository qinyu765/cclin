# npm Scoped 包发布及版本迭代流程

> 解决拥有命名空间（Scoped）的包在发布时遇到的 `402 Payment Required` 错误，并梳理日常包发版的标准开发工作流。

---

## 原始问题回顾

在尝试通过 `npm publish` 发布形如 `@username/package-name` 的包时，有时会遇到以下错误：
`npm error code E402 Payment Required - PUT https://registry.npmjs.org/@hflin%2fcclin - You must sign up for private packages`

**原因分析**：
npm 默认将所有带有作用域（如 `@hflin/`）的包视为**私有包**，而私有包功能是需要开通付费账户的。如果是要发布开源包，需要明确告知 npm 这是一个公开包。

---

## 解决方案

为了将 Scoped 包免费发布到公共仓库，有两种方式：

### 方式一：发布命令带上参数（单次有效）
```bash
npm publish --access=public
```

### 方式二：配置 package.json（推荐，一劳永逸）
在项目的 `package.json` 根级节点中加入以下配置：
```json
"publishConfig": {
  "access": "public"
}
```
配置之后，以后敲击 `npm publish` 时 npm 就会自动按公开包处理。

---

## 日常持续迭代与发布指南

在首次发布成功之后，随着代码的修复和功能的增加，后续发布的流程（生命周期）应遵循标准的包版本管理规范：

**前提**：所有的代码修改在本地确认无误（通过了相关测试即可）。

### 1. 提交代码至 git
使用 git 管理你的改动：
```bash
git add .
git commit -m "update: 添加新功能/修复XX问题"
```

### 2. 升级版本号（Version Bump）
npm 要求每一次发布必须要用一个**高于上一次的全新版本号**。
**注意：绝对不要手动去改 `package.json` 的 version 字段**，应使用命令自动更新（命令同时还会自动在 git 打对应的 tag）。

根据你代码修改的性质选择以下命令：
- **打补丁版**（修复了小 Bug 且保证功能无异），例如 `0.1.0` -> `0.1.1`：
  ```bash
  npm version patch
  ```
- **次版本**（加了新特性，但依然向下兼容），例如 `0.1.1` -> `0.2.0`：
  ```bash
  npm version minor
  ```
- **主版本**（做了重大的、不向下兼容的重构），例如 `0.2.0` -> `1.0.0`：
  ```bash
  npm version major
  ```

### 3. 发布到 npm
因为前面已经配置好了 `"publishConfig": {"access": "public"}`，现在可以直接无脑执行：
```bash
npm publish
```
*(注: 如果项目设置了 `prepublishOnly` 脚本，npm 会在打包提交给仓库前自动执行如 build 类的操作。)*

### 4. 同步 Tag 到远程代码库 (可选但推荐)
将刚才自动打好版本号 Tag 的 commit 推送到 GitHub/GitLab：
```bash
git push --follow-tags
```

---

## 核心流程速记口诀
1. `git commit` 保存代码
2. `npm version xxx` 升版本号
3. `npm publish` 按版本发布新包
4. `git push --follow-tags` 推送远程代码
