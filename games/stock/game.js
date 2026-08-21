// ============ 股票风云（本地版，后续接入联机） ============

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

// ---------- 数据层（本地版：localStorage + BroadcastChannel） ----------
const ROOM_PREFIX = 'stock_room_';
let broadcastChannel = null;
let broadcastRoomsCache = {};

// 生成房间
function makeRoomId() { return 'stock_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6); }

function saveRoom(roomId, roomData) {
    localStorage.setItem(ROOM_PREFIX + roomId, JSON.stringify(roomData));
    broadcastPost({ type: 'room-data', roomId, roomData });
}
function getRoom(roomId) {
    const data = localStorage.getItem(ROOM_PREFIX + roomId);
    return data ? JSON.parse(data) : null;
}
function getAllRooms() {
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
    localStorage.removeItem(ROOM_PREFIX + roomId);
    broadcastPost({ type: 'room-deleted', roomId });
    if (broadcastRoomsCache) delete broadcastRoomsCache[roomId];
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
        // 不支持 BroadcastChannel 时退化为只靠 storage 事件
        window.addEventListener('storage', (e) => {
            if (e.key && e.key.startsWith(ROOM_PREFIX)) {
                app.refreshRooms();
            }
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
            money: INITIAL_MONEY
        };
        saveRoom(roomId, room);
        this.currentRoomId = roomId;
        localStorage.setItem('stock_current_room', roomId);
        this.currentRoomData = room;
        this.showRoom();
        this.showToast('已加入房间');
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
        // 随机移除5张
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
        return {
            phase: 'play',          // play: 进行中, score: 结算
            seats: seats,
            seatOrder: seats,
            currentPlayerSeat: seats[0],
            players: playersObj,    // 存 seat -> playerData（含 money）
            hands: hands,           // seat -> [卡牌]
            deck: deck,             // 剩余牌库
            market: [],             // 市场：{company, investMoney, owner}
            invested: {},           // seat -> { company: count }
            majorHolder: {},        // company -> seat（大股东）
            turnStep: 'draw',       // 'draw': 需抽牌, 'play': 需打牌
            turnCount: 0,
            history: []
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

        // 回合信息
        const cur = this.getSeatPlayer(gd.currentPlayerSeat);
        const isMyTurn = gd.currentPlayerSeat === mySeat;
        document.getElementById('turn-info').textContent = isMyTurn ? '轮到你了' : `等待 ${cur ? cur.name : ''}...`;

        // 资金
        const me = this.getSeatPlayer(mySeat);
        document.getElementById('money-bar').textContent = `💰 我的资金：${me ? me.money : 0}`;

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

        // 市场
        const marketArea = document.getElementById('market-area');
        if (gd.market.length === 0) {
            marketArea.innerHTML = '<h3>市场（空）</h3><p style="color:var(--text-dim);">市场暂无卡牌</p>';
        } else {
            marketArea.innerHTML = '<h3>市场</h3>' + gd.market.map((mc, idx) => `
                <div class="market-card" onclick="app.actionTakeMarket(${idx})">
                    <div class="company-num">${mc.company}</div>
                    <div class="invest-count">💰${mc.investMoney}</div>
                </div>
            `).join('');
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
                // 抽牌阶段：必须二选一；市场没牌时只能抽牌库
                const marketEmpty = !gd.market || gd.market.length === 0;
                actionArea.innerHTML = `
                    <div style="width:100%;margin-bottom:6px;color:var(--gold);">① 请先抽一张牌</div>
                    <button class="action-btn" onclick="app.actionDrawFromDeck()">🃏 从牌库抽牌</button>
                    ${marketEmpty ? '' : '<button class="action-btn" onclick="app.actionDrawFromMarket()">📊 从市场拿牌</button>'}
                `;
            } else if (gd.turnStep === 'play') {
                // 打牌阶段：选一张手牌，再打出/投资
                if (this.selectedHandCard < 0) {
                    actionArea.innerHTML = `
                        <div style="width:100%;margin-bottom:6px;color:var(--gold);">② 请选择一张手牌打出或投资</div>
                    `;
                } else {
                    const card = gd.hands[mySeat][this.selectedHandCard];
                    actionArea.innerHTML = `
                        <div style="width:100%;margin-bottom:6px;color:var(--gold);">选中：公司${card} 的牌</div>
                        <button class="action-btn" onclick="app.actionPlayToMarket()">📤 打出到市场</button>
                        <button class="action-btn" onclick="app.actionInvest()">🏢 投资到面前</button>
                        <button class="action-btn" onclick="app.selectedHandCard=-1;app.renderGame()">取消</button>
                    `;
                }
            }
        } else {
            actionArea.innerHTML = '';
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
        playSfx('draw');
        this.afterDraw();
        saveRoom(this.currentRoomId, room);
        this.renderGame();
        this.showToast(`抽到公司${card}的牌${cost > 0 ? '，支付市场投资' + cost + '元' : ''}`);
    },

    // ===== 抽牌：从市场明拿 =====
    actionDrawFromMarket() {
        const room = this.currentRoomData;
        const gd = room.gameData;
        const mySeat = this.getSeatByPid(this.playerId);
        if (gd.currentPlayerSeat !== mySeat) return;
        if (gd.market.length === 0) { this.showToast('市场没有牌'); return; }
        const mc = gd.market[0];
        // 大股东限制：不能拿自己是大股东的公司的牌
        if (gd.majorHolder[mc.company] === mySeat) { this.showToast('你是该公司的股东，不能拿'); return; }
        gd.hands[mySeat].push(mc.company);
        this.getSeatPlayer(mySeat).money += mc.investMoney;
        gd.market.shift();
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
        gd.hands[mySeat].splice(this.selectedHandCard, 1);
        gd.market.push({ company: card, investMoney: 0 });
        playSfx('play');
        this.checkAllMajorHolders();   // 打牌后结算所有公司大股东
        this.endTurn();
        saveRoom(this.currentRoomId, room);
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
        playSfx('invest');
        this.checkAllMajorHolders();   // 打牌后结算所有公司大股东
        this.endTurn();
        saveRoom(this.currentRoomId, room);
    },

    // 结算所有公司的大股东
    checkAllMajorHolders() {
        COMPANIES.forEach(num => {
            let maxCount = 0, holderSeat = null, tie = false;
            this.currentRoomData.gameData.seats.forEach(seat => {
                const count = (this.currentRoomData.gameData.invested[seat] && this.currentRoomData.gameData.invested[seat][num]) || 0;
                if (count > maxCount) { maxCount = count; holderSeat = seat; tie = false; }
                else if (count === maxCount && count > 0) { tie = true; }
            });
            const prev = this.currentRoomData.gameData.majorHolder[num];
            // 平手时清空大股东；否则更新
            const newHolder = (tie || maxCount === 0) ? null : holderSeat;
            if (prev !== newHolder) {
                this.currentRoomData.gameData.majorHolder[num] = newHolder;
                if (newHolder !== null) {
                    this.showToast(`公司${num}大股东：${this.getSeatPlayer(newHolder).name}`);
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
        // 所有玩家把剩余手牌投资到面前
        gd.seats.forEach(seat => {
            const hand = gd.hands[seat] || [];
            gd.invested[seat] = gd.invested[seat] || {};
            hand.forEach(card => {
                gd.invested[seat][card] = (gd.invested[seat][card] || 0) + 1;
            });
            gd.hands[seat] = [];
        });
        // 各公司结算（从5到10）
        const money = {};
        gd.seats.forEach(seat => { money[seat] = this.getSeatPlayer(seat).money; });
        COMPANIES.forEach(num => {
            let maxCount = 0, holderSeat = null, tie = false;
            gd.seats.forEach(seat => {
                const count = (gd.invested[seat] && gd.invested[seat][num]) || 0;
                if (count > maxCount) { maxCount = count; holderSeat = seat; tie = false; }
                else if (count === maxCount && count > 0) { tie = true; }
            });
            if (holderSeat !== null && !tie && maxCount > 0) {
                // 其他持有者支付给大股东
                gd.seats.forEach(seat => {
                    if (seat === holderSeat) return;
                    const count = (gd.invested[seat] && gd.invested[seat][num]) || 0;
                    if (count > 0) {
                        money[seat] -= count;
                        money[holderSeat] += count;
                    }
                });
            }
            // 平手：所有玩家均无需支付
        });
        // 保存最终资金
        gd.seats.forEach(seat => { this.getSeatPlayer(seat).money = money[seat]; });
        gd.phase = 'score';
        gd.scores = money;
        saveRoom(this.currentRoomId, room);
        playSfx('score');
        this.showResult();
    },

    // 显示结算
    showResult() {
        const room = this.currentRoomData;
        const gd = room.gameData;
        const content = document.getElementById('result-content');
        const sorted = [...gd.seats].sort((a, b) => gd.scores[b] - gd.scores[a]);
        content.innerHTML = '<h3>最终资金</h3>' + sorted.map((seat, i) => {
            const p = this.getSeatPlayer(seat);
            return `<div style="padding:6px 0;border-bottom:1px solid var(--border);">
                ${i+1}. ${p.name}：💰 ${gd.scores[seat]}
            </div>`;
        }).join('');
        document.getElementById('result-modal').classList.remove('hidden');
    },

    closeResult() {
        document.getElementById('result-modal').classList.add('hidden');
        // 结算后回到房间（本地版简化：重置房间为等待）
        const room = this.currentRoomData;
        if (room) {
            room.status = 'waiting';
            room.gameData = null;
            saveRoom(this.currentRoomId, room);
        }
        this.showRoom();
    }
};

// ---------- 初始化 ----------
initBroadcastChannel();
document.addEventListener('DOMContentLoaded', () => {
    app.showLogin();
    document.getElementById('name-input').addEventListener('keypress', (e) => {
        if (e.key === 'Enter') app.login();
    });
});
