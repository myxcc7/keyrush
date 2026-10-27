import { DIFFICULTIES, pickText, textIdOf } from './words.js?v=20261027d';
import { TypingEngine } from './game.js?v=20261027d';
import { loadConfig, saveConfig, clearConfig, getClient, bakedConfig } from './supabase.js?v=20261027d';
import { SupabaseTransport, LocalTransport } from './net.js?v=20261027d';
import { audio } from './audio.js?v=20261027d';

const $ = (id) => document.getElementById(id);
const NICK_KEY = 'keyrush.nickname';
const PID_KEY = 'keyrush.playerId';
const LOCAL_RECORDS_KEY = 'keyrush.local.records';
const AUTH_KEY = 'keyrush.auth';
const MAX_PLAYERS = 4; // 一个房间最多 4 人同场对决
const WINS_NEEDED = 4; // 七局四胜：每局第一名得 1 分，先到 4 分赢下整场对决
const MAX_ROUNDS = 7;
// 每局限时随难度：初级 20 秒 / 中级 30 秒 / 高级 40 秒，超时强制结束
const TIME_LIMITS_MS = { easy: 20000, medium: 30000, hard: 40000 };
function raceLimitMs(difficulty) {
  return TIME_LIMITS_MS[difficulty] || TIME_LIMITS_MS.easy;
}

const state = {
  playerId: getPlayerId(),
  nickname: localStorage.getItem(NICK_KEY) || '',
  authName: (() => {
    try {
      return JSON.parse(localStorage.getItem(AUTH_KEY) || 'null')?.nickname || '';
    } catch {
      return '';
    }
  })(),
  code: '',
  isHost: false,
  difficulty: 'easy',
  transport: null,
  cloud: false,
  players: [],
  raceTarget: '',
  raceDifficulty: 'easy',
  textId: '',
  engine: null,
  spans: [],
  laneSignature: '',
  startAt: 0,
  racing: false,
  finished: false,
  raf: 0,
  lastBroadcast: 0,
  lastPercentSent: -1,
  myResult: null,
  results: {},        // playerId -> 其他玩家的本局结果
  roundPlayers: [],   // 本局参赛者快照（开局时确定，中途加入/离开不影响本局）
  roundWins: {},      // playerId -> 整场累计胜局分
  recorded: false,
  roundNo: 1,
  playedRound: 1,
  matchOver: false,
  roundTallied: false,
  roomBeat: null,
  autoNextTimer: null,
  autoNextInterval: null,
  limitTimer: null,
  lang: 'zh',
  joinedFresh: false
};

// playerId -> 进度条元素；最多 4 条
const laneEls = new Map();

/* ---------- 工具 ---------- */

function getPlayerId() {
  // 用 sessionStorage：同一浏览器的不同标签页要能在本机演示模式下互相识别为不同玩家
  let id = sessionStorage.getItem(PID_KEY);
  if (!id) {
    id = crypto.randomUUID ? crypto.randomUUID() : `p${Math.random().toString(36).slice(2)}`;
    sessionStorage.setItem(PID_KEY, id);
  }
  return id;
}

function show(screenId) {
  document.querySelectorAll('.screen').forEach((el) => {
    el.classList.toggle('active', el.id === screenId);
  });
  // 各界面背景音乐（对战场景由 startRaceMusic/stopRaceMusic 单独接管）
  if (screenId === 'screen-auth') audio.setScene('auth');
  if (screenId === 'screen-home') {
    // 未登录（云端模式）→ 登录音乐；已登录或本机演示 → 房间列表音乐
    const needAuth = !!loadConfig() && !state.authName;
    audio.setScene(needAuth ? 'auth' : 'list');
  }
  if (screenId === 'screen-lobby' || screenId === 'screen-result') {
    audio.setScene('lobby');
  }
}

function setHint(id, text) {
  const el = $(id);
  if (el) el.textContent = text || '';
}

function generateCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i += 1) {
    code += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return code;
}

function updateConnBadge() {
  const cloud = !!loadConfig();
  const badge = $('conn-badge');
  badge.textContent = cloud ? '云端房间' : '本机演示';
  badge.classList.toggle('cloud', cloud);
}

/* ---------- 账号：注册 / 登录 ---------- */

function applyAuthUI() {
  const cloud = !!loadConfig();
  const authed = !!state.authName;
  $('auth-area').hidden = !cloud; // 本机演示无需账号
  $('auth-form').hidden = authed;
  $('auth-user').hidden = !authed;
  $('auth-nick').textContent = state.authName || '';
  $('play-area').hidden = cloud && !authed;
  const nickInput = $('input-nickname');
  nickInput.disabled = authed;
  nickInput.value = authed ? state.authName : state.nickname;
  // 登录态变化时同步切换背景音乐（登录 ↔ 房间列表）
  if (document.querySelector('#screen-home').classList.contains('active')) {
    audio.setScene(cloud && !authed ? 'auth' : 'list');
  }
}

function setAuthed(nickname) {
  state.authName = nickname;
  state.nickname = nickname;
  localStorage.setItem(AUTH_KEY, JSON.stringify({ nickname }));
  localStorage.setItem(NICK_KEY, nickname);
  applyAuthUI();
}

/** 一键登录/注册：账户不存在直接注册；存在则校验密码 */
async function doAuth() {
  const nickname = $('input-auth-name').value.trim().slice(0, 12);
  const password = $('input-auth-pass').value;
  if (!nickname) {
    setHint('auth-hint', '先输入昵称作为账号。');
    return;
  }
  if (password.length < 6) {
    setHint('auth-hint', '密码至少 6 位。');
    return;
  }
  setHint('auth-hint', '正在登录…');

  try {
    const client = await getClient();
    if (!client) throw new Error('云端不可用');
    const { data, error } = await client.rpc('login_or_register', {
      p_nickname: nickname,
      p_password: password
    });
    if (error) throw error;
    if (data !== 'ok') {
      setHint('auth-hint', data);
      return;
    }
    setAuthed(nickname);
    setHint('auth-hint', '');
    setHint('home-hint', `欢迎，${nickname}！`);
  } catch (err) {
    setHint('auth-hint', `操作失败：${err.message || err}`);
  }
}

function logout() {
  state.authName = '';
  state.nickname = '';
  localStorage.removeItem(AUTH_KEY);
  localStorage.removeItem(NICK_KEY);
  applyAuthUI();
  setHint('home-hint', '已退出登录。');
}

function openModal(id) {
  $(id).hidden = false;
}

function closeModal(id) {
  $(id).hidden = true;
}

/* ---------- 首页 ---------- */

function readNickname() {
  const input = $('input-nickname');
  const value = input.value.trim().slice(0, 12);
  if (!value) {
    setHint('home-hint', '先给自己起个昵称吧。');
    input.focus();
    return null;
  }
  state.nickname = value;
  localStorage.setItem(NICK_KEY, value);
  setHint('home-hint', '');
  return value;
}

async function createRoom() {
  if (!readNickname()) return;
  await enterRoom(generateCode(), true);
}

async function joinRoom() {
  if (!readNickname()) return;
  const code = $('input-room').value.trim().toUpperCase();
  if (code.length !== 6) {
    setHint('home-hint', '房间码是 6 位，向房主再确认一下。');
    return;
  }
  await enterRoom(code, false);
}

async function enterRoom(code, isHost) {
  $('btn-create').disabled = true;
  $('btn-join').disabled = true;
  setHint('home-hint', '正在连接房间…');

  try {
    let client = null;
    try {
      client = await getClient();
    } catch (err) {
      client = null;
      setHint('home-hint', `${err.message}，已回退到本机演示模式。`);
    }

    const me = { playerId: state.playerId, nickname: state.nickname, isHost };
    const transport = client
      ? new SupabaseTransport(client, code, me)
      : new LocalTransport(code, me);

    state.transport = transport;
    state.players = [];
    state.cloud = !!client;
    state.joinedFresh = true; // 首次拿到含自己的在线名单时校验房间人数
    transport.on('players', onPlayers);
    transport.on('game', onGame);

    await transport.connect();

    state.code = code;
    state.isHost = isHost;
    state.difficulty = 'easy';
    state.lang = 'zh';
    state.myResult = null;
    state.results = {};
    state.roundPlayers = [];
    state.roundWins = {};
    state.finished = false;
    state.recorded = false;
    state.roundNo = 1;
    state.playedRound = 1;
    state.matchOver = false;
    state.roundTallied = false;

    $('lobby-code').textContent = code;
    $('difficulty-seg').dataset.host = isHost ? '1' : '0';
    $('lang-seg').dataset.host = isHost ? '1' : '0';
    updateLangUI();
    updateDifficultyUI();
    renderLobby();
    show('screen-lobby');
    if (isHost && client) registerRoom(code);
    setHint(
      'lobby-hint',
      isHost
        ? '把房间码发给好友，等对方加入就能开始。'
        : '已进入房间，等待房主开始对战。'
    );
  } catch (err) {
    setHint('home-hint', `连接失败：${err.message || err}`);
    if (state.transport) {
      state.transport.close();
      state.transport = null;
    }
  } finally {
    $('btn-create').disabled = false;
    $('btn-join').disabled = false;
  }
}

/* ---------- 房间登记（公开房间列表） ---------- */

const ROOM_STALE_MS = 15000; // 与数据库列表查询的窗口保持一致
const DIFFICULTY_LABELS = { easy: '简单', medium: '中等', hard: '困难' };

function roomRegistryClient() {
  return state.cloud && state.transport && state.transport.client
    ? state.transport.client
    : null;
}

/** 房主建房后登记到 rooms 表，并开启心跳 */
async function registerRoom(code) {
  const client = roomRegistryClient();
  if (!client) return;
  try {
    await client.from('rooms').upsert({
      code,
      host: state.nickname,
      difficulty: state.difficulty || 'easy',
      status: 'waiting',
      updated_at: new Date().toISOString()
    });
    state.roomBeat = setInterval(() => {
      const c = roomRegistryClient();
      if (!c || state.code !== code) return;
      c.from('rooms')
        .update({ updated_at: new Date().toISOString() })
        .eq('code', code)
        .then(() => {}, () => {});
    }, 8000);
  } catch {
    /* 列表登记失败不影响对战 */
  }
}

async function removeRoomRow(code) {
  if (state.roomBeat) {
    clearInterval(state.roomBeat);
    state.roomBeat = null;
  }
  const client = roomRegistryClient();
  if (!client || !code) return;
  try {
    await client.from('rooms').delete().eq('code', code);
  } catch {
    /* 忽略 */
  }
}

async function refreshRooms() {
  const box = $('room-list');
  const client = await getClient().catch(() => null);
  if (!client) {
    box.innerHTML = '<p class="hint">本机演示模式下无法查看其他设备的房间。</p>';
    return;
  }
  try {
    const since = new Date(Date.now() - ROOM_STALE_MS).toISOString();
    const { data, error } = await client
      .from('rooms')
      .select('code, host, difficulty')
      .eq('status', 'waiting')
      .gt('updated_at', since)
      .order('updated_at', { ascending: false })
      .limit(12);
    if (error) throw error;
    const rows = data || [];
    box.innerHTML = '';
    if (!rows.length) {
      const empty = document.createElement('p');
      empty.className = 'hint';
      empty.textContent = '暂无等待中的房间，创建一个让大家加入吧。';
      box.append(empty);
      return;
    }
    rows.forEach((row) => {
      const item = document.createElement('div');
      item.className = 'room-row';
      const info = document.createElement('div');
      info.className = 'room-info';
      const codeEl = document.createElement('strong');
      codeEl.textContent = row.code;
      const meta = document.createElement('span');
      meta.className = 'room-meta';
      meta.textContent = `${row.host} · ${DIFFICULTY_LABELS[row.difficulty] || '简单'}`;
      info.append(codeEl, meta);
      const join = document.createElement('button');
      join.className = 'btn tiny primary';
      join.textContent = '加入';
      join.addEventListener('click', () => {
        if (!readNickname()) return;
        enterRoom(row.code, false);
      });
      item.append(info, join);
      box.append(item);
    });
  } catch (err) {
    box.innerHTML = '';
    const tip = document.createElement('p');
    tip.className = 'hint';
    tip.textContent = `房间列表读取失败：${err.message || err}`;
    box.append(tip);
  }
}

/* ---------- 大厅 ---------- */

function onPlayers(players) {
  const prevCount = state.players.length;
  state.players = players || [];

  // 刚进房就发现人满了（最多 4 人）→ 主动退出，避免第 5 人搅乱对局
  if (state.joinedFresh) {
    // 等在线名单里出现自己（presence 首次同步可能还没包含自己）
    const seenMe = state.players.some((p) => p.playerId === state.playerId);
    if (seenMe) {
      state.joinedFresh = false;
      if (state.players.length > MAX_PLAYERS) {
        setHint('home-hint', `房间已满（最多 ${MAX_PLAYERS} 人），换一个房间吧。`);
        leaveRoom();
        return;
      }
    }
  }

  if ($('screen-lobby').classList.contains('active')) renderLobby();

  const others = othersList();
  if (!others.length && !state.isHost) {
    if ($('screen-race').classList.contains('active')) {
      setHint('race-tip', '其他玩家都已离开，本局仍可继续完成。');
    } else if ($('screen-result').classList.contains('active')) {
      setHint('result-hint', '其他玩家都已离开，请点"返回首页"。');
    } else if ($('screen-lobby').classList.contains('active')) {
      setHint('lobby-hint', '房主已离开，返回首页重新创建一个房间吧。');
    }
  }

  // 有人新加入时，房主补发当前难度与语言设置（此前的广播对方收不到）
  if (state.isHost && state.players.length > prevCount) {
    state.transport?.send('difficulty', { difficulty: state.difficulty });
    state.transport?.send('lang', { lang: state.lang });
  }

  // 对局中：按最新人数重建进度条；参赛者都已出结果就结算
  if (state.racing) syncLanes();
  if (state.finished && allResultsIn()) showResult();
}

function playerSlot(name, tag, present, isHost, isMe) {
  const slot = document.createElement('div');
  slot.className = `player-slot${present ? '' : ' empty'}${isMe ? ' me' : ''}`;

  const avatar = document.createElement('div');
  avatar.className = 'avatar';
  avatar.textContent = present ? (name.trim().slice(0, 1).toUpperCase() || '?') : '?';

  const body = document.createElement('div');
  body.className = 'slot-body';
  const title = document.createElement('strong');
  title.textContent = present ? name : '等待对手加入…';
  const sub = document.createElement('span');
  sub.textContent = present ? `${tag}${isHost ? ' · 房主' : ''}` : '把房间码发给好友';
  body.append(title, sub);
  slot.append(avatar, body);
  return slot;
}

function othersList() {
  return state.players.filter((p) => p.playerId !== state.playerId);
}

/** 我排第一，其余按进入房间的顺序 */
function playerOrder() {
  const me = state.players.find((p) => p.playerId === state.playerId);
  const others = othersList();
  return me ? [me, ...others] : [...others];
}

function renderLobby() {
  const me = state.players.find((p) => p.playerId === state.playerId);
  const others = othersList();
  const container = $('lobby-players');
  container.innerHTML = '';
  container.append(playerSlot(me?.nickname || state.nickname, '你', true, !!me?.isHost, true));
  others.forEach((p) => {
    container.append(playerSlot(p.nickname, '玩家', true, !!p.isHost, false));
  });
  for (let i = others.length; i < MAX_PLAYERS - 1; i += 1) {
    container.append(playerSlot('', '玩家', false, false, false));
  }

  const count = state.players.length;
  const startBtn = $('btn-start');
  if (!state.isHost) {
    startBtn.disabled = true;
    startBtn.textContent = '等待房主开始…';
  } else if (count >= 2 && count <= MAX_PLAYERS) {
    startBtn.disabled = false;
    startBtn.textContent = '开始对战';
    setHint(
      'lobby-hint',
      `已就位 ${count} 人（最多 ${MAX_PLAYERS} 人），每局第一名得 1 分，先到 ${WINS_NEEDED} 分赢下整场。`
    );
  } else {
    startBtn.disabled = true;
    startBtn.textContent = count > MAX_PLAYERS ? `房间超过 ${MAX_PLAYERS} 人` : '等待玩家加入…';
  }
}

function updateDifficultyUI() {
  const seg = $('difficulty-seg');
  seg.querySelectorAll('button').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.difficulty === state.difficulty);
  });
  const meta = DIFFICULTIES[state.difficulty] || DIFFICULTIES.easy;
  setHint('difficulty-note', `${meta.label}：${meta.note}`);
}

function updateLangUI() {
  const seg = $('lang-seg');
  seg.querySelectorAll('button').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.lang === state.lang);
  });
  setHint(
    'lang-note',
    state.lang === 'en'
      ? '英文词库：初中 / 高中 / 大学词汇，直接键盘输入。'
      : state.lang === 'digit'
        ? '数字模式：随机数字，每 4 位空格分组，直接键盘输入。'
        : '中文词库，输入时请使用输入法。'
  );
}

function setLang(lang) {
  if (!state.isHost || (lang !== 'zh' && lang !== 'en' && lang !== 'digit')) return;
  state.lang = lang;
  updateLangUI();
  state.transport?.send('lang', { lang });
}

function setDifficulty(difficulty) {
  if (!state.isHost || !DIFFICULTIES[difficulty]) return;
  state.difficulty = difficulty;
  updateDifficultyUI();
  state.transport?.send('difficulty', { difficulty });
  // 同步房间列表里的难度展示
  const client = roomRegistryClient();
  if (client && state.code) {
    client.from('rooms').update({ difficulty }).eq('code', state.code)
      .then(() => {}, () => {});
  }
}

/* ---------- 实时事件 ---------- */

function onGame(payload) {
  if (!payload || !payload.kind) return;

  if (payload.kind === 'difficulty') {
    state.difficulty = payload.difficulty || state.difficulty;
    updateDifficultyUI();
    return;
  }

  if (payload.kind === 'lang') {
    state.lang = ['zh', 'en', 'digit'].includes(payload.lang) ? payload.lang : 'zh';
    updateLangUI();
    return;
  }

  if (payload.kind === 'start') {
    beginRace(payload);
    return;
  }

  if (payload.kind === 'progress') {
    if (payload.playerId !== state.playerId) updateLane(payload.playerId, payload);
    return;
  }

  if (payload.kind === 'finish') {
    if (payload.playerId === state.playerId) return;
    if (!state.results[payload.playerId]) {
      setHint(
        'race-tip',
        `${payload.nickname || '对手'}${payload.finished
          ? `已完成：${(payload.elapsedMs / 1000).toFixed(1)} 秒`
          : `${raceLimitMs(state.raceDifficulty) / 1000} 秒内没打完`}`
      );
    }
    state.results[payload.playerId] = payload;
    if (state.finished && allResultsIn()) showResult();
  }
}

function hostStartRace() {
  if (!state.isHost || othersList().length === 0) return;
  // 开局后房间从公开列表移除（不再接受加入）
  removeRoomRow(state.code);
  // 整场对决已分出胜负：重新开一场，比分归零
  if (state.matchOver) {
    state.roundWins = {};
    state.roundNo = 1;
    state.matchOver = false;
  }
  const target = pickText(state.difficulty, state.raceTarget, state.lang);
  const payload = {
    target,
    difficulty: state.difficulty,
    lang: state.lang,
    textId: textIdOf(target),
    startInMs: 3000,
    round: state.roundNo,
    // 参赛名单随开局广播发出，保证各端本局参与者一致
    roster: playerOrder().map((p) => ({ playerId: p.playerId, nickname: p.nickname }))
  };
  state.transport?.send('start', payload);
  beginRace(payload);
}

/* ---------- 对战 ---------- */

function beginRace(payload) {
  cancelAnimationFrame(state.raf);
  clearAutoNext();
  state.raceTarget = payload.target || '';
  state.raceDifficulty = payload.difficulty || state.difficulty;
  state.lang = payload.lang || state.lang;
  state.textId = payload.textId || textIdOf(state.raceTarget);
  state.roundNo = Number(payload.round) || 1;
  if (state.roundNo === 1) {
    state.roundWins = {};
    state.matchOver = false;
  }
  state.playedRound = state.roundNo;
  // 本局参赛者名单：以房主随开局发出的 roster 为准
  state.roundPlayers =
    Array.isArray(payload.roster) && payload.roster.length
      ? payload.roster
      : playerOrder().map((p) => ({ playerId: p.playerId, nickname: p.nickname }));
  state.myResult = null;
  state.results = {};
  state.finished = false;
  state.racing = false;
  state.recorded = false;
  state.roundTallied = false;
  state.lastPercentSent = -1;
  state.lastBroadcast = 0;

  audio.stopRaceMusic();
  // 决胜局（有人拿到赛点）收紧音乐节奏
  audio.setUrgent(maxRoundWins() >= WINS_NEEDED - 1);

  show('screen-race');

  $('race-difficulty').textContent =
    (DIFFICULTIES[state.raceDifficulty] || DIFFICULTIES.easy).label +
    (state.lang === 'en' ? ' · EN' : state.lang === 'digit' ? ' · 数字' : '');
  updateRaceRound();
  const limit = raceLimitMs(state.raceDifficulty);
  $('race-timer').textContent = `${limit / 1000}.0s`;
  $('race-timer').classList.remove('danger');
  setHint(
    'race-tip',
    state.lang === 'digit'
      ? `限时 ${limit / 1000} 秒，只输数字即可，空格分组会自动跳过，打错可以退格修改。`
      : `限时 ${limit / 1000} 秒，用你习惯的输入法直接输入，打错可以退格修改。`
  );

  buildTyping();
  buildLanes();
  startCountdown(Number(payload.startInMs) || 3000);
}

function updateRaceRound() {
  const el = $('race-round');
  if (el) el.textContent = `第 ${state.roundNo} 局 · ${roundPlayers().length} 人`;
}

function buildTyping() {
  const container = $('typing-text');
  container.innerHTML = '';
  container.scrollTop = 0;
  state.spans = [];
  for (const ch of state.raceTarget) {
    const span = document.createElement('span');
    span.textContent = ch;
    container.append(span);
    state.spans.push(span);
  }
  state.engine = new TypingEngine(state.raceTarget, { skipSpaces: state.lang === 'digit' });
  paint();
}

function paint() {
  const engine = state.engine;
  const value = engine ? engine.value : '';
  const target = state.raceTarget;
  if (engine && engine.skipSpaces) {
    // 数字模式：空格仅分组展示，输入位置通过 map 对齐到目标文本
    for (let i = 0; i < state.spans.length; i += 1) {
      const span = state.spans[i];
      if (target.charAt(i) === ' ') {
        span.className = '';
        continue;
      }
      const typedIndex = engine.map.indexOf(i);
      if (typedIndex < value.length) {
        span.className = engine.norm(value[typedIndex]) === engine.norm(target.charAt(i)) ? 'ok' : 'bad';
      } else {
        span.className = typedIndex === value.length ? 'current' : '';
      }
    }
    ensureVisible(engine.map[Math.min(value.length, engine.map.length - 1)] || 0);
    return;
  }
  for (let i = 0; i < state.spans.length; i += 1) {
    const span = state.spans[i];
    if (i < value.length) {
      const norm = engine ? engine.norm : (c) => c;
      span.className = norm(value[i]) === norm(target.charAt(i)) ? 'ok' : 'bad';
    } else span.className = i === value.length ? 'current' : '';
  }
  ensureVisible(value.length);
}

function ensureVisible(index) {
  const span = state.spans[Math.min(index, state.spans.length - 1)];
  if (!span) return;
  const container = $('typing-text');
  const lineHeight = span.offsetHeight || 34;
  const top = span.offsetTop;
  if (top < container.scrollTop) {
    container.scrollTop = Math.max(0, top - lineHeight);
  } else if (top + lineHeight > container.scrollTop + container.clientHeight) {
    container.scrollTop = top + lineHeight - container.clientHeight + Math.round(lineHeight / 2);
  }
}

// 进度条配色：自己固定绿色，其余按座位区分
const LANE_COLORS = [
  'linear-gradient(90deg, #3fd48a, #6ff0a8)',
  'linear-gradient(90deg, #3c7dff, #6aa8ff)',
  'linear-gradient(90deg, #f2a03d, #ffcf6b)',
  'linear-gradient(90deg, #b45cff, #d69bff)'
];

/** 本局参赛者，我在最前 */
function roundPlayers() {
  const roster =
    Array.isArray(state.roundPlayers) && state.roundPlayers.length
      ? state.roundPlayers
      : playerOrder();
  return [...roster].sort((a, b) => {
    if (a.playerId === state.playerId) return -1;
    if (b.playerId === state.playerId) return 1;
    return 0;
  });
}

/** 仍在场的参赛者（中途离开的不计入本局排名） */
function activeRoundPlayers() {
  const roster = roundPlayers();
  const present = new Set(state.players.map((p) => p.playerId));
  const alive = roster.filter((p) => p.playerId === state.playerId || present.has(p.playerId));
  return alive.length ? alive : roster;
}

function laneLabel(player) {
  const wins = state.roundWins[player.playerId] || 0;
  return `${player.nickname || '玩家'} · ${wins} 分`;
}

function buildLanes() {
  const container = $('race-lanes');
  container.innerHTML = '';
  laneEls.clear();
  const players = roundPlayers();
  players.forEach((player, index) => {
    container.append(makeLane(player, index));
  });
  players.forEach((player) => updateLane(player.playerId, { percent: 0, kpm: 0, accuracy: 100 }));
  state.laneSignature = players.map((p) => p.playerId).join('|');
}

/** 人数变化时重建进度条，避免出现 4 条以上的泳道 */
function syncLanes() {
  const signature = roundPlayers().map((p) => p.playerId).join('|');
  if (signature !== state.laneSignature) buildLanes();
}

function makeLane(player, index) {
  const isMe = player.playerId === state.playerId;
  const lane = document.createElement('div');
  lane.className = `lane ${isMe ? 'lane-me' : 'lane-opp'}`;

  const head = document.createElement('div');
  head.className = 'lane-head';
  const nameEl = document.createElement('span');
  nameEl.className = 'lane-name';
  nameEl.textContent = laneLabel(player);
  const statEl = document.createElement('span');
  statEl.className = 'lane-kpm';
  statEl.textContent = '0 字/分';
  head.append(nameEl, statEl);

  const track = document.createElement('div');
  track.className = 'lane-track';
  const fill = document.createElement('div');
  fill.className = 'lane-fill';
  fill.style.background = LANE_COLORS[index % LANE_COLORS.length];
  track.append(fill);

  lane.append(head, track);
  laneEls.set(player.playerId, { nameEl, statEl, fill });
  return lane;
}

function updateLane(playerId, stats) {
  const lane = laneEls.get(playerId);
  if (!lane) return;
  lane.fill.style.width = `${Math.min(100, stats.percent || 0)}%`;
  lane.statEl.textContent = `${stats.kpm || 0} 字/分 · ${stats.accuracy ?? 100}%`;
}

function startCountdown(ms) {
  const overlay = $('countdown-overlay');
  const number = $('countdown-number');
  const input = $('typing-input');

  input.value = '';
  input.disabled = true;
  overlay.classList.remove('hidden');
  number.classList.remove('go');
  number.textContent = '3';

  const startAt = performance.now() + ms;
  let lastLabel = '';
  const step = (now) => {
    const remain = startAt - now;
    if (remain > 0) {
      const label = String(Math.max(1, Math.ceil(remain / 1000)));
      if (label !== lastLabel) {
        lastLabel = label;
        audio.countdownTick(false);
      }
      number.textContent = label;
      state.raf = requestAnimationFrame(step);
      return;
    }
    number.textContent = 'GO';
    number.classList.add('go');
    audio.countdownTick(true);
    setTimeout(() => overlay.classList.add('hidden'), 260);
    state.startAt = performance.now();
    activateRace();
  };
  state.raf = requestAnimationFrame(step);
}

function activateRace() {
  state.racing = true;
  const input = $('typing-input');
  input.value = '';
  input.disabled = false;
  input.focus();
  audio.startRaceMusic();
  state.raf = requestAnimationFrame(timerLoop);
  // 后台标签页 RAF 会被浏览器节流，用 setTimeout 兜底保证限时一定触发
  clearTimeout(state.limitTimer);
  state.limitTimer = setTimeout(() => {
    if (state.racing && !state.finished) finishRace(true);
  }, raceLimitMs(state.raceDifficulty) + 800);
}

function timerLoop(now) {
  if (!state.racing) return;
  const elapsed = now - state.startAt;
  const limitMs = raceLimitMs(state.raceDifficulty);
  const remainMs = Math.max(0, limitMs - elapsed);
  const timerEl = $('race-timer');
  timerEl.textContent = `${(remainMs / 1000).toFixed(1)}s`;
  timerEl.classList.toggle('danger', remainMs <= 5000);

  const stats = computeStats(now);
  updateLane(state.playerId, stats);

  if (remainMs <= 0) {
    finishRace(true);
    return;
  }

  if (now - state.lastBroadcast > 120 && stats.percent !== state.lastPercentSent) {
    state.lastBroadcast = now;
    state.lastPercentSent = stats.percent;
    state.transport?.send('progress', {
      playerId: state.playerId,
      percent: stats.percent,
      progress: stats.progress,
      kpm: stats.kpm,
      accuracy: stats.accuracy
    });
  }
  state.raf = requestAnimationFrame(timerLoop);
}

function computeStats(now = performance.now()) {
  const engine = state.engine;
  const correct = engine.correctChars();
  const minutes = Math.max((now - state.startAt) / 60000, 1 / 60000);
  // 数字模式下去掉空格后的长度才是完成进度/完成条件的分母
  const total = state.engine.cmpTarget.length || 1;
  const percent = Math.round((engine.value.length / total) * 100);
  return {
    progress: engine.value.length / total,
    percent,
    correctChars: correct,
    kpm: correct > 0 ? Math.round(correct / minutes) : 0,
    accuracy: engine.accuracy()
  };
}

function handleInput(event) {
  if (!state.racing) return;
  if (event.isComposing) return;
  syncFromInput();
}

/** 以输入框当前值为准同步一次（输入法提交后、浏览器差异下都可调用） */
function syncFromInput() {
  if (!state.racing) return;
  const input = $('typing-input');
  state.engine.setValue(input.value);
  if (input.value !== state.engine.value) input.value = state.engine.value;
  paint();

  if (state.engine.value.length >= state.engine.cmpTarget.length) finishRace();
}

function finishRace(timedOut = false) {
  if (state.finished) return;
  state.finished = true;
  state.racing = false;
  cancelAnimationFrame(state.raf);
  clearTimeout(state.limitTimer);
  audio.stopRaceMusic();

  const now = performance.now();
  const stats = computeStats(now);
  const elapsedMs = timedOut ? raceLimitMs(state.raceDifficulty) : Math.max(1, Math.round(now - state.startAt));
  const minutes = elapsedMs / 60000;

  state.myResult = {
    playerId: state.playerId,
    nickname: state.nickname,
    finished: !timedOut,
    elapsedMs,
    chars: state.engine.value.length,
    correctChars: stats.correctChars,
    kpm: Math.max(0, Math.round(stats.correctChars / minutes)),
    accuracy: stats.accuracy
  };

  const input = $('typing-input');
  input.disabled = true;
  input.blur();
  $('race-timer').textContent = timedOut ? '0.0s' : `${(elapsedMs / 1000).toFixed(1)}s`;
  paint();
  updateLane(state.playerId, {
    percent: stats.percent,
    kpm: state.myResult.kpm,
    accuracy: state.myResult.accuracy
  });

  state.transport?.send('finish', state.myResult);
  showResult();
}

/* ---------- 结算 ---------- */

/**
 * 本局排名：完成者优先（准确率高者在前，相同则用时短者在前），
 * 未完成者排在其后（正确字数多者在前）。
 * 无人完成、或第一名并列 → 本局平局（winnerId 为 null）。
 */
function rankRound() {
  const players = activeRoundPlayers();
  if (!players.length) return null;
  const entries = players.map((p) => ({
    playerId: p.playerId,
    nickname: p.nickname,
    result: p.playerId === state.playerId ? state.myResult : state.results[p.playerId] || null
  }));
  if (entries.some((entry) => !entry.result)) return null;

  entries.sort((a, b) => {
    const ra = a.result;
    const rb = b.result;
    if (ra.finished !== rb.finished) return ra.finished ? -1 : 1;
    if (ra.finished) {
      if (rb.accuracy !== ra.accuracy) return rb.accuracy - ra.accuracy;
      if (ra.elapsedMs !== rb.elapsedMs) return ra.elapsedMs - rb.elapsedMs;
    } else {
      if ((rb.correctChars || 0) !== (ra.correctChars || 0)) {
        return (rb.correctChars || 0) - (ra.correctChars || 0);
      }
      if (rb.accuracy !== ra.accuracy) return rb.accuracy - ra.accuracy;
    }
    // 完全相同时按昵称排序，保证各端排名顺序一致
    return (a.nickname || '').localeCompare(b.nickname || '');
  });

  const top = entries[0];
  const second = entries[1];
  const noOneFinished = !top.result.finished;
  const tied =
    second &&
    top.result.finished === second.result.finished &&
    top.result.accuracy === second.result.accuracy &&
    top.result.elapsedMs === second.result.elapsedMs &&
    (top.result.correctChars || 0) === (second.result.correctChars || 0);
  const winnerId = noOneFinished || tied ? null : top.playerId;
  return { entries, winnerId };
}

function myRoundVerdict(ranking) {
  if (!ranking) return 'waiting';
  if (!ranking.winnerId) return 'draw';
  return ranking.winnerId === state.playerId ? 'win' : 'lose';
}

function maxRoundWins() {
  return Math.max(0, ...Object.values(state.roundWins));
}

function allResultsIn() {
  const players = activeRoundPlayers();
  if (!players.length || !state.myResult) return false;
  return players.every(
    (p) => p.playerId === state.playerId || !!state.results[p.playerId]
  );
}

function showResult() {
  const ranking = rankRound();
  const verdict = myRoundVerdict(ranking);

  // 每局只计一次分：本局第一名 +1，平局不得分；先到 4 分或打满 7 局整场结束
  if (ranking && !state.roundTallied) {
    state.roundTallied = true;
    state.playedRound = state.roundNo;
    if (ranking.winnerId) {
      state.roundWins[ranking.winnerId] = (state.roundWins[ranking.winnerId] || 0) + 1;
    }
    if (maxRoundWins() >= WINS_NEEDED || state.roundNo >= MAX_ROUNDS) {
      state.matchOver = true;
    } else {
      state.roundNo += 1;
    }
    audio.playSting(verdict);
  }

  const standings = rankByWins();
  $('result-score').textContent = standings
    .map((entry) => `${entry.nickname} ${entry.wins}`)
    .join('  ·  ');

  const title = $('result-title');
  if (state.matchOver && verdict !== 'waiting') {
    const myWins = state.roundWins[state.playerId] || 0;
    const best = maxRoundWins();
    const tiedBest = standings.filter((entry) => entry.wins === best).length > 1;
    const matchVerdict = myWins < best ? 'lose' : tiedBest ? 'draw' : 'win';
    $('result-eyebrow').textContent =
      `七局四胜 · ${standings.length} 人 · 最高 ${best} 分`;
    title.textContent =
      matchVerdict === 'win' ? '对决胜利！' : matchVerdict === 'lose' ? '对决失利' : '平分秋色';
    title.className = `verdict ${matchVerdict}`;
  } else {
    const titles = { win: '你赢了', lose: '惜败', draw: '平局', waiting: '你已完成' };
    $('result-eyebrow').textContent =
      `第 ${state.playedRound} 局 · ${state.code} · ${(DIFFICULTIES[state.raceDifficulty] || DIFFICULTIES.easy).label}`;
    title.textContent = titles[verdict];
    title.className = `verdict ${verdict}`;
  }

  renderResultCards(ranking);

  const rematch = $('btn-rematch');
  const done = verdict !== 'waiting';
  // 只有整场分出胜负后才出现"开始新对决"按钮；平时自动进入下一局，禁止提前开下一局
  rematch.hidden = !(done && state.matchOver && state.isHost);
  rematch.disabled = rematch.hidden;
  rematch.textContent = '开始新对决';

  if (!done) {
    setHint(
      'result-hint',
      state.players.length < 2 ? '其他玩家都已离开，请点"返回首页"。' : '等待其他玩家完成本局…'
    );
  } else if (state.matchOver) {
    setHint(
      'result-hint',
      state.isHost
        ? '整场对决结束；点"开始新对决"从第一局重新开打。'
        : '整场对决结束，等待房主开启新对决。'
    );
  } else {
    scheduleAutoNext();
  }

  show('screen-result');
  if (done) persistResult(ranking);
}

/** 按整场胜局分从高到低排序 */
function rankByWins() {
  return roundPlayers()
    .map((p) => ({
      playerId: p.playerId,
      nickname: p.nickname || '玩家',
      wins: state.roundWins[p.playerId] || 0
    }))
    .sort((a, b) => b.wins - a.wins || a.nickname.localeCompare(b.nickname));
}

/** 所有参赛者都出结果后，房主 1 秒后自动开下一局；其他人只等房主的开始广播 */
function scheduleAutoNext() {
  clearAutoNext();
  if (!state.isHost) {
    setHint('result-hint', '所有玩家已完成，即将自动开始下一局…');
    return;
  }
  let remain = 1;
  const render = () =>
    setHint(
      'result-hint',
      `${remain} 秒后自动开始第 ${state.roundNo} 局（${rankByWins()
        .map((entry) => `${entry.nickname} ${entry.wins}`)
        .join(' · ')}）…`
    );
  render();
  state.autoNextInterval = setInterval(() => {
    remain -= 1;
    if (remain > 0) render();
  }, 1000);
  state.autoNextTimer = setTimeout(() => {
    clearAutoNext();
    if (!othersList().length) {
      setHint('result-hint', '其他玩家都已离开，请点"返回首页"。');
      return;
    }
    hostStartRace();
  }, 1000);
}

function clearAutoNext() {
  if (state.autoNextTimer) {
    clearTimeout(state.autoNextTimer);
    state.autoNextTimer = null;
  }
  if (state.autoNextInterval) {
    clearInterval(state.autoNextInterval);
    state.autoNextInterval = null;
  }
}

function resultCard(name, result, options) {
  const card = document.createElement('div');
  card.className = 'result-card';
  if (options.winner) card.classList.add('winner');
  if (!result) card.classList.add('missing');

  const head = document.createElement('h4');
  const title = document.createElement('span');
  title.textContent = name;
  head.append(title);
  if (options.rank) {
    const badge = document.createElement('em');
    badge.textContent = options.winner ? '本局第一' : `第 ${options.rank} 名`;
    head.append(badge);
  }

  const grid = document.createElement('div');
  grid.className = 'result-stats';
  const stats = result
    ? [
        ['用时', result.finished ? `${(result.elapsedMs / 1000).toFixed(1)}s` : '超时'],
        ['速度', `${result.kpm} 字/分`],
        ['准确率', `${result.accuracy}%`],
        ['错字', `${Math.max(0, (result.chars || 0) - (result.correctChars || 0))} 个`]
      ]
    : [
        ['用时', '—'],
        ['速度', '还在打字…'],
        ['准确率', '—'],
        ['错字', '—']
      ];
  stats.forEach(([label, value]) => {
    const cell = document.createElement('div');
    cell.textContent = label;
    const strong = document.createElement('b');
    strong.textContent = value;
    cell.append(strong);
    grid.append(cell);
  });

  card.append(head, grid);
  return card;
}

function renderResultCards(ranking) {
  const grid = $('result-grid');
  grid.innerHTML = '';
  if (ranking) {
    ranking.entries.forEach((entry, index) => {
      grid.append(
        resultCard(entry.nickname || '玩家', entry.result, {
          winner: entry.playerId === ranking.winnerId,
          rank: index + 1
        })
      );
    });
    return;
  }
  // 还没全部完成：先列自己 + 已出结果的玩家
  roundPlayers().forEach((player) => {
    const result =
      player.playerId === state.playerId ? state.myResult : state.results[player.playerId];
    grid.append(resultCard(player.nickname || '玩家', result || null, {}));
  });
}

async function persistResult(ranking) {
  if (state.recorded) return;
  if (!state.isHost) return;
  if (!ranking) return;
  state.recorded = true;

  const entries = ranking.entries.map((entry) => ({ ...entry.result, playerId: entry.playerId }));
  const winnerName = ranking.winnerId
    ? entries.find((result) => result.playerId === ranking.winnerId)?.nickname || null
    : null;

  if (!state.cloud) {
    recordLocal(entries, ranking.winnerId);
    return;
  }

  try {
    const client = await getClient();
    if (!client) {
      recordLocal(entries, ranking.winnerId);
      return;
    }
    const matchId = crypto.randomUUID();
    const { error: matchError } = await client.from('matches').insert({
      id: matchId,
      room_code: state.code,
      difficulty: state.raceDifficulty,
      text_id: state.textId,
      winner_name: winnerName,
      started_at: new Date(Date.now() - (state.myResult?.elapsedMs || 0)).toISOString()
    });
    if (matchError) throw matchError;

    const rows = entries.map((result) => ({
      match_id: matchId,
      player_id: result.playerId,
      nickname: result.nickname,
      elapsed_ms: result.elapsedMs,
      chars: result.chars,
      correct_chars: result.correctChars,
      accuracy: result.accuracy,
      kpm: result.kpm,
      finished: !!result.finished,
      is_winner: !!ranking.winnerId && result.playerId === ranking.winnerId,
      outcome: !ranking.winnerId
        ? 'draw'
        : result.playerId === ranking.winnerId
          ? 'win'
          : 'lose'
    }));
    const { error: playersError } = await client.from('match_players').insert(rows);
    if (playersError) throw playersError;
  } catch (err) {
    console.warn('战绩保存失败：', err);
    setHint('result-hint', `战绩保存失败：${err.message || err}`);
  }
}

/* ---------- 排行榜 ---------- */

function recordLocal(results, winnerId) {
  let records = [];
  try {
    records = JSON.parse(localStorage.getItem(LOCAL_RECORDS_KEY) || '[]');
  } catch {
    records = [];
  }
  results.forEach((result) => {
    records.push({
      nickname: result.nickname,
      kpm: result.kpm,
      accuracy: result.accuracy,
      elapsedMs: result.elapsedMs,
      finished: !!result.finished,
      outcome: !winnerId ? 'draw' : result.playerId === winnerId ? 'win' : 'lose'
    });
  });
  localStorage.setItem(LOCAL_RECORDS_KEY, JSON.stringify(records.slice(-500)));
}

function readLocalRecords() {
  try {
    return JSON.parse(localStorage.getItem(LOCAL_RECORDS_KEY) || '[]');
  } catch {
    return [];
  }
}

function localWinsRows() {
  const map = new Map();
  readLocalRecords().forEach((record) => {
    if (typeof record.kpm !== 'number') return;
    const row = map.get(record.nickname) || {
      nickname: record.nickname,
      races: 0,
      wins: 0,
      draws: 0,
      losses: 0,
      best_kpm: 0,
      sumKpm: 0,
      sumAccuracy: 0
    };
    row.races += 1;
    if (record.outcome === 'win') row.wins += 1;
    else if (record.outcome === 'draw') row.draws += 1;
    else row.losses += 1;
    row.best_kpm = Math.max(row.best_kpm, record.kpm);
    row.sumKpm += record.kpm;
    row.sumAccuracy += record.accuracy || 0;
    map.set(record.nickname, row);
  });
  return [...map.values()]
    .map((row) => ({
      nickname: row.nickname,
      races: row.races,
      wins: row.wins,
      draws: row.draws,
      losses: row.losses,
      best_kpm: Math.round(row.best_kpm),
      avg_kpm: Math.round((row.sumKpm / row.races) * 10) / 10,
      avg_accuracy: Math.round((row.sumAccuracy / row.races) * 10) / 10
    }))
    .sort((a, b) => b.wins - a.wins || b.avg_kpm - a.avg_kpm);
}

/** 平均耗时（本地演示模式：聚合本机所有已完成对局的耗时） */
function localAvgRows() {
  const map = new Map();
  readLocalRecords().forEach((record) => {
    if (!record.finished || typeof record.elapsedMs !== 'number') return;
    const row = map.get(record.nickname) || { nickname: record.nickname, sumMs: 0, races: 0 };
    row.sumMs += record.elapsedMs;
    row.races += 1;
    map.set(record.nickname, row);
  });
  return [...map.values()]
    .map((row) => ({
      nickname: row.nickname,
      avg_ms: Math.round(row.sumMs / row.races),
      races: row.races
    }))
    .sort((a, b) => a.avg_ms - b.avg_ms);
}

let lbTab = 'wins';

async function openLeaderboard(tab) {
  if (tab) lbTab = tab;
  document.querySelectorAll('#lb-tabs button').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.lb === lbTab);
  });

  const body = $('leaderboard-body');
  body.innerHTML = '<p class="hint">加载中…</p>';
  openModal('modal-leaderboard');

  try {
    const client = await getClient();
    if (!client) {
      renderLeaderboard(lbTab, lbTab === 'wins' ? localWinsRows() : localAvgRows(),
        '本机演示模式下只统计这台设备上的对局。');
      return;
    }
    const table = lbTab === 'wins' ? 'leaderboard_wins' : 'leaderboard_avg_daily';
    const { data, error } = await client.from(table).select('*').limit(20);
    if (error) throw error;
    renderLeaderboard(lbTab, data || [], lbTab === 'avg' ? '平均耗时榜每天凌晨 0 点结算一次。' : '');
  } catch (err) {
    body.innerHTML = '';
    const tip = document.createElement('p');
    tip.className = 'hint';
    tip.textContent = `读取失败：${err.message || err}`;
    body.append(tip);
  }
}

function renderLeaderboard(tab, rows, note) {
  const body = $('leaderboard-body');
  body.innerHTML = '';

  if (!rows.length) {
    const empty = document.createElement('p');
    empty.className = 'hint';
    empty.textContent = tab === 'wins'
      ? '还没有战绩，先打一局吧。'
      : '暂无完成的对局数据；平均耗时榜每天凌晨 0 点结算一次。';
    body.append(empty);
    return;
  }

  const columns = tab === 'wins'
    ? ['#', '昵称', '胜', '平', '负', '最佳', '平均', '准确']
    : ['#', '昵称', '平均耗时', '完成场次'];

  const table = document.createElement('table');
  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  columns.forEach((label) => {
    const th = document.createElement('th');
    th.textContent = label;
    headRow.append(th);
  });
  thead.append(headRow);

  const tbody = document.createElement('tbody');
  rows.forEach((row, index) => {
    const tr = document.createElement('tr');
    const cells = tab === 'wins'
      ? [
          String(index + 1),
          row.nickname,
          String(row.wins ?? '—'),
          String(row.draws ?? '—'),
          String(row.losses ?? '—'),
          String(row.best_kpm ?? '—'),
          String(row.avg_kpm ?? '—'),
          row.avg_accuracy == null ? '—' : `${row.avg_accuracy}%`
        ]
      : [
          String(index + 1),
          row.nickname,
          row.avg_ms == null ? '—' : `${(row.avg_ms / 1000).toFixed(2)}s`,
          String(row.races ?? '—')
        ];
    cells.forEach((value, cellIndex) => {
      const td = document.createElement('td');
      td.textContent = value;
      if (cellIndex === 1 && row.nickname === state.nickname) td.className = 'me';
      tr.append(td);
    });
    tbody.append(tr);
  });

  table.append(thead, tbody);
  body.append(table);

  if (note) {
    const tip = document.createElement('p');
    tip.className = 'hint';
    tip.textContent = note;
    body.append(tip);
  }
}

/* ---------- 设置 ---------- */

function openSettings() {
  const baked = bakedConfig();
  const cfg = baked || loadConfig();
  const urlInput = $('input-sb-url');
  const keyInput = $('input-sb-key');
  urlInput.value = cfg ? cfg.url : '';
  keyInput.value = cfg ? cfg.key : '';

  // 站点已内置云端配置时，禁止在这里改掉它
  urlInput.disabled = !!baked;
  keyInput.disabled = !!baked;
  $('btn-save-settings').hidden = !!baked;
  $('btn-local-mode').hidden = !!baked;
  setHint('settings-hint', baked ? '本站已内置云端配置，打开即可与好友跨网络对战。' : '');
  openModal('modal-settings');
}

async function saveSettings() {
  const url = $('input-sb-url').value.trim();
  const key = $('input-sb-key').value.trim();
  if (!/^https?:\/\//i.test(url) || !key) {
    setHint('settings-hint', 'URL 需要以 https:// 开头，并且要填写 anon key。');
    return;
  }
  saveConfig({ url, key });
  updateConnBadge();
  applyAuthUI();
  setHint('settings-hint', '正在加载 Supabase 客户端…');
  try {
    const client = await getClient();
    if (!client) throw new Error('配置无效');
    setHint('settings-hint', '已切换到云端房间模式，重新创建房间即可生效。');
    setHint('home-hint', '已开启云端房间，可与好友在不同网络下对战。');
  } catch (err) {
    setHint('settings-hint', `${err.message || err}，请检查网络后重试。`);
  }
}

function useLocalMode() {
  clearConfig();
  updateConnBadge();
  applyAuthUI();
  closeModal('modal-settings');
  setHint('home-hint', '已切换到本机演示模式：请在同一浏览器开两个标签页。');
}

/* ---------- 房间退出 ---------- */

async function leaveRoom() {
  cancelAnimationFrame(state.raf);
  clearAutoNext();
  clearTimeout(state.limitTimer);
  state.racing = false;
  state.finished = false;

  if (state.isHost) await removeRoomRow(state.code);
  else if (state.roomBeat) {
    clearInterval(state.roomBeat);
    state.roomBeat = null;
  }

  if (state.transport) {
    const transport = state.transport;
    state.transport = null;
    try {
      await transport.close();
    } catch {
      /* 忽略 */
    }
  }

  state.code = '';
  state.players = [];
  state.myResult = null;
  state.results = {};
  state.roundPlayers = [];
  state.roundWins = {};
  state.recorded = false;
  state.spans = [];
  state.engine = null;
  state.roundNo = 1;
  state.matchOver = false;
  state.roundTallied = false;
  laneEls.clear();
  state.laneSignature = '';
  audio.stopRaceMusic();
  setHint('home-hint', '');
  show('screen-home');
}

/* ---------- 绑定 ---------- */

function bindEvents() {
  $('btn-create').addEventListener('click', createRoom);
  $('btn-join').addEventListener('click', joinRoom);
  $('input-room').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') joinRoom();
  });
  $('input-room').addEventListener('input', () => {
    $('input-room').value = $('input-room').value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  });
  $('input-nickname').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') createRoom();
  });

  $('btn-copy').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(state.code);
      setHint('lobby-hint', `房间码 ${state.code} 已复制。`);
    } catch {
      setHint('lobby-hint', `复制失败，请手动复制：${state.code}`);
    }
  });

  $('difficulty-seg').addEventListener('click', (event) => {
    const btn = event.target.closest('button[data-difficulty]');
    if (btn) setDifficulty(btn.dataset.difficulty);
  });

  $('lang-seg').addEventListener('click', (event) => {
    const btn = event.target.closest('button[data-lang]');
    if (btn) setLang(btn.dataset.lang);
  });

  $('btn-start').addEventListener('click', hostStartRace);
  $('btn-leave-lobby').addEventListener('click', leaveRoom);
  $('btn-back-home').addEventListener('click', leaveRoom);
  $('btn-rematch').addEventListener('click', hostStartRace);

  $('typing-input').addEventListener('input', handleInput);
  $('typing-input').addEventListener('compositionend', syncFromInput);
  $('typing-input').addEventListener('paste', (event) => event.preventDefault());
  $('typing-wrap').addEventListener('click', () => {
    if (state.racing) $('typing-input').focus();
  });

  $('btn-leaderboard').addEventListener('click', () => openLeaderboard());
  $('btn-result-lb').addEventListener('click', () => openLeaderboard());
  $('btn-settings').addEventListener('click', openSettings);
  $('btn-save-settings').addEventListener('click', saveSettings);
  $('btn-local-mode').addEventListener('click', useLocalMode);

  // 账号：登录 / 注册 / 退出
  $('btn-login').addEventListener('click', () => doAuth());
  $('btn-logout').addEventListener('click', logout);
  ['input-auth-name', 'input-auth-pass'].forEach((fieldId) => {
    $(fieldId).addEventListener('keydown', (event) => {
      if (event.key === 'Enter') doAuth();
    });
  });

  // 排行榜 tabs
  document.querySelectorAll('#lb-tabs button').forEach((btn) => {
    btn.addEventListener('click', () => openLeaderboard(btn.dataset.lb));
  });

  // 房间列表：手动刷新 + 首页可见时每 4 秒自动刷新
  $('btn-refresh-rooms').addEventListener('click', refreshRooms);
  setInterval(() => {
    const onHome = $('screen-home').classList.contains('active');
    const loggedIn = !$('play-area').hidden;
    if (onHome && loggedIn) refreshRooms();
  }, 4000);

  document.querySelectorAll('[data-close]').forEach((btn) => {
    btn.addEventListener('click', () => closeModal(btn.dataset.close));
  });
  document.querySelectorAll('.modal').forEach((modal) => {
    modal.addEventListener('click', (event) => {
      if (event.target === modal) modal.hidden = true;
    });
  });

  // 背景音乐：开关按钮 + 首次交互解锁 AudioContext（浏览器自动播放策略）
  const audioBtn = $('btn-audio');
  const syncAudioBtn = () => {
    audioBtn.textContent = audio.muted ? '♪ 已静音' : '♪ 音乐开';
    audioBtn.classList.toggle('off', audio.muted);
  };
  syncAudioBtn();
  audioBtn.addEventListener('click', () => {
    audio.toggleMuted();
    syncAudioBtn();
  });
  const unlockAudio = () => audio.unlock();
  document.addEventListener('pointerdown', unlockAudio, { once: true });
  document.addEventListener('keydown', unlockAudio, { once: true });
}

function init() {
  bindEvents();
  updateConnBadge();
  applyAuthUI();
  refreshRooms();
  show('screen-home');
}

init();
