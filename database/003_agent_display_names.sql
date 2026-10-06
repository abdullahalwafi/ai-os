-- TASK 018: stable human display names; agent_key and relationships remain unchanged.
USE dm_ai_os;
START TRANSACTION;
UPDATE agents
SET name = CASE agent_key
  WHEN 'group_ceo' THEN 'Wafi'
  WHEN 'digital_musik_ceo' THEN 'Nara'
  WHEN 'digital_musik_seo' THEN 'Raka'
  WHEN 'digital_musik_content' THEN 'Mira'
  WHEN 'digital_musik_web_qc' THEN 'Tara'
  WHEN 'digital_musik_developer' THEN 'Dion'
  WHEN 'audio_one_ceo' THEN 'Arka'
  WHEN 'audio_one_seo' THEN 'Reno'
  WHEN 'audio_one_content' THEN 'Luna'
  WHEN 'audio_one_web_qc' THEN 'Kira'
  WHEN 'audio_one_developer' THEN 'Niko'
  WHEN 'gg_audio_ceo' THEN 'Gema'
  WHEN 'gg_audio_seo' THEN 'Zeno'
  WHEN 'gg_audio_content' THEN 'Cleo'
  WHEN 'gg_audio_web_qc' THEN 'Vega'
  WHEN 'gg_audio_developer' THEN 'Rian'
  WHEN 'paudio_ceo' THEN 'Vira'
  WHEN 'paudio_seo' THEN 'Sena'
  WHEN 'paudio_content' THEN 'Naya'
  WHEN 'paudio_web_qc' THEN 'Raya'
  WHEN 'paudio_developer' THEN 'Kian'
  ELSE name
END
WHERE agent_key IN (
  'group_ceo', 'digital_musik_ceo', 'digital_musik_seo', 'digital_musik_content',
  'digital_musik_web_qc', 'digital_musik_developer', 'audio_one_ceo', 'audio_one_seo',
  'audio_one_content', 'audio_one_web_qc', 'audio_one_developer', 'gg_audio_ceo',
  'gg_audio_seo', 'gg_audio_content', 'gg_audio_web_qc', 'gg_audio_developer',
  'paudio_ceo', 'paudio_seo', 'paudio_content', 'paudio_web_qc', 'paudio_developer'
);
COMMIT;
