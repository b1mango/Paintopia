# Paintopia

<p align="center">
  <img src="apps/web/public/media/paintopia-icon-black-128.png" alt="Paintopia" width="112" height="112" />
</p>

<p align="center">图像创作工作台</p>

<p align="center">
  <img src="https://img.shields.io/badge/platform-Web-1f6feb" alt="Web" />
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-2ea043" alt="MIT License" /></a>
</p>

## 功能

- **创作**：文生图、图生图，多尺寸与分辨率；提示词一键翻译和优化
- **多 Provider 回退**：图像与文本接口可配置多个，按优先级自动切换，密钥加密存储
- **灵感库**：聚合多个开源提示词来源与站主推荐，按标签筛选，一键带入创作
- **画廊**：作品投稿审核、标签分类与浏览
- **资产**：个人生成历史、预览与下载，临时作品按生命周期自动清理
- **管理后台**：邀请码注册、用户与额度管理、Provider 测试与排序
- **部署**：本地 SQLite 零配置开发；生产使用 Vercel、Neon PostgreSQL 与私有 Cloudflare R2

## 安装

生产入口为 [paintopia.b1mango.cc](https://paintopia.b1mango.cc)。仓库当前没有发布安装包；本地运行需要 Node.js 22 或更高版本。

```bash
git clone https://github.com/b1mango/Paintopia.git
cd Paintopia
npm install
```

复制 `.env.example` 为 `.env`，填写本地管理员、邀请码、Session secret 和所需 Provider 配置后启动：

```bash
npm run dev
```

Web 默认运行于 `http://127.0.0.1:5173`，API 默认运行于 `http://127.0.0.1:8787`。

## 开发

```bash
npm run typecheck
npm test
npm run build
```

生产部署、数据迁移、R2 生命周期和验收步骤见 [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md)。不要把 Provider key、数据库连接串、Session secret 或 R2 凭据写入仓库。

## License

[MIT](LICENSE)
