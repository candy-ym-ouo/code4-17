-- 材料效期风险规划器：开封日、开封后建议使用天数、人工豁免事件链。
--
-- 豁免采用只追加事件链：每次授予写一条 GRANT，每次撤销写一条 REVOKE，
-- 不更新、不删除历史；是否生效在查询/重算时按 asOf 与撤销事件推导。

ALTER TABLE materials
  ADD COLUMN open_shelf_life_days integer CHECK (open_shelf_life_days IS NULL OR (open_shelf_life_days BETWEEN 1 AND 3650));

ALTER TABLE batches
  ADD COLUMN opened_at date,
  ADD CONSTRAINT batches_opened_after_received CHECK (opened_at IS NULL OR opened_at >= received_at),
  ADD CONSTRAINT batches_opened_before_expiry CHECK (opened_at IS NULL OR expiry_at IS NULL OR opened_at <= expiry_at);

CREATE INDEX batches_opened_idx ON batches(opened_at);

CREATE TABLE batch_exemptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id uuid NOT NULL REFERENCES batches(id),
  action varchar(8) NOT NULL CHECK (action IN ('GRANT', 'REVOKE')),
  -- GRANT 事件的豁免窗口与原因
  valid_from date,
  valid_until date,
  reason varchar(1000) NOT NULL CHECK (length(btrim(reason)) >= 3),
  note varchar(2000),
  -- REVOKE 事件指向被撤销的 GRANT
  grant_id uuid REFERENCES batch_exemptions(id),
  actor_user_id uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT batch_exemptions_grant_window_chk CHECK (
    action <> 'GRANT' OR (valid_from IS NOT NULL AND valid_until IS NOT NULL AND valid_until >= valid_from)
  ),
  CONSTRAINT batch_exemptions_revoke_ref_chk CHECK (
    action <> 'REVOKE' OR grant_id IS NOT NULL
  )
);
CREATE INDEX batch_exemptions_batch_idx ON batch_exemptions(batch_id, created_at DESC);
CREATE INDEX batch_exemptions_grant_idx ON batch_exemptions(grant_id) WHERE action = 'REVOKE';
-- 每条 GRANT 至多被撤销一次。
CREATE UNIQUE INDEX batch_exemptions_revoke_once_uq
  ON batch_exemptions(grant_id) WHERE action = 'REVOKE';
