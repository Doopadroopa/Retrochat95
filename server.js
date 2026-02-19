const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: { origin: "*", methods: ["GET", "POST"], credentials: true },
    pingTimeout: 60000,
    pingInterval: 25000
});

const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.static(__dirname));
app.use(express.json());

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/health', (req, res) => res.json({ status: 'OK', version: '1.0.0', uptime: process.uptime() }));

// ======================== DATABASE ========================

const DB_PATH = process.env.DATABASE_PATH || './arabiac.db';
let db;

function initDatabase() {
    return new Promise((resolve, reject) => {
        db = new sqlite3.Database(DB_PATH, (err) => {
            if (err) { console.error('[DB] Failed:', err); reject(err); }
            else { console.log('[DB] Connected'); createTables().then(resolve).catch(reject); }
        });
    });
}

function createTables() {
    return new Promise((resolve, reject) => {
        db.serialize(() => {
            db.run(`CREATE TABLE IF NOT EXISTS users (
                username TEXT PRIMARY KEY, password TEXT, color TEXT DEFAULT '#c9a227',
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                last_login DATETIME DEFAULT CURRENT_TIMESTAMP,
                total_messages INTEGER DEFAULT 0
            )`);
            db.run(`CREATE TABLE IF NOT EXISTS achievements (
                id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL,
                achievement TEXT NOT NULL, unlocked_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(username, achievement)
            )`);
            db.run(`CREATE TABLE IF NOT EXISTS messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT, room TEXT NOT NULL,
                username TEXT NOT NULL, color TEXT, message TEXT NOT NULL,
                message_type TEXT DEFAULT 'normal', timestamp TEXT NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )`);
            db.run(`CREATE TABLE IF NOT EXISTS reactions (
                id INTEGER PRIMARY KEY AUTOINCREMENT, message_id INTEGER NOT NULL,
                username TEXT NOT NULL, reaction TEXT NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(message_id, username, reaction)
            )`, (err) => { if (err) reject(err); else resolve(); });
        });
    });
}

// ======================== DATA ========================

let connectedUsers = {};
let rooms = {
    'general': { users: [], topic: 'General discussion' },
    'random': { users: [], topic: 'Random stuff & fun' },
    'media': { users: [], topic: 'Share images & media' },
    'lounge': { users: [], topic: 'Chill & hang out' }
};

const BANNED_WORDS = [
    'nigger','nigga','n1gger','n1gga','nig','nigg','n!gger','n!gga',
    'faggot','fag','f4ggot','f4g','f@ggot','f@g',
    'retard','retarded','r3tard','r3tarded',
    'tranny','tr4nny','tr@nny',
    'chink','ch1nk','spic','sp1c','kike','k1ke',
    'coon','c00n','beaner','wetback','gook','g00k','raghead','towelhead'
];

const IMAGE_KEYWORDS = {
    'dog': 'https://raw.githubusercontent.com/Doopadroopa/retrochatemotes/refs/heads/main/2-20933_cute-puppies-png-background-havanese-dog.png',
    'cat': 'https://raw.githubusercontent.com/Doopadroopa/retrochatemotes/refs/heads/main/cat.png',
    'lol': 'https://raw.githubusercontent.com/Doopadroopa/retrochatemotes/refs/heads/main/laugh.png',
    'cool': 'https://raw.githubusercontent.com/Doopadroopa/retrochatemotes/refs/heads/main/Derp-face.png',
    'fire': 'https://raw.githubusercontent.com/Doopadroopa/retrochatemotes/refs/heads/main/pixel-art-fire-icon-png.png'
};

// ======================== UTILS ========================

function getCurrentTime() {
    const n = new Date();
    return `${String(n.getHours()).padStart(2,'0')}:${String(n.getMinutes()).padStart(2,'0')}`;
}

function containsBannedWord(text) {
    const clean = text.toLowerCase().replace(/[^a-z0-9]/g, '');
    return BANNED_WORDS.some(w => clean.includes(w.replace(/[^a-z0-9]/g, '')));
}

function sanitize(text) { return text.replace(/[<>]/g, '').trim(); }

function getRoomUserList(roomName) {
    return rooms[roomName].users.map(username => {
        const sid = Object.keys(connectedUsers).find(id => connectedUsers[id].username === username);
        return {
            username,
            status: sid ? connectedUsers[sid].status : 'Online',
            color: sid ? connectedUsers[sid].color : '#c9a227'
        };
    });
}

// ======================== DB HELPERS ========================

function saveMessage(room, username, color, message, type, timestamp) {
    return new Promise((resolve, reject) => {
        db.run('INSERT INTO messages (room,username,color,message,message_type,timestamp) VALUES (?,?,?,?,?,?)',
            [room, username, color, message, type, timestamp], function(err) {
                if (err) reject(err);
                else {
                    db.run(`DELETE FROM messages WHERE room=? AND id NOT IN (SELECT id FROM messages WHERE room=? ORDER BY id DESC LIMIT 100)`, [room, room]);
                    resolve(this.lastID);
                }
            });
    });
}

function loadHistory(room) {
    return new Promise((resolve, reject) => {
        db.all('SELECT * FROM messages WHERE room=? ORDER BY id DESC LIMIT 100', [room], (err, rows) => {
            if (err) reject(err); else resolve(rows.reverse());
        });
    });
}

function createUser(username, password, color) {
    return new Promise((resolve, reject) => {
        db.run('INSERT INTO users (username,password,color) VALUES (?,?,?)', [username, password||'', color],
            function(err) { if (err) reject(err); else resolve(true); });
    });
}

function getUser(username) {
    return new Promise((resolve, reject) => {
        db.get('SELECT * FROM users WHERE username=?', [username], (err, row) => {
            if (err) reject(err); else resolve(row);
        });
    });
}

function updateLogin(u) { db.run('UPDATE users SET last_login=CURRENT_TIMESTAMP WHERE username=?', [u]); }
function incMessages(u) { db.run('UPDATE users SET total_messages=total_messages+1 WHERE username=?', [u]); }

function getAchievements(username) {
    return new Promise((resolve, reject) => {
        db.all('SELECT achievement FROM achievements WHERE username=?', [username], (err, rows) => {
            if (err) reject(err); else resolve(rows.map(r => r.achievement));
        });
    });
}

function unlockAchievement(username, achievement) {
    return new Promise((resolve, reject) => {
        db.run('INSERT OR IGNORE INTO achievements (username,achievement) VALUES (?,?)',
            [username, achievement], function(err) {
                if (err) reject(err); else resolve(this.changes > 0);
            });
    });
}

// ======================== SOCKET.IO ========================

io.on('connection', (socket) => {
    console.log(`[+] ${socket.id}`);

    connectedUsers[socket.id] = {
        username: null, color: '#c9a227', status: 'Online', room: 'general',
        messageCount: 0, joinTime: Date.now(), isGuest: false,
        roomsVisited: ['general'], lastMessageTime: 0
    };

    // ---- LOGIN ----
    socket.on('user-login', async (data) => {
        try {
            let { username, color, password, isGuest } = data;
            let finalUsername = sanitize(username || '');

            if (isGuest) {
                finalUsername = `Guest${Math.floor(Math.random() * 9999)}`;
                connectedUsers[socket.id].username = finalUsername;
                connectedUsers[socket.id].color = color || '#c9a227';
                connectedUsers[socket.id].isGuest = true;
            } else {
                if (!finalUsername || finalUsername.length < 2) {
                    socket.emit('login-error', 'Username must be at least 2 characters'); return;
                }
                const alreadyOn = Object.values(connectedUsers).find(u => u.username === finalUsername);
                if (alreadyOn) { socket.emit('login-error', 'Username already logged in'); return; }

                const existing = await getUser(finalUsername);
                if (!existing) {
                    await createUser(finalUsername, password, color);
                    connectedUsers[socket.id].username = finalUsername;
                    connectedUsers[socket.id].color = color;
                } else {
                    if (existing.password && password !== existing.password) {
                        socket.emit('login-error', 'Invalid password'); return;
                    }
                    connectedUsers[socket.id].username = finalUsername;
                    connectedUsers[socket.id].color = existing.color;
                    const achs = await getAchievements(finalUsername);
                    socket.emit('achievements-update', achs);
                }
                updateLogin(finalUsername);
            }

            socket.emit('login-success', {
                username: connectedUsers[socket.id].username,
                color: connectedUsers[socket.id].color,
                isGuest: connectedUsers[socket.id].isGuest
            });

            await joinRoom(socket, 'general', connectedUsers[socket.id].username);
        } catch (e) {
            console.error('[ERR] Login:', e);
            socket.emit('login-error', 'Login failed');
        }
    });

    // ---- JOIN ROOM ----
    async function joinRoom(socket, roomName, username) {
        try {
            socket.join(roomName);
            connectedUsers[socket.id].room = roomName;
            if (!rooms[roomName].users.includes(username)) rooms[roomName].users.push(username);
            if (!connectedUsers[socket.id].roomsVisited.includes(roomName))
                connectedUsers[socket.id].roomsVisited.push(roomName);

            const msgs = await loadHistory(roomName);
            socket.emit('message-history', msgs);
            io.to(roomName).emit('users-update', getRoomUserList(roomName));
            io.to(roomName).emit('user-joined', { username });
        } catch (e) { console.error('[ERR] Join:', e); }
    }

    // ---- CHAT MESSAGE ----
    socket.on('chat-message', async (data) => {
        try {
            const user = connectedUsers[socket.id];
            if (!user || !user.username) return;
            const message = sanitize(data.message);
            if (!message) return;

            if (message.startsWith('/')) { await handleCommand(socket, message, user); return; }

            const now = Date.now();
            if (user.lastMessageTime && now - user.lastMessageTime < 500) {
                socket.emit('command-error', 'Slow down!'); return;
            }
            user.lastMessageTime = now;

            if (containsBannedWord(message)) {
                socket.emit('message-blocked', 'Message blocked: inappropriate language.'); return;
            }

            const kwMatch = message.match(/^!(\w+)$/);
            if (kwMatch && IMAGE_KEYWORDS[kwMatch[1]]) {
                io.to(user.room).emit('image-keyword', {
                    username: user.username, color: user.color,
                    imageUrl: IMAGE_KEYWORDS[kwMatch[1]], timestamp: data.timestamp
                });
                await saveMessage(user.room, user.username, user.color, `!${kwMatch[1]}`, 'image', data.timestamp);
                if (!user.isGuest) incMessages(user.username);
                return;
            }

            io.to(user.room).emit('chat-message', {
                username: user.username, color: user.color, message,
                timestamp: data.timestamp, status: user.status
            });
            await saveMessage(user.room, user.username, user.color, message, 'normal', data.timestamp);
            user.messageCount++;
            if (!user.isGuest) { incMessages(user.username); await checkAchievements(socket, user); }
        } catch (e) { console.error('[ERR] Msg:', e); }
    });

    // ---- COMMANDS ----
    async function handleCommand(socket, message, user) {
        const parts = message.split(' ');
        const cmd = parts[0].toLowerCase();
        const room = user.room;

        try {
            switch (cmd) {
                case '/me': {
                    const action = parts.slice(1).join(' ');
                    if (!action) { socket.emit('command-error', 'Usage: /me <action>'); return; }
                    io.to(room).emit('action-message', {
                        username: user.username, color: user.color, action, timestamp: getCurrentTime()
                    });
                    await saveMessage(room, user.username, user.color, action, 'action', getCurrentTime());
                    break;
                }
                case '/nick': {
                    const name = sanitize(parts[1] || '');
                    if (!name || name.length < 2 || name.length > 20) {
                        socket.emit('command-error', 'Usage: /nick <name> (2-20 chars)'); return;
                    }
                    if (!user.isGuest) { socket.emit('command-error', 'Only guests can change names'); return; }
                    const old = user.username;
                    user.username = name;
                    rooms[room].users = rooms[room].users.map(u => u === old ? name : u);
                    io.to(room).emit('system-message', { text: `${old} → ${name}` });
                    io.to(room).emit('users-update', getRoomUserList(room));
                    socket.emit('login-success', { username: name, color: user.color, isGuest: true });
                    break;
                }
                case '/color': {
                    const c = parts[1];
                    if (!c || !c.match(/^#[0-9A-Fa-f]{6}$/)) {
                        socket.emit('command-error', 'Usage: /color #RRGGBB'); return;
                    }
                    user.color = c;
                    socket.emit('color-changed', c);
                    socket.emit('system-message', { text: 'Color updated!' });
                    break;
                }
                case '/clear':
                    socket.emit('clear-chat');
                    break;
                case '/status': {
                    const s = parts[1];
                    if (!['Online','Away','Busy'].includes(s)) {
                        socket.emit('command-error', 'Usage: /status [Online|Away|Busy]'); return;
                    }
                    user.status = s;
                    io.to(room).emit('users-update', getRoomUserList(room));
                    socket.emit('system-message', { text: `Status: ${s}` });
                    break;
                }
                case '/join': {
                    const nr = parts[1];
                    if (!nr || !rooms[nr]) {
                        socket.emit('command-error', 'Rooms: general, random, media, lounge'); return;
                    }
                    if (nr === room) { socket.emit('command-error', 'Already here!'); return; }
                    socket.leave(room);
                    rooms[room].users = rooms[room].users.filter(u => u !== user.username);
                    io.to(room).emit('users-update', getRoomUserList(room));
                    io.to(room).emit('user-left', { username: user.username });
                    await joinRoom(socket, nr, user.username);
                    socket.emit('room-changed', nr);
                    break;
                }
                case '/msg': {
                    const target = sanitize(parts[1] || '');
                    const pm = parts.slice(2).join(' ');
                    if (!target || !pm) { socket.emit('command-error', 'Usage: /msg <user> <message>'); return; }
                    const tid = Object.keys(connectedUsers).find(id => connectedUsers[id].username === target);
                    if (!tid) { socket.emit('command-error', `User '${target}' not found`); return; }
                    io.to(tid).emit('private-message', {
                        from: user.username, message: pm, color: user.color, timestamp: getCurrentTime()
                    });
                    socket.emit('private-message-sent', { to: target, message: pm });
                    if (!user.isGuest) {
                        const achs = await getAchievements(user.username);
                        if (!achs.includes('socialite')) {
                            const ok = await unlockAchievement(user.username, 'socialite');
                            if (ok) socket.emit('achievement-unlocked', { title: 'Socialite', description: 'Sent a private message' });
                        }
                    }
                    break;
                }
                case '/help':
                    socket.emit('system-message', {
                        text: 'Commands: /me, /nick, /color, /clear, /status, /join, /msg, /help — Image keywords: !dog !cat !lol !cool !fire'
                    });
                    break;
                default:
                    socket.emit('command-error', `Unknown: ${cmd}`);
            }
        } catch (e) { console.error('[ERR] Cmd:', e); }
    }

    // ---- ACHIEVEMENTS ----
    async function checkAchievements(socket, user) {
        if (user.isGuest) return;
        try {
            const achs = await getAchievements(user.username);
            const ud = await getUser(user.username);
            if (!ud) return;

            const checks = [
                { id: 'first-message', title: 'First Message!', desc: 'Sent your first message', cond: user.messageCount >= 1 },
                { id: 'chatty', title: 'Chatty', desc: 'Sent 10 messages', cond: ud.total_messages >= 10 },
                { id: 'super-chatty', title: 'Super Chatty', desc: 'Sent 50 messages', cond: ud.total_messages >= 50 },
                { id: 'chatterbox', title: 'Chatterbox', desc: 'Sent 100 messages', cond: ud.total_messages >= 100 },
                { id: 'veteran', title: 'Veteran', desc: '30 minutes online', cond: (Date.now() - user.joinTime) >= 30*60*1000 },
                { id: 'room-hopper', title: 'Room Hopper', desc: 'Visited all rooms', cond: user.roomsVisited.length >= 4 }
            ];

            for (const c of checks) {
                if (!achs.includes(c.id) && c.cond) {
                    const ok = await unlockAchievement(user.username, c.id);
                    if (ok) socket.emit('achievement-unlocked', { title: c.title, description: c.desc });
                }
            }
        } catch (e) { console.error('[ERR] Ach:', e); }
    }

    // ---- IMAGE UPLOAD ----
    socket.on('image-upload', async (data) => {
        const user = connectedUsers[socket.id];
        if (!user || !user.username) return;
        io.to(user.room).emit('image-message', {
            username: user.username, color: user.color,
            imageData: data.imageData, timestamp: data.timestamp
        });
        await saveMessage(user.room, user.username, user.color, '[Image]', 'image', data.timestamp);
        if (!user.isGuest) {
            const achs = await getAchievements(user.username);
            if (!achs.includes('image-poster')) {
                const ok = await unlockAchievement(user.username, 'image-poster');
                if (ok) socket.emit('achievement-unlocked', { title: 'Picture Perfect', description: 'Posted an image' });
            }
        }
    });

    // ---- TYPING ----
    socket.on('typing', () => {
        const u = connectedUsers[socket.id];
        if (u && u.username) socket.broadcast.to(u.room).emit('user-typing', { username: u.username });
    });
    socket.on('stop-typing', () => {
        const u = connectedUsers[socket.id];
        if (u && u.username) socket.broadcast.to(u.room).emit('user-stop-typing');
    });

    // ---- REACTIONS ----
    socket.on('add-reaction', (data) => {
        const u = connectedUsers[socket.id];
        if (!u || !u.username) return;
        io.to(u.room).emit('reaction-added', { messageId: data.messageId, username: u.username, reaction: data.reaction });
    });

    // ---- DISCONNECT ----
    socket.on('disconnect', () => {
        const user = connectedUsers[socket.id];
        if (user && user.username) {
            rooms[user.room].users = rooms[user.room].users.filter(u => u !== user.username);
            io.to(user.room).emit('user-left', { username: user.username });
            io.to(user.room).emit('users-update', getRoomUserList(user.room));
            console.log(`[-] ${user.username}`);
        }
        delete connectedUsers[socket.id];
    });
});

// ======================== START ========================

async function startServer() {
    try {
        await initDatabase();
        server.listen(PORT, () => {
            console.log(`\n  Arabiac v1.0.0\n  Port: ${PORT}\n  Status: ONLINE\n`);
        });
    } catch (e) { console.error('[FATAL]', e); process.exit(1); }
}

process.on('SIGINT', () => { db.close(() => process.exit(0)); });
process.on('SIGTERM', () => { db.close(() => process.exit(0)); });

startServer();
