import { SUPABASE_CONFIG } from './config.js?v=20261027d';

const STORAGE_KEY = 'keyrush.supabase';

let clientPromise = null;
let cachedFor = '';

/** 站点内置的云端配置（部署到公网时填写 js/config.js） */
export function bakedConfig() {
  const url = String(SUPABASE_CONFIG?.url || '').trim();
  const key = String(SUPABASE_CONFIG?.key || '').trim();
  return url && key ? { url, key } : null;
}

export function loadConfig() {
  const baked = bakedConfig();
  if (baked) return baked;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const cfg = JSON.parse(raw);
    if (!cfg || !cfg.url || !cfg.key) return null;
    return cfg;
  } catch {
    return null;
  }
}

export function saveConfig(cfg) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg));
  clientPromise = null;
  cachedFor = '';
}

export function clearConfig() {
  localStorage.removeItem(STORAGE_KEY);
  clientPromise = null;
  cachedFor = '';
}

export async function getClient() {
  const cfg = loadConfig();
  if (!cfg) return null;
  const signature = `${cfg.url}|${cfg.key}`;
  if (clientPromise && cachedFor === signature) return clientPromise;

  cachedFor = signature;
  clientPromise = import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm')
    .then((mod) => mod.createClient(cfg.url, cfg.key))
    .catch((err) => {
      clientPromise = null;
      cachedFor = '';
      throw new Error(`Supabase 客户端加载失败（${err.message || err}）`);
    });

  return clientPromise;
}
