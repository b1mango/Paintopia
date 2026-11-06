# 灵感页后端接口契约

所有用户接口需要登录，管理接口需要管理员角色。列表、详情、收藏成功响应均为 `Cache-Control: private, no-store`。

## 列表与详情

`GET /api/prompt-library`

| 参数 | 类型/范围 | 默认值 | 含义 |
| --- | --- | --- | --- |
| source | 来源 ID 或 all | all | 限定来源 |
| q | string，最多 200 字 | 空字符串 | 去首尾空白，忽略大小写，匹配 title/text/description/author/tags 子串 |
| tag | string，最多 100 字 | 无 | 精确匹配单个标签 |
| favorites | true / false | false | 只看当前用户收藏，可跨来源 |
| offset | 安全整数，≥0 | 0 | 筛选后偏移量 |
| limit | 整数，1–60 | 24 | 每页条数 |
| refresh | true / false | false | 刷新过期或尚无快照来源，受租约及退避约束 |

完整共享响应类型：

```ts
export type PromptSource = {
  id: string; name: string; homepage: string; feedUrl: string;
  license: string; licenseUrl: string; aggregatorUrl: string; aggregatorLicenseUrl: string;
  model: string; compatibilityNote: string;
};
export type SourcedPrompt = {
  id: string; sourceId: string; title: string; text: string; description: string;
  tags: string[]; author: string; sourceUrl: string; coverUrl?: string;
  model: string; favorite: boolean;
  imageUrl?: string; width?: number; height?: number;
};
export type PromptSourceError = { sourceId: string; message: string };
export type PromptLibraryResponse = {
  sources: (PromptSource & { count: number })[];
  items: SourcedPrompt[];
  total: number; offset: number; limit: number;
  tags: { tag: string; count: number }[];
  fetchedAt: string | null;
  sourceErrors: PromptSourceError[];
  refreshNeeded: boolean;
};
```

- 来源顺序：paintopia-curated、youmind-gpt-image-2、image-2-5、freestylefly-gpt-image-2、awesome-gpt-image。空站主推荐仍返回 count 0。
- sources[].count 为来源总条数，不受任何筛选影响。tags 在 source 和 favorites 范围内统计，不叠加 q/tag；按频次降序、名称（zh-CN）升序，最多 200 个。
- 站主推荐按 sort_order DESC、created_at DESC、id DESC；外部来源保留快照原顺序。all 按来源顺序拼接，再筛选分页。
- fetchedAt 保留原有含义：已读取外部快照中最早的抓取时间，无外部快照时为 null。
- 站主推荐 sourceUrl 为空字符串、author 为“绘境”；coverUrl/imageUrl 分别为签名缩略图/原图，未配置边缘服务时直接为鉴权回源地址。
- 站主推荐 license 为“站主原创”；没有聚合仓库，licenseUrl/aggregatorUrl/aggregatorLicenseUrl 为空字符串，homepage 指向站点。

`GET /api/prompt-library/items/:id`：完整 SourcedPrompt.id，例如 paintopia-curated:abc；返回 SourcedPrompt，包含当前用户 favorite。

`PUT /api/prompt-library/:id/favorite`：请求 `{ favorite: boolean }`，响应 `{ id: string; favorite: boolean }`。旧来源 ID 继续有效；取消收藏无需访问来源。

## 站主推荐管理（内部 id 仍为 paintopia-curated）

管理接口使用裸记录 ID（如 abc）；它不同于列表、详情、收藏中的 paintopia-curated:abc。前端从列表发起管理操作时须移除 paintopia-curated: 前缀。

```ts
export type CuratedPrompt = {
  id: string; title: string; text: string; description: string | null; tags: string[];
  sortOrder: number; sourceAssetId: string | null;
  coverUrl: string; imageUrl: string; width: number; height: number;
  createdAt: string; updatedAt: string;
};
export type CreateCuratedPromptRequest = {
  assetId: string; title?: string; text?: string; description?: string | null; tags?: string[];
};
export type UpdateCuratedPromptRequest = Partial<Pick<
  CuratedPrompt, "title" | "text" | "description" | "tags" | "sortOrder"
>>;
```

- POST /api/admin/curated-prompts：请求 CreateCuratedPromptRequest，201 返回 CuratedPrompt。text 默认取资产 prompt；title 默认取 text 前 24 个 Unicode 字符。只允许 ready 资产，同一资产重复/并发收录返回 409。
- PATCH /api/admin/curated-prompts/:id：请求 UpdateCuratedPromptRequest，200 返回 CuratedPrompt。只更新提供的字段，description 可设 null 清空。
- DELETE /api/admin/curated-prompts/:id：204 无响应体，删除站主推荐记录、独立永久原图/缩略图及收藏，保留个人源资产。
- title/text 去首尾空白后非空，最多 80/20000 字；description 最多 500 字；tags 最多 12 个、每个去空白后非空且最多 20 字，自动去重；sortOrder 为有符号 32 位整数。
- 非管理员 403、未登录 401、记录不存在 404、输入无效 400。
- 每次成功管理操作在事务中写入 curated_prompt.create/update/delete 审计，记录目标及修改字段，不记录全文或图片内容。

`GET /api/curated-prompts/:id/image` 和 `/thumbnail` 使用裸记录 ID，所有已登录用户可访问。回源不跳回边缘服务：本地存储回传字节，R2 返回对象下载签名 URL。前端应在边缘失败/签名过期时切换此路由。

GET /api/media-feed/assets、GET /api/assets、GET /api/assets/:id 和上传完成资产响应新增：

```ts
curatedPromptId?: string | null;
```

仅管理员返回：已收录为裸站主推荐 ID，未收录为 null。普通用户不返回此字段。

## 存储与缓存

- SQLite/PostgreSQL 两个迁移入口调用同一 curated DDL；版本提升为 2026-11-06.1，让旧部署初始化新表及新来源。
- 创建站主推荐复用资产复制逻辑，写入 permanent/curated/<id>.<ext>；读实际尺寸，复用 imageThumbnail 生成 permanent/curated/<id>-thumb.webp。这两个前缀均符合现有 API/Worker 白名单。
- 事务锁定 ready 资产，通过 source_asset_id 唯一索引处理并发。每个请求使用独立对象名；失败只清理自己的副本。源资产删除后 FK 置空，站主推荐和图片继续保留。
- 每次外部来源列表请求一次读取所有来源小字段（source_id/fetched_at/retry_at/是否有快照），只在首次读取或 fetched_at 变化时批量读取相应 items_json。
- 进程缓存每个 source_id 最新 fetched_at 对应的解析结果及预先小写化搜索文本。收藏和站主推荐每次读取数据库，签名 URL 每次生成；数据库保证跨实例正确性。
- 七天过期只设置 refreshNeeded，普通读取继续返回快照。真实刷新失败保留快照并返回 sourceErrors，退避 30 秒。数据库租约/token 条件更新协调并发；失去租约时读取数据库获胜版本。

## 验证与交接

- npx vitest run apps/api：32 文件、206 测试通过。
- npm run typecheck：shared/api 通过；web 的 src/features/prompts/PromptLibraryView.test.tsx、tests/prompt-library-view.test.tsx 旧 fixture 缺少 sources[].count，未越界修改。typecheck:scripts 已单独通过。
- apps/web/src/features/prompts/promptSources.test.ts：6 通过、5 失败，旧 fixture 和断言只涵盖两个来源；行为适配超出“仅类型适配”授权，留给前端负责人。
- 只读样本通过实际解析器：Freestylefly 541/541、ZeroLu 53/53，封面全部保留。
- 当前并行前端把管理响应当作 SourcedPrompt，并用完整带前缀 ID 调用管理路由，需要按本契约调整 ID/响应映射，或保存后重新拉取列表；同时接入图片回源路径。
- PostgreSQL 已验证迁移入口与 DDL，未连接真实 Neon/PostgreSQL，未调用生产写接口或真实收费生图，未 commit/push。
