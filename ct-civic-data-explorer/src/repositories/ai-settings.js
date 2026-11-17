import { pool } from '../db/pool.js';

export async function getSettings() {
  const { rows } = await pool.query('SELECT provider, model FROM ai_settings WHERE id = 1');
  return rows[0];
}

export async function saveSettings(provider, model) {
  await pool.query(
    `INSERT INTO ai_settings (id, provider, model) VALUES (1, ?, ?) AS incoming
     ON DUPLICATE KEY UPDATE provider = incoming.provider, model = incoming.model`,
    [provider, model],
  );
}
