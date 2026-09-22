<script setup lang="ts">
import { computed, onMounted, reactive, ref } from "vue";
import { ElMessage } from "element-plus";
import { request, ApiError } from "@/lib/api";
import { localDateValue } from "@/lib/dates";
import {
  deadlineKindLabels,
  disposalActionLabels,
  riskLevelLabels,
  riskLevelTypes,
  type BatchRiskPlanData
} from "@/types";

const props = defineProps<{ batchId: string }>();

type ExemptionEvent = {
  id: string;
  action: "GRANT" | "REVOKE";
  reason: string;
  note: string | null;
  validFrom: string | null;
  validUntil: string | null;
  grantId: string | null;
  activeNow: boolean;
  createdAt: string;
  actorName: string;
};

const loading = ref(true);
const plan = ref<BatchRiskPlanData | null>(null);
const events = ref<ExemptionEvent[]>([]);
const asOf = ref(localDateValue());
const lookbackDays = ref(30);
const grantVisible = ref(false);
const revokeTargetId = ref<string | null>(null);
const saving = ref(false);
const grantForm = reactive({ reason: "", validUntil: localDateValue(), note: "" });
const revokeReason = ref("");

async function load() {
  loading.value = true;
  try {
    const [planResponse, eventsResponse] = await Promise.all([
      request<{ data: BatchRiskPlanData & { asOf: string; lookbackDays: number } }>(
        `/batches/${props.batchId}/risk-plan?asOf=${asOf.value}&lookbackDays=${lookbackDays.value}&includeDepleted=true`
      ),
      request<{ data: ExemptionEvent[] }>(`/batches/${props.batchId}/exemptions`)
    ]);
    plan.value = planResponse.data;
    events.value = eventsResponse.data;
  } catch (error) {
    ElMessage.error(error instanceof ApiError ? error.message : "效期规划加载失败");
  } finally {
    loading.value = false;
  }
}

async function submitGrant() {
  if (grantForm.reason.trim().length < 3) {
    ElMessage.error("请填写至少 3 个字的豁免原因");
    return;
  }
  if (!grantForm.validUntil) {
    ElMessage.error("请选择豁免保留期限");
    return;
  }
  saving.value = true;
  try {
    await request(`/batches/${props.batchId}/exemptions`, {
      method: "POST",
      body: {
        reason: grantForm.reason.trim(),
        validUntil: grantForm.validUntil,
        note: grantForm.note.trim() || null
      }
    });
    ElMessage.success("人工豁免已授予，系统建议已保留在原因链中");
    grantVisible.value = false;
    grantForm.reason = "";
    grantForm.note = "";
    await load();
  } catch (error) {
    ElMessage.error(error instanceof ApiError ? error.message : "豁免授予失败");
  } finally {
    saving.value = false;
  }
}

async function submitRevoke() {
  if (revokeReason.value.trim().length < 3) {
    ElMessage.error("请填写至少 3 个字的撤销原因");
    return;
  }
  const targetId = revokeTargetId.value;
  if (!targetId) return;
  saving.value = true;
  try {
    await request(`/exemptions/${targetId}/revoke`, {
      method: "POST",
      body: { reason: revokeReason.value.trim() }
    });
    ElMessage.success("豁免已撤销，系统建议即刻恢复");
    revokeTargetId.value = null;
    revokeReason.value = "";
    await load();
  } catch (error) {
    ElMessage.error(error instanceof ApiError ? error.message : "豁免撤销失败");
  } finally {
    saving.value = false;
  }
}

function openGrant() {
  grantForm.validUntil = localDateValue();
  grantForm.reason = "";
  grantForm.note = "";
  grantVisible.value = true;
}

const revokeVisible = computed({
  get: () => revokeTargetId.value !== null,
  set: (value) => {
    if (!value) revokeTargetId.value = null;
  }
});

onMounted(load);
</script>

<template>
  <section class="panel" v-loading="loading">
    <div class="risk-header">
      <h2>效期风险规划</h2>
      <div class="risk-controls">
        <el-date-picker v-model="asOf" type="date" value-format="YYYY-MM-DD" size="small" @change="load" />
        <el-input-number v-model="lookbackDays" :min="7" :max="730" size="small" controls-position="right" style="width:130px" @change="load" />
        <span class="muted">天速率窗口</span>
        <el-button size="small" @click="load">重算</el-button>
        <el-button v-if="plan && !plan.exempt" size="small" type="warning" plain @click="openGrant">人工豁免</el-button>
      </div>
    </div>

    <template v-if="plan">
      <div class="risk-summary">
        <el-tag :type="riskLevelTypes[plan.riskLevel]" size="large">
          {{ riskLevelLabels[plan.riskLevel] || plan.riskLevel }}
        </el-tag>
        <el-tag size="large" effect="plain">{{ disposalActionLabels[plan.action] || plan.action }}</el-tag>
        <el-tag v-if="plan.underlyingRiskLevel !== plan.riskLevel" size="small" type="info">
          叠加豁免前：{{ riskLevelLabels[plan.underlyingRiskLevel] }} / {{ disposalActionLabels[plan.underlyingAction] }}
        </el-tag>
      </div>

      <el-descriptions :column="3" border size="small" class="risk-metrics">
        <el-descriptions-item label="剩余量">{{ plan.remainingQuantity }} {{ plan.stockUnit }}</el-descriptions-item>
        <el-descriptions-item label="开封日">{{ plan.openedAt || "未开封/未记录" }}</el-descriptions-item>
        <el-descriptions-item label="密封有效期">
          {{ plan.sealedExpiryAt || "无" }}
          <span v-if="plan.sealedDaysRemaining !== null" class="muted">（剩 {{ plan.sealedDaysRemaining }} 天）</span>
        </el-descriptions-item>
        <el-descriptions-item label="约束到期日">
          <template v-if="plan.bindingDeadline">
            {{ deadlineKindLabels[plan.bindingDeadline.kind] }} {{ plan.bindingDeadline.date }}
            <span class="muted">（剩 {{ plan.bindingDeadline.daysRemaining }} 天）</span>
          </template>
          <span v-else class="muted">无约束</span>
        </el-descriptions-item>
        <el-descriptions-item label="开封后效期剩余">
          <span v-if="plan.openDaysRemaining !== null">{{ plan.openDaysRemaining }} 天</span>
          <span v-else class="muted">未配置</span>
        </el-descriptions-item>
        <el-descriptions-item label="日均使用速率">
          <template v-if="plan.dailyUsageRate">{{ plan.dailyUsageRate }} {{ plan.stockUnit }}/天</template>
          <span v-else class="muted">无消耗样本</span>
        </el-descriptions-item>
        <el-descriptions-item label="预计耗尽">{{ plan.coverageDays !== null ? `约 ${plan.coverageDays} 天` : "无法估算" }}</el-descriptions-item>
        <el-descriptions-item label="到期日预计剩余">
          <template v-if="plan.projectedLeftover !== null">{{ plan.projectedLeftover }} {{ plan.stockUnit }}</template>
          <span v-else class="muted">—</span>
        </el-descriptions-item>
        <el-descriptions-item label="窗口消耗">
          {{ plan.consumedQuantity }} {{ plan.stockUnit }} · {{ plan.consumptionCount }} 笔（按 {{ plan.rateBasisDays }} 天计速率）
        </el-descriptions-item>
      </el-descriptions>

      <h3>判定原因链</h3>
      <el-timeline class="reason-chain">
        <el-timeline-item
          v-for="(reason, index) in plan.reasons"
          :key="`${reason.code}-${index}`"
          :type="reason.code.startsWith('EXEMPT') ? 'warning' : reason.code.includes('EXPIRED') ? 'danger' : 'primary'"
        >
          <code class="reason-code">{{ reason.code }}</code>
          <span>{{ reason.message }}</span>
        </el-timeline-item>
      </el-timeline>
    </template>

    <template v-if="events.length">
      <h3>人工豁免记录</h3>
      <el-table :data="events" size="small">
        <el-table-column label="动作" width="80">
          <template #default="{ row }">
            <el-tag :type="row.action === 'GRANT' ? 'warning' : 'danger'" size="small">
              {{ row.action === "GRANT" ? "授予" : "撤销" }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="保留期限" width="200">
          <template #default="{ row }">
            <template v-if="row.action === 'GRANT'">{{ row.validFrom }} 至 {{ row.validUntil }}</template>
            <span v-else class="muted">—</span>
          </template>
        </el-table-column>
        <el-table-column label="原因" prop="reason" />
        <el-table-column label="操作人" prop="actorName" width="110" />
        <el-table-column label="时间" width="170">
          <template #default="{ row }">{{ new Date(row.createdAt).toLocaleString() }}</template>
        </el-table-column>
        <el-table-column label="操作" width="100">
          <template #default="{ row }">
            <el-button
              v-if="row.action === 'GRANT' && row.activeNow"
              size="small" type="danger" plain
              @click="revokeTargetId = row.id; revokeReason = ''"
            >撤销</el-button>
          </template>
        </el-table-column>
      </el-table>
    </template>

    <el-dialog v-model="grantVisible" title="人工豁免" width="520px">
      <el-alert
        title="豁免只改变处置建议（标记为豁免保留），不会删除系统判定；原始风险级别和完整原因链始终保留，豁免到期后自动恢复系统建议。"
        type="warning" show-icon :closable="false" style="margin-bottom:16px"
      />
      <el-form label-position="top">
        <el-form-item label="豁免原因" required>
          <el-input v-model="grantForm.reason" type="textarea" :rows="3" maxlength="1000" show-word-limit placeholder="例如：供应商书面确认延期，本月留样检测合格" />
        </el-form-item>
        <el-form-item label="保留期限至" required>
          <el-date-picker v-model="grantForm.validUntil" type="date" value-format="YYYY-MM-DD" style="width:100%" />
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="grantForm.note" maxlength="2000" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="grantVisible = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="submitGrant">授予豁免</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="revokeVisible" title="撤销豁免" width="480px">
      <el-form label-position="top">
        <el-form-item label="撤销原因" required>
          <el-input v-model="revokeReason" type="textarea" :rows="3" maxlength="1000" show-word-limit placeholder="撤销后立即恢复系统处置建议" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="revokeTargetId = null">取消</el-button>
        <el-button type="danger" :loading="saving" @click="submitRevoke">确认撤销</el-button>
      </template>
    </el-dialog>
  </section>
</template>

<style scoped>
.risk-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}
.risk-controls {
  display: flex;
  align-items: center;
  gap: 8px;
}
.risk-summary {
  display: flex;
  gap: 8px;
  margin: 12px 0;
}
.risk-metrics {
  margin: 8px 0 16px;
}
.reason-chain {
  margin-top: 8px;
  padding-left: 4px;
}
.reason-code {
  margin-right: 8px;
  font-size: 12px;
  background: var(--el-fill-color-light);
  padding: 1px 6px;
  border-radius: 4px;
}
</style>
