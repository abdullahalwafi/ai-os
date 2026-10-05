-- Logical registry only. Reruns preserve existing agent settings.
USE dm_ai_os;
START TRANSACTION;

INSERT INTO agents (agent_key, brand_id, agent_type, name, status, config_json)
SELECT 'group_ceo', NULL, 'GROUP_CEO', 'Digital Musik Group CEO',
       'active', JSON_OBJECT('version', 1)
WHERE NOT EXISTS (SELECT 1 FROM agents WHERE agent_key = 'group_ceo');

INSERT INTO agents (agent_key, brand_id, agent_type, name, status, config_json)
SELECT CONCAT(b.brand_key, '_', role.suffix), b.id, role.agent_type,
       CONCAT(b.name, ' ', role.label), 'active', JSON_OBJECT('version', 1)
FROM brands b
CROSS JOIN (
  SELECT 'ceo' AS suffix, 'BRAND_CEO' AS agent_type, 'CEO' AS label
  UNION ALL SELECT 'seo', 'SEO_AGENT', 'SEO Agent'
  UNION ALL SELECT 'content', 'CONTENT_AGENT', 'Content Agent'
  UNION ALL SELECT 'web_qc', 'WEB_QC_AGENT', 'Web QC Agent'
  UNION ALL SELECT 'developer', 'DEVELOPER_AGENT', 'Developer Agent'
) AS role
WHERE b.brand_key IN ('digital_musik', 'audio_one', 'gg_audio', 'paudio')
  AND NOT EXISTS (
    SELECT 1 FROM agents a
    WHERE a.agent_key = CONCAT(b.brand_key, '_', role.suffix)
  );

COMMIT;
