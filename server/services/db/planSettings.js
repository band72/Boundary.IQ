import { getDb } from './core.js';

export function getAllPlanSettings() {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM PlanSettings').all();
  return rows.map(r => ({
    plan: r.Plan,
    name: r.Name,
    dailyDeedLimit: r.DailyDeedLimit,
    price: r.Price,
    features: JSON.parse(r.Features || '[]'),
    description: r.Description,
  }));
}

export function getPlanSettings(plan) {
  const db = getDb();
  const r = db.prepare('SELECT * FROM PlanSettings WHERE Plan = ?').get(plan);
  if (!r) return null;
  return {
    plan: r.Plan,
    name: r.Name,
    dailyDeedLimit: r.DailyDeedLimit,
    price: r.Price,
    features: JSON.parse(r.Features || '[]'),
    description: r.Description,
  };
}

export function updatePlanSettings(plan, { name, dailyDeedLimit, price, features, description }) {
  const db = getDb();
  db.prepare(`
    UPDATE PlanSettings
    SET Name = ?, DailyDeedLimit = ?, Price = ?, Features = ?, Description = ?
    WHERE Plan = ?
  `).run(name, dailyDeedLimit, price, JSON.stringify(features || []), description, plan);
  return getPlanSettings(plan);
}
