// ============ Firebase 配置（可选） ============
// 在 https://console.firebase.google.com 创建项目并启用 Realtime Database 后，
// 填入下方配置即可实现真正意义上的跨设备多人联机（部署到 GitHub Pages 也能用）。
// 若不填写，将自动回退到「本地模式」（仅同一浏览器多标签页可联机）。
const firebaseConfig = {
    apiKey: "AIzaSyBGNFb5Gor9Yk0-rteL3mm9HLIsH3-OPBM",
    authDomain: "murder-mystery-1aff7.firebaseapp.com",
    databaseURL: "https://murder-mystery-1aff7-default-rtdb.asia-southeast1.firebasedatabase.app",
    projectId: "murder-mystery-1aff7",
    storageBucket: "murder-mystery-1aff7.firebasestorage.app",
    messagingSenderId: "263644023144",
    appId: "1:263644023144:web:93f985237f0dcea3acaedd"
};

// ============ 数据库初始化 ============
let db = null;
let useFirebase = false;
// 内存缓存：让 getRoom/getAllRooms 可以同步返回最新数据（Firebase 读取是异步的）
let firebaseRoomsCache = {};

// 尝试以「匿名认证 + 锁定规则」的方式连接 Firebase。
// 只有配置了真实 firebaseConfig 才会启用；否则回退到本地模式。
function initFirebase() {
    // 未配置真实密钥 → 本地模式
    if (typeof firebase === 'undefined' || !firebaseConfig.apiKey || firebaseConfig.apiKey === 'YOUR_API_KEY') {
        console.log('✅ 本地模式已启动（仅同一浏览器多标签页可联机，配置 Firebase 后支持跨设备）');
        return;
    }
    try {
        firebase.initializeApp(firebaseConfig);
        // 先匿名登录，认证成功后才具备数据库读写权限（配合锁定模式规则 auth != null）
        firebase.auth().signInAnonymously()
            .then(() => {
                db = firebase.database();
                useFirebase = true;
                console.log('✅ Firebase 已连接（匿名认证成功，支持跨设备联机）');
                initFirebaseListener();
                // 认证完成后刷新一次房间列表
                if (app && typeof app.refreshRooms === 'function') {
                    app.refreshRooms();
                }
            })
            .catch((err) => {
                console.warn('Firebase 匿名认证失败，使用本地模式', err);
            });
    } catch (e) {
        console.warn('Firebase 初始化失败，使用本地模式', e);
    }
}

// ============ 数据层（统一接口，支持 Firebase / 本地双后端） ============
const ROOM_PREFIX = 'mm_room_';
const ROOM_COLLECTION = 'rooms';

function saveRoom(roomId, roomData) {
    if (useFirebase && db) {
        firebaseRoomsCache[roomId] = roomData;
        db.ref(ROOM_COLLECTION + '/' + roomId).set(roomData).catch(e => console.warn('Firebase 写入失败', e));
    } else {
        localStorage.setItem(ROOM_PREFIX + roomId, JSON.stringify(roomData));
        // 通过 BroadcastChannel 通知同浏览器其他标签页（携带完整数据，解决 file:// 下 localStorage 隔离问题）
        broadcastChannelPost({ type: 'room-data', roomId, roomData });
    }
}

function getRoom(roomId) {
    if (useFirebase && db) {
        return firebaseRoomsCache[roomId] || null;
    }
    const data = localStorage.getItem(ROOM_PREFIX + roomId);
    return data ? JSON.parse(data) : null;
}

function getAllRooms() {
    if (useFirebase && db) {
        return { ...firebaseRoomsCache };
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
    if (useFirebase && db) {
        delete firebaseRoomsCache[roomId];
        db.ref(ROOM_COLLECTION + '/' + roomId).remove().catch(e => console.warn('Firebase 删除失败', e));
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

// 订阅 Firebase 根节点，实时同步所有房间到本地缓存
function initFirebaseListener() {
    if (!useFirebase || !db) return;
    db.ref(ROOM_COLLECTION).on('value', (snap) => {
        firebaseRoomsCache = snap.val() || {};
    });
}

// 尝试初始化 Firebase（匿名认证成功后自动建立监听）
initFirebase();

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
        sessionStorage.setItem('mm_player_id', this.playerId);
        sessionStorage.setItem('mm_player_name', this.playerName);
        this.showLobby();
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
        sessionStorage.removeItem('mm_player_id');
        sessionStorage.removeItem('mm_player_name');
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
                <div class="room-item" onclick="app.joinRoom('${id}')">
                    <div class="room-info">
                        <span class="room-name">${room.name || '未命名房间'}</span>
                        <span class="room-meta">玩家：${playerNames}</span>
                    </div>
                    <span style="color:var(--text-dim);font-size:0.9em;">${activePlayers.length}/5</span>
                </div>
            `;
        }).join('');
    },

    createRoom() {
        if (!this.playerName) return;
        const roomId = 'room_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);
        const roomData = {
            name: `${this.playerName} 的房间`,
            status: 'waiting',
            createdBy: this.playerId,
            createdAt: Date.now(),
            players: {},
            gameData: null
        };
        saveRoom(roomId, roomData);
        this.currentRoomId = roomId;
        this.joinRoom(roomId);
    },

    joinRoom(roomId) {
        if (!this.playerName || !this.playerId) return;
        const room = getRoom(roomId);
        if (!room) {
            this.showToast('房间不存在');
            return;
        }
        if (room.status !== 'waiting') {
            this.showToast('游戏已开始，无法加入');
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
            joinedAt: Date.now()
        };
        room.players = room.players || {};
        room.players[this.playerId] = playerData;
        saveRoom(roomId, room);
        this.currentRoomId = roomId;
        this.listenToRoom(roomId);
        this.showRoom();
        this.showToast('已加入房间，座位 #' + (seat + 1));
    },

    listenToRoom(roomId) {
        const checkRoom = () => {
            const room = getRoom(roomId);
            if (!room) {
                this.currentRoomId = null;
                this.currentRoomData = null;
                this.showLobby();
                this.showToast('房间已解散');
                return;
            }
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
        document.getElementById('room-code-display').textContent = `房间ID: ${this.currentRoomId}`;

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
        if (this.roomListener) {
            clearInterval(this.roomListener);
            this.roomListener = null;
        }
        this.currentRoomId = null;
        this.currentRoomData = null;
        this.mySeat = -1;
        this.gamePhase = 'idle';
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
        const gd = room.gameData;
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

        // 结算结果展示后，所有标签页都会通过轮询检测到时间点并协同开启下一轮。
        // 必须先处理自动推进：时间一到就进入新一局（phase 离开 revealing），
        // 避免停留在结算阶段反复弹窗（无限循环）。
        if (gd.phase === 'revealing' && gd.autoNextAt && Date.now() >= gd.autoNextAt) {
            this.startNextRound();
            return;
        }
        // 让所有玩家都能看到结算结果（不只有触发结算的那位）。
        // 用持久化的 gd.resultConfirmed 标记「本局结算弹窗是否已展示」，避免用内存变量导致反复弹出。
        if ((gd.phase === 'revealing' || gd.phase === 'gameover') &&
            gd.resultDetails && !gd.resultConfirmed) {
            gd.resultConfirmed = true;
            saveRoom(this.currentRoomId, room);
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
        if (this.localHand) {
            handDisplay.textContent = this.localHand;
            handDisplay.style.color = this.localHand === 'X' ? 'var(--red)' : '#fff';
            hint.textContent = this.localOriginalCard ? `原始牌: ${this.localOriginalCard}` : '';
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
        gd.seenHand[this.playerId] = true;
        saveRoom(this.currentRoomId, room);
        const allSeen = gd.playerIds.every(pid => gd.seenHand[pid]);
        if (allSeen) {
            this.passCards(room);
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
        saveRoom(this.currentRoomId, room);
        const allVoted = gd.playerIds.every(pid => gd.hasVoted[pid]);
        if (allVoted) {
            this.enterRevealPhase(gd);
        } else {
            const seats = gd.seats;
            const n = seats.length;
            const myIndex = seats.indexOf(mySeat);
            const nextSeat = seats[(myIndex + 1) % n];
            gd.currentPlayerSeat = nextSeat;
            saveRoom(this.currentRoomId, room);
        }
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
            // 游戏结束 → 回到房间等待界面
            gd.phase = 'gameover';
            gd.finalResult = true;
            room.status = 'waiting';
            room.gameData = null;
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
            gd.autoNextAt = Date.now() + 2000;
            saveRoom(this.currentRoomId, room);
            this._resultShown = true;
            this.showResultModal(gd, killer, resultDetails, initMarkers, totalWrongMarkers, false);
        }
    },

    startNextRound() {
        const room = getRoom(this.currentRoomId);
        if (!room) return;
        // 只在结算阶段触发；phase 离开 revealing 后（下一轮已建立）不再重复推进
        if (!room.gameData || room.gameData.phase !== 'revealing') return;
        // 并发保护：标记「正在推进」，避免多个标签页同时创建新一局相互覆盖。
        // 新一局是新对象，不含此标记，因此不影响后续轮次。
        if (room.gameData.autoNextStarted) return;
        room.gameData.autoNextStarted = true;
        saveRoom(this.currentRoomId, room);
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
    app.showLogin();
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