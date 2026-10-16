ALTER TABLE identity_verification_submissions
    ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'pending',
    ADD COLUMN IF NOT EXISTS reviewed_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'identity_verification_submissions_status_check'
          AND conrelid = 'identity_verification_submissions'::regclass
    ) THEN
        ALTER TABLE identity_verification_submissions
            ADD CONSTRAINT identity_verification_submissions_status_check
            CHECK (status IN ('pending', 'approved', 'rejected'));
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS identity_verification_submissions_status_created_idx
    ON identity_verification_submissions (status, created_at DESC, id DESC);
