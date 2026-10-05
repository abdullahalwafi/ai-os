-- TASK 002: run only against the existing dm_ai_os database.
-- DDL auto-commits in MySQL; rerunning completes an interrupted migration.
USE dm_ai_os;

CREATE TABLE IF NOT EXISTS brands (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  brand_key VARCHAR(50) NOT NULL UNIQUE,
  name VARCHAR(100) NOT NULL,
  domain VARCHAR(255) NOT NULL UNIQUE,
  website_url VARCHAR(500) NOT NULL,
  status ENUM('active','inactive') NOT NULL DEFAULT 'active',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS agents (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  agent_key VARCHAR(100) NOT NULL UNIQUE,
  brand_id BIGINT UNSIGNED NULL,
  agent_type ENUM('GROUP_CEO','BRAND_CEO','SEO_AGENT','CONTENT_AGENT','WEB_QC_AGENT','DEVELOPER_AGENT') NOT NULL,
  name VARCHAR(100) NOT NULL,
  status ENUM('active','inactive') NOT NULL DEFAULT 'inactive',
  config_json JSON NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_agents_brand FOREIGN KEY (brand_id) REFERENCES brands(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS tasks (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  task_key VARCHAR(100) NOT NULL UNIQUE,
  brand_id BIGINT UNSIGNED NULL,
  assigned_agent_id BIGINT UNSIGNED NULL,
  task_type VARCHAR(100) NOT NULL,
  title VARCHAR(255) NOT NULL,
  description TEXT NULL,
  priority ENUM('P1','P2','P3','P4') NOT NULL DEFAULT 'P3',
  status ENUM('created','queued','running','waiting','need_approval','completed','failed','cancelled') NOT NULL DEFAULT 'created',
  payload_json JSON NULL,
  result_json JSON NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  started_at TIMESTAMP NULL DEFAULT NULL,
  completed_at TIMESTAMP NULL DEFAULT NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_tasks_status_priority (status, priority, created_at),
  CONSTRAINT fk_tasks_brand FOREIGN KEY (brand_id) REFERENCES brands(id) ON DELETE SET NULL,
  CONSTRAINT fk_tasks_agent FOREIGN KEY (assigned_agent_id) REFERENCES agents(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS events (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  event_key VARCHAR(100) NOT NULL UNIQUE,
  brand_id BIGINT UNSIGNED NULL,
  event_type VARCHAR(150) NOT NULL,
  source VARCHAR(100) NOT NULL,
  payload_json JSON NULL,
  status ENUM('pending','processed','failed') NOT NULL DEFAULT 'pending',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  processed_at TIMESTAMP NULL DEFAULT NULL,
  KEY idx_events_status_created (status, created_at),
  CONSTRAINT fk_events_brand FOREIGN KEY (brand_id) REFERENCES brands(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Callers must exclude passwords, API keys, tokens, cookies and other secrets
-- from message/context_json and all other stored payloads.
CREATE TABLE IF NOT EXISTS activity_logs (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  brand_id BIGINT UNSIGNED NULL,
  agent_id BIGINT UNSIGNED NULL,
  task_id BIGINT UNSIGNED NULL,
  level ENUM('INFO','WARN','ERROR') NOT NULL DEFAULT 'INFO',
  action VARCHAR(150) NOT NULL,
  message TEXT NOT NULL,
  context_json JSON NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_activity_logs_created (created_at),
  CONSTRAINT fk_activity_logs_brand FOREIGN KEY (brand_id) REFERENCES brands(id) ON DELETE SET NULL,
  CONSTRAINT fk_activity_logs_agent FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE SET NULL,
  CONSTRAINT fk_activity_logs_task FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Preserve existing registry data on reruns; do not overwrite edited brands.
INSERT INTO brands (brand_key, name, domain, website_url)
SELECT seed.brand_key, seed.name, seed.domain, seed.website_url
FROM (
  SELECT 'digital_musik' AS brand_key, 'Digital Musik' AS name,
         'digitalmusik.id' AS domain, 'https://digitalmusik.id' AS website_url
  UNION ALL SELECT 'audio_one', 'Audio One', 'audioonepro.com', 'https://audioonepro.com'
  UNION ALL SELECT 'gg_audio', 'GG Audio', 'ggaudio.id', 'https://ggaudio.id'
  UNION ALL SELECT 'paudio', 'P.Audio', 'paudio.id', 'https://paudio.id'
) AS seed
WHERE NOT EXISTS (SELECT 1 FROM brands b WHERE b.brand_key = seed.brand_key);
