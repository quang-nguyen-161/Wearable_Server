-- migrations/001_assignments.sql
-- Architecture v2 Patient Assignment and Watch Metadata Schema
-- Enforces interval constraints [validFrom, validTo), tenant isolation, and idempotency store.

CREATE EXTENSION IF NOT EXISTS btree_gist;

-- 1. Watch Registry (Tenant-scoped)
CREATE TABLE IF NOT EXISTS watches (
    tenant_id VARCHAR(64) NOT NULL,
    watch_mac VARCHAR(17) NOT NULL, -- Format: AA:BB:CC:DD:EE:FF
    tb_device_id VARCHAR(64),
    label VARCHAR(128),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (tenant_id, watch_mac)
);

-- 2. Patient Reference Registry (Tenant-scoped)
CREATE TABLE IF NOT EXISTS patients (
    tenant_id VARCHAR(64) NOT NULL,
    patient_id VARCHAR(64) NOT NULL,
    name VARCHAR(128) NOT NULL,
    mrn VARCHAR(64),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (tenant_id, patient_id)
);

-- 3. Patient Assignments Table with Strict Interval Constraints
CREATE TABLE IF NOT EXISTS assignments (
    assignment_id VARCHAR(64) PRIMARY KEY,
    tenant_id VARCHAR(64) NOT NULL,
    watch_mac VARCHAR(17) NOT NULL,
    patient_id VARCHAR(64) NOT NULL,
    valid_from BIGINT NOT NULL, -- UTC epoch milliseconds
    valid_to BIGINT,            -- UTC epoch milliseconds, NULL means open interval [valid_from, infinity)
    version INTEGER NOT NULL DEFAULT 1,
    created_by VARCHAR(64),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_assignment_interval CHECK (valid_to IS NULL OR valid_from < valid_to),
    CONSTRAINT fk_assignment_watch FOREIGN KEY (tenant_id, watch_mac)
        REFERENCES watches(tenant_id, watch_mac) ON DELETE RESTRICT,
    CONSTRAINT fk_assignment_patient FOREIGN KEY (tenant_id, patient_id)
        REFERENCES patients(tenant_id, patient_id) ON DELETE RESTRICT,
    CONSTRAINT no_assignment_overlap EXCLUDE USING gist (
        tenant_id WITH =,
        watch_mac WITH =,
        int8range(valid_from, COALESCE(valid_to, 9223372036854775807), '[)') WITH &&
    )
);

CREATE INDEX IF NOT EXISTS idx_assignments_tenant_patient
    ON assignments(tenant_id, patient_id, valid_from);

CREATE INDEX IF NOT EXISTS idx_assignments_tenant_mac
    ON assignments(tenant_id, watch_mac, valid_from);

-- 4. Idempotency Key Store (Strict tenant+actor+operation scoping)
CREATE TABLE IF NOT EXISTS idempotency_keys (
    tenant_id VARCHAR(64) NOT NULL,
    actor VARCHAR(64) NOT NULL,
    operation VARCHAR(64) NOT NULL,
    idempotency_key VARCHAR(128) NOT NULL,
    request_hash VARCHAR(64) NOT NULL,
    status_code INTEGER NOT NULL,
    response_body TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (tenant_id, actor, operation, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_idempotency_expires
    ON idempotency_keys(expires_at);

-- 5. Assignment Audit Log
CREATE TABLE IF NOT EXISTS assignment_audit_log (
    audit_id BIGSERIAL PRIMARY KEY,
    assignment_id VARCHAR(64) NOT NULL,
    tenant_id VARCHAR(64) NOT NULL,
    action VARCHAR(32) NOT NULL, -- CREATED, CLOSED, REASSIGNED
    actor VARCHAR(64),
    old_state JSONB,
    new_state JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_assignment
    ON assignment_audit_log(tenant_id, assignment_id, created_at);

-- -----------------------------------------------------------------------------
-- ROLLBACK / DOWN MIGRATION (Execute manually if rollback is required)
-- -----------------------------------------------------------------------------
-- DROP TABLE IF EXISTS assignment_audit_log;
-- DROP TABLE IF EXISTS idempotency_keys;
-- DROP TABLE IF EXISTS assignments;
-- DROP TABLE IF EXISTS patients;
-- DROP TABLE IF EXISTS watches;
