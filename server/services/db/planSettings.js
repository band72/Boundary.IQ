import { query } from './core.js';

export async function getAllPlanSettings() {
  const res = await query('SELECT * FROM PlanSettings');
  return res.rows.map(r => ({
    plan: r.Plan,
    name: r.Name,
    dailyDeedLimit: r.DailyDeedLimit,
    price: r.Price,
    features: typeof r.Features === 'string' ? JSON.parse(r.Features || '[]') : r.Features,
    description: r.Description,
  }));
}

export async function getPlanSettings(plan) {
  const res = await query('SELECT * FROM PlanSettings WHERE Plan = ?', [plan]);
  const r = res.rows[0];
  if (!r) return null;
  return {
    plan: r.Plan,
    name: r.Name,
    dailyDeedLimit: r.DailyDeedLimit,
    price: r.Price,
    features: typeof r.Features === 'string' ? JSON.parse(r.Features || '[]') : r.Features,
    description: r.Description,
  };
}

export async function updatePlanSettings(plan, { name, dailyDeedLimit, price, features, description }) {
  await query(`
    UPDATE PlanSettings
    SET Name = ?, DailyDeedLimit = ?, Price = ?, Features = ?, Description = ?
    WHERE Plan = ?
  `, [name, dailyDeedLimit, price, JSON.stringify(features || []), description, plan]);
  return getPlanSettings(plan);
}
