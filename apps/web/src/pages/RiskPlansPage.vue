<script setup lang="ts">
import { onMounted, ref } from "vue";
import { ElMessage } from "element-plus";
import { request, ApiError } from "@/lib/api";
import { localDateValue } from "@/lib/dates";
import {
  deadlineKindLabels,
  disposalActionLabels,
  riskLevelLabels,
  riskLevelTypes,
  type BatchRiskPlanData,
  type PlannerSummary
} from "@/types";

type PlanRow = BatchRiskPlanData & {
  materialId: string;
  materialName: string;
  batchCode: string | null;
  batchStatus: string;
};

type Meta = {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  asOf: string;
  lookbackDays: number;
  summary: PlannerSummary;
};

const loading = ref(true);
const rows = ref<PlanRow[]>([]);
const meta = ref<Meta | null>(null);
const page = ref(1);
const filters = ref({
  asOf: localDateValue(),
  lookbackDays: 30,
  riskLevel: "",
  includeExempt: true
});

async function load() {
  loading.value = true;
  try {
    const params = new URLSearchParams({
      asOf: filters.value.asOf,
      lookbackDays: String(filters.value.lookbackDays),
      page: String(page.value),
      pageSize: "50",
      includeExempt: String(filters.value.includeExempt),
      includeDepleted: "false"
    });
    if (filters.value.riskLevel) params.set("riskLevel", filters.value.riskLevel);
    const response = await request<{ data: PlanRow[]; meta: Meta }>(`/risk-plans?${params.toString()}`);
    rows.value = response.data;
    meta.value = response.meta;
  } catch (error) {
    ElMessage.error(error instanceof ApiError ? error.message : "效期规划加载失败");
  } finally {
    loading.value = false;
  }
}

function applyFilters() {
  page.value = 1;
  void load();
}

onMounted(load);
</script>

<template>
  <div v-loading="loading">
    <header class="page-header">
      <div>
        <h1>效期风险规划</h1>
        <p>结合剩余量、开封日与实际使用速率重算处置建议；同一基准日与库存快照下结果稳定可复算。</p>
      </div>
    </header>

    <section class="panel">
      <div class="planner-filters">
        <div>
          <div class="muted">基准日</div>
          <el-date-picker v-model="filters.asOf" type="date" value-format="YYYY-MM-DD" @change="applyFilters" />
        </div>
        <div>
          <div class="muted">速率回看窗口（天）</div>
          <el-input-number v-model="filters.lookbackDays" :min="7" :max="730" controls-position="right" @change="applyFilters" />
        </div>
        <div>
          <div class="muted">风险级别</div>
          <el-select v-model="filters.riskLevel" clearable placeholder="全部" style="width:140px" @change="applyFilters">
            <el-option v-for="(label, value) in riskLevelLabels" :key="value" :value="value" :label="label" />
          </el-select>
        </div>
        <div>
          <div class="muted">人工豁免</div>
          <el-switch v-model="filters.includeExempt" active-text="包含" inactive-text="隐藏" @change="applyFilters" />
        </div>
        <el-button @click="load">重算</el-button>
      </div>

      <div v-if="meta" class="risk-summary-bar">
        <el-tag type="danger">严重 {{ meta.summary.byRiskLevel.CRITICAL ?? 0 }}</el-tag>
        <el-tag type="warning">高 {{ meta.summary.byRiskLevel.HIGH ?? 0 }}</el-tag>
        <el-tag type="primary">中 {{ meta.summary.byRiskLevel.MEDIUM ?? 0 }}</el-tag>
        <el-tag type="success">低 {{ meta.summary.byRiskLevel.LOW ?? 0 }}</el-tag>
        <el-tag type="info">豁免 {{ meta.summary.exemptCount ?? 0 }}</el-tag>
        <span class="muted">共 {{ meta.summary.total }} 个在库批次 · 基准日 {{ meta.asOf }} · 窗口 {{ meta.lookbackDays }} 天</span>
      </div>
    </section>

    <section class="panel" style="margin-top:16px">
      <el-table :data="rows" size="small">
        <el-table-column label="风险" width="80">
          <template #default="{ row }">
            <el-tag :type="riskLevelTypes[row.riskLevel]" size="small">{{ riskLevelLabels[row.riskLevel] || row.riskLevel }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="处置建议" width="150">
          <template #default="{ row }">
            <strong>{{ disposalActionLabels[row.action] || row.action }}</strong>
            <div v-if="row.underlyingAction !== row.action" class="muted" style="font-size:12px">
              原建议：{{ disposalActionLabels[row.underlyingAction] }}
            </div>
          </template>
        </el-table-column>
        <el-table-column label="批次" min-width="180">
          <template #default="{ row }">
            <router-link :to="`/batches/${row.batchId}`">{{ row.materialName }}</router-link>
            <div class="muted">{{ row.batchCode || "无批次号" }}</div>
          </template>
        </el-table-column>
        <el-table-column label="剩余量" width="130">
          <template #default="{ row }">{{ row.remainingQuantity }} {{ row.stockUnit }}</template>
        </el-table-column>
        <el-table-column label="约束到期" width="170">
          <template #default="{ row }">
            <template v-if="row.bindingDeadline">
              {{ deadlineKindLabels[row.bindingDeadline.kind] }} {{ row.bindingDeadline.date }}
              <div :class="row.bindingDeadline.daysRemaining < 0 ? 'danger-text' : 'muted'" style="font-size:12px">
                {{ row.bindingDeadline.daysRemaining < 0 ? `已过期 ${-row.bindingDeadline.daysRemaining} 天` : `剩 ${row.bindingDeadline.daysRemaining} 天` }}
              </div>
            </template>
            <span v-else class="muted">无</span>
          </template>
        </el-table-column>
        <el-table-column label="日均速率" width="130">
          <template #default="{ row }">
            <template v-if="row.dailyUsageRate">{{ row.dailyUsageRate }} {{ row.stockUnit }}/天</template>
            <span v-else class="muted">无样本</span>
          </template>
        </el-table-column>
        <el-table-column label="预计耗尽" width="100">
          <template #default="{ row }">{{ row.coverageDays !== null ? `${row.coverageDays} 天` : "—" }}</template>
        </el-table-column>
        <el-table-column label="到期预计剩余" width="130">
          <template #default="{ row }">
            <template v-if="row.projectedLeftover !== null">{{ row.projectedLeftover }} {{ row.stockUnit }}</template>
            <span v-else>—</span>
          </template>
        </el-table-column>
        <el-table-column label="关键原因" min-width="240">
          <template #default="{ row }">
            <el-tooltip placement="top" :show-after="200">
              <template #content>
                <div v-for="(reason, index) in row.reasons" :key="index" style="max-width:420px">
                  <strong>{{ reason.code }}</strong>：{{ reason.message }}
                </div>
              </template>
              <span>{{ row.reasons[row.reasons.length - 1]?.message || "—" }}</span>
            </el-tooltip>
          </template>
        </el-table-column>
      </el-table>

      <el-empty v-if="!rows.length && !loading" description="该筛选条件下没有需要规划的批次" />

      <div v-if="meta && meta.totalPages > 1" class="pager">
        <el-pagination
          layout="prev, pager, next"
          :current-page="page"
          :page-size="meta.pageSize"
          :total="meta.total"
          @current-change="(value: number) => { page = value; void load(); }"
        />
      </div>
    </section>
  </div>
</template>

<style scoped>
.planner-filters {
  display: flex;
  gap: 16px;
  align-items: flex-end;
  flex-wrap: wrap;
}
.risk-summary-bar {
  display: flex;
  gap: 8px;
  align-items: center;
  margin-top: 16px;
  flex-wrap: wrap;
}
.pager {
  display: flex;
  justify-content: center;
  margin-top: 12px;
}
.danger-text {
  color: var(--el-color-danger);
}
</style>
