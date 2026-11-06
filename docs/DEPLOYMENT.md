# Paintopia 公网部署

生产入口固定为 https://paintopia.b1mango.cc。仓库使用两个 Vercel 项目：paintopia-web 部署 apps/web，paintopia-api 部署 apps/api。浏览器始终访问同域 /api/*，由 Web 项目反向代理到 API 项目。

## 1. 上线前

1. 将 GitHub 仓库设为 Private，确认 .env、data/、本地图片和 SQLite 文件未提交。
2. 立即轮换所有曾在聊天、截图或日志中出现过的 Provider API Key，再把新 Key 通过后台录入。
3. 生成三个独立随机值：

       node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
       node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
       node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"

   依次用于 PAINTOPIA_SESSION_SECRET、PAINTOPIA_PROVIDER_ENCRYPTION_KEY、CRON_SECRET。

## 2. Neon

1. 创建 Singapore 区域的 Neon PostgreSQL 项目。
2. 使用 pooled connection string 作为 DATABASE_URL。
3. 不在 GitHub、Vercel 配置文件或文档中写入连接串。

API 首次启动会创建表和索引，并在 `schema_meta` 记录 `SCHEMA_VERSION`（apps/api/src/db/database.ts）；版本一致时后续冷启动跳过整套建表语句。今后任何表结构、索引或启动迁移的改动，都必须同时调高 `SCHEMA_VERSION`，否则线上实例会认为已是最新而不执行新迁移。PostgreSQL 上迁移在事务内持有 advisory lock，多实例同时冷启动只会执行一次。

迁移本地数据前先完成 R2 配置，然后在本机临时设置生产环境变量并执行：

    npm run migrate:production

该脚本迁移用户、邀请码、额度、Provider、任务、提示词和资产；Session 不迁移。已有画廊项按已审核永久迁移，其他历史资产从迁移时起重新保留七天。

本地需要按公网可见数据重建时，先停止本地 API，再执行：

    npm run sync:production-to-local

该命令固定为公网到本地单向同步：登录 `paintopia.b1mango.cc`，先把本地 SQLite 备份到 `data/exports/`，再同步用户元数据、Provider 配置、模板、提示词、资产原图和画廊。Provider 的公网掩码不会写入数据库，脚本要求所有 Provider 都能匹配到本地已有真实 Key，否则在修改数据库前失败。同步后 Session 会清空；公网 API 不导出的密码哈希、邀请码和完整任务历史不属于该快照范围。

## 3. Cloudflare R2

1. 新建私有 bucket：paintopia-assets，不要复用 blog-images。
2. 创建仅限该 bucket 的 Object Read & Write S3 API Token。
3. 在 bucket 的 CORS 设置导入 infra/cloudflare/r2-cors.json。
4. 在生命周期设置导入 infra/cloudflare/r2-lifecycle.json，或执行：

    npx wrangler r2 bucket lifecycle set paintopia-assets --file infra/cloudflare/r2-lifecycle.json

对象前缀：

- temporary/：七天自动删除。
- pending/：三十天自动删除。
- gallery/：无生命周期规则，永久保留。
- permanent/：站长个人图片，无生命周期规则，永久保留。唯一站长由 `PAINTOPIA_OWNER_EMAIL` 指定，未配置时使用 `PAINTOPIA_BOOTSTRAP_EMAIL`；其他管理员与普通用户均保留七天。
- thumbnails/：720px WebP 列表缩略图，由应用随资产删除；历史资产首次读取缩略图时自动补生成。

存量资产启用永久保留前，先备份数据库，并暂停 cleanup Cron 及 `temporary/` 生命周期，避免旧对象在迁移途中到期。核对站长账号后执行 `node --import tsx scripts/preserve-permanent-assets.ts` 查看只读清单，再加 `--apply` 执行。该脚本只处理站长和已审核通过的图片：复制到永久前缀、校验 SHA-256、再更新数据库引用和清空到期时间；不删除旧对象，不修改普通用户私有图片。数据库旧引用保存在 data/logs/asset-retention-before-*.json，失败资产会单独列出；已丢失的原图无法恢复，须从备份补回。全部目标核验通过后恢复生命周期和 Cron。API 与媒体 Worker 一起更新，以支持 permanent/ 图片地址。

普通用户撤回已通过的画廊作品后，个人资产重新保留七天；站长撤回后仍永久保留。已审核且仍在画廊中的作品始终永久保留，待审核作品不获得永久资格。

SQLite 升级会补齐与 PostgreSQL 一致的 `gallery_items.asset_id` 唯一索引。若启动提示旧画廊存在同资产重复记录，先备份并人工核对；迁移不会擅自删除历史记录。

## 4. Vercel

从同一个 GitHub 仓库导入两个项目，并启用 Include source files outside of the Root Directory。

### API 项目

- Project Name：paintopia-api
- Root Directory：apps/api
- Region：配置文件固定 sin1
- Function Max Duration：300 秒

环境变量：

    NODE_ENV=production
    DATABASE_URL=<Neon pooled connection string>
    PAINTOPIA_WEB_ORIGIN=https://paintopia.b1mango.cc
    PAINTOPIA_BOOTSTRAP_EMAIL=<管理员账号>
    PAINTOPIA_BOOTSTRAP_PASSWORD=<首次部署临时强密码>
    PAINTOPIA_SESSION_SECRET=<随机值>
    PAINTOPIA_PROVIDER_ENCRYPTION_KEY=<32 字节 base64 随机值>
    PAINTOPIA_R2_ACCOUNT_ID=<Cloudflare Account ID>
    PAINTOPIA_R2_ACCESS_KEY_ID=<R2 Access Key ID>
    PAINTOPIA_R2_SECRET_ACCESS_KEY=<R2 Secret Access Key>
    PAINTOPIA_R2_BUCKET=paintopia-assets
    PAINTOPIA_ASSET_RETENTION_DAYS=7
    PAINTOPIA_PENDING_GALLERY_RETENTION_DAYS=30
    PAINTOPIA_PROHIBITED_TERMS=<可选，逗号分隔的站点附加违禁词>
    CRON_SECRET=<随机值>

### Web 项目

- Project Name：paintopia-web
- Root Directory：apps/web
- Output Directory：dist

apps/web/vercel.json 默认代理到 https://paintopia-api.vercel.app。如果 Vercel 实际分配的 API 生产域名不同，先修改该目标再部署 Web。

## 5. 域名

1. 在 paintopia-web 项目添加 paintopia.b1mango.cc。
2. 在 Cloudflare DNS 新增 Vercel 页面给出的 CNAME 目标，不要凭经验硬编码。
3. 首次验证使用 DNS only，确认 Vercel 域名验证和 HTTPS 正常后再评估 Cloudflare Proxy。
4. 不给 R2 bucket 开公共访问，也不把 API 单独暴露到自定义子域名。

## 6. 验收

1. 邀请码只能使用一次；无邀请码无法注册。
2. 登录 Cookie 为 Secure、HttpOnly 的 __Host-paintopia_session。
3. 文生图、图生图、Provider 顺序回退和 300 秒长请求正常。
4. 浏览器上传图片直接 PUT 到 R2，API 请求体不承载大图。
5. 未验证代理只展示 1K；实际成功输出 2K/4K 后才展示对应档位。
6. 新画廊项显示“待审核”，管理员通过后其他用户可见；拒绝后永久对象不存在。
7. GET /api/internal/cleanup 无正确 Bearer CRON_SECRET 时返回 401。
8. 七天临时对象、三十天待审对象和永久画廊对象的生命周期符合预期。
9. 资产与画廊列表请求 `/thumbnail`，打开预览和下载时才请求 `/original` 或画廊原图。
10. 连续触发登录、注册、生成、提示词工具或上传限流时返回 429 和 `Retry-After`。
11. 违禁词在去除空格、标点和常见不可见字符后仍会命中；Provider 自带审核保持默认开启。
12. 图生图最多选择 16 张参考图，单张不超过 10MB、单次总计不超过 50MB；生成完成后临时上传的参考图不出现在资产列表。
13. 创作预览、画廊卡片和资产卡片的下载按钮均返回附件响应，而不是跳转到 R2 预览页。

## 7. 公网风险与运维措施

应用内限制只能降低风险，不能代替边缘防护和账单控制。上线时同时完成以下配置：

1. 在 Vercel Firewall 或 Cloudflare WAF 对登录、注册和 API 异常流量设置规则；不要在应用层自行实现 IP 黑名单。分布式攻击应在到达 Serverless Function 前处理。
2. 为 Vercel、Neon、R2 和所有 Provider 设置用量或余额告警。Paintopia 的用户额度和路由限流用于控制单个账号，平台预算用于控制密钥泄漏、并发账号和绕过应用的成本风险。
3. 保持 R2 私有，下载使用短期签名 URL；每季度演练 Neon 备份恢复和 R2 关键画廊对象恢复。生命周期删除不是备份。
4. 监控 429、401/403、Provider 429/5xx、注册耗时和生成失败率。日志只记录请求 ID、状态、耗时和内部用户 ID，不记录密码、邀请码、Cookie、Provider Key 或完整提示词。
5. 内置违禁词只覆盖高风险底线，`PAINTOPIA_PROHIBITED_TERMS` 用于补充站点规则；它不能替代 GPT Image 的输入/输出审核。不要把 Provider 的 moderation 调成宽松模式。
6. 定期删除过期 Session、临时资产、待审画廊项和限流记录；当前 `/api/internal/cleanup` 已统一处理这些数据。
7. 新依赖和 Provider 上线前先在预览环境验证 CSP、CORS、Cookie、上传签名范围和错误重试，避免生产环境出现无限重试或跨域凭据泄漏。

GPT Image 的 Image Edit API 当前对 GPT Image 模型支持最多 16 张输入图，详见 [OpenAI Image Edit API](https://developers.openai.com/api/reference/resources/images/methods/edit)。Paintopia 采用该上限，但额外设置 50MB 单次总量限制，以约束 Serverless 内存和上传滥用。


## 管理员增量导入

本地运行 `node --import tsx scripts/export-local-import.ts`，生成被Git忽略的 `data/exports/paintopia-admin-import.json`。文件包含原始接口密钥，权限为0600，不上传到GitHub。登录目标公网管理员，在配置→账户选择文件，先检查，再确认合并。

文件直传私有R2（最大64MB，图片最大32MB），服务校验SHA-256和管理员签名凭证。同ID创作/资产跳过，归属冲突则拒绝；接口按ID或名称+类型+地址匹配并更新。不导入用户、密码、余额、Session、额度预留或扣费流水。站长导入图片永久保留，其他管理员导入图片重新保留七天；不会自动公开到用户画廊。导入前接口快照保存在私有R2 temporary/<管理员ID>/import-backup-*，随七天生命周期清理。大批数据应分批导入。
