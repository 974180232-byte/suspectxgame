// ============ 大股东之神秘的9和谁想吃10（本地版，后续接入联机） ============

// ---------- 音效（Web Audio API） ----------
let _audioCtx = null;
let _sfxEnabled = true;
function _getAudioCtx() {
    if (!_audioCtx) {
        try {
            const AC = window.AudioContext || window.webkitAudioContext;
            if (AC) _audioCtx = new AC();
        } catch (e) { _audioCtx = null; }
    }
    return _audioCtx;
}
function playSfx(type) {
    if (!_sfxEnabled) return;
    const ctx = _getAudioCtx();
    if (!ctx) return;
    if (ctx.state === 'suspended') ctx.resume();
    try {
        const now = ctx.currentTime;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);
        let freq = 600, dur = 0.08, wave = 'sine';
        switch (type) {
            case 'click': freq = 800; dur = 0.05; break;
            case 'draw': freq = 500; dur = 0.12; break;
            case 'play': freq = 700; dur = 0.1; break;
            case 'invest': freq = 650; dur = 0.15; break;
            case 'score': freq = 900; dur = 0.2; wave = 'triangle'; break;
        }
        osc.type = wave;
        osc.frequency.setValueAtTime(freq, now);
        gain.gain.setValueAtTime(0.0001, now);
        gain.gain.exponentialRampToValueAtTime(0.25, now + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + dur);
        osc.start(now);
        osc.stop(now + dur + 0.05);
    } catch (e) {}
}

// ---------- 数据层（Supabase 跨设备联机，网络不可用时回退本地模式） ----------
const ROOM_PREFIX = 'stock_room_';
const SUPABASE_URL = 'https://thmxdynsofffarecfauw.supabase.co';
const SUPABASE_KEY = 'sb_publishable_prdBh_WqbbiZbCXm5nLeBA_ojMhFyo3';
const ROOM_COLLECTION = 'rooms';
let supabaseClient = null;
let useCloud = false;
let cloudRoomsCache = {};
let broadcastChannel = null;
let broadcastRoomsCache = {};

// 生成房间（用 stock_ 前缀区分于嫌疑人游戏）
function makeRoomId() { return 'stock_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6); }

function saveRoom(roomId, roomData) {
    if (!roomId || !roomData) return;
    roomData.updatedAt = Date.now();
    if (useCloud && supabaseClient) {
        cloudRoomsCache[roomId] = roomData;
        supabaseClient.from(ROOM_COLLECTION)
            .upsert({ id: roomId, data: roomData }, { onConflict: 'id' })
            .then(({ error }) => { if (error) console.warn('Supabase 写入失败', error); });
    } else {
        localStorage.setItem(ROOM_PREFIX + roomId, JSON.stringify(roomData));
        broadcastPost({ type: 'room-data', roomId, roomData });
    }
}
function getRoom(roomId) {
    if (useCloud && supabaseClient) {
        const cached = cloudRoomsCache[roomId];
        if (cached) return cached;
        const localData = localStorage.getItem(ROOM_PREFIX + roomId);
        if (localData) {
            const room = JSON.parse(localData);
            cloudRoomsCache[roomId] = room;
            return room;
        }
        return null;
    }
    const data = localStorage.getItem(ROOM_PREFIX + roomId);
    return data ? JSON.parse(data) : null;
}
function getAllRooms() {
    if (useCloud && supabaseClient) {
        const rooms = { ...cloudRoomsCache };
        // 合并本地房间（处理登录前创建）
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key.startsWith(ROOM_PREFIX)) {
                const roomId = key.substring(ROOM_PREFIX.length);
                if (!rooms[roomId]) {
                    try {
                        const roomData = JSON.parse(localStorage.getItem(key));
                        if (roomData) rooms[roomId] = roomData;
                    } catch (e) {}
                }
            }
        }
        return rooms;
    }
    const rooms = {};
    for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key.startsWith(ROOM_PREFIX)) {
            const roomId = key.substring(ROOM_PREFIX.length);
            try {
                const roomData = JSON.parse(localStorage.getItem(key));
                if (roomData) rooms[roomId] = roomData;
            } catch (e) {}
        }
    }
    Object.keys(broadcastRoomsCache).forEach(id => {
        if (!rooms[id]) rooms[id] = broadcastRoomsCache[id];
    });
    return rooms;
}
function deleteRoom(roomId) {
    if (useCloud && supabaseClient) {
        delete cloudRoomsCache[roomId];
        supabaseClient.from(ROOM_COLLECTION).delete().eq('id', roomId)
            .then(({ error }) => { if (error) console.warn('Supabase 删除失败', error); });
    } else {
        localStorage.removeItem(ROOM_PREFIX + roomId);
        broadcastPost({ type: 'room-deleted', roomId });
        if (broadcastRoomsCache) delete broadcastRoomsCache[roomId];
    }
}

// 尝试连接 Supabase（匿名登录，失败回退本地模式）
function initSupabase() {
    if (typeof supabase === 'undefined' || !SUPABASE_URL || !SUPABASE_KEY) {
        updateConnStatus('本地模式（仅同浏览器多标签页）');
        return;
    }
    try {
        supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
        supabaseClient.auth.signInAnonymously()
            .then(({ error }) => {
                if (error) { console.warn('Supabase 匿名登录失败，本地模式', error); useCloud = false; updateConnStatus('本地模式（登录失败）'); return; }
                useCloud = true;
                console.log('✅ Supabase 已连接（跨设备联机）');
                updateConnStatus('Supabase 已连接');
                migrateLocalRoomsToCloud();
                startCloudSyncLoop();
            });
    } catch (e) {
        console.warn('Supabase 初始化失败，本地模式', e);
        useCloud = false;
        updateConnStatus('本地模式（初始化异常）');
    }
}

function migrateLocalRoomsToCloud() {
    if (!useCloud || !supabaseClient) return;
    for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key.startsWith(ROOM_PREFIX)) {
            const roomId = key.substring(ROOM_PREFIX.length);
            try {
                const roomData = JSON.parse(localStorage.getItem(key));
                if (roomData && !cloudRoomsCache[roomId]) {
                    cloudRoomsCache[roomId] = roomData;
                    supabaseClient.from(ROOM_COLLECTION).upsert({ id: roomId, data: roomData }, { onConflict: 'id' });
                }
            } catch (e) {}
        }
    }
}

// 定时轮询云端同步（跨设备）
let cloudSyncTimer = null;
function startCloudSyncLoop() {
    stopCloudSyncLoop();
    const tick = () => {
        if (useCloud && supabaseClient) {
            pullRoomsFromCloud();
            heartbeatCurrentRoom();   // 刷新自己在房间中的活跃时间
            triggerGlobalCleanup();   // 云端全局清理（掉线玩家 / 0 人房间）
            tryRejoinPendingRoom();   // 若有待重连的房间且已同步到缓存，则自动回到房间
        }
        cloudSyncTimer = setTimeout(tick, 1000);
    };
    tick();
}

// 处理「刷新/重连」：待重连的房间同步到缓存后，自动回到房间
function tryRejoinPendingRoom() {
    if (!app || !app.pendingRejoin) return;
    const roomId = app.pendingRejoin;
    const room = getRoom(roomId);
    if (room) {
        app.pendingRejoin = null;
        app.rejoinRoom(roomId);
    }
    // 若云端确认没有该房间（清理逻辑已移除它），清除待重连标记回到大厅
    if (!room && !cloudRoomsCache[roomId]) {
        app.pendingRejoin = null;
        localStorage.removeItem('stock_current_room');
    }
}
function stopCloudSyncLoop() {
    if (cloudSyncTimer) { clearTimeout(cloudSyncTimer); cloudSyncTimer = null; }
}

// 心跳：玩家在房间时，定期用 RPC 更新自己的 lastActive（服务器时间），防止被误判掉线
let lastHeartbeat = 0;
const HEARTBEAT_INTERVAL = 10000;      // 每 10 秒刷新一次活跃时间
const GLOBAL_CLEANUP_INTERVAL = 15000; // 每 15 秒调用一次云端全局清理
let lastGlobalCleanup = 0;

function heartbeatCurrentRoom() {
    if (!app || !app.currentRoomId) return;
    if (Date.now() - lastHeartbeat < HEARTBEAT_INTERVAL) return;
    lastHeartbeat = Date.now();
    const room = getRoom(app.currentRoomId);
    if (!room || !room.players || !room.players[app.playerId]) return;
    room.players[app.playerId].lastActive = Date.now();   // 本地缓存更新
    if (useCloud && supabaseClient) {
        // 用 RPC 在数据库层只更新 lastActive，避免整对象覆盖他人数据
        supabaseClient.rpc('heartbeat', { room_id: app.currentRoomId, player_id: app.playerId })
            .then(({ error }) => { if (error) console.warn('heartbeat RPC 失败', error); });
    } else {
        saveRoom(app.currentRoomId, room);
    }
}

// 调用云端全局清理 RPC（限频）：移除所有房间掉线玩家 / 0 人房间
function triggerGlobalCleanup() {
    if (!useCloud || !supabaseClient) return;
    if (Date.now() - lastGlobalCleanup < GLOBAL_CLEANUP_INTERVAL) return;
    lastGlobalCleanup = Date.now();
    supabaseClient.rpc('cleanup_expired_rooms')
        .then(({ error }) => { if (error) console.warn('cleanup_expired_rooms RPC 失败', error); });
}
function pullRoomsFromCloud() {
    if (!useCloud || !supabaseClient) return;
    supabaseClient.from(ROOM_COLLECTION)
        .select('id, data')
        .then(({ data, error }) => {
            if (error) return;
            (data || []).forEach(row => {
                // 只处理股票游戏自己的房间（id 以 stock_ 开头）
                if (row && row.data && row.id && row.id.startsWith('stock_')) {
                    const localData = cloudRoomsCache[row.id];
                    if (JSON.stringify(localData) !== JSON.stringify(row.data)) {
                        cloudRoomsCache[row.id] = row.data;
                        if (app.currentRoomId === row.id) {
                            app.currentRoomData = row.data;
                            app.renderCurrentView();
                        } else {
                            app.refreshRooms();
                        }
                    }
                }
            });
        });
}

// 连接状态显示
function updateConnStatus(text, color) {
    try {
        const el = document.getElementById('conn-status');
        if (el) { el.textContent = text; el.style.background = color || 'rgba(0,0,0,0.55)'; }
    } catch (e) {}
}

// BroadcastChannel 跨标签页同步（本地模式，同一浏览器多标签页联机）
function initBroadcastChannel() {
    try {
        broadcastChannel = new BroadcastChannel('stock-sync');
        broadcastChannel.onmessage = (event) => {
            const msg = event.data;
            if (!msg) return;
            if (msg.type === 'room-data') {
                broadcastRoomsCache[msg.roomId] = msg.roomData;
                if (app.currentRoomId === msg.roomId) {
                    app.currentRoomData = msg.roomData;
                    app.renderCurrentView();
                } else {
                    app.refreshRooms();
                }
            } else if (msg.type === 'room-deleted') {
                delete broadcastRoomsCache[msg.roomId];
                if (app.currentRoomId === msg.roomId) {
                    app.leaveRoomSilent();
                } else {
                    app.refreshRooms();
                }
            }
        };
    } catch (e) {
        window.addEventListener('storage', (e) => {
            if (e.key && e.key.startsWith(ROOM_PREFIX)) app.refreshRooms();
        });
    }
}
function broadcastPost(msg) {
    try { if (broadcastChannel) broadcastChannel.postMessage(msg); } catch (e) {}
}

// ---------- 游戏常量 ----------
// 6家公司：编号5-10，编号=该公司牌数量
const COMPANIES = [5, 6, 7, 8, 9, 10];
// 各公司的卡牌颜色（用于区分不同公司的牌）
const COMPANIES_COLORS = ['#e63946', '#2a9d8f', '#457b9d', '#f4a261', '#9b5de5', '#6d28d9'];
const TOTAL_CARDS = 45;        // 5+6+7+8+9+10 = 45
const HAND_SIZE = 3;           // 初始手牌3张
const INITIAL_MONEY = 10;      // 初始10元
const PLAYER_COLORS = ['#e63946', '#2a9d8f', '#457b9d', '#f4a261', '#9b5de5', '#e07b00', '#6d28d9'];

// 构建所有公司卡牌
function buildDeck() {
    const deck = [];
    COMPANIES.forEach(num => {
        for (let i = 0; i < num; i++) deck.push(num);
    });
    return deck;
}

// 洗牌
function shuffle(arr) {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}

// 生成随机名字
function generateName() {
    const adj = ['闪电', '钢铁', '黄金', '风云', '极速', '无畏', '雷霆', '猎手'];
    const noun = ['玩家', '股神', '大亨', '操盘手', '财神', '投手'];
    return adj[Math.floor(Math.random()*adj.length)] + noun[Math.floor(Math.random()*noun.length)] + Math.floor(Math.random()*90+10);
}

// ---------- 应用对象 ----------
const app = {
    playerName: '',
    playerId: '',
    currentRoomId: null,
    currentRoomData: null,

    // ===== 登录 =====
    login() {
        const input = document.getElementById('name-input');
        const name = input.value.trim() || generateName();
        this.playerName = name;
        this.playerId = 'p_' + Date.now() + '_' + Math.random().toString(36).substr(2, 8);
        localStorage.setItem('stock_player_id', this.playerId);
        localStorage.setItem('stock_player_name', this.playerName);
        this.showLobby();
    },

    restoreSession() {
        const id = localStorage.getItem('stock_player_id');
        const name = localStorage.getItem('stock_player_name');
        if (id && name) {
            this.playerId = id;
            this.playerName = name;
            return true;
        }
        return false;
    },

    logout() {
        localStorage.removeItem('stock_player_id');
        localStorage.removeItem('stock_player_name');
        localStorage.removeItem('stock_current_room');
        this.playerId = '';
        this.playerName = '';
        this.currentRoomId = null;
        this.showLogin();
    },

    // ===== 界面切换 =====
    showLogin() {
        document.querySelectorAll('.screen').forEach(s => s.classList.add('hidden'));
        document.getElementById('login-screen').classList.remove('hidden');
    },
    showLobby() {
        document.querySelectorAll('.screen').forEach(s => s.classList.add('hidden'));
        document.getElementById('lobby-screen').classList.remove('hidden');
        // 欢迎玩家名字（仿照嫌疑人）
        const welcome = document.getElementById('lobby-welcome');
        if (welcome) welcome.textContent = `👋 欢迎，${this.playerName}`;
        this.refreshRooms();
    },
    showRoom() {
        document.querySelectorAll('.screen').forEach(s => s.classList.add('hidden'));
        document.getElementById('room-screen').classList.remove('hidden');
        this.renderRoomPlayers();
    },
    showGame() {
        document.querySelectorAll('.screen').forEach(s => s.classList.add('hidden'));
        document.getElementById('game-screen').classList.remove('hidden');
        // 若已离开结算阶段（进入下一轮），关闭结算弹窗
        const rm = document.getElementById('result-modal');
        if (rm && !rm.classList.contains('hidden')) rm.classList.add('hidden');
        this.renderGame();
    },

    showToast(msg) {
        const el = document.getElementById('toast');
        el.textContent = msg;
        el.classList.remove('hidden');
        clearTimeout(this._toastTimer);
        this._toastTimer = setTimeout(() => el.classList.add('hidden'), 2500);
    },

    renderCurrentView() {
        const room = this.currentRoomData;
        if (!room) return;
        if (room.status === 'waiting') {
            if (document.getElementById('game-screen').classList.contains('hidden') === false) {
                this.showRoom();
            }
            this.renderRoomPlayers();
        } else if (room.status === 'playing') {
            this.showGame();
            // 结算阶段：所有玩家都应弹出结算弹窗
            if (room.gameData && room.gameData.phase === 'score') {
                this.showResult();
            }
        }
    },

    // ===== 大厅 =====
    refreshRooms() {
        const container = document.getElementById('room-list');
        const rooms = getAllRooms();
        const available = Object.entries(rooms).filter(([id, room]) => {
            if (!id || !room || room.status !== 'waiting') return false;
            const players = Object.values(room.players || {}).filter(p => p && p.name);
            return players.length < 7;
        });
        if (available.length === 0) {
            container.innerHTML = '<p style="color:var(--text-dim);text-align:center;">暂无房间，创建一个吧</p>';
            return;
        }
        container.innerHTML = available.map(([id, room]) => {
            const players = Object.values(room.players || {}).filter(p => p && p.name);
            const names = players.map(p => p.name).join('、') || '空';
            return `
                <div class="room-item" onclick="app.joinRoomWithCheck('${id}')">
                    <div class="room-info">
                        <span class="room-name">${room.name}</span>
                        <span class="room-meta">玩家：${names}</span>
                    </div>
                    <span style="color:var(--text-dim);font-size:0.9em;">${players.length}/7</span>
                </div>
            `;
        }).join('');
    },

    // ===== 创建/加入房间 =====
    createRoom() {
        if (!this.playerName) return;
        const roomId = makeRoomId();
        const roomData = {
            name: `${this.playerName} 的房间`,
            status: 'waiting',
            createdBy: this.playerId,
            createdAt: Date.now(),
            players: {},
            gameData: null,
            password: Math.floor(1000 + Math.random() * 9000).toString()
        };
        this.currentRoomId = roomId;
        this.joinRoom(roomId, roomData.password, roomData);
        this.showToast('房间口令：' + roomData.password);
    },

    joinRoomWithCheck(roomId) {
        const room = getRoom(roomId);
        if (!room) { this.showToast('房间不存在'); return; }
        const password = prompt('请输入房间口令：');
        if (password === null) return;
        this.joinRoom(roomId, (password || '').trim());
    },

    joinRoom(roomId, password, explicitRoom) {
        if (!this.playerName || !this.playerId) return;
        const room = explicitRoom || getRoom(roomId);
        if (!room) { this.showToast('房间不存在'); return; }
        if (room.status !== 'waiting') { this.showToast('游戏已开始，无法加入'); return; }
        if (room.password && room.password !== password) { this.showToast('房间口令错误'); return; }
        const players = Object.values(room.players || {}).filter(p => p && p.name);
        if (players.length >= 7) { this.showToast('房间已满'); return; }
        const usedSeats = Object.values(room.players || {}).map(p => p.seat);
        let seat = 0;
        while (usedSeats.includes(seat)) seat++;
        room.players = room.players || {};
        room.players[this.playerId] = {
            name: this.playerName,
            seat: seat,
            money: INITIAL_MONEY,
            joinedAt: Date.now(),
            lastActive: Date.now()
        };
        saveRoom(roomId, room);
        this.currentRoomId = roomId;
        localStorage.setItem('stock_current_room', roomId);
        this.currentRoomData = room;
        this.showRoom();
        this.showToast('已加入房间');
    },

    // 刷新/重连：恢复身份后自动回到之前所在的房间
    rejoinRoom(roomId) {
        if (!this.playerId) return;
        // 等云端数据同步后房间可能才在缓存里，先尝试直接读，稍后靠轮询兜底
        const room = getRoom(roomId);
        if (!room) {
            // 房间还没同步到本地缓存：保留 pendingRejoin，由轮询拉取到后自动重连；
            // 若云端确实已删除，轮询会清除 pendingRejoin 回到大厅。
            this.pendingRejoin = roomId;
            this.currentRoomId = null;
            this.currentRoomData = null;
            this.showLobby();
            return;
        }
        // 房间存在：若该玩家已被移除（掉线被清理），则按原座位重新加入；否则直接进入
        if (!room.players || !room.players[this.playerId]) {
            const usedSeats = Object.values(room.players || {}).map(p => p.seat);
            let seat = 0;
            while (usedSeats.includes(seat)) seat++;
            room.players = room.players || {};
            room.players[this.playerId] = {
                name: this.playerName,
                seat: seat,
                money: INITIAL_MONEY,
                joinedAt: Date.now(),
                lastActive: Date.now()
            };
        }
        // 已在该房间：刷新活跃时间并进入
        room.players[this.playerId].lastActive = Date.now();
        saveRoom(roomId, room);
        this.currentRoomId = roomId;
        localStorage.setItem('stock_current_room', roomId);
        this.currentRoomData = room;
        this.renderCurrentView();
        this.showToast('已回到房间');
    },

    leaveRoom() {
        this.leaveRoomSilent();
    },
    leaveRoomSilent() {
        if (this.currentRoomId && this.playerId) {
            const room = getRoom(this.currentRoomId);
            if (room && room.players && room.players[this.playerId]) {
                delete room.players[this.playerId];
                const active = Object.values(room.players).filter(p => p && p.name);
                if (active.length === 0) {
                    deleteRoom(this.currentRoomId);
                } else {
                    saveRoom(this.currentRoomId, room);
                }
            }
        }
        this.currentRoomId = null;
        this.currentRoomData = null;
        localStorage.removeItem('stock_current_room');
        this.showLobby();
    },

    renderRoomPlayers() {
        const room = this.currentRoomData;
        if (!room) return;
        document.getElementById('room-title').textContent = `📋 ${room.name}`;
        const pw = room.password ? ` | 房间口令: ${room.password}` : '';
        document.getElementById('room-code-display').textContent = `房间ID: ${this.currentRoomId}${pw}`;
        const container = document.getElementById('room-players');
        const players = Object.values(room.players || {}).sort((a, b) => a.seat - b.seat);
        container.innerHTML = players.map(p => `
            <div class="player-row">
                <span>${p.name}</span>
                <span>💰 ${p.money}</span>
            </div>
        `).join('');
        const isOwner = room.createdBy === this.playerId;
        const btn = document.getElementById('btn-start-game');
        btn.disabled = !isOwner || players.length < 3;
        btn.textContent = isOwner ? '开始游戏' : '等待房主开始...';
    },

    // ===== 开始游戏 =====
    startGame() {
        const room = this.currentRoomData;
        if (!room || room.createdBy !== this.playerId) return;
        const players = Object.values(room.players || {}).filter(p => p && p.name);
        if (players.length < 3) { this.showToast('至少需要 3 名玩家'); return; }
        room.status = 'playing';
        room.gameData = this.initGameData(room.players);
        saveRoom(this.currentRoomId, room);
        this.showGame();
    },

    // 初始化游戏数据
    initGameData(playersObj) {
        const players = Object.values(playersObj).filter(p => p && p.name).sort((a, b) => a.seat - b.seat);
        const n = players.length;
        // 牌库
        let deck = buildDeck();
        deck = shuffle(deck);
        // 随机移除5张，并记录（结算页面要展示）
        const removedCards = deck.slice(deck.length - 5);
        deck = deck.slice(0, deck.length - 5);
        // 发手牌
        const hands = {};
        players.forEach(p => { hands[p.seat] = []; });
        for (let i = 0; i < HAND_SIZE; i++) {
            players.forEach(p => {
                if (deck.length > 0) hands[p.seat].push(deck.pop());
            });
        }
        const seats = players.map(p => p.seat).sort((a, b) => a - b);
        // 面值3筹码（每个玩家单独记录，结算用）
        const chips3 = {};
        seats.forEach(seat => { chips3[seat] = 0; });
        return {
            phase: 'play',          // play: 进行中, score: 结算
            seats: seats,
            seatOrder: seats,
            currentPlayerSeat: seats[0],
            players: playersObj,    // 存 seat -> playerData（含 money）
            hands: hands,           // seat -> [卡牌]
            deck: deck,             // 剩余牌库
            removedCards: removedCards,  // 本轮删除的5张牌
            market: [],             // 市场：{company, investMoney, owner}
            invested: {},           // seat -> { company: count }
            majorHolder: {},        // company -> seat（大股东）
            chips3: chips3,         // seat -> 面值3筹码数量
            roundScore: {},         // seat -> 本轮积分
            totalScore: {},         // seat -> 总积分（多轮累加）
            round: 1,               // 当前轮次（1-4）
            turnStep: 'draw',       // 'draw': 需抽牌, 'play': 需打牌
            turnCount: 0,
            history: [],
            resultConfirmed: {}     // pid -> true（结算确认，需所有玩家都确认才进入下一轮）
        };
    },

    getSeatPlayer(seat) {
        const room = this.currentRoomData;
        if (!room || !room.gameData) return null;
        const gd = room.gameData;
        const playersObj = gd.players || room.players;
        const p = Object.values(playersObj).find(x => x.seat === seat);
        return p;
    },
    getSeatByPid(pid) {
        const room = this.currentRoomData;
        if (!room || !room.gameData) return null;
        return (room.gameData.players[pid] || {}).seat;
    },

    // 广播公告：记录到 gd.announcement，所有玩家通过轮询看到（显示在资金上方的公告栏）
    announce(text) {
        const room = this.currentRoomData;
        if (!room || !room.gameData) return;
        room.gameData.announcement = text;
        room.gameData.announceTime = Date.now();
    },

    // 渲染单个玩家的投资区域（含大股东筹码，放在该玩家面前）
    renderInvestedCard(seat, gd) {
        const player = this.getSeatPlayer(seat);
        if (!player) return '';
        const isMe = seat === this.getSeatByPid(this.playerId);
        const invested = gd.invested[seat] || {};
        const entries = Object.entries(invested);
        // 找出该玩家是大股东的公司
        const majorCompanies = COMPANIES.filter(num => gd.majorHolder[num] === seat);
        // 投资牌内容
        const cards = entries.length === 0
            ? '<span style="color:var(--text-dim);font-size:0.85em;">暂无投资</span>'
            : entries.map(([company, count]) => {
                const idx = COMPANIES.indexOf(Number(company));
                const color = COMPANIES_COLORS[idx] || '#888';
                return `<span class="inv-chip" style="background:${color};">${company}</span><span class="inv-count">×${count}</span>`;
              }).join(' ');
        // 大股东标记
        const major = majorCompanies.length > 0
            ? `<div class="major-badge">👑 大股东：${majorCompanies.map(n => '公司' + n).join('、')}</div>`
            : '';
        return `
            <div class="invest-card ${isMe ? 'me' : ''}">
                <div class="invest-header">${isMe ? '你' : player.name}</div>
                <div class="invest-body">${cards}</div>
                ${major}
            </div>
        `;
    },

    // ===== 渲染 =====
    renderGame() {
        const room = this.currentRoomData;
        if (!room || !room.gameData) return;
        const gd = room.gameData;
        const mySeat = this.getSeatByPid(this.playerId);
        if (mySeat === null || mySeat === undefined) { this.showLobby(); return; }

        // 左右栏：上家（座位号-1）/下家（座位号+1）
        const seats = [...gd.seats].sort((a, b) => a - b);
        const n = seats.length;
        const myIdx = seats.indexOf(mySeat);
        const upSeat = seats[(myIdx - 1 + n) % n];
        const downSeat = seats[(myIdx + 1) % n];
        const renderStockNeighbor = (seat, label) => {
            const p = this.getSeatPlayer(seat);
            if (!p) return `<div class="neighbor-label">${label}</div><div class="neighbor-name">空</div>`;
            const colorIdx = seats.indexOf(seat);
            const color = PLAYER_COLORS[colorIdx % PLAYER_COLORS.length];
            return `
                <div class="neighbor-label">${label}</div>
                <div class="neighbor-chip" style="background:${color};">${p.name.slice(0,2)}</div>
                <div class="neighbor-name">${p.name}</div>
                <div class="neighbor-money">💰${p.money}</div>
            `;
        };
        const leftEl = document.getElementById('left-neighbor');
        const rightEl = document.getElementById('right-neighbor');
        if (leftEl) leftEl.innerHTML = renderStockNeighbor(downSeat, '⬇ 下家');
        if (rightEl) rightEl.innerHTML = renderStockNeighbor(upSeat, '⬆ 上家');

        // 回合信息
        const cur = this.getSeatPlayer(gd.currentPlayerSeat);
        const isMyTurn = gd.currentPlayerSeat === mySeat;
        document.getElementById('turn-info').textContent = isMyTurn ? '轮到你了' : `等待 ${cur ? cur.name : ''}...`;

        // 资金 + 牌库数量
        const me = this.getSeatPlayer(mySeat);
        document.getElementById('money-bar').textContent = `💰 我的资金：${me ? me.money : 0} | 🃏 牌库剩余：${gd.deck ? gd.deck.length : 0}张`;

        // 公告栏：显示当前玩家最近的操作（保留在资金上方）
        const annEl = document.getElementById('announce-bar');
        if (gd.announcement) {
            annEl.innerHTML = `<strong>📢 ${gd.announcement}</strong>`;
            annEl.classList.remove('empty');
        } else {
            annEl.innerHTML = '等待玩家操作...';
            annEl.classList.add('empty');
        }

        // 大股东信息
        const stockInfo = document.getElementById('stock-info');
        stockInfo.innerHTML = COMPANIES.map(num => {
            const idx = COMPANIES.indexOf(num);
            const holderSeat = gd.majorHolder[num];
            const holder = holderSeat !== undefined && holderSeat !== null ? this.getSeatPlayer(holderSeat) : null;
            const isMeHolder = holderSeat === mySeat;
            const holderText = holder ? (isMeHolder ? '你 👑' : `👑${holder.name}`) : '无大股东';
            return `<span class="stock-chip" style="border-left:4px solid ${COMPANIES_COLORS[idx]};${isMeHolder ? 'outline:2px solid var(--gold);' : ''}">公司${num} 📊 ${holderText}</span>`;
        }).join('');

        // 市场（我的回合且抽牌阶段时，牌可点击拿取）
        const marketArea = document.getElementById('market-area');
        const canTakeMarket = isMyTurn && gd.turnStep === 'draw';
        if (gd.market.length === 0) {
            marketArea.innerHTML = '<h3>市场（空）</h3><p style="color:var(--text-dim);">市场暂无卡牌</p>';
        } else {
            marketArea.innerHTML = '<h3>市场</h3>' + gd.market.map((mc, idx) => {
                const isMajorHolder = gd.majorHolder[mc.company] === mySeat;
                const clickable = canTakeMarket && !isMajorHolder;
                return `<div class="market-card ${clickable ? 'clickable' : ''}" ${clickable ? `onclick="app.actionTakeMarket(${idx})"` : ''} title="${isMajorHolder ? '你是该公司股东，不能拿' : (canTakeMarket ? '点击拿取' : '等待回合')}">
                    <div class="company-num">${mc.company}</div>
                    <div class="invest-count">💰${mc.investMoney}${isMajorHolder ? '（股东）' : ''}</div>
                </div>`;
            }).join('');
        }

        // 手牌：所有玩家都能看到自己的手牌；只有轮到自己且已抽牌时才能点击选择
        const handArea = document.getElementById('hand-area');
        const myHand = gd.hands[mySeat] || [];
        const canSelect = isMyTurn && gd.turnStep === 'play';
        const cardColor = (num) => {
            const idx = COMPANIES.indexOf(num);
            return COMPANIES_COLORS[idx % COMPANIES_COLORS.length];
        };
        if (canSelect) {
            handArea.innerHTML = '<h3>你的手牌（点击选择要打出/投资的牌）</h3><div style="margin-top:6px;">' +
                myHand.map((card, idx) => `<div class="hand-card" style="background:${cardColor(card)};" onclick="app.selectHandCard(${idx})">
                    <div class="company-num">${card}</div>
                </div>`).join('') +
                '</div>';
        } else {
            handArea.innerHTML = `<h3>你的手牌（${myHand.length}张${isMyTurn ? '，请先抽牌' : '，等待回合'}）</h3><div style="margin-top:6px;">` +
                myHand.map(card => `<div class="hand-card" style="background:${cardColor(card)};cursor:default;">
                    <div class="company-num">${card}</div>
                </div>`).join('') +
                '</div>';
        }

        // ===== 其他玩家的投资区域 =====
        const investOthers = document.getElementById('invest-others');
        investOthers.innerHTML = '<h3>其他玩家投资</h3>' + gd.seats
            .filter(seat => seat !== mySeat)
            .map(seat => this.renderInvestedCard(seat, gd)).join('');

        // ===== 我的投资区域 =====
        const investMine = document.getElementById('invest-mine');
        investMine.innerHTML = '<h3>我的投资</h3>' + this.renderInvestedCard(mySeat, gd);

        // 操作区（严格回合制：先抽牌，再打牌）
        const actionArea = document.getElementById('action-area');
        if (isMyTurn) {
            if (gd.turnStep === 'draw') {
                // 抽牌阶段：二选一——抽牌库 或 点击市场牌拿取（市场没牌时只能抽牌库）
                const marketEmpty = !gd.market || gd.market.length === 0;
                actionArea.innerHTML = `
                    <div style="width:100%;margin-bottom:6px;color:var(--gold);">① 请先抽一张牌${marketEmpty ? '' : '（点击下方市场牌可直接拿取）'}</div>
                    <button class="action-btn" onclick="app.actionDrawFromDeck()">🃏 从牌库抽牌</button>
                `;
            } else if (gd.turnStep === 'play') {
                // 打牌阶段：选一张手牌，再打出/投资
                if (this.selectedHandCard < 0) {
                    actionArea.innerHTML = `
                        <div style="width:100%;margin-bottom:6px;color:var(--gold);">② 请选择一张手牌打出或投资</div>
                    `;
                } else {
                    const card = gd.hands[mySeat][this.selectedHandCard];
                    // 若本轮是从市场拿了该公司的牌，则不能把它打出到市场（只能投资）
                    const cannotPlay = gd.tookFromMarketCompany === card;
                    actionArea.innerHTML = `
                        <div style="width:100%;margin-bottom:6px;color:var(--gold);">选中：公司${card} 的牌${cannotPlay ? '（本轮从市场拿到该公司，不能打出到市场，可投资）' : ''}</div>
                        ${cannotPlay ? '' : '<button class="action-btn" onclick="app.actionPlayToMarket()">📤 打出到市场</button>'}
                        <button class="action-btn" onclick="app.actionInvest()">🏢 投资到面前</button>
                        <button class="action-btn" onclick="app.selectedHandCard=-1;app.renderGame()">取消</button>
                    `;
                }
            }
        } else {
            actionArea.innerHTML = '';
        }

        // 结算阶段：若弹窗被隐藏（复盘），提供「查看结算」入口
        if (gd.phase === 'score' && document.getElementById('result-modal').classList.contains('hidden')) {
            actionArea.innerHTML += '<button class="action-btn" onclick="app.showResult()" style="margin-top:8px;">📊 查看结算</button>';
        }
    },

    // 选中的手牌（用于打牌）
    selectedHandCard: -1,
    selectHandCard(idx) {
        this.selectedHandCard = idx;
        this.renderGame();   // 统一由 renderGame 渲染选中状态和操作按钮
    },

    // ===== 抽牌：从牌库盲抽 =====
    actionDrawFromDeck() {
        const room = this.currentRoomData;
        const gd = room.gameData;
        const mySeat = this.getSeatByPid(this.playerId);
        if (gd.currentPlayerSeat !== mySeat) return;
        if (gd.deck.length === 0) { this.showToast('牌库已空'); return; }
        // 若市场有牌，需为每张市场牌投资1元（大股东特权除外）
        const me = this.getSeatPlayer(mySeat);
        let cost = 0;
        gd.market.forEach(mc => {
            if (gd.majorHolder[mc.company] !== mySeat) cost += 1;
        });
        if (cost > me.money) { this.showToast('资金不足，无法支付市场投资'); return; }
        me.money -= cost;
        // 给市场牌增加投资（非大股东的公司）
        gd.market.forEach(mc => {
            if (gd.majorHolder[mc.company] !== mySeat) mc.investMoney += 1;
        });
        // 抽一张牌
        const card = gd.deck.pop();
        gd.hands[mySeat].push(card);
        // 从牌库抽牌，本轮不是从市场拿牌，清除限制
        gd.tookFromMarketCompany = null;
        // 只播报公开动作，不暴露抽到哪家公司（私密信息）
        this.announce(`${this.getSeatPlayer(mySeat).name} 从牌库抽了一张牌${cost > 0 ? '（支付市场投资' + cost + '元）' : ''}`);
        playSfx('draw');
        this.afterDraw();
        saveRoom(this.currentRoomId, room);
        this.renderGame();
        this.showToast(`抽到公司${card}的牌${cost > 0 ? '，支付市场投资' + cost + '元' : ''}`);
    },

    // ===== 抽牌：从市场明拿指定的一张牌 =====
    actionTakeMarket(idx) {
        const room = this.currentRoomData;
        const gd = room.gameData;
        const mySeat = this.getSeatByPid(this.playerId);
        if (gd.currentPlayerSeat !== mySeat) { this.showToast('还没轮到你'); return; }
        if (gd.turnStep !== 'draw') { this.showToast('已抽过牌，请打牌'); return; }
        if (idx < 0 || idx >= gd.market.length) { this.showToast('请选择一张市场牌'); return; }
        const mc = gd.market[idx];
        // 大股东限制：不能拿自己是大股东的公司的牌
        if (gd.majorHolder[mc.company] === mySeat) { this.showToast('你是该公司的股东，不能拿'); return; }
        gd.hands[mySeat].push(mc.company);
        this.getSeatPlayer(mySeat).money += mc.investMoney;
        gd.market.splice(idx, 1);
        // 记录本轮是从市场拿的哪家公司（该公司的牌本轮不能打出到市场，但可投资）
        gd.tookFromMarketCompany = mc.company;
        this.announce(`${this.getSeatPlayer(mySeat).name} 从市场拿了公司${mc.company}的牌（+💰${mc.investMoney}）`);
        playSfx('draw');
        this.afterDraw();
        saveRoom(this.currentRoomId, room);
        this.renderGame();
        this.showToast(`拿到公司${mc.company}的牌，获得💰${mc.investMoney}`);
    },

    afterDraw() {
        const room = this.currentRoomData;
        const gd = room.gameData;
        this.selectedHandCard = -1;
        // 抽牌完成后进入「打牌」阶段
        gd.turnStep = 'play';
    },

    // ===== 打牌：打出到市场 =====
    actionPlayToMarket() {
        const room = this.currentRoomData;
        const gd = room.gameData;
        const mySeat = this.getSeatByPid(this.playerId);
        if (gd.currentPlayerSeat !== mySeat) return;
        if (gd.turnStep !== 'play') { this.showToast('请先抽牌'); return; }
        if (this.selectedHandCard < 0) { this.showToast('请先选一张手牌'); return; }
        const card = gd.hands[mySeat][this.selectedHandCard];
        // 规则：若本轮是从市场拿的该公司的牌，不能打出到市场（可投资）
        if (gd.tookFromMarketCompany === card) { this.showToast('本轮从市场拿到该公司，不能打出到市场'); return; }
        gd.hands[mySeat].splice(this.selectedHandCard, 1);
        gd.market.push({ company: card, investMoney: 0 });
        this.announce(`${this.getSeatPlayer(mySeat).name} 将公司${card}的牌打出到市场`);
        playSfx('play');
        this.checkAllMajorHolders();   // 打牌后结算所有公司大股东
        this.endTurn();
        saveRoom(this.currentRoomId, room);
        this.renderGame();   // 立即刷新界面，让操作即时生效
    },

    // ===== 打牌：投资到面前 =====
    actionInvest() {
        const room = this.currentRoomData;
        const gd = room.gameData;
        const mySeat = this.getSeatByPid(this.playerId);
        if (gd.currentPlayerSeat !== mySeat) return;
        if (gd.turnStep !== 'play') { this.showToast('请先抽牌'); return; }
        if (this.selectedHandCard < 0) { this.showToast('请先选一张手牌'); return; }
        const card = gd.hands[mySeat][this.selectedHandCard];
        gd.hands[mySeat].splice(this.selectedHandCard, 1);
        gd.invested[mySeat] = gd.invested[mySeat] || {};
        gd.invested[mySeat][card] = (gd.invested[mySeat][card] || 0) + 1;
        this.announce(`${this.getSeatPlayer(mySeat).name} 将公司${card}的牌投资到面前`);
        playSfx('invest');
        this.checkAllMajorHolders();   // 打牌后结算所有公司大股东
        this.endTurn();
        saveRoom(this.currentRoomId, room);
        this.renderGame();   // 立即刷新界面，让操作即时生效
    },

    // 结算所有公司的大股东（游戏进行中：平手时保持原大股东，超过才转移）
    checkAllMajorHolders() {
        COMPANIES.forEach(num => {
            let maxCount = 0, holderSeat = null, tie = false;
            this.currentRoomData.gameData.seats.forEach(seat => {
                const count = (this.currentRoomData.gameData.invested[seat] && this.currentRoomData.gameData.invested[seat][num]) || 0;
                if (count > maxCount) { maxCount = count; holderSeat = seat; tie = false; }
                else if (count === maxCount && count > 0) { tie = true; }
            });
            const prev = this.currentRoomData.gameData.majorHolder[num];
            // 规则：大股东一直存在，除非被「超过」才转移；平手保持原大股东（不清空）
            if (maxCount === 0) {
                // 没有人投资 → 无大股东
                if (prev !== null) this.currentRoomData.gameData.majorHolder[num] = null;
            } else if (tie) {
                // 平手：保持原大股东（不清空）
                // 若原本没有大股东（首次出现平手），则仍无大股东
                if (prev === undefined || prev === null) {
                    this.currentRoomData.gameData.majorHolder[num] = null;
                }
            } else {
                // 唯一最多者：若超过原大股东则转移；否则保持
                // 原大股东数量 = 原大股东的投资数
                if (prev !== undefined && prev !== null && prev !== holderSeat) {
                    // 原大股东仍存在，检查是否被超过（新 holder 数量 > 原 holder 数量才转移）
                    const prevCount = (this.currentRoomData.gameData.invested[prev] && this.currentRoomData.gameData.invested[prev][num]) || 0;
                    if (maxCount > prevCount) {
                        this.currentRoomData.gameData.majorHolder[num] = holderSeat;
                        this.showToast(`公司${num}大股东变更：${this.getSeatPlayer(holderSeat).name}`);
                    }
                    // 否则保持原大股东（不转移）
                } else {
                    this.currentRoomData.gameData.majorHolder[num] = holderSeat;
                    if (prev !== holderSeat) {
                        this.showToast(`公司${num}大股东：${this.getSeatPlayer(holderSeat).name}`);
                    }
                }
            }
        });
    },

    // 检查并更新大股东
    checkMajorHolder(company) {
        const room = this.currentRoomData;
        const gd = room.gameData;
        let maxCount = 0, holderSeat = null;
        gd.seats.forEach(seat => {
            const count = (gd.invested[seat] && gd.invested[seat][company]) || 0;
            if (count > maxCount) { maxCount = count; holderSeat = seat; }
        });
        // 只有「超过」才转移（等于不转移）
        const prev = gd.majorHolder[company];
        if (prev !== holderSeat) {
            gd.majorHolder[company] = holderSeat;
            if (holderSeat !== null) {
                this.showToast(`公司${company}大股东变更为 ${this.getSeatPlayer(holderSeat).name}`);
            }
        }
    },

    // 结束回合
    endTurn() {
        const room = this.currentRoomData;
        const gd = room.gameData;
        const mySeat = this.getSeatByPid(this.playerId);
        gd.turnCount++;
        this.selectedHandCard = -1;
        // 回合结束，清除「从市场拿牌」的限制（仅限当前回合，不影响下一位玩家）
        gd.tookFromMarketCompany = null;
        // 检查牌库是否抽完 → 结算
        if (gd.deck.length === 0) {
            // 最后一张牌抽完后，当前玩家打完牌 → 结算
            this.finalize();
            return;
        }
        // 轮到下一位（左手边 = 座位号+1），并重置为「抽牌」阶段
        const idx = gd.seats.indexOf(mySeat);
        gd.currentPlayerSeat = gd.seats[(idx + 1) % gd.seats.length];
        gd.turnStep = 'draw';
    },

    // ===== 结算 =====
    finalize() {
        const room = this.currentRoomData;
        const gd = room.gameData;
        // 1. 所有玩家把剩余手牌投资到面前
        gd.seats.forEach(seat => {
            const hand = gd.hands[seat] || [];
            gd.invested[seat] = gd.invested[seat] || {};
            hand.forEach(card => {
                gd.invested[seat][card] = (gd.invested[seat][card] || 0) + 1;
            });
            gd.hands[seat] = [];
        });
        // 2. 各公司结算（从5到10）
        // 记录结算过程供展示
        const settlementLog = [];
        const money = {};
        const chips3 = {};
        gd.seats.forEach(seat => { money[seat] = this.getSeatPlayer(seat).money; chips3[seat] = gd.chips3[seat] || 0; });
        COMPANIES.forEach(num => {
            let maxCount = 0, holderSeat = null, tie = false;
            gd.seats.forEach(seat => {
                const count = (gd.invested[seat] && gd.invested[seat][num]) || 0;
                if (count > maxCount) { maxCount = count; holderSeat = seat; tie = false; }
                else if (count === maxCount && count > 0) { tie = true; }
            });
            if (maxCount === 0) {
                settlementLog.push(`<div class="settle-company">公司${num}：无人投资，无大股东</div>`);
            } else if (tie) {
                settlementLog.push(`<div class="settle-company">公司${num}：最多${maxCount}张，平手，无大股东</div>`);
            } else {
                // 大股东获得所有其他持有者的筹码
                const paidBy = [];
                gd.seats.forEach(seat => {
                    if (seat === holderSeat) return;
                    const count = (gd.invested[seat] && gd.invested[seat][num]) || 0;
                    if (count > 0) {
                        money[seat] -= count;
                        // 给出对应股份的面值1资金筹码（数字用醒目颜色区分，与玩家名数字区分）
                        paidBy.push(`${this.getSeatPlayer(seat).name}持股<span class="paid-count">${count}</span>张 → 付<span class="paid-count">${count}</span>个面值1筹码`);
                    }
                });
                // 大股东得到的金钱筹码「会变成3」：每个收到的面值1筹码都变成1个面值3筹码
                let receivedTotal = 0;
                gd.seats.forEach(seat => {
                    if (seat === holderSeat) return;
                    receivedTotal += (gd.invested[seat] && gd.invested[seat][num]) || 0;
                });
                // 每个收到的面值1筹码 -> 1个面值3筹码（不再保留为普通资金）
                chips3[holderSeat] += receivedTotal;
                // 结算展示：大股东 + 各股东持股/付筹码
                const lines = [`<div class="settle-company">公司${num}：大股东 ${this.getSeatPlayer(holderSeat).name}（持股${maxCount}张）</div>`];
                paidBy.forEach(p => lines.push(`<div class="settle-pay">&nbsp;&nbsp;${p}</div>`));
                // 大股东共收到筹码数（全部转为面值3筹码）
                if (receivedTotal > 0) {
                    lines.push(`<div class="settle-pay">&nbsp;&nbsp;共收 <span class="paid-count">${receivedTotal}</span> 个面值1筹码，全部变为面值3筹码</div>`);
                }
                settlementLog.push(lines.join(''));
            }
        });
        // 3. 保存最终资金和面值3筹码
        gd.seats.forEach(seat => {
            this.getSeatPlayer(seat).money = money[seat];
            gd.chips3[seat] = chips3[seat];
        });
        // 4. 计算总筹码并排名（面值3筹码算 3 分）
        const totalChips = {};
        gd.seats.forEach(seat => { totalChips[seat] = money[seat] + chips3[seat] * 3; });
        // 排名：先按总筹码，同分按面值3筹码
        const ranked = [...gd.seats].sort((a, b) => {
            if (totalChips[b] !== totalChips[a]) return totalChips[b] - totalChips[a];
            return chips3[b] - chips3[a];
        });
        // 5. 排名积分：第一名+2、第二名+1、中间0、最后一名-1（并列处理）
        const scoreMap = {};
        const n = ranked.length;
        ranked.forEach((seat, i) => {
            let pts = 0;
            if (i === 0) pts = 2;
            else if (i === 1) pts = 1;
            else if (i === n - 1) pts = -1;
            // 并列：若与前一名总筹码和面值3都相同，则视为并列同分
            if (i > 0) {
                const prevSeat = ranked[i-1];
                if (totalChips[seat] === totalChips[prevSeat] && chips3[seat] === chips3[prevSeat]) {
                    pts = scoreMap[prevSeat];   // 并列取前一名积分
                }
            }
            scoreMap[seat] = pts;
        });
        // 累加到总积分
        gd.seats.forEach(seat => {
            gd.totalScore[seat] = (gd.totalScore[seat] || 0) + (scoreMap[seat] || 0);
        });
        gd.phase = 'score';
        gd.advancing = false;   // 结算确认推进锁，防止多人竞态重复进入下一轮
        gd.resultConfirmed = {};  // 重置确认状态（每轮结算单独统计）
        gd.scores = money;
        gd.chips3Final = chips3;
        gd.totalChips = totalChips;
        gd.rank = ranked;
        gd.roundScores = scoreMap;
        gd.settlementLog = settlementLog;
        saveRoom(this.currentRoomId, room);
        playSfx('score');
        this.showResult();
    },

    // 显示结算（所有玩家通过轮询同步时都会调用，需避免重复渲染闪烁）
    showResult() {
        const room = this.currentRoomData;
        const gd = room.gameData;
        const content = document.getElementById('result-content');
        const pName = (seat) => this.getSeatPlayer(seat).name;
        // 1. 展示删除的5张牌
        let html = `<h3>① 本轮移除的 5 张牌</h3><div class="result-removed">${(gd.removedCards || []).map(c => `<span class="inv-chip" style="background:${COMPANIES_COLORS[COMPANIES.indexOf(c)] || '#888'};">${c}</span>`).join(' ')}</div>`;
        // 2. 公司结算过程（settlementLog 每项已是多行 HTML，直接拼接）
        html += `<h3>② 公司结算</h3><div class="result-settle">${(gd.settlementLog || []).join('')}</div>`;
        // 3. 排名（总筹码 = 资金 + 面值3×3，等号后显示完整总分）
        html += `<h3>③ 本轮排名（总筹码 = 资金 + 面值3×3）</h3>`;
        html += (gd.rank || []).map((seat, i) => {
            const pts = gd.roundScores[seat];
            const sign = pts > 0 ? '+' + pts : pts;
            return `<div class="result-rank ${i === 0 ? 'first' : ''}" style="padding:6px 0;border-bottom:1px solid var(--border);">
                ${i+1}. ${pName(seat)}：💰<b>${gd.totalChips[seat]}</b>（资金${gd.scores[seat]} + 面值3×${gd.chips3Final[seat]} = <span class="chips3-val">${gd.totalChips[seat]}</span>）积分 <b>${sign}</b> 总积分${gd.totalScore[seat]}
            </div>`;
        }).join('');
        // 轮次信息
        html += `<div style="margin-top:10px;color:var(--text-dim);">第 ${gd.round} / 4 轮</div>`;
        // 确认进度（需所有存活玩家都确认才进入下一轮）
        const players = Object.values(room.players || {}).filter(p => p && p.name);
        const confirmedCount = Object.values(gd.resultConfirmed || {}).filter(Boolean).length;
        const needCount = players.length;
        const isMeConfirmed = !!(gd.resultConfirmed && gd.resultConfirmed[this.playerId]);
        html += `<div class="result-confirm-info" style="margin-top:12px;padding-top:10px;border-top:1px solid var(--border);color:var(--text-dim);font-size:0.9em;">
            ✅ 已确认 ${confirmedCount} / ${needCount} 名玩家${isMeConfirmed ? '（你已确认）' : ''}
        </div>`;
        content.innerHTML = html;
        const modal = document.getElementById('result-modal');
        // 若尚未显示弹窗，则显示；已显示则只更新内容，避免闪烁
        if (modal.classList.contains('hidden')) {
            modal.classList.remove('hidden');
        }
        // 更新确认按钮文案
        const btn = document.getElementById('btn-result-confirm');
        btn.textContent = isMeConfirmed ? '等待其他玩家确认...' : '确认结算';
        btn.disabled = isMeConfirmed;
    },

    // 隐藏结算弹窗（仅收起弹窗便于复盘，不触发确认推进）
    hideResult() {
        document.getElementById('result-modal').classList.add('hidden');
        this.showGame();   // 刷新界面，显示「查看结算」入口
    },

    closeResult() {
        const room = this.currentRoomData;
        if (!room || !room.gameData) return;
        const gd = room.gameData;
        // 标记自己已确认
        gd.resultConfirmed = gd.resultConfirmed || {};
        gd.resultConfirmed[this.playerId] = true;
        saveRoom(this.currentRoomId, room);
        this.showResult();   // 刷新确认进度显示

        // 检查是否所有存活玩家都已确认（players 的值是 playerData，用其 playerId key 对应）
        const players = Object.values(room.players || {}).filter(p => p && p.name);
        const allConfirmedByPid = players.every(p => {
            const pid = this.playerIdOfPlayer(p);
            return gd.resultConfirmed[pid] === true;
        });
        if (!allConfirmedByPid) return;   // 未全部确认，等待
        // 防重复推进：若已有其他玩家在推进下一轮，则跳过（避免竞态覆盖）
        if (gd.advancing) return;
        gd.advancing = true;
        saveRoom(this.currentRoomId, room);

        // 所有人已确认：关闭弹窗并进入下一轮/结束
        document.getElementById('result-modal').classList.add('hidden');
        // 多轮：若不足4轮则进入下一轮，否则游戏结束
        if (gd.round < 4) {
            const prevScore = { ...gd.totalScore };
            const prevChips3 = { ...gd.chips3 };
            const newGd = this.initGameData(room.players);
            newGd.round = gd.round + 1;
            newGd.totalScore = prevScore;
            newGd.chips3 = prevChips3;
            room.status = 'playing';
            room.gameData = newGd;
            saveRoom(this.currentRoomId, room);
            this.showGame();
        } else {
            // 4轮结束，游戏结束：回房间，显示最终排名
            room.status = 'waiting';
            room.gameData = null;
            saveRoom(this.currentRoomId, room);
            this.showRoom();
        }
    },

    // 根据 playerData 获取其 playerId（room.players 的 key 就是 playerId）
    playerIdOfPlayer(p) {
        const room = this.currentRoomData;
        if (room && room.players) {
            for (const id in room.players) {
                if (room.players[id] === p) return id;
            }
        }
        return '';
    }
};

// ---------- 初始化 ----------
initBroadcastChannel();
initSupabase();   // 尝试连接 Supabase（跨设备联机），失败回退本地模式
document.addEventListener('DOMContentLoaded', () => {
    // 尝试恢复之前的身份并自动回到房间（刷新/关闭网页后重连）
    const restored = app.restoreSession();
    const savedRoom = localStorage.getItem('stock_current_room');
    if (restored && savedRoom) {
        // 尝试立即重连；若云端数据尚未同步（房间不在本地缓存），
        // 会设置 pendingRejoin，由轮询拉取到数据后自动重连
        app.rejoinRoom(savedRoom);
        app.pendingRejoin = savedRoom;
    } else {
        app.showLogin();
    }
    document.getElementById('name-input').addEventListener('keypress', (e) => {
        if (e.key === 'Enter') app.login();
    });
});
