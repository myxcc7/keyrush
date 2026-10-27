/**
 * 云端对战配置（部署到公网时填写）。
 * 把 Supabase 项目的 Project URL 与 anon public key 填在下面，
 * 这样任何访客打开网页都会直接接入云端房间，无需手动设置。
 * anon key 是前端公开密钥，可以安全地放在静态站点里。
 */
export const SUPABASE_CONFIG = {
  url: 'https://khlstydepholbezfqbgy.supabase.co',
  key: 'sb_publishable_KRjForLh2ICHpS0LaPCBAA_q6HtotNa'
};
