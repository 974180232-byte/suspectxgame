// ============ Supabase 配置（跨设备联机） ============
// 在 https://supabase.com 创建项目后，填入下方 Project URL 与 anon key。
// 若 Supabase SDK 加载失败或未配置，将自动回退到「本地模式」（仅同一浏览器多标签页可联机）。
const SUPABASE_URL = 'https://thmxdynsofffarecfauw.supabase.co';
const SUPABASE_KEY = 'sb_publishable_prdBh_WqbbiZbCXm5nLeBA_ojMhFyo3';

// ============ 数据库初始化 ============
let supabaseClient = null;
let useCloud = false;
// 当前玩家的匿名身份 UID（用于按房间成员授权）
let myUid = null;
// 内存缓存：让 getRoom/getAllRooms 可以同步返回最新数据（Supabase 读取是异步的）
let cloudRoomsCache = {};

// 同步获取当前匿名 UID（登录完成后可用）；未登录返回 null
function getMyUid() {
    return myUid;
}

// 尝试连接 Supabase；只有 SDK 可用且配置完整才启用，否则回退本地模式。
function initSupabase() {
    if (typeof supabase === 'undefined' || !SUPABASE_URL || !SUPABASE_KEY) {
        console.log('✅ 本地模式已启动（仅同一浏览器多标签页可联机，配置 Supabase 后支持跨设备）');
        return;
    }
    try {
        supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
        // 匿名登录，拿到 UID 后才具备按房间授权的读写权限
        supabaseClient.auth.signInAnonymously()
            .then(({ data, error }) => {
                if (error) {
                    console.warn('Supabase 匿名登录失败，使用本地模式', error);
                    useCloud = false;
                    return;
                }
                myUid = data.user ? data.user.id : null;
                useCloud = true;
                console.log('✅ Supabase 已连接（匿名认证成功，支持跨设备联机）');
                // 迁移登录完成前用 localStorage 创建的房间到云端，避免「创建后读不到/其他设备看不到」
                migrateLocalRoomsToCloud();
                // 不使用 Realtime 订阅：其 WebSocket 在部分网络（尤其国内）下连接不稳定，
                // 会导致实时推送失败并产生大量报错。改用定时轮询（HTTP）作为唯一可靠同步通道。
                startCloudSyncLoop();          // 定时轮询云端，作为跨设备同步的可靠通道
            });
    } catch (e) {
        console.warn('Supabase 初始化失败，使用本地模式', e);
    }
}

// ============ 数据层（统一接口，支持 Supabase / 本地双后端） ============
const ROOM_PREFIX = 'mm_room_';
const ROOM_COLLECTION = 'rooms';

function saveRoom(roomId, roomData) {
    // 防御：roomId 无效时不写入，避免产生「roomId 为 null/undefined」的脏数据
    if (!roomId || !roomData) return;
    // 记录更新时间戳，供轮询判断「只接受更新的数据」，避免本地新写入被旧云端数据覆盖
    roomData.updatedAt = Date.now();
    if (useCloud && supabaseClient) {
        // 同步更新内存缓存，让 getRoom/getAllRooms 立即返回最新数据
        cloudRoomsCache[roomId] = roomData;
        // members 从房间的 memberUids 取（该房间所有玩家的匿名 UID），供 RLS 按成员授权
        const members = Array.isArray(roomData.memberUids) ? roomData.memberUids : [];
        // 异步写入 Supabase（id 主键，upsert 覆盖）
        supabaseClient
            .from(ROOM_COLLECTION)
            .upsert({ id: roomId, data: roomData, members }, { onConflict: 'id' })
            .then(({ error }) => {
                if (error) console.warn('Supabase 写入失败', error);
            });
    } else {
        localStorage.setItem(ROOM_PREFIX + roomId, JSON.stringify(roomData));
        // 通过 BroadcastChannel 通知同浏览器其他标签页（携带完整数据，解决 file:// 下 localStorage 隔离问题）
        broadcastChannelPost({ type: 'room-data', roomId, roomData });
    }
}

function getRoom(roomId) {
    if (useCloud && supabaseClient) {
        // 优先读缓存；若缓存没有，回退读 localStorage（处理匿名登录完成前创建的房间）
        const cached = cloudRoomsCache[roomId];
        if (cached) return cached;
        const localData = localStorage.getItem(ROOM_PREFIX + roomId);
        if (localData) {
            const room = JSON.parse(localData);
            cloudRoomsCache[roomId] = room; // 同步回缓存
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
        // 合并 localStorage 中的房间（处理匿名登录完成前创建的房间，避免创建后列表看不到）
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
    // 先从 localStorage 读取
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
    // 合并 BroadcastChannel 内存缓存中的房间（解决 file:// 下 localStorage 隔离问题）
    if (broadcastRoomsCache) {
        Object.keys(broadcastRoomsCache).forEach(roomId => {
            if (!rooms[roomId]) {
                rooms[roomId] = broadcastRoomsCache[roomId];
            }
        });
    }
    return rooms;
}

function deleteRoom(roomId) {
    if (useCloud && supabaseClient) {
        delete cloudRoomsCache[roomId];
        supabaseClient
            .from(ROOM_COLLECTION)
            .delete()
            .eq('id', roomId)
            .then(({ error }) => {
                if (error) console.warn('Supabase 删除失败', error);
            });
    } else {
        localStorage.removeItem(ROOM_PREFIX + roomId);
        // 通过 BroadcastChannel 通知同浏览器其他标签页
        broadcastChannelPost({ type: 'room-deleted', roomId });
        // 同时清理内存缓存
        if (broadcastRoomsCache) {
            delete broadcastRoomsCache[roomId];
        }
    }
}

function updateRoom(roomId, updates) {
    const room = getRoom(roomId);
    if (!room) return;
    const newRoom = { ...room, ...updates };
    saveRoom(roomId, newRoom);
}

// ---------- Supabase 云端同步辅助 ----------
// 把登录完成前用 localStorage 创建的房间迁移到云端，确保跨设备可见、缓存一致
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
                    const members = Array.isArray(roomData.memberUids) ? roomData.memberUids : [];
                    supabaseClient.from(ROOM_COLLECTION).upsert({ id: roomId, data: roomData, members }, { onConflict: 'id' });
                }
            } catch (e) {}
        }
    }
}

// 从云端拉取所有房间，写入内存缓存，并对比差异触发对应房间的界面更新。
// 返回是否发生过变化（用于大厅刷新判断）
function pullRoomsFromCloud() {
    if (!useCloud || !supabaseClient) return Promise.resolve(false);
    return supabaseClient
        .from(ROOM_COLLECTION)
        .select('id, data')
        .then(({ data, error }) => {
            if (error) {
                console.warn('Supabase 拉取房间失败', error);
                return false;
            }
            const rows = data || [];
            const seenIds = {};
            let changed = false;
            rows.forEach(row => {
                if (row && row.data) {
                    seenIds[row.id] = true;
                    const cloudData = row.data;
                    const localData = cloudRoomsCache[row.id];
                    // 自动清理：0 人的空房间（创建超过 5 秒，避免误删刚创建尚未加入的房间）
                    const playersObj = cloudData.players || {};
                    const activeCount = Object.values(playersObj).filter(p => p && p.name).length;
                    const created = cloudData.createdAt || 0;
                    if (activeCount === 0 && Date.now() - created > 5000) {
                        deleteRoom(row.id);
                        return;
                    }
                    // 云端是权威数据：只要与本地不同就覆盖本地缓存并触发界面更新。
                    // （不依赖 updatedAt 判断——多设备下时间戳不可靠，会导致无法同步到最新的结算推进状态。）
                    if (JSON.stringify(localData) !== JSON.stringify(cloudData)) {
                        cloudRoomsCache[row.id] = cloudData;
                        changed = true;
                        handleCrossTabUpdate(row.id);
                    }
                }
            });
            // 注意：这里【不】清理「云端 SELECT 未返回的房间」。
            // saveRoom 是异步写入，写入完成前云端暂时查不到该房间；
            // 若此时误判「房间已不存在」并清理缓存、触发 handleCrossTabUpdate，
            // 会导致玩家被判定「房间已解散」而退回大厅。
            // 房间真正删除只走显式 deleteRoom / leave_room RPC。
            // 变化时刷新房间列表（大厅显示）
            if (changed && app && typeof app.refreshRooms === 'function') {
                app.refreshRooms();
            }
            return changed;
        });
}

// 定时轮询云端，作为跨设备同步的可靠兜底（不依赖 Realtime 是否生效）
let cloudSyncTimer = null;
let lastHeartbeat = 0;
const HEARTBEAT_INTERVAL = 10000;   // 每 10 秒刷新一次活跃时间
const OFFLINE_TIMEOUT = 300000;     // 300 秒无活跃视为掉线

function startCloudSyncLoop() {
    stopCloudSyncLoop();
    const tick = () => {
        if (useCloud && supabaseClient) {
            pullRoomsFromCloud();
            heartbeatCurrentRoom();       // 刷新自己在房间中的活跃时间
            cleanupOfflinePlayers();      // 清理掉线的玩家 / 解散房主掉线的房间
            // 即使云端数据未变化，也要对当前房间做「结算自动推进」检查，
            // 否则 autoNextAt 到达后因数据无变化不触发 updateGameFromRoom，会一直卡在结算。
            tryAutoAdvanceCurrentRoom();
            tryRejoinPendingRoom();      // 若有待重连的房间且已同步到缓存，则自动回到房间
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
        localStorage.removeItem('mm_current_room');
    }
}

// 心跳：若玩家在房间中，定期刷新自己的 lastActive，防止被误判为掉线。
// 关键：必须用 RPC 只更新 lastActive 字段，绝不能 saveRoom 整对象覆盖——
// 否则会覆盖其他玩家刚写入的数据，导致加入闪退、房间号 null 等回归问题。
function heartbeatCurrentRoom() {
    if (!app || !app.currentRoomId) return;
    if (Date.now() - lastHeartbeat < HEARTBEAT_INTERVAL) return;
    lastHeartbeat = Date.now();
    const room = getRoom(app.currentRoomId);
    if (!room || !room.players || !room.players[app.playerId]) return;
    // 本地缓存更新（即时 UI，不写云端避免覆盖）
    room.players[app.playerId].lastActive = Date.now();
    if (useCloud && supabaseClient) {
        // 云端：用 RPC 只更新该玩家的 lastActive，不覆盖其他数据
        supabaseClient
            .rpc('heartbeat', { room_id: app.currentRoomId, player_id: app.playerId })
            .then(({ error }) => {
                if (error) console.warn('heartbeat RPC 失败', error);
            });
    } else {
        saveRoom(app.currentRoomId, room);
    }
}

// 掉线清理：在轮询到的房间数据中，移除「超过 OFFLINE_TIMEOUT 无活跃」的玩家；
// 若房主掉线，则解散（删除）房间。
function cleanupOfflinePlayers() {
    if (!app || !useCloud) return;
    const roomId = app.currentRoomId;
    if (!roomId) return;
    const room = getRoom(roomId);
    if (!room || !room.players) return;
    const now = Date.now();
    let changed = false;
    // 房主掉线 → 解散房间（仅当明确有房主活跃时间且确实超时才解散；
    // 数据缺失/未同步时不误判，避免因同步时序把在房间的玩家误当掉线而解散房间）
    const owner = room.players[room.createdBy];
    const ownerLast = owner ? (owner.lastActive || owner.joinedAt || 0) : 0;
    if (owner && ownerLast > 0 && (now - ownerLast > OFFLINE_TIMEOUT)) {
        deleteRoom(roomId);
        return;
    }
    // 若房主数据缺失（尚未同步到该设备），不做任何解散操作，等待数据同步
    if (!owner) {
        return;
    }
    // 移除掉线的非房主玩家
    Object.keys(room.players).forEach(pid => {
        const p = room.players[pid];
        if (pid !== app.playerId && p) {
            const lastActive = p.lastActive || p.joinedAt || 0;
            if (now - lastActive > OFFLINE_TIMEOUT) {
                delete room.players[pid];
                changed = true;
            }
        }
    });
    if (changed) {
        saveRoom(roomId, room);
    }
}
function stopCloudSyncLoop() {
    if (cloudSyncTimer) {
        clearTimeout(cloudSyncTimer);
        cloudSyncTimer = null;
    }
}

// 检查当前房间是否到了「结算后自动开启下一轮」的时间点，到了就推进。
// 用房间级 version 记录上一次处理的状态，避免重复触发。
function tryAutoAdvanceCurrentRoom() {
    if (!app || !app.currentRoomId || !app.currentRoomData) return;
    const gd = app.currentRoomData.gameData;
    if (!gd || gd.phase !== 'revealing') return;
    if (!gd.autoNextAt || Date.now() < gd.autoNextAt) return;
    app.startNextRound();
}

// 订阅云端房间变化，实时同步其他设备的增删改到本地缓存
function subscribeRoomsFromCloud() {
    if (!useCloud || !supabaseClient) return;
    supabaseClient
        .channel('rooms-sync')
        .on('postgres_changes', { event: '*', schema: 'public', table: ROOM_COLLECTION }, (payload) => {
            if (payload.eventType === 'DELETE') {
                delete cloudRoomsCache[payload.old.id];
                handleCrossTabUpdate(payload.old.id);
            } else if (payload.new && payload.new.id && payload.new.data) {
                cloudRoomsCache[payload.new.id] = payload.new.data;
                handleCrossTabUpdate(payload.new.id);
            }
        })
        .subscribe();
}

// ============ BroadcastChannel 跨标签页通信（解决 file:// 下 localStorage 不同步问题） ============
let broadcastChannel = null;
let broadcastRoomsCache = null;

function initBroadcastChannel() {
    try {
        broadcastChannel = new BroadcastChannel('murder_mystery_channel');
        broadcastChannel.onmessage = (event) => {
            const msg = event.data;
            if (msg.type === 'room-data') {
                // 写入当前标签页的 localStorage，确保 getRoom 能读取
                localStorage.setItem(ROOM_PREFIX + msg.roomId, JSON.stringify(msg.roomData));
                // 同时更新内存缓存（供 getAllRooms 合并使用）
                if (!broadcastRoomsCache) broadcastRoomsCache = {};
                broadcastRoomsCache[msg.roomId] = msg.roomData;
                // 触发 UI 更新
                handleCrossTabUpdate(msg.roomId);
            } else if (msg.type === 'room-deleted') {
                localStorage.removeItem(ROOM_PREFIX + msg.roomId);
                if (broadcastRoomsCache) {
                    delete broadcastRoomsCache[msg.roomId];
                }
                // 如果当前就在该房间，自动退出
                if (app.currentRoomId === msg.roomId) {
                    app.currentRoomId = null;
                    app.currentRoomData = null;
                    app.showLobby();
                    app.showToast('房间已解散');
                } else {
                    app.refreshRooms();
                }
            }
        };
        console.log('✅ BroadcastChannel 已启动（跨标签页实时同步）');
    } catch (e) {
        console.warn('BroadcastChannel 不可用，回退到 storage 事件', e);
    }
}

function broadcastChannelPost(msg) {
    try {
        if (broadcastChannel) {
            broadcastChannel.postMessage(msg);
        } else {
            // 降级方案：创建一次性通道
            const channel = new BroadcastChannel('murder_mystery_channel');
            channel.postMessage(msg);
            channel.close();
        }
    } catch (e) {}
}

function handleCrossTabUpdate(roomId) {
    // 如果当前就在该房间中，更新界面
    if (app.currentRoomId === roomId) {
        const room = getRoom(roomId);
        if (!room) {
            app.currentRoomId = null;
            app.currentRoomData = null;
            app.showLobby();
            app.showToast('房间已解散');
            return;
        }
        app.currentRoomData = room;
        if (room.status === 'waiting') {
            app.showRoom();
            app.updateRoomUI();
        } else if (room.status === 'playing') {
            app.updateGameFromRoom(room);
            app.showGame();
        }
    } else {
        // 在大厅中则刷新房间列表
        app.refreshRooms();
    }
}

// 立即初始化 BroadcastChannel
initBroadcastChannel();

// 尝试初始化 Supabase（连接成功后自动拉取并订阅房间变化）
initSupabase();

// 重写 app 中的房间操作方法，使用上述函数
// ============ 应用状态 ============
const app = {
    playerName: '',
    playerId: '',
    currentRoomId: null,
    currentRoomData: null,
    mySeat: -1,
    roomListener: null,
    gamePhase: 'idle',
    localHand: null,
    localOriginalCard: null,
    resultData: null,
    lobbyRefreshTimer: null,

    // ============ 登录 ============
    login() {
        const nameInput = document.getElementById('name-input');
        let name = nameInput.value.trim();
        if (!name) {
            name = this.generateUniqueRandomName();
        } else {
            if (this.isNameTaken(name)) {
                this.showToast('该名字已被使用，请换一个');
                return;
            }
        }
        this.playerName = name;
        this.playerId = 'player_' + Date.now() + '_' + Math.random().toString(36).substr(2, 8);
        // 用 localStorage 持久化身份，刷新/关闭网页后能恢复身份重新连接
        localStorage.setItem('mm_player_id', this.playerId);
        localStorage.setItem('mm_player_name', this.playerName);
        this.showLobby();
    },

    // 恢复之前保存的身份（供刷新后重连）
    restoreSession() {
        const savedId = localStorage.getItem('mm_player_id');
        const savedName = localStorage.getItem('mm_player_name');
        if (savedId && savedName) {
            this.playerId = savedId;
            this.playerName = savedName;
            return true;
        }
        return false;
    },

    generateUniqueRandomName() {
        const baseNames = ['福尔摩斯', '华生', '波洛', '马普尔', '柯南', '金田一', '明智小五郎', '狄仁杰', '宋慈', '包拯'];
        let attempts = 0;
        while (attempts < 50) {
            const base = baseNames[Math.floor(Math.random() * baseNames.length)];
            const suffix = Math.floor(Math.random() * 1000);
            const candidate = `${base}_${suffix}`;
            if (!this.isNameTaken(candidate)) return candidate;
            attempts++;
        }
        return '玩家_' + Date.now() % 100000;
    },

    isNameTaken(name) {
        const rooms = getAllRooms();
        for (const roomId in rooms) {
            const room = rooms[roomId];
            if (room && room.players) {
                for (const pid in room.players) {
                    const player = room.players[pid];
                    if (player && player.name === name) return true;
                }
            }
        }
        return false;
    },

    logout() {
        if (this.currentRoomId && this.mySeat >= 0) {
            this.leaveRoomSilent();
        }
        this.stopLobbyRefresh();
        this.playerName = '';
        this.playerId = '';
        this.currentRoomId = null;
        this.currentRoomData = null;
        this.mySeat = -1;
        this.gamePhase = 'idle';
        localStorage.removeItem('mm_player_id');
        localStorage.removeItem('mm_player_name');
        localStorage.removeItem('mm_current_room');
        document.getElementById('name-input').value = '';
        this.showLogin();
    },

    // ============ 界面切换 ============
    showLogin() {
        this.stopLobbyRefresh();
        document.getElementById('login-screen').classList.remove('hidden');
        document.getElementById('lobby-screen').classList.add('hidden');
        document.getElementById('room-screen').classList.add('hidden');
        document.getElementById('game-screen').classList.add('hidden');
    },
    showLobby() {
        document.getElementById('login-screen').classList.add('hidden');
        document.getElementById('lobby-screen').classList.remove('hidden');
        document.getElementById('room-screen').classList.add('hidden');
        document.getElementById('game-screen').classList.add('hidden');
        document.getElementById('lobby-welcome').textContent = `👋 欢迎，${this.playerName}`;
        this.refreshRooms();
        this.startLobbyRefresh();
    },
    showRoom() {
        this.stopLobbyRefresh();
        document.getElementById('login-screen').classList.add('hidden');
        document.getElementById('lobby-screen').classList.add('hidden');
        document.getElementById('room-screen').classList.remove('hidden');
        document.getElementById('game-screen').classList.add('hidden');
        this.updateRoomUI();
    },
    showGame() {
        this.stopLobbyRefresh();
        document.getElementById('login-screen').classList.add('hidden');
        document.getElementById('lobby-screen').classList.add('hidden');
        document.getElementById('room-screen').classList.add('hidden');
        document.getElementById('game-screen').classList.remove('hidden');
        this.renderGame();
    },

    startLobbyRefresh() {
        this.stopLobbyRefresh();
        const refreshLoop = () => {
            this.refreshRooms();
            this.lobbyRefreshTimer = setTimeout(refreshLoop, 1000);
        };
        refreshLoop();
    },
    stopLobbyRefresh() {
        if (this.lobbyRefreshTimer) {
            clearTimeout(this.lobbyRefreshTimer);
            this.lobbyRefreshTimer = null;
        }
    },

    // ============ 房间管理 ============
    refreshRooms() {
        const rooms = getAllRooms();
        this.renderRoomList(rooms);
    },

    renderRoomList(rooms) {
        const container = document.getElementById('room-list');
        const availableRooms = Object.entries(rooms).filter(([id, room]) => {
            if (!id) return false;                 // 过滤无效 roomId，避免「null 空房间」
            if (!room || room.status !== 'waiting') return false;
            const players = room.players || {};
            const activePlayers = Object.values(players).filter(p => p && p.name);
            return activePlayers.length < 5;
        });

        if (availableRooms.length === 0) {
            container.innerHTML = '<p style="color:var(--text-dim);text-align:center;">暂无可用房间</p>';
            return;
        }

        container.innerHTML = availableRooms.map(([id, room]) => {
            const players = room.players || {};
            const activePlayers = Object.values(players).filter(p => p && p.name);
            const playerNames = activePlayers.map(p => p.name).join(', ') || '空';
            return `
                <div class="room-item" onclick="app.joinRoomWithCheck('${id}')">
                    <div class="room-info">
                        <span class="room-name">${room.name || '未命名房间'}</span>
                        <span class="room-meta">玩家：${playerNames}</span>
                    </div>
                    <span style="color:var(--text-dim);font-size:0.9em;">${activePlayers.length}/5 ${room.password ? '🔒' : ''}</span>
                </div>
            `;
        }).join('');
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
            this.showLobby();
            return;
        }
        // 房间存在：恢复该玩家（若已被移除则重新加入）
        if (!room.players || !room.players[this.playerId]) {
            this.joinRoom(roomId, room.password || '');
            return;
        }
        // 已在该房间：刷新活跃时间并进入
        room.players[this.playerId].lastActive = Date.now();
        saveRoom(roomId, room);
        this.currentRoomId = roomId;
        localStorage.setItem('mm_current_room', roomId);
        this.listenToRoom(roomId);
        this.showRoom();
    },

    createRoom() {
        if (!this.playerName) return;
        const roomId = 'room_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);
        // 生成房间口令：房主分享给朋友才能加入，防止陌生人进入
        const password = Math.floor(1000 + Math.random() * 9000).toString();
        const roomData = {
            name: `${this.playerName} 的房间`,
            status: 'waiting',
            createdBy: this.playerId,
            createdAt: Date.now(),
            players: {},
            gameData: null,
            password: password
        };
        this.currentRoomId = roomId;
        // 房主直接加入，无需输入口令。
        // 注意：不要在这里先 saveRoom 0 人的房间，避免「0 人写入」晚于「1 人写入」到达云端覆盖成 0 人。
        // 直接让 joinRoom 用 roomData 创建并保存含房主的 1 人房间。
        this.joinRoom(roomId, password, roomData);
        this.showToast('房间口令：' + password + '（请分享给朋友）');
    },

    // 从大厅点击房间：先校验口令再加入
    joinRoomWithCheck(roomId) {
        const room = getRoom(roomId);
        if (!room) {
            this.showToast('房间不存在');
            return;
        }
        const password = prompt('请输入房间口令：');
        if (password === null) return; // 取消
        this.joinRoom(roomId, (password || '').trim());
    },

    joinRoom(roomId, password, explicitRoom) {
        if (!this.playerName || !this.playerId) return;
        // createRoom 场景直接传入刚创建的 roomData，避免 getRoom 读到旧缓存导致「0 人」等问题
        const room = explicitRoom || getRoom(roomId);
        if (!room) {
            this.showToast('房间不存在');
            return;
        }
        if (room.status !== 'waiting') {
            this.showToast('游戏已开始，无法加入');
            return;
        }
        // 口令校验：房主创建时带正确口令加入；其他玩家需输入正确口令
        if (room.password && room.password !== password) {
            this.showToast('房间口令错误，无法加入');
            return;
        }

        const players = room.players || {};
        const activePlayers = Object.values(players).filter(p => p && p.name);
        if (activePlayers.length >= 5) {
            this.showToast('房间已满');
            return;
        }

        let seat = -1;
        for (let i = 0; i < 5; i++) {
            const occupied = Object.values(players).some(p => p && p.seat === i);
            if (!occupied) { seat = i; break; }
        }
        if (seat === -1) seat = Math.floor(Math.random() * 5);

        this.mySeat = seat;
        const playerData = {
            name: this.playerName,
            seat: seat,
            connected: true,
            markers: 6,
            wrongMarkers: 0,
            joinedAt: Date.now(),
            lastActive: Date.now()
        };
        room.players = room.players || {};
        room.players[this.playerId] = playerData;
        saveRoom(roomId, room);
        this.currentRoomId = roomId;
        localStorage.setItem('mm_current_room', roomId); // 保存当前房间，刷新后重连
        this.listenToRoom(roomId);
        this.showRoom();
        this.showToast('已加入房间，座位 #' + (seat + 1));
    },

    listenToRoom(roomId) {
        let missingCount = 0;
        const checkRoom = () => {
            const room = getRoom(roomId);
            if (!room) {
                // 容错：创建房间写入云端是异步的，缓存可能暂时没有该房间。
                // 若连续多次（约 3 秒）都读不到才判定为解散，避免开房后误退回大厅。
                missingCount++;
                if (missingCount < 6) return;
                this.currentRoomId = null;
                this.currentRoomData = null;
                this.showLobby();
                this.showToast('房间已解散');
                return;
            }
            missingCount = 0;
            this.currentRoomData = room;
            if (room.status === 'waiting') {
                this.showRoom();
                this.updateRoomUI();
            } else if (room.status === 'playing') {
                this.updateGameFromRoom(room);
                this.showGame();
            }
        };
        checkRoom();
        this.roomListener = setInterval(checkRoom, 500);
    },

    updateRoomUI() {
        const room = this.currentRoomData;
        if (!room) return;
        const players = room.players || {};
        const seatMap = document.getElementById('seat-map');
        const myId = this.playerId;
        const mySeat = players[myId] ? players[myId].seat : -1;

        document.getElementById('room-title').textContent = `📋 ${room.name}`;
        // 一直显示房间 ID 和口令，方便房主随时分享给朋友
        const pwText = room.password ? ` | 房间口令: ${room.password}` : '';
        document.getElementById('room-code-display').textContent = `房间ID: ${this.currentRoomId}${pwText}`;

        let seatHTML = '';
        for (let i = 0; i < 5; i++) {
            const occupant = Object.entries(players).find(([id, p]) => p && p.seat === i);
            let cls = 'seat-btn';
            let label = (i + 1).toString();
            let title = '空座位';
            if (occupant) {
                cls += ' occupied';
                label = occupant[1].name.charAt(0).toUpperCase();
                title = occupant[1].name;
                if (occupant[0] === myId) {
                    cls += ' mine';
                    title += ' (你)';
                }
            }
            if (mySeat === i && occupant && occupant[0] === myId) {
                cls += ' selected';
            }
            const clickable = !occupant || occupant[0] === myId;
            seatHTML += `<button class="${cls}" title="${title}" ${clickable ? `onclick="app.changeSeat(${i})"` : 'disabled'}>${label}</button>`;
        }
        seatMap.innerHTML = seatHTML;

        const playerCount = Object.values(players).filter(p => p && p.name).length;
        const canStart = playerCount >= 2 && playerCount <= 5;
        const isCreator = room.createdBy === myId;
        const startBtn = document.getElementById('btn-start-game');
        startBtn.disabled = !canStart || !isCreator;
        document.getElementById('room-status-text').textContent =
            `当前 ${playerCount}/5 人 | ${canStart ? '可以开始' : '至少需要2人'} ${isCreator ? '| 你是房主' : ''}`;
    },

    changeSeat(newSeat) {
        const room = this.currentRoomData;
        if (!room || room.status !== 'waiting') return;
        const players = room.players || {};
        const isOccupied = Object.entries(players).some(([id, p]) => id !== this.playerId && p && p.seat === newSeat);
        if (isOccupied) {
            this.showToast('该座位已被占用');
            return;
        }
        room.players[this.playerId].seat = newSeat;
        saveRoom(this.currentRoomId, room);
        this.mySeat = newSeat;
    },

    leaveRoom() {
        this.leaveRoomSilent();
        this.showLobby();
    },

    leaveRoomSilent() {
        if (this.currentRoomId && this.playerId) {
            // 用 RPC 在数据库层原子移除玩家；若房间已无玩家则删除房间。
            // 避免多玩家退出时因各自基于过时缓存判断而残留玩家，导致房间不删除。
            if (useCloud && supabaseClient) {
                supabaseClient
                    .rpc('leave_room', { room_id: this.currentRoomId, player_id: this.playerId })
                    .then(({ error }) => {
                        if (error) console.warn('leave_room RPC 失败', error);
                    });
                // 本地缓存同步：移除自己，若 0 人则删除缓存
                const localRoom = getRoom(this.currentRoomId);
                if (localRoom && localRoom.players) {
                    delete localRoom.players[this.playerId];
                    const activePlayers = Object.values(localRoom.players).filter(p => p && p.name);
                    if (activePlayers.length === 0) {
                        delete cloudRoomsCache[this.currentRoomId];
                    } else {
                        cloudRoomsCache[this.currentRoomId] = localRoom;
                    }
                }
            } else {
                const room = getRoom(this.currentRoomId);
                if (room) {
                    if (room.players && room.players[this.playerId]) {
                        delete room.players[this.playerId];
                        const activePlayers = Object.values(room.players).filter(p => p && p.name);
                        if (activePlayers.length === 0) {
                            deleteRoom(this.currentRoomId);
                        } else {
                            saveRoom(this.currentRoomId, room);
                        }
                    }
                }
            }
        }
        if (this.roomListener) {
            clearInterval(this.roomListener);
            this.roomListener = null;
        }
        this.currentRoomId = null;
        this.currentRoomData = null;
        this.mySeat = -1;
        this.gamePhase = 'idle';
        localStorage.removeItem('mm_current_room');
    },

    // ============ 游戏开始 ============
    startGame() {
        const room = this.currentRoomData;
        if (!room || room.status !== 'waiting') return;
        const players = room.players || {};
        const playerCount = Object.values(players).filter(p => p && p.name).length;
        if (playerCount < 2 || playerCount > 5) {
            this.showToast('需要2-5名玩家');
            return;
        }
        if (room.createdBy !== this.playerId) {
            this.showToast('只有房主可以开始游戏');
            return;
        }

        const gameData = this.initGameData(players, playerCount);
        room.status = 'playing';
        room.gameData = gameData;
        saveRoom(this.currentRoomId, room);
        this.showToast('游戏开始！');
    },

    initGameData(players, playerCount) {
        let deck = [...ALL_CARDS];
        if (playerCount <= 4) {
            const xIndex = deck.indexOf('X');
            deck.splice(xIndex, 1);
        }
        deck = this.shuffle(deck);

        const playerIds = Object.keys(players).filter(pid => players[pid] && players[pid].name);
        const seats = playerIds.map(id => players[id].seat).sort((a, b) => a - b);
        const playerBySeat = {};
        playerIds.forEach(id => { playerBySeat[players[id].seat] = id; });

        const handCards = {};
        const originalCards = {};
        seats.forEach(seat => {
            const card = deck.pop();
            const playerId = playerBySeat[seat];
            handCards[playerId] = card;
            originalCards[playerId] = card;
        });

        const middleCards = deck.splice(0, 4);
        const suspects = middleCards.slice(0, 3);
        const body = middleCards[3];

        let revealedCard = null;
        if (playerCount === 2 || playerCount === 3) {
            const remaining = deck;
            if (remaining.length > 0) {
                revealedCard = remaining[Math.floor(Math.random() * remaining.length)];
            }
        }

        const firstSeat = seats[Math.floor(Math.random() * seats.length)];

        return {
            phase: 'confirming',
            round: 1,
            playerCount: playerCount,
            playerIds: playerIds,
            playerBySeat: playerBySeat,
            seats: seats,
            handCards: handCards,
            originalCards: originalCards,
            suspects: suspects,
            body: body,
            revealedCard: revealedCard,
            firstInvestigatorSeat: firstSeat,
            currentPlayerSeat: firstSeat,
            markedSuspectIndex: -1,
            votes: {},
            hasVoted: {},
            seenHand: {},
            markers: {},
            wrongMarkers: {},
            voteLog: [],
            lastVoterSeat: -1,
            initMarkers: {},
            totalWrongMarkers: {},
            suspectVoters: { 0: [], 1: [], 2: [] },
            viewedCards: {},
            turnCount: 0,
        };
    },

    shuffle(arr) {
        const a = [...arr];
        for (let i = a.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [a[i], a[j]] = [a[j], a[i]];
        }
        return a;
    },

    // ============ 游戏逻辑处理 ============
    updateGameFromRoom(room) {
        let gd = room.gameData;
        // 处理游戏结束回到房间的情况（gameData 为 null）
        if (!gd) {
            // 如果之前有弹窗，关闭它
            if (this._resultShown) {
                this._resultShown = false;
                document.getElementById('result-modal').classList.add('hidden');
            }
            this.currentRoomData = room;
            this.gamePhase = 'idle';
            this.localHand = null;
            this.localOriginalCard = null;
            return;
        }
        this.currentRoomData = room;
        this.gamePhase = gd.phase;

        // 进入新回合（非结算阶段），关闭结算弹窗
        if (gd.phase !== 'revealing' && gd.phase !== 'gameover') {
            this._resultShown = false;
            document.getElementById('result-modal').classList.add('hidden');
        }

        if (gd.handCards && gd.handCards[this.playerId]) {
            this.localHand = gd.handCards[this.playerId];
        }
        if (gd.originalCards && gd.originalCards[this.playerId]) {
            this.localOriginalCard = gd.originalCards[this.playerId];
        }
        this.renderGame();

        // 确认手牌阶段：所有玩家都确认后，自动传牌进入调查阶段。
        // 放在统一入口判断，保证在 Supabase 异步同步下，任一方都能拿到全员确认状态后推进。
        if (gd.phase === 'confirming' && gd.seenHand) {
            const allSeen = gd.playerIds.every(pid => gd.seenHand[pid]);
            if (allSeen) {
                this.passCards(room);
                // passCards 会保存并改变 phase，重新取最新数据继续渲染
                const latest = getRoom(this.currentRoomId);
                if (!latest || !latest.gameData) return;
                room = latest;
                gd = latest.gameData;
                this.currentRoomData = latest;
                this.gamePhase = gd.phase;
                this.renderGame();
            }
        }

        // 调查阶段：统一推进回合——若当前玩家已投票，则轮到下一个未投票玩家；
        // 若所有人都已投票，则进入结算。放在统一入口，基于云端完整数据判断，避免投票后卡住。
        if (gd.phase === 'investigating' && gd.hasVoted) {
            const curSeat = gd.currentPlayerSeat;
            const curPid = gd.playerBySeat && gd.playerBySeat[curSeat];
            if (curPid && gd.hasVoted[curPid]) {
                // 当前玩家已投票，找下一个未投票玩家
                const seats = gd.seats;
                const n = seats.length;
                let nextSeat = -1;
                for (let i = 1; i <= n; i++) {
                    const cand = seats[(seats.indexOf(curSeat) + i) % n];
                    const pid = gd.playerBySeat && gd.playerBySeat[cand];
                    if (pid && !gd.hasVoted[pid]) { nextSeat = cand; break; }
                }
                if (nextSeat !== -1) {
                    // 还没人全投 → 轮到下一个
                    if (gd.currentPlayerSeat !== nextSeat) {
                        gd.currentPlayerSeat = nextSeat;
                        saveRoom(this.currentRoomId, room);
                    }
                } else {
                    // 所有人都已投票 → 进入结算
                    this.enterRevealPhase(gd);
                    const latest2 = getRoom(this.currentRoomId);
                    if (!latest2 || !latest2.gameData) return;
                    room = latest2;
                    gd = latest2.gameData;
                    this.currentRoomData = latest2;
                    this.gamePhase = gd.phase;
                }
            }
        }

        // 结算结果展示后，所有标签页都会通过轮询检测到时间点并协同开启下一轮。
        // 必须先处理自动推进：时间一到就进入新一局（phase 离开 revealing），
        // 避免停留在结算阶段反复弹窗（无限循环）。
        if (gd.phase === 'revealing' && gd.autoNextAt && Date.now() >= gd.autoNextAt) {
            this.startNextRound();
            return;
        }
        // 游戏结束：弹窗展示 5 秒后，清空 gameData 并返回房间等待界面（所有设备统一处理）
        if (gd.phase === 'gameover' && gd.autoNextAt && Date.now() >= gd.autoNextAt) {
            const r = getRoom(this.currentRoomId);
            if (r && r.gameData) {
                r.status = 'waiting';
                r.gameData = null;
                saveRoom(this.currentRoomId, r);
                this._resultShown = false;
                document.getElementById('result-modal').classList.add('hidden');
            }
            return;
        }
        // 让每个玩家都看到结算结果（不只有触发结算的那位）。
        // 用「本地内存」标记 _resultShown 防止本设备重复弹出；
        // 不能用持久化的云端标记，否则其他设备看到已展示过就不显示了。
        if ((gd.phase === 'revealing' || gd.phase === 'gameover') &&
            gd.resultDetails && !this._resultShown) {
            this._resultShown = true;
            this.showResultModal(gd, gd.killer, gd.resultDetails, gd.initMarkers, gd.totalWrongMarkers, gd.finalResult);
        }
    },

    renderGame() {
        const gd = this.currentRoomData?.gameData;
        if (!gd) return;
        document.getElementById('game-room-name').textContent = this.currentRoomData.name || '游戏';
        document.getElementById('game-status').textContent = this.getPhaseText(gd);
        this.renderPlayers(gd);
        this.renderMiddleCards(gd);
        this.renderHand(gd);
        this.renderActions(gd);
        this.renderPhaseHint(gd);
        this.renderResult(gd);
    },

    getPhaseText(gd) {
        switch (gd.phase) {
            case 'confirming': return '👁️ 查看手牌阶段';
            case 'passing': return '🔄 传牌阶段';
            case 'investigating': return '🔍 调查阶段 - 第' + gd.round + '轮';
            case 'revealing': return '🏆 结算阶段';
            case 'gameover': return '📊 游戏结束';
            default: return '';
        }
    },

    renderPlayers(gd) {
        const container = document.getElementById('game-players');
        const players = this.currentRoomData.players || {};
        const sortedSeats = [...gd.seats].sort((a, b) => a - b);
        container.innerHTML = sortedSeats.map(seat => {
            const playerId = gd.playerBySeat[seat];
            const player = players[playerId];
            if (!player) return '';
            const isMe = playerId === this.playerId;
            const isActive = gd.phase === 'investigating' && gd.currentPlayerSeat === seat;
            const hasVoted = gd.hasVoted && gd.hasVoted[playerId];
            const markers = gd.initMarkers && gd.initMarkers[playerId] !== undefined ? gd.initMarkers[playerId] : (player.markers || 6);
            const wrongMarkers = gd.totalWrongMarkers && gd.totalWrongMarkers[playerId] !== undefined ? gd.totalWrongMarkers[playerId] : 0;
            return `
                <div class="player-chip ${isActive ? 'active' : ''} ${hasVoted ? 'voted' : ''}">
                    <span class="dot ${player.connected ? 'online' : ''}"></span>
                    <span>${isMe ? '你' : ''}${player.name} #${seat+1}</span>
                    <span class="markers">🔵${markers} <span class="wrong-markers">🔴${wrongMarkers}</span></span>
                    ${hasVoted ? '✅' : ''}
                </div>
            `;
        }).join('');
    },

    renderMiddleCards(gd) {
        const container = document.getElementById('middle-cards');
        const mySeat = this.mySeat;
        const isMyTurn = gd.phase === 'investigating' && gd.currentPlayerSeat === mySeat;
        const canView = isMyTurn && !gd.hasVoted[this.playerId];
        let cardsHTML = '';

        gd.suspects.forEach((card, index) => {
            const isRevealed = gd.phase === 'revealing' || gd.phase === 'gameover';
            const isMarked = gd.markedSuspectIndex === index;
            const voteCount = (gd.suspectVoters && gd.suspectVoters[index]) ? gd.suspectVoters[index].length : 0;
            const myVote = gd.votes[this.playerId];
            const isVotedOn = myVote === index;
            const cardDisplay = isRevealed ? card : '?';
            const cardClass = card === 'X' ? 'x-card' : 'num-card';
            cardsHTML += `
                <div class="middle-card-wrapper">
                    <span class="middle-card-label">嫌疑人${['A','B','C'][index]} ${isMarked ? '🚫' : ''}</span>
                    <div class="card ${!isRevealed ? 'face-down' : ''} ${isMarked ? 'marked' : ''} ${isVotedOn ? 'voted-on' : ''} ${canView && !isRevealed ? 'selectable' : ''}" 
                         data-index="${index}" 
                         onclick="${canView && !isRevealed ? `app.viewSuspect(${index})` : ''}">
                        ${isRevealed ? card : ''}
                    </div>
                    <div class="vote-markers">
                        ${Array(voteCount).fill(0).map((_, vi) => `<span class="vote-marker">${vi+1}</span>`).join('')}
                    </div>
                </div>
            `;
        });

        const bodyRevealed = gd.phase === 'revealing' || gd.phase === 'gameover';
        cardsHTML += `
            <div class="middle-card-wrapper">
                <span class="middle-card-label">尸体</span>
                <div class="card body-card ${!bodyRevealed ? 'face-down' : ''}">
                    ${bodyRevealed ? gd.body : ''}
                </div>
            </div>
        `;
        container.innerHTML = cardsHTML;

        const revealedArea = document.getElementById('revealed-card-area');
        if (gd.revealedCard) {
            revealedArea.classList.remove('hidden');
            revealedArea.innerHTML = `
                <span style="font-size:0.9em;">公开展示的牌：</span>
                <span class="revealed-card-display">${gd.revealedCard}</span>
            `;
        } else {
            revealedArea.classList.add('hidden');
        }
    },

    renderHand(gd) {
        const handDisplay = document.getElementById('hand-card-display');
        const hint = document.getElementById('hand-card-hint');
        // 优先用 localHand；若为空，则直接从 gameData.handCards 读取该玩家手牌，
        // 避免在 Supabase 异步同步下因 localHand 未及时设置而显示成「?」
        let card = this.localHand;
        let original = this.localOriginalCard;
        if (!card && gd && gd.handCards) {
            card = gd.handCards[this.playerId];
        }
        if (!original && gd && gd.originalCards) {
            original = gd.originalCards[this.playerId];
        }
        if (card) {
            handDisplay.textContent = card;
            handDisplay.style.color = card === 'X' ? 'var(--red)' : '#fff';
            hint.textContent = original ? `原始牌: ${original}` : '';
        } else {
            handDisplay.textContent = '?';
            hint.textContent = '';
        }
    },

    renderPhaseHint(gd) {
        const hintEl = document.getElementById('phase-hint');
        const mySeat = this.mySeat;
        let text = '';
        if (gd.phase === 'confirming') {
            const hasSeen = gd.seenHand && gd.seenHand[this.playerId];
            text = hasSeen ? '✅ 已确认手牌，等待其他玩家...' : '👁️ 请查看你的手牌（点击下方按钮确认）';
        } else if (gd.phase === 'passing') {
            text = '🔄 牌已传给左手边玩家，准备调查...';
        } else if (gd.phase === 'investigating') {
            const currentSeat = gd.currentPlayerSeat;
            const currentPlayerId = gd.playerBySeat[currentSeat];
            const currentPlayer = this.currentRoomData.players?.[currentPlayerId];
            const isMyTurn = currentSeat === mySeat;
            if (isMyTurn) {
                if (gd.hasVoted[this.playerId]) {
                    text = '⏳ 你已投票，等待其他玩家...';
                } else {
                    text = '🔍 你的回合：请查看嫌疑人卡牌并投票';
                }
            } else {
                text = `⏳ 等待 ${currentPlayer?.name || '玩家'} 操作...`;
            }
        } else if (gd.phase === 'revealing') {
            text = '🏆 结算中...';
        } else if (gd.phase === 'gameover') {
            text = '📊 游戏结束';
        }
        hintEl.textContent = text;
    },

    renderActions(gd) {
        const container = document.getElementById('action-bar');
        const mySeat = this.mySeat;
        const isMyTurn = gd.phase === 'investigating' && gd.currentPlayerSeat === mySeat;
        const hasVoted = gd.hasVoted && gd.hasVoted[this.playerId];
        let buttonsHTML = '';

        if (gd.phase === 'confirming') {
            const hasSeen = gd.seenHand && gd.seenHand[this.playerId];
            if (!hasSeen) {
                buttonsHTML = `<button class="btn-primary" onclick="app.confirmHand()">👁️ 查看并确认手牌</button>`;
            } else {
                buttonsHTML = `<button class="btn-secondary" disabled>✅ 已确认</button>`;
            }
        } else if (gd.phase === 'passing') {
            buttonsHTML = `<button class="btn-secondary" disabled>🔄 传牌中...</button>`;
        } else if (gd.phase === 'investigating') {
            if (isMyTurn && !hasVoted) {
                buttonsHTML = `
                    <button class="btn-primary" onclick="app.viewSuspectsForVote()">🔍 查看卡牌</button>
                    <button class="btn-green" onclick="app.voteForSuspect(0)">投A</button>
                    <button class="btn-green" onclick="app.voteForSuspect(1)">投B</button>
                    <button class="btn-green" onclick="app.voteForSuspect(2)">投C</button>
                `;
            } else {
                buttonsHTML = `<button class="btn-secondary" disabled>⏳ 等待中...</button>`;
            }
        } else if (gd.phase === 'revealing' || gd.phase === 'gameover') {
            if (gd.phase === 'revealing') {
                buttonsHTML = `<button class="btn-secondary" disabled>🏆 结算中...</button>`;
            } else {
                const isCreator = this.currentRoomData?.createdBy === this.playerId;
                if (isCreator) {
                    buttonsHTML = `<button class="btn-primary" onclick="app.restartGame()">🔄 新一局</button>`;
                } else {
                    buttonsHTML = `<button class="btn-secondary" disabled>等待房主...</button>`;
                }
            }
        }
        container.innerHTML = buttonsHTML;
    },

    renderResult(gd) {
        const resultArea = document.getElementById('result-area');
        if (gd.phase === 'revealing' || gd.phase === 'gameover') {
            resultArea.classList.remove('hidden');
            if (gd.phase === 'gameover') {
                const players = this.currentRoomData.players || {};
                let resultHTML = '<div style="display:flex;flex-direction:column;gap:8px;width:100%;">';
                resultHTML += '<h3 style="color:var(--gold);text-align:center;">📊 最终结果</h3>';
                gd.seats.forEach(seat => {
                    const pid = gd.playerBySeat[seat];
                    const p = players[pid];
                    if (!p) return;
                    const wrong = gd.totalWrongMarkers?.[pid] || 0;
                    const remaining = gd.initMarkers?.[pid] !== undefined ? gd.initMarkers[pid] : 6;
                    resultHTML += `
                        <div style="display:flex;justify-content:space-between;padding:6px 12px;background:#1a1a2e;border-radius:8px;">
                            <span>${p.name} #${seat+1}</span>
                            <span>🔵剩余:${remaining} 🔴错误:${wrong}</span>
                        </div>
                    `;
                });
                resultHTML += '</div>';
                resultArea.innerHTML = resultHTML;
            } else {
                const killer = this.determineKiller(gd);
                resultArea.innerHTML = `
                    <div class="result-banner ${killer ? 'win' : 'lose'}">
                        ${killer ? `🔪 凶手是: ${killer}` : '结算中...'}
                    </div>
                `;
            }
        } else {
            resultArea.classList.add('hidden');
        }
    },

    determineKiller(gd) {
        if (!gd || !gd.suspects) return null;
        const s = gd.suspects;
        const validCards = s.filter(c => c !== 'X');
        if (validCards.length === 0) return null;
        const nums = validCards.map(Number);
        if (s.includes('5')) {
            return Math.min(...nums).toString();
        } else {
            return Math.max(...nums).toString();
        }
    },

    // ============ 玩家操作 ============
    confirmHand() {
        if (!this.currentRoomId || !this.playerId) return;
        const room = getRoom(this.currentRoomId);
        if (!room || !room.gameData) return;
        const gd = room.gameData;
        if (gd.phase !== 'confirming') return;
        if (gd.seenHand && gd.seenHand[this.playerId]) return; // 已确认过，避免重复
        gd.seenHand = gd.seenHand || {};
        gd.seenHand[this.playerId] = true;
        // 本地先合并（即时 UI 反馈）
        this.renderGame();
        // 云端：用 RPC 在数据库层合并 seenHand，避免多人同时确认时互相覆盖
        if (useCloud && supabaseClient) {
            supabaseClient
                .rpc('add_seen_hand', { room_id: this.currentRoomId, player_id: this.playerId })
                .then(({ error }) => {
                    if (error) console.warn('confirmHand RPC 失败', error);
                });
        } else {
            saveRoom(this.currentRoomId, room);
        }
    },

    passCards(room) {
        const gd = room.gameData;
        const seats = gd.seats;
        const n = seats.length;
        const newHandCards = {};
        const playerBySeat = gd.playerBySeat;
        seats.forEach((seat, i) => {
            const currentPlayerId = playerBySeat[seat];
            const leftSeat = seats[(i + 1) % n];
            const leftPlayerId = playerBySeat[leftSeat];
            newHandCards[leftPlayerId] = gd.handCards[currentPlayerId];
        });
        gd.phase = 'investigating';
        gd.handCards = newHandCards;
        gd.seenHand = {};
        gd.currentPlayerSeat = gd.firstInvestigatorSeat;
        gd.votes = {};
        gd.hasVoted = {};
        gd.viewedCards = {};
        gd.suspectVoters = { 0: [], 1: [], 2: [] };
        gd.markedSuspectIndex = -1;
        gd.turnCount = 0;
        gd.voteLog = [];
        saveRoom(this.currentRoomId, room);
    },

    viewSuspect(index) {
        const room = getRoom(this.currentRoomId);
        if (!room || !room.gameData) return;
        const gd = room.gameData;
        if (gd.phase !== 'investigating') return;
        if (gd.currentPlayerSeat !== this.mySeat) return;
        if (gd.hasVoted[this.playerId]) return;
        const mySeat = this.mySeat;
        if (gd.firstInvestigatorSeat === mySeat) {
            const alreadyViewed = gd.viewedCards[this.playerId] || [];
            if (alreadyViewed.length >= 2) {
                this.showToast('你已查看2张卡牌，请直接投票');
            } else if (alreadyViewed.includes(index)) {
                this.showToast('这张牌你已经看过了');
            } else {
                this.showViewModal([index]);
            }
        } else {
            const lastVote = this.getLastVote(gd);
            if (lastVote !== -1) {
                const available = [0, 1, 2].filter(i => i !== lastVote);
                if (available.includes(index)) {
                    this.showViewModal([index]);
                } else {
                    this.showToast('你无法查看上一人投票的卡牌');
                }
            } else {
                if ([0,1,2].includes(index)) {
                    this.showViewModal([index]);
                }
            }
        }
    },

    getLastVote(gd) {
        if (gd.voteLog && gd.voteLog.length > 0) {
            return gd.voteLog[gd.voteLog.length - 1].suspectIndex;
        }
        const mySeat = this.mySeat;
        const seats = gd.seats;
        const n = seats.length;
        const myIndex = seats.indexOf(mySeat);
        for (let step = 1; step <= n; step++) {
            const prevSeat = seats[(myIndex - step + n) % n];
            const prevPlayerId = gd.playerBySeat[prevSeat];
            if (gd.hasVoted && gd.hasVoted[prevPlayerId] && gd.votes[prevPlayerId] !== undefined) {
                return gd.votes[prevPlayerId];
            }
        }
        return -1;
    },

    showViewModal(indices) {
        const room = getRoom(this.currentRoomId);
        if (!room || !room.gameData) return;
        const gd = room.gameData;
        const modal = document.getElementById('view-modal');
        const cardsContainer = document.getElementById('view-cards');
        cardsContainer.innerHTML = indices.map(idx => {
            const card = gd.suspects[idx];
            const label = ['A', 'B', 'C'][idx];
            return `
                <div class="card-view-item">
                    <span>嫌疑人${label}</span>
                    <div class="card" style="width:70px;height:100px;font-size:2em;border-color:var(--gold);">
                        ${card}
                    </div>
                </div>
            `;
        }).join('');
        modal.classList.remove('hidden');
        const mySeat = this.mySeat;
        const alreadyViewed = gd.viewedCards[this.playerId] || [];
        const newViewed = [...new Set([...alreadyViewed, ...indices])];
        gd.viewedCards[this.playerId] = newViewed;
        if (gd.firstInvestigatorSeat === mySeat) {
            const remaining = [0, 1, 2].filter(i => !newViewed.includes(i));
            if (remaining.length === 1) {
                gd.markedSuspectIndex = remaining[0];
            }
        }
        saveRoom(this.currentRoomId, room);
    },

    closeViewModal() {
        document.getElementById('view-modal').classList.add('hidden');
        this.renderGame();
    },

    viewSuspectsForVote() {
        const room = getRoom(this.currentRoomId);
        if (!room || !room.gameData) return;
        const gd = room.gameData;
        if (gd.phase !== 'investigating') return;
        if (gd.currentPlayerSeat !== this.mySeat) return;
        if (gd.hasVoted[this.playerId]) return;
        const mySeat = this.mySeat;
        const isFirst = gd.firstInvestigatorSeat === mySeat;
        const alreadyViewed = gd.viewedCards[this.playerId] || [];
        if (isFirst) {
            if (alreadyViewed.length === 0) this.showToast('请点击嫌疑人卡牌查看（需看2张）');
            else if (alreadyViewed.length === 1) this.showToast('再看一张牌');
            else this.showToast('已查看2张，请投票');
        } else {
            const lastVote = this.getLastVote(gd);
            const available = lastVote !== -1 ? [0,1,2].filter(i => i !== lastVote) : [0,1,2];
            if (alreadyViewed.length < available.length) this.showToast(`请点击查看可用的嫌疑人牌`);
            else this.showToast('已查看，请投票');
        }
        this.renderGame();
    },

    voteForSuspect(index) {
        const room = getRoom(this.currentRoomId);
        if (!room || !room.gameData) return;
        const gd = room.gameData;
        if (gd.phase !== 'investigating') return;
        if (gd.currentPlayerSeat !== this.mySeat) return;
        if (gd.hasVoted[this.playerId]) return;
        const markers = gd.initMarkers?.[this.playerId] !== undefined ? gd.initMarkers[this.playerId] : 6;
        if (markers <= 0) {
            this.showToast('你没有标识物了！游戏即将结束');
            return;
        }
        const mySeat = this.mySeat;
        gd.votes[this.playerId] = index;
        gd.hasVoted[this.playerId] = true;
        gd.turnCount = (gd.turnCount || 0) + 1;
        gd.voteLog.push({ seat: mySeat, suspectIndex: index });
        if (!gd.suspectVoters[index]) gd.suspectVoters[index] = [];
        gd.suspectVoters[index].push(this.playerId);
        gd.lastVoterSeat = mySeat;
        // 只记录投票并保存；「是否轮到下一个 / 是否进入结算」由 updateGameFromRoom 统一判断，
        // 保证基于云端完整数据推进，避免依赖本地缓存完整性而卡住。
        saveRoom(this.currentRoomId, room);
    },

    enterRevealPhase(gd) {
        const room = getRoom(this.currentRoomId);
        if (!room) return;
        room.gameData.phase = 'revealing';
        saveRoom(this.currentRoomId, room);
        setTimeout(() => {
            this.calculateReveal();
        }, 800);
    },

    calculateReveal() {
        const room = getRoom(this.currentRoomId);
        if (!room || !room.gameData) return;
        const gd = room.gameData;
        const killer = this.determineKiller(gd);
        const suspects = gd.suspects;
        const suspectVoters = gd.suspectVoters || { 0: [], 1: [], 2: [] };
        const initMarkers = {};
        gd.playerIds.forEach(pid => {
            initMarkers[pid] = gd.initMarkers?.[pid] !== undefined ? gd.initMarkers[pid] : 6;
        });
        const totalWrongMarkers = {};
        gd.playerIds.forEach(pid => {
            totalWrongMarkers[pid] = gd.totalWrongMarkers?.[pid] || 0;
        });
        const resultDetails = [];

        suspects.forEach((suspect, index) => {
            const votersOnThis = suspectVoters[index] || [];
            const isKiller = (suspect === killer);
            if (isKiller) {
                votersOnThis.forEach(pid => {
                    initMarkers[pid] = Math.max(0, initMarkers[pid] - 1);
                    resultDetails.push(`${pid} 投中凶手，标志物弃掉`);
                });
            } else if (votersOnThis.length > 0) {
                const lastVoter = votersOnThis[votersOnThis.length - 1];
                const totalWrong = votersOnThis.length;
                votersOnThis.forEach(pid => {
                    initMarkers[pid] = Math.max(0, initMarkers[pid] - 1);
                });
                totalWrongMarkers[lastVoter] = (totalWrongMarkers[lastVoter] || 0) + totalWrong;
                resultDetails.push(
                    `嫌疑人${['A','B','C'][index]}(${suspect})错误，${votersOnThis.map(p => this.getPlayerName(p, gd)).join(', ')}投票，最后投票者${this.getPlayerName(lastVoter, gd)}获得${totalWrong}个错误标志物`
                );
            }
        });

        gd.initMarkers = initMarkers;
        gd.totalWrongMarkers = totalWrongMarkers;
        gd.resultDetails = resultDetails;
        gd.killer = killer;

        // 检查游戏是否应该结束：错误标志物>=5 或 有人没有标志物
        let gameEnded = false;
        gd.playerIds.forEach(pid => {
            if (totalWrongMarkers[pid] >= 5) gameEnded = true;
            if (initMarkers[pid] <= 0) gameEnded = true;
        });

        if (gameEnded) {
            // 游戏结束：先保留 gameData 并显示「游戏结束」弹窗 5 秒，让所有玩家都能看到，
            // 时间到后再由统一逻辑清空 gameData 返回房间，避免某一边立即返回、另一边才看到弹窗。
            gd.phase = 'gameover';
            gd.finalResult = true;
            gd.autoNextAt = Date.now() + 5000;
            saveRoom(this.currentRoomId, room);
            this._resultShown = true;
            this.showResultModal(gd, killer, resultDetails, initMarkers, totalWrongMarkers, true);
        } else {
            // 结算后自动开启下一轮（先保存结算结果让所有玩家看到）
            gd.phase = 'revealing';
            gd.finalResult = false;
            // 标记本局结算弹窗已展示，防止轮询因内存状态变化而反复弹出
            gd.resultConfirmed = true;
            // 记录自动开启下一轮的时间点，由所有玩家的轮询统一推进，
            // 避免只依赖单个标签页的 setTimeout（该定时器失效会导致结算阶段无限循环、无法进入下一轮）
            // 结算弹窗保留 5 秒，方便玩家看完结算结果
            gd.autoNextAt = Date.now() + 5000;
            saveRoom(this.currentRoomId, room);
            this._resultShown = true;
            this.showResultModal(gd, killer, resultDetails, initMarkers, totalWrongMarkers, false);
        }
    },

    startNextRound() {
        // 用 RPC 原子获取「推进权」：只有一台设备能创建下一轮，避免多设备并发推进互相覆盖。
        // 拿到推进权（true）的才继续；拿不到（false，另一台设备已在推进）则等待同步。
        if (useCloud && supabaseClient) {
            supabaseClient
                .rpc('try_start_next_round', { room_id: this.currentRoomId })
                .then(({ data, error }) => {
                    if (error) {
                        console.warn('try_start_next_round RPC 失败', error);
                        return;
                    }
                    if (data === true) {
                        this.doCreateNextRound();
                    }
                });
            return;
        }
        // 本地模式：直接推进
        this.doCreateNextRound();
    },

    // 真正创建下一轮（由获得推进权的设备执行）
    doCreateNextRound() {
        const room = getRoom(this.currentRoomId);
        if (!room) return;
        // 只在结算阶段触发；phase 离开 revealing 后（下一轮已建立）不再重复推进
        if (!room.gameData || room.gameData.phase !== 'revealing') return;
        const players = room.players || {};
        const playerCount = Object.values(players).filter(p => p && p.name).length;
        if (playerCount < 2) {
            this.showToast('玩家不足，回到房间');
            room.status = 'waiting';
            room.gameData = null;
            saveRoom(this.currentRoomId, room);
            return;
        }

        const oldGd = room.gameData;
        const newGd = this.initGameData(players, playerCount);

        // 继承之前的标志物
        if (oldGd && oldGd.totalWrongMarkers) {
            newGd.totalWrongMarkers = { ...oldGd.totalWrongMarkers };
        }
        if (oldGd && oldGd.initMarkers) {
            newGd.initMarkers = { ...oldGd.initMarkers };
        } else {
            Object.keys(players).filter(pid => players[pid] && players[pid].name).forEach(pid => {
                newGd.initMarkers[pid] = 6;
            });
        }

        // 再次检查游戏是否应该结束（可能有人标志物为0）
        let shouldEnd = false;
        Object.keys(players).filter(pid => players[pid] && players[pid].name).forEach(pid => {
            if ((newGd.totalWrongMarkers?.[pid] || 0) >= 5) shouldEnd = true;
            if ((newGd.initMarkers?.[pid] || 0) <= 0) shouldEnd = true;
        });

        if (shouldEnd) {
            // 游戏结束，回到房间界面
            room.status = 'waiting';
            room.gameData = null;
            saveRoom(this.currentRoomId, room);
            this._resultShown = false;
            document.getElementById('result-modal').classList.add('hidden');
            this.showToast('🏁 游戏结束条件达成，返回房间');
        } else {
            // 开启新一局
            newGd.round = (oldGd?.round || 0) + 1;
            // 第一轮为随机目击者（initGameData 已实现）；从第二轮起按规则决定第一目击者：
            // 除上一轮目击者外，错误标志物最多者；并列时取距离上一轮目击者左手最近者
            if (newGd.round > 1 && oldGd) {
                this.setFirstInvestigatorByRule(oldGd, newGd);
            }
            room.status = 'playing';
            room.gameData = newGd;
            saveRoom(this.currentRoomId, room);
            this._resultShown = false;
            document.getElementById('result-modal').classList.add('hidden');
            this.showToast('🔄 进入第 ' + newGd.round + ' 轮');
        }
    },

    // 依据规则决定后续轮次的第一目击者：
    // 排除上一轮第一目击者，取错误标志物最多者；若并列，取距离上一轮目击者左手最近者。
    setFirstInvestigatorByRule(prevGd, newGd) {
        const seats = newGd.seats;
        const n = seats.length;
        const prevSeat = prevGd.firstInvestigatorSeat;
        const playerBySeat = newGd.playerBySeat;
        const wrong = newGd.totalWrongMarkers || {};

        // 左手方向 = 座位号递增方向（与传牌方向一致），求座位相对上一轮目击者的左手距离
        const prevIndex = seats.indexOf(prevSeat);
        const leftDist = (seat) => {
            const idx = seats.indexOf(seat);
            return (idx - prevIndex + n) % n;
        };

        // 候选：除上一轮目击者外的所有玩家
        const candidates = seats.filter(seat => seat !== prevSeat);

        // 先按错误标志物从多到少选；若并列，再按左手距离从小到大（越靠近左手越优先）
        let best = candidates[0];
        for (let i = 1; i < candidates.length; i++) {
            const c = candidates[i];
            const cur = (wrong[playerBySeat[c]] || 0);
            const bestVal = (wrong[playerBySeat[best]] || 0);
            if (cur > bestVal || (cur === bestVal && leftDist(c) < leftDist(best))) {
                best = c;
            }
        }

        newGd.firstInvestigatorSeat = best;
        newGd.currentPlayerSeat = best;
    },

    getPlayerName(pid, gd) {
        const players = this.currentRoomData?.players || {};
        return players[pid]?.name || pid;
    },

    showResultModal(gd, killer, details, markers, wrongMarkers, gameEnded) {
        const modal = document.getElementById('result-modal');
        const content = document.getElementById('result-modal-content');
        const players = this.currentRoomData?.players || {};
        let html = `
            <div class="result-banner ${gameEnded ? 'win' : 'lose'}" style="margin-bottom:12px;">
                ${gameEnded ? '📊 游戏结束！' : '🔪 凶手揭晓: ' + killer}
            </div>
            <div style="display:flex;flex-direction:column;gap:4px;font-size:0.9em;">
        `;
        details.forEach(d => { html += `<p style="color:var(--text-dim);">${d}</p>`; });
        html += '</div>';
        html += '<div style="border-top:1px solid #333;margin-top:8px;padding-top:8px;display:flex;flex-direction:column;gap:4px;">';
        gd.playerIds.forEach(pid => {
            const p = players[pid];
            if (!p) return;
            html += `
                <div style="display:flex;justify-content:space-between;font-size:0.9em;">
                    <span>${p.name}</span>
                    <span>🔵剩余:${markers[pid]} 🔴错误:${wrongMarkers[pid]}</span>
                </div>
            `;
        });
        html += '</div>';
        if (!gameEnded) {
            html += '<p style="text-align:center;color:var(--green);font-weight:600;margin-top:8px;">⏳ 即将自动进入下一轮...</p>';
        } else {
            html += '<p style="text-align:center;color:var(--red);font-weight:600;margin-top:8px;">🏁 游戏结束条件达成，返回房间</p>';
        }
        content.innerHTML = html;
        modal.classList.remove('hidden');
    },

    closeResultModal() {
        const gd = this.currentRoomData?.gameData;
        // 总是先关闭弹窗显示层
        document.getElementById('result-modal').classList.add('hidden');
        this._resultShown = false;
        if (!gd) {
            return;
        }
        if (gd.phase === 'gameover') {
            // 游戏已结束，回到房间界面（room 已设为 waiting）
            return;
        }
        if (gd.phase === 'revealing') {
            // 结算阶段：点确认后立即推进到下一轮（phase 变为新回合，轮询便不再重复弹窗）。
            // 由于 gd.resultConfirmed 已持久化为 true，即使推进失败也不会被轮询重新弹出。
            this.startNextRound();
        }
    },

    restartGame() {
        const room = getRoom(this.currentRoomId);
        if (!room || room.createdBy !== this.playerId) return;
        const players = room.players || {};
        const playerCount = Object.values(players).filter(p => p && p.name).length;
        if (playerCount < 2 || playerCount > 5) {
            this.showToast('需要2-5名玩家');
            return;
        }
        const oldGd = room.gameData;
        const newGd = this.initGameData(players, playerCount);
        if (oldGd && oldGd.totalWrongMarkers) {
            newGd.totalWrongMarkers = { ...oldGd.totalWrongMarkers };
        }
        if (oldGd && oldGd.initMarkers) {
            newGd.initMarkers = { ...oldGd.initMarkers };
        } else {
            Object.keys(players).filter(pid => players[pid] && players[pid].name).forEach(pid => { newGd.initMarkers[pid] = 6; });
        }
        let shouldEnd = false;
        Object.keys(players).filter(pid => players[pid] && players[pid].name).forEach(pid => {
            if ((newGd.totalWrongMarkers?.[pid] || 0) >= 5) shouldEnd = true;
            if ((newGd.initMarkers?.[pid] || 0) <= 0) shouldEnd = true;
        });
        if (shouldEnd) {
            newGd.phase = 'gameover';
            newGd.finalResult = true;
        }
        room.status = 'playing';
        room.gameData = newGd;
        saveRoom(this.currentRoomId, room);
        this._resultShown = false;
        this.showToast('新一局开始！');
    },

    showToast(msg) {
        let toast = document.querySelector('.toast');
        if (!toast) {
            toast = document.createElement('div');
            toast.className = 'toast';
            document.body.appendChild(toast);
        }
        toast.textContent = msg;
        toast.style.opacity = '1';
        clearTimeout(this._toastTimeout);
        this._toastTimeout = setTimeout(() => { toast.style.opacity = '0'; }, 2000);
    },
};

// ============ 常量 ============
const ALL_CARDS = ['2', '3', '4', '5', '6', '7', '8', 'X', 'X'];

// ============ 初始化 ============
document.addEventListener('DOMContentLoaded', () => {
    // 尝试恢复之前的身份并自动回到房间（刷新/关闭网页后重连）
    const restored = app.restoreSession();
    const savedRoom = localStorage.getItem('mm_current_room');
    if (restored && savedRoom) {
        app.playerId = localStorage.getItem('mm_player_id');
        app.playerName = localStorage.getItem('mm_player_name');
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

    // 本地模式下监听 storage 事件，实现同一浏览器多标签页的实时同步
    // （storage 事件只在【其他】标签页修改 localStorage 时触发，正是需要的跨标签通知）
    window.addEventListener('storage', (e) => {
        if (e.key !== null && !e.key.startsWith(ROOM_PREFIX)) return;
        // 当前处于房间中：刷新房间 UI / 游戏界面
        if (app.currentRoomId) {
            const room = getRoom(app.currentRoomId);
            if (!room) {
                app.currentRoomId = null;
                app.currentRoomData = null;
                app.showLobby();
                app.showToast('房间已解散');
                return;
            }
            app.currentRoomData = room;
            if (room.status === 'waiting') {
                app.showRoom();
                app.updateRoomUI();
            } else if (room.status === 'playing') {
                app.updateGameFromRoom(room);
                app.showGame();
            }
        } else {
            // 当前在大厅：刷新房间列表
            app.refreshRooms();
        }
    });
});