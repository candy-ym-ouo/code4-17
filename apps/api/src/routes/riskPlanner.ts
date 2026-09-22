import type { FastifyInstance } from "fastify";
import {
  exemptionCreateSchema,
  exemptionRevokeSchema,
  planBatchRisk,
  riskPlannerQuerySchema,
  summarizePlans,
  type PlannerBatchInput,
  type PlannerExemption,
  type RiskLevel
} from "@handcraft/contracts";
import type { AuthenticatedRequest } from "../lib/auth.js";
import { pool, withTransaction } from "../lib/db.js";
import { AppError } from "../lib/errors.js";
import { pageMeta, parsePagination } from "../lib/pagination.js";
import { parseInput } from "../lib/validation.js";
import { writeAudit } from "../lib/audit.js";

type Query = Record<string, string | undefined>;

const RISK_ORDER: Record<RiskLevel, number> = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3, NONE: 4 };

type BatchRow = {
  id: string;
  material_id: string;
  material_name: string;
  batch_code: string | null;
  remaining_quantity: string;
  stock_unit: string;
  expiry_at: string | null;
  opened_at: string | null;
  open_shelf_life_days: number | null;
  status: string;
};

type ConsumptionRow = {
  batch_id: string;
  consumed_at: string;
  total_quantity: string;
};

type ExemptionRow = {
  id: string;
  batch_id: string;
  reason: string;
  note: string | null;
  valid_from: string;
  valid_until: string;
  is_active: boolean;
  revoked_at: string | null;
  revoked_reason: string | null;
  created_at: string;
  actor_name: string;
};

function toExemption(row: ExemptionRow): PlannerExemption {
  return {
    id: row.id,
    reason: row.reason,
    validFrom: row.valid_from,
    validUntil: row.valid_until,
    status: row.is_active ? "ACTIVE" : row.revoked_at ? "REVOKED" : "EXPIRED",
    revokedReason: row.revoked_reason,
    revokedAt: row.revoked_at,
    createdAt: row.created_at
  };
}

function parsePlannerQuery(query: Query) {
  const parsed = parseInput(riskPlannerQuerySchema, {
    asOf: query.asOf,
    lookbackDays: query.lookbackDays,
    riskLevel: query.riskLevel
  });
  if (query.includeExempt !== undefined && query.includeExempt !== "true" && query.includeExempt !== "false") {
    throw new AppError(422, "VALIDATION_ERROR", "请求参数不符合要求", { includeExempt: ["只能是 true 或 false"] });
  }
  if (query.includeDepleted !== undefined && query.includeDepleted !== "true" && query.includeDepleted !== "false") {
    throw new AppError(422, "VALIDATION_ERROR", "请求参数不符合要求", { includeDepleted: ["只能是 true 或 false"] });
  }
  const asOf = parsed.asOf ?? new Date().toISOString().slice(0, 10);
  const lookbackDays = parsed.lookbackDays ?? 30;
  const includeExempt = query.includeExempt !== "false";
  const includeDepleted = query.includeDepleted === "true";
  return { asOf, lookbackDays, includeExempt, includeDepleted, riskLevel: parsed.riskLevel };
}

async function loadPlans(
  options: { asOf: string; lookbackDays: number; includeDepleted: boolean; batchIds?: string[] }
) {
  const { asOf, lookbackDays, includeDepleted } = options;
  const batchParams: string[] = [];
  const batchConditions = ["m.archived_at IS NULL", "b.status <> 'ARCHIVED'"];
  if (!includeDepleted) batchConditions.push("b.remaining_quantity > 0");
  if (options.batchIds) {
    batchParams.push(...options.batchIds);
    batchConditions.push(`b.id = ANY($${batchParams.length}::uuid[])`);
  }
  const batchResult = await pool.query<BatchRow>(
    `SELECT b.id, b.material_id AS material_id, m.name AS material_name, b.batch_code,
            b.remaining_quantity::text AS remaining_quantity, b.stock_unit,
            b.expiry_at, b.opened_at, m.open_shelf_life_days, b.status
       FROM batches b JOIN materials m ON m.id = b.material_id
      WHERE ${batchConditions.join(" AND ")}
      ORDER BY b.created_at DESC, b.id DESC`,
    batchParams
  );
  const batches = batchResult.rows;
  if (batches.length === 0) return { batches: [], plans: [] };
  const ids = batches.map((batch) => batch.id);

  const [consumptionResult, exemptionResult] = await Promise.all([
    pool.query<ConsumptionRow>(
      `SELECT batch_id, consumed_at::text AS consumed_at, total_quantity::text AS total_quantity
         FROM consumptions
        WHERE status = 'ACTIVE'
          AND batch_id = ANY($1::uuid[])
          AND consumed_at > $2::date - $3::int * INTERVAL '1 day'
          AND consumed_at < ($2::date + 1)`,
      [ids, asOf, lookbackDays]
    ),
    pool.query<ExemptionRow>(
      `SELECT DISTINCT ON (e.batch_id)
              e.id, e.batch_id, e.reason, e.note, e.valid_from::text AS valid_from,
              e.valid_until::text AS valid_until, e.created_at::text AS created_at,
              (e.valid_from <= $2::date AND e.valid_until >= $2::date AND r.id IS NULL) AS is_active,
              r.created_at::text AS revoked_at, r.reason AS revoked_reason
         FROM batch_exemptions e
         LEFT JOIN batch_exemptions r ON r.grant_id = e.id AND r.action = 'REVOKE'
        WHERE e.action = 'GRANT' AND e.batch_id = ANY($1::uuid[])
        ORDER BY e.batch_id,
                 (e.valid_from <= $2::date AND e.valid_until >= $2::date AND r.id IS NULL) DESC,
                 e.created_at DESC, e.id DESC`,
      [ids, asOf]
    )
  ]);

  const consumptionsByBatch = new Map<string, ConsumptionRow[]>();
  for (const row of consumptionResult.rows) {
    const list = consumptionsByBatch.get(row.batch_id) ?? [];
    list.push(row);
    consumptionsByBatch.set(row.batch_id, list);
  }
  const exemptionByBatch = new Map<string, ExemptionRow>();
  for (const row of exemptionResult.rows) exemptionByBatch.set(row.batch_id, row);

  const plans = batches.map((batch) => {
    const input: PlannerBatchInput = {
      id: batch.id,
      remainingQuantity: batch.remaining_quantity,
      stockUnit: batch.stock_unit,
      expiryAt: batch.expiry_at,
      openedAt: batch.opened_at,
      openShelfLifeDays: batch.open_shelf_life_days,
      consumptions: (consumptionsByBatch.get(batch.id) ?? []).map((row) => ({
        consumedAt: row.consumed_at,
        totalQuantity: row.total_quantity
      })),
      latestExemption: exemptionByBatch.has(batch.id) ? toExemption(exemptionByBatch.get(batch.id)!) : null
    };
    const plan = planBatchRisk(input, { asOf, lookbackDays });
    return {
      batchId: batch.id,
      materialId: batch.material_id,
      materialName: batch.material_name,
      batchCode: batch.batch_code,
      batchStatus: batch.status,
      plan
    };
  });

  return { batches, plans };
}

export async function riskPlannerRoutes(app: FastifyInstance): Promise<void> {
  // 批量重算：同一 asOf 与同一库存/消耗/豁免快照下结果稳定可复算。
  app.get<{ Querystring: Query }>("/risk-plans", async (request) => {
    const { page, pageSize, offset } = parsePagination(request.query);
    const options = parsePlannerQuery(request.query);
    const { plans } = await loadPlans(options);

    let filtered = plans.filter((entry) => {
      if (!options.includeExempt && entry.plan.exempt) return false;
      if (options.riskLevel && entry.plan.riskLevel !== options.riskLevel) return false;
      return true;
    });
    filtered = filtered.sort((a, b) => {
      const rank = RISK_ORDER[a.plan.riskLevel] - RISK_ORDER[b.plan.riskLevel];
      if (rank !== 0) return rank;
      const aDeadline = a.plan.bindingDeadline?.date ?? "9999-12-31";
      const bDeadline = b.plan.bindingDeadline?.date ?? "9999-12-31";
      if (aDeadline !== bDeadline) return aDeadline < bDeadline ? -1 : 1;
      return a.batchId < b.batchId ? -1 : a.batchId > b.batchId ? 1 : 0;
    });

    const total = filtered.length;
    const pageRows = filtered.slice(offset, offset + pageSize);
    return {
      data: pageRows,
      meta: {
        ...pageMeta(page, pageSize, total),
        asOf: options.asOf,
        lookbackDays: options.lookbackDays,
        summary: summarizePlans(plans.map((entry) => entry.plan))
      }
    };
  });

  app.get<{ Params: { id: string }; Querystring: Query }>("/batches/:id/risk-plan", async (request) => {
    const options = parsePlannerQuery(request.query);
    const { plans } = await loadPlans({ ...options, batchIds: [request.params.id] });
    const entry = plans.find((item) => item.batchId === request.params.id);
    if (!entry) throw new AppError(404, "NOT_FOUND", "批次不存在或已归档/耗尽");
    return { data: { asOf: options.asOf, lookbackDays: options.lookbackDays, ...entry } };
  });

  app.get<{ Params: { id: string } }>("/batches/:id/exemptions", async (request) => {
    const exists = await pool.query("SELECT 1 FROM batches WHERE id = $1", [request.params.id]);
    if (!exists.rowCount) throw new AppError(404, "NOT_FOUND", "批次不存在");
    const result = await pool.query(
      `SELECT e.id, e.action, e.reason, e.note, e.valid_from AS "validFrom", e.valid_until AS "validUntil",
              e.grant_id AS "grantId", e.created_at AS "createdAt", e.actor_user_id AS "actorUserId",
              u.display_name AS "actorName",
              CASE
                WHEN e.action = 'GRANT' THEN
                  (e.valid_from <= current_date AND e.valid_until >= current_date
                   AND NOT EXISTS (SELECT 1 FROM batch_exemptions r WHERE r.grant_id = e.id AND r.action = 'REVOKE'))
                ELSE false
              END AS "activeNow"
         FROM batch_exemptions e JOIN users u ON u.id = e.actor_user_id
        WHERE e.batch_id = $1
        ORDER BY e.created_at DESC, e.id DESC`,
      [request.params.id]
    );
    return { data: result.rows };
  });

  app.post<{ Params: { id: string } }>("/batches/:id/exemptions", async (request, reply) => {
    const input = parseInput(exemptionCreateSchema, request.body);
    const user = (request as AuthenticatedRequest).authUser;
    const granted = await withTransaction(async (client) => {
      const batch = await client.query<{ status: string }>(
        "SELECT status FROM batches WHERE id = $1 FOR UPDATE",
        [request.params.id]
      );
      if (!batch.rows[0]) throw new AppError(404, "NOT_FOUND", "批次不存在");
      if (batch.rows[0].status === "ARCHIVED") throw new AppError(409, "BATCH_ARCHIVED", "已归档批次不能设置豁免");

      const today = await client.query<{ today: string }>("SELECT current_date::text AS today");
      const currentDate = today.rows[0]?.today ?? "";
      if (!currentDate) throw new AppError(500, "DATE_UNAVAILABLE", "无法确定数据库当前日期");
      if (input.validUntil < currentDate) {
        throw new AppError(422, "INVALID_EXEMPTION_WINDOW", "豁免保留期限不能早于今天");
      }
      const active = await client.query(
        `SELECT 1 FROM batch_exemptions g
          WHERE g.batch_id = $1 AND g.action = 'GRANT'
            AND g.valid_from <= current_date AND g.valid_until >= current_date
            AND NOT EXISTS (SELECT 1 FROM batch_exemptions r WHERE r.grant_id = g.id AND r.action = 'REVOKE')
          LIMIT 1`,
        [request.params.id]
      );
      if (active.rowCount) throw new AppError(409, "EXEMPTION_ACTIVE", "该批次已有生效中的豁免，请先撤销再重新授予");

      const result = await client.query(
        `INSERT INTO batch_exemptions(batch_id, action, valid_from, valid_until, reason, note, actor_user_id)
         VALUES ($1, 'GRANT', current_date, $2::date, $3, $4, $5)
         RETURNING id, batch_id AS "batchId", action, valid_from AS "validFrom", valid_until AS "validUntil",
                   reason, note, created_at AS "createdAt"`,
        [request.params.id, input.validUntil, input.reason, input.note ?? null, user.id]
      );
      await writeAudit(client, {
        actorUserId: user.id,
        action: "GRANT_EXEMPTION",
        entityType: "BATCH_EXEMPTION",
        entityId: result.rows[0]?.id,
        afterData: result.rows[0],
        requestId: request.id
      });
      return result.rows[0];
    });
    return reply.status(201).send({ data: granted });
  });

  app.post<{ Params: { id: string } }>("/exemptions/:id/revoke", async (request) => {
    const input = parseInput(exemptionRevokeSchema, request.body);
    const user = (request as AuthenticatedRequest).authUser;
    const revoked = await withTransaction(async (client) => {
      const grant = await client.query<{ id: string; batch_id: string }>(
        `SELECT id, batch_id FROM batch_exemptions
          WHERE id = $1 AND action = 'GRANT' FOR UPDATE`,
        [request.params.id]
      );
      if (!grant.rows[0]) throw new AppError(404, "NOT_FOUND", "豁免记录不存在");
      const already = await client.query(
        "SELECT 1 FROM batch_exemptions WHERE grant_id = $1 AND action = 'REVOKE'",
        [request.params.id]
      );
      if (already.rowCount) throw new AppError(409, "EXEMPTION_REVOKED", "该豁免已经撤销");

      const result = await client.query(
        `INSERT INTO batch_exemptions(batch_id, action, reason, grant_id, actor_user_id)
         VALUES ($1, 'REVOKE', $2, $3, $4)
         RETURNING id, batch_id AS "batchId", action, grant_id AS "grantId", reason, created_at AS "createdAt"`,
        [grant.rows[0].batch_id, input.reason, request.params.id, user.id]
      );
      await writeAudit(client, {
        actorUserId: user.id,
        action: "REVOKE_EXEMPTION",
        entityType: "BATCH_EXEMPTION",
        entityId: result.rows[0]?.id,
        afterData: result.rows[0],
        requestId: request.id
      });
      return result.rows[0];
    });
    return { data: revoked };
  });
}
