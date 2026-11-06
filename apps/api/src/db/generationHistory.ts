import type { AppDatabase, DatabaseValue } from './database.js';

/** Filter and aggregate in SQL; only the requested page carries request/attempt JSON. */
export async function generationHistory(db: AppDatabase, filters: {
  userId?: string; from?: Date; to?: Date; status?: string;
  user?: string; model?: string; provider?: string; page: number; pageSize: number;
}) {
  const pg = db.dialect === 'postgres';
  const json = (value: string, path: string[]) => pg
    ? `paintopia_json(${value}::text) #>> '{${path.join(',')}}'`
    : `json_extract(CASE WHEN json_valid(${value}) THEN ${value} ELSE '{}' END, '$.${path.join('.')}')`;
  const params = pg ? 'paintopia_json(j.params_json)'  : "CASE WHEN json_valid(j.params_json) THEN j.params_json ELSE '{}' END";
  const attemptsPath = ['__paintopiaRuntime', 'imageGeneration', 'attempts'];
  const attempts = pg ? `(${params})::jsonb #> '{${attemptsPath.join(',')}}'` : json(params, attemptsPath);
  const actual = pg
    ? `(SELECT a.value FROM jsonb_array_elements(CASE WHEN jsonb_typeof(${attempts}) = 'array' THEN ${attempts} ELSE '[]'::jsonb END) WITH ORDINALITY a(value, ord)
        WHERE jsonb_typeof(a.value) = 'object' AND (j.status <> 'succeeded' OR a.value->>'providerId' IS NOT DISTINCT FROM j.provider_id) ORDER BY a.ord DESC LIMIT 1)`
    : `(SELECT a.value FROM json_each(CASE WHEN json_type(${params}, '$.${attemptsPath.join('.')}') = 'array' THEN ${attempts} ELSE '[]' END) a
        WHERE a.type = 'object' AND (j.status <> 'succeeded' OR json_extract(a.value, '$.providerId') IS j.provider_id) ORDER BY CAST(a.key AS INTEGER) DESC LIMIT 1)`;
  const conditions: string[] = [];
  const values: DatabaseValue[] = [];
  for (const [condition, value] of [
    ['j.user_id = ?', filters.userId], ['j.created_at >= ?', filters.from],
    ['j.created_at <= ?', filters.to], ['j.status = ?', filters.status]
  ] as const) if (value !== undefined) { conditions.push(condition); values.push(value); }
  const cte = `WITH base AS (
    SELECT j.*, u.email, ${actual} AS actual FROM generation_jobs j JOIN users u ON u.id = j.user_id
    ${conditions.length ? 'WHERE ' + conditions.join(' AND ') : ''}
  ), candidates AS (
    SELECT base.*, COALESCE(${json('actual', ['model'])}, ${json('params_json', ['model'])}) AS model,
      COALESCE(${json('actual', ['providerName'])}, ${json('params_json', ['providerName'])}, '未记录来源') AS provider_name,
      COALESCE(${json('actual', ['providerId'])}, provider_id) AS actual_provider_id
    FROM base
  )`;
  const search: string[] = [];
  const searchValues: DatabaseValue[] = [];
  for (const [query, columns] of [[filters.user, ['user_id', 'email']], [filters.model, ['model']], [filters.provider, ['actual_provider_id', 'provider_name']]] as const) {
    if (!query) continue;
    search.push('(' + columns.map(column => `${pg ? `strpos(lower(${column}), ?)` : `instr(lower(${column}), ?)`} > 0`).join(' OR ') + ')');
    columns.forEach(() => searchValues.push(query.toLowerCase()));
  }
  const filtered = cte + `, filtered AS (SELECT * FROM candidates ${search.length ? 'WHERE ' + search.join(' AND ') : ''})`;
  const bindings = [...values, ...searchValues];
  const duration = 'CASE WHEN updated_at > created_at THEN updated_at - created_at ELSE 0 END';
  const [rows, totals, choices] = await Promise.all([
    db.query<any>(`${filtered} SELECT * FROM filtered ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`, [...bindings, filters.pageSize, (filters.page - 1) * filters.pageSize]),
    db.queryOne<any>(`${filtered} SELECT COUNT(*) AS total,
      SUM(CASE WHEN status = 'succeeded' THEN 1 ELSE 0 END) AS succeeded,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
      AVG(CASE WHEN status IN ('succeeded','failed') THEN ${duration} ELSE NULL END) AS duration FROM filtered`, bindings),
    db.query<{ model: string | null; provider_name: string }>(`${cte} SELECT DISTINCT model, provider_name FROM candidates`, values)
  ]);
  // Ledger lookup is restricted to this page; never load another user's ledger into the process.
  const costs = rows.length ? await db.query<{ job_id: string; user_id: string; cost: number }>(`
    SELECT ${json('note', ['jobId'])} AS job_id, user_id, -SUM(amount) AS cost FROM usage_ledger
    WHERE action = 'image_generation' AND (${rows.map(() => `(user_id = ? AND ${json('note', ['jobId'])} = ?)`).join(' OR ')})
    GROUP BY user_id, ${json('note', ['jobId'])}`, rows.flatMap(row => [row.user_id, row.id])) : [];
  const items = rows.map(row => {
    let params: any = {};
    try { params = JSON.parse(row.params_json) ?? {}; } catch { /* Legacy invalid JSON. */ }
    const generation = params?.__paintopiaRuntime?.imageGeneration;
    return { id: row.id, userId: row.user_id, userEmail: row.email, providerId: row.actual_provider_id,
      providerName: row.provider_name, model: row.model, status: row.status,
      createdAt: new Date(Number(row.created_at)).toISOString(), updatedAt: new Date(Number(row.updated_at)).toISOString(),
      params, error: row.error, durationMs: Math.max(0, Number(row.updated_at) - Number(row.created_at)),
      outputs: Array.isArray(generation?.outputs) ? generation.outputs : [],
      attempts: Array.isArray(generation?.attempts) ? generation.attempts.filter((v: unknown) => v && typeof v === 'object' && !Array.isArray(v)) : [],
      quotaCost: Number(costs.find(cost => cost.job_id === row.id && cost.user_id === row.user_id)?.cost ?? 0) };
  });
  const total = Number(totals?.total ?? 0), succeeded = Number(totals?.succeeded ?? 0);
  return { items, total, page: filters.page, pageSize: filters.pageSize,
    summary: { total, succeeded, failed: Number(totals?.failed ?? 0), successRate: total ? succeeded / total : 0, averageDurationMs: Number(totals?.duration ?? 0) },
    options: { models: [...new Set(choices.map(v => v.model).filter(v => typeof v === 'string'))], providers: [...new Set(choices.map(v => v.provider_name))] } };
}
