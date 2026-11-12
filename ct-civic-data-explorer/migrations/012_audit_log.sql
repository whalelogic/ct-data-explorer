-- Who did what, and when: sign-ins, account changes, dataset publication and report
-- removal. Rows are only ever inserted. The actor's email is stored as text beside the
-- id so the history still reads correctly after an account is renamed or deactivated.
CREATE TABLE audit_log (
  id           BIGINT AUTO_INCREMENT PRIMARY KEY,
  occurred_at  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  actor_id     INT          NULL,                 -- NULL when nobody was signed in (failed sign-in)
  actor_email  VARCHAR(254) NULL,
  action       VARCHAR(60)  NOT NULL,             -- 'dataset.published', 'user.invited', ...
  target_type  VARCHAR(30)  NULL,                 -- 'user' | 'dataset' | 'report'
  target_id    INT          NULL,
  target_label VARCHAR(300) NULL,                 -- the name at the time, for reading the log
  details      JSON         NULL,
  ip           VARCHAR(45)  NULL,
  KEY audit_log_occurred_idx (occurred_at),
  KEY audit_log_action_idx (action, id),
  KEY audit_log_actor_idx (actor_id, id)
) DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_0900_as_cs;
