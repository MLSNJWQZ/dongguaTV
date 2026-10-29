// 👤 自建账号体系（可选功能，需 CACHE_TYPE=sqlite）
//
// 为什么要有这一层：
//   上游的账号模型是「一个 ACCESS_PASSWORD 里的密码 = 一个用户」，token 就是 sha256(密码)——
//   没有用户名、没有后台建号、改密码必然等于换 token（所有设备掉线）、且密码无盐裸哈希。
//   本模块在【完全不动现有逻辑】的前提下补一层真正的账号：
//
//   · 用户名 + 密码登录（老式的「只输密码」照常可用，现有密码与已登录设备零影响）
//   · token 与密码解耦：改密码不换 token → 手机/电视/电脑全都不用重新登录
//   · scrypt 加盐存储（不再裸 sha256）
//   · 站长后台可建号 / 改密 / 删号，用户可自助改密
//
// 最小侵入的关键设计 —— 令牌并入 PASSWORD_HASH_MAP：
//   server.js 里有 20 多处 `PASSWORD_HASH_MAP[token]` / ownToken(token) 做鉴权。要让新账号的 token
//   被这些地方认下来，不需要逐个改调用点，只需在启动时把每个账号的 token 写进 PASSWORD_HASH_MAP
//   （index 从 1000 起，syncEnabled:true，因此自动获得跨设备同步）。新增/改密/删除后调 resync() 保持一致。
//
// 只存 SQLite(cache.db)：db.json 会被 REMOTE_DB_URL 每 5 分钟覆盖一次，写进去的账号会凭空消失。

const crypto = require('crypto');

// scrypt 参数：128*N*r = 16MB，单次约 50~80ms（Node 默认 maxmem 32MB，这里显式放宽到 64MB 留余量）
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32, maxmem: 64 * 1024 * 1024 };

// 用户名：3-32 位字母/数字/下划线/连字符（不区分大小写，统一按小写存）
const NAME_RE = /^[a-zA-Z0-9_-]{3,32}$/;
const normName = (s) => String(s || '').trim().toLowerCase();

function hashPassword(pwd) {
    return new Promise((resolve, reject) => {
        const salt = crypto.randomBytes(16).toString('hex');
        crypto.scrypt(String(pwd), salt, SCRYPT.keylen, SCRYPT, (err, dk) => {
            if (err) return reject(err);
            resolve(`scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt}$${dk.toString('hex')}`);
        });
    });
}

function verifyPassword(pwd, stored) {
    return new Promise((resolve) => {
        const m = /^scrypt\$(\d+)\$(\d+)\$(\d+)\$([0-9a-f]+)\$([0-9a-f]+)$/.exec(String(stored || ''));
        if (!m) return resolve(false);
        const want = Buffer.from(m[5], 'hex');
        if (want.length !== SCRYPT.keylen) return resolve(false);
        crypto.scrypt(String(pwd), m[4], want.length,
            { N: +m[1], r: +m[2], p: +m[3], maxmem: SCRYPT.maxmem },
            (err, dk) => {
                if (err || !dk || dk.length !== want.length) return resolve(false);
                try { resolve(crypto.timingSafeEqual(dk, want)); } catch (e) { resolve(false); }
            });
    });
}

// 恒定时间比较，避免按返回快慢枚举用户名
function safeEq(a, b) {
    const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || ''));
    if (x.length !== y.length) return false;
    try { return crypto.timingSafeEqual(x, y); } catch (e) { return false; }
}

function createAuthUsers(opts) {
    opts = opts || {};
    const dbOf = opts.db || (() => null);
    let ready = false;

    function init() {
        const db = dbOf();
        if (!db) return false;      // 非 sqlite：功能整体关闭，不报错
        try {
            db.exec(`
                CREATE TABLE IF NOT EXISTS app_users (
                    username   TEXT PRIMARY KEY,
                    pwd_hash   TEXT NOT NULL,
                    token      TEXT NOT NULL UNIQUE,
                    note       TEXT,
                    banned     INTEGER NOT NULL DEFAULT 0,
                    created_at INTEGER,
                    last_login INTEGER
                )
            `);
            db.exec('CREATE INDEX IF NOT EXISTS idx_app_users_token ON app_users(token)');
            ready = true;
            return true;
        } catch (e) {
            console.warn('[账号] app_users 表初始化失败，自建账号已禁用:', e.message);
            return false;
        }
    }

    const ok = () => ready && !!dbOf();
    const byName = (u) => { try { return dbOf().prepare('SELECT * FROM app_users WHERE username = ?').get(normName(u)) || null; } catch (e) { return null; } };
    const byToken = (t) => { try { return (typeof t === 'string' && /^[a-f0-9]{32}$/.test(t)) ? (dbOf().prepare('SELECT * FROM app_users WHERE token = ?').get(t) || null) : null; } catch (e) { return null; } };

    // ---- 登录校验 ----
    async function verify(username, password) {
        if (!ok() || !username || !password) return { ok: false };
        const row = byName(username);
        // 用户名不存在也走一次假的 scrypt，避免「有这个号 / 没这个号」的响应时间差
        const stored = row ? row.pwd_hash : `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${'0'.repeat(32)}$${'0'.repeat(SCRYPT.keylen * 2)}`;
        const pass = await verifyPassword(password, stored);
        if (!row || !pass) return { ok: false };
        if (row.banned) return { ok: false, banned: true };
        try { dbOf().prepare('UPDATE app_users SET last_login = ? WHERE username = ?').run(Date.now(), row.username); } catch (e) { }
        return { ok: true, username: row.username, token: row.token, note: row.note || '', index: 1000 + (row.rowid || 0) };
    }

    // ---- 令牌并入 PASSWORD_HASH_MAP（让全站既有鉴权点自动认这些账号）----
    // 每次写操作后调用：先清掉上一轮写进去的（index >= 1000），再按当前表重写。
    function resync(map) {
        if (!ok() || !map) return 0;
        try {
            for (const k of Object.keys(map)) { if (map[k] && map[k].index >= 1000) delete map[k]; }
            const rows = dbOf().prepare('SELECT username, token, note FROM app_users').all();
            rows.forEach((r, i) => {
                if (!r.token) return;
                map[r.token] = { index: 1000 + i, syncEnabled: true, username: r.username, account: true };
            });
            return rows.length;
        } catch (e) { console.warn('[账号] 令牌并入失败:', e.message); return 0; }
    }

    // ---- 后台管理 ----
    function list() {
        if (!ok()) return [];
        try {
            return dbOf().prepare('SELECT username, token, note, banned, created_at, last_login FROM app_users ORDER BY created_at ASC')
                .all().map(r => ({
                    username: r.username, token: r.token, note: r.note || '',
                    banned: !!r.banned, created_at: r.created_at || 0, last_login: r.last_login || 0
                }));
        } catch (e) { return []; }
    }

    async function create(input) {
        if (!ok()) return { ok: false, error: 'SQLite not available' };
        const username = normName(input && input.username);
        const password = String((input && input.password) || '');
        if (!NAME_RE.test(username)) return { ok: false, error: '用户名需 3-32 位字母/数字/下划线/连字符' };
        if (password.length < 6 || password.length > 128) return { ok: false, error: '密码需 6-128 位' };
        if (byName(username)) return { ok: false, error: '用户名已存在' };
        const pwd_hash = await hashPassword(password);
        const token = crypto.randomBytes(16).toString('hex');
        try {
            dbOf().prepare('INSERT INTO app_users (username, pwd_hash, token, note, banned, created_at) VALUES (?, ?, ?, ?, 0, ?)')
                .run(username, pwd_hash, token, String((input && input.note) || '').slice(0, 200), Date.now());
        } catch (e) { return { ok: false, error: 'Database error' }; }
        return { ok: true, username, token };
    }

    // 改密（站长重置）：只换 pwd_hash，token 不动 → 用户其他设备不掉线
    async function setPassword(username, password) {
        if (!ok()) return { ok: false, error: 'SQLite not available' };
        const row = byName(username);
        if (!row) return { ok: false, error: '用户不存在' };
        if (String(password || '').length < 6 || String(password || '').length > 128) return { ok: false, error: '密码需 6-128 位' };
        const pwd_hash = await hashPassword(password);
        try { dbOf().prepare('UPDATE app_users SET pwd_hash = ? WHERE username = ?').run(pwd_hash, row.username); }
        catch (e) { return { ok: false, error: 'Database error' }; }
        return { ok: true, username: row.username, token: row.token };
    }

    function remove(username) {
        if (!ok()) return { ok: false, error: 'SQLite not available' };
        const row = byName(username);
        if (!row) return { ok: false, error: '用户不存在' };
        try { dbOf().prepare('DELETE FROM app_users WHERE username = ?').run(row.username); }
        catch (e) { return { ok: false, error: 'Database error' }; }
        return { ok: true, username: row.username, token: row.token };
    }

    function setBanned(username, banned) {
        if (!ok()) return { ok: false, error: 'SQLite not available' };
        const row = byName(username);
        if (!row) return { ok: false, error: '用户不存在' };
        try { dbOf().prepare('UPDATE app_users SET banned = ? WHERE username = ?').run(banned ? 1 : 0, row.username); }
        catch (e) { return { ok: false, error: 'Database error' }; }
        return { ok: true, username: row.username, token: row.token, banned: !!banned };
    }

    // 用户自助改密：校验旧密码，只换哈希（token 不变 → 其他设备保持登录）
    async function changePassword(token, oldPassword, newPassword) {
        if (!ok()) return { ok: false, error: 'SQLite not available' };
        const row = byToken(token);
        if (!row) return { ok: false, error: '登录状态无效' };
        if (!(await verifyPassword(oldPassword, row.pwd_hash))) return { ok: false, error: '当前密码不正确' };
        if (String(newPassword || '').length < 6 || String(newPassword || '').length > 128) return { ok: false, error: '新密码需 6-128 位' };
        if (safeEq(oldPassword, newPassword)) return { ok: false, error: '新密码不能与当前密码相同' };
        const pwd_hash = await hashPassword(newPassword);
        try { dbOf().prepare('UPDATE app_users SET pwd_hash = ? WHERE username = ?').run(pwd_hash, row.username); }
        catch (e) { return { ok: false, error: 'Database error' }; }
        return { ok: true, username: row.username, token: row.token };
    }

    // 后台展示用：把 token 翻成人能认的身份
    const labelOf = (token) => { const r = byToken(token); return r ? ('账号: ' + r.username) : null; };

    // /api/auth/check 每次页面加载都调,别每次查库;30s 缓存足够(建号后最多 30s 登录墙就生效)
    let _cnt = { n: 0, at: 0 };
    const count = () => {
        if (!ok()) return 0;
        const now = Date.now();
        if (now - _cnt.at < 30000) return _cnt.n;
        try {
            const r = dbOf().prepare('SELECT COUNT(*) c FROM app_users').get();
            _cnt = { n: (r && r.c) || 0, at: now };
        } catch (e) { _cnt = { n: 0, at: now }; }
        return _cnt.n;
    };

    return {
        init, resync, verify, list, create, setPassword, remove, setBanned, changePassword, labelOf, count,
        byToken, byName,
        enabled: () => ok(),
        nameOk: (u) => NAME_RE.test(normName(u))
    };
}

module.exports = { createAuthUsers, hashPassword, verifyPassword };
