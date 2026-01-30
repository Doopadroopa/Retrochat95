// ============================================================================
// RETROCHAT95 v1.0 - ULTIMATE EDITION
// Complete Server Rewrite with Bug Fixes and Game Support
// ============================================================================

const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const app = express();
const server = http.createServer(app);

const io = socketIo(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"],
        credentials: true
    },
    pingTimeout: 60000,
    pingInterval: 25000
});

const PORT = process.env.PORT || 3000;

app.use(express.static(__dirname));
app.use(express.json());

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/health', (req, res) => {
    res.json({ 
        status: 'OK', 
        version: '1.0-ULTIMATE', 
        uptime: process.uptime(),
        users: Object.keys(connectedUsers).length
    });
});

// ============================================================================
// DATABASE
// ============================================================================

const DB_PATH = process.env.DATABASE_PATH || './retrochat95.db';
let db;

function initDatabase() {
    return new Promise((resolve, reject) => {
        db = new sqlite3.Database(DB_PATH, (err) => {
            if (err) {
                console.error('[DATABASE] Connection failed:', err);
                reject(err);
            } else {
                console.log('[DATABASE] Connected:', DB_PATH);
                createTables().then(resolve).catch(reject);
            }
        });
    });
}

function createTables() {
    return new Promise((resolve) => {
        db.serialize(() => {
            db.run(`CREATE TABLE IF NOT EXISTS users (
                username TEXT PRIMARY KEY,
                password TEXT,
                color TEXT DEFAULT '#ff00ff',
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                last_login DATETIME DEFAULT CURRENT_TIMESTAMP,
                total_messages INTEGER DEFAULT 0
            )`);

            db.run(`CREATE TABLE IF NOT EXISTS achievements (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT NOT NULL,
                achievement TEXT NOT NULL,
                unlocked_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(username, achievement)
            )`);

            db.run(`CREATE TABLE IF NOT EXISTS messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                room TEXT NOT NULL,
                username TEXT NOT NULL,
                color TEXT,
                message TEXT NOT NULL,
                message_type TEXT DEFAULT 'normal',
                timestamp TEXT NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )`);

            db.run(`CREATE TABLE IF NOT EXISTS game_scores (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT NOT NULL,
                game TEXT NOT NULL,
                score INTEGER NOT NULL,
                achieved_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )`);

            console.log('[DATABASE] Tables initialized');
            resolve();
        });
    });
}

// ============================================================================
// DATA
// ============================================================================

let connectedUsers = {};
let rooms = {
    'general': { users: [], topic: 'General Discussion' },
    'random': { users: [], topic: 'Random Chat' },
    'images': { users: [], topic: 'Share Images' },
    'windows': { users: [], topic: 'Windows 95 Nostalgia' }
};

const BANNED_WORDS = [
    'nigger', 'nigga', 'n1gger', 'n1gga', 'nig', 'nigg',
    'faggot', 'fag', 'f4ggot', 'f4g', 'f@ggot',
    'retard', 'retarded', 'r3tard', 'r3tarded',
    'tranny', 'tr4nny', 'chink', 'ch1nk', 'spic', 'sp1c',
    'kike', 'k1ke', 'coon', 'c00n'
];

const WIN95_ERRORS = [
    "A fatal exception 0E has occurred at 0028:C0011E36",
    "This program has performed an illegal operation and will be shut down",
    "RUNDLL error loading C:\\WINDOWS\\SYSTEM\\BRIDGE.DLL",
    "The system is dangerously low on resources!",
    "Cannot find KERNEL32.DLL",
    "GPF in module MSVCRT.DLL at 0137:BFF9B3BC"
];

const TIPS = [
    "[TIP] Use /help to see all commands",
    "[TIP] Try !dog !cat for quick images",
    "[TIP] Drag windows around",
    "[TIP] Play games from desktop",
    "[TIP] Use @username to mention",
    "[JOKE] Why did the computer go to the doctor? It had a virus!",
    "[JOKE] What's a programmer's favorite snack? Microchips!"
];

const IMAGE_KEYWORDS = {
    'dog': 'https://raw.githubusercontent.com/Doopadroopa/retrochatemotes/refs/heads/main/2-20933_cute-puppies-png-background-havanese-dog.png',
    'cat': 'https://raw.githubusercontent.com/Doopadroopa/retrochatemotes/refs/heads/main/cat.png',
    'lol': 'https://raw.githubusercontent.com/Doopadroopa/retrochatemotes/refs/heads/main/laugh.png',
    'windows': 'https://raw.githubusercontent.com/Doopadroopa/retrochatemotes/refs/heads/main/windows95box.0.png',
    'error': 'https://raw.githubusercontent.com/Doopadroopa/retrochatemotes/refs/heads/main/error.png',
    'cool': 'https://raw.githubusercontent.com/Doopadroopa/retrochatemotes/refs/heads/main/Derp-face.png',
    'fire': 'https://raw.githubusercontent.com/Doopadroopa/retrochatemotes/refs/heads/main/pixel-art-fire-icon-png.png'
};

// ============================================================================
// HELPERS
// ============================================================================

function getCurrentTime() {
    const now = new Date();
    return `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
}

function containsBannedWord(text) {
    const clean = text.toLowerCase().replace(/[^a-z0-9]/g, '');
    return BANNED_WORDS.some(word => {
        const cleanWord = word.replace(/[^a-z0-9]/g, '');
        return clean.includes(cleanWord);
    });
}

function sanitize(text) {
    return text.replace(/[<>]/g, '').trim();
}

function getRandomTip() {
    return TIPS[Math.floor(Math.random() * TIPS.length)];
}

function getRandomError() {
    return WIN95_ERRORS[Math.floor(Math.random() * WIN95_ERRORS.length)];
}

// ============================================================================
// DATABASE FUNCTIONS
// ============================================================================

function saveMessage(room, username, color, message, messageType, timestamp) {
    return new Promise((resolve) => {
        db.run(
            'INSERT INTO messages (room, username, color, message, message_type, timestamp) VALUES (?, ?, ?, ?, ?, ?)',
            [room, username, color, message, messageType, timestamp],
            function() {
                db.run(
                    `DELETE FROM messages WHERE room = ? AND id NOT IN (
                        SELECT id FROM messages WHERE room = ? ORDER BY id DESC LIMIT 100
                    )`,
                    [room, room]
                );
                resolve();
            }
        );
    });
}

function loadMessages(room) {
    return new Promise((resolve) => {
        db.all(
            'SELECT * FROM messages WHERE room = ? ORDER BY id DESC LIMIT 100',
            [room],
            (err, rows) => {
                if (err) resolve([]);
                else resolve(rows.reverse());
            }
        );
    });
}

function createUser(username, password, color) {
    return new Promise((resolve) => {
        db.run(
            'INSERT INTO users (username, password, color) VALUES (?, ?, ?)',
            [username, password || '', color],
            function(err) {
                if (err) resolve(false);
                else {
                    console.log(`[DB] User created: ${username}`);
                    resolve(true);
                }
            }
        );
    });
}

function getUser(username) {
    return new Promise((resolve) => {
        db.get('SELECT * FROM users WHERE username = ?', [username], (err, row) => {
            if (err) resolve(null);
            else resolve(row);
        });
    });
}

function updateLogin(username) {
    db.run('UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE username = ?', [username]);
}

function incrementMessages(username) {
    db.run('UPDATE users SET total_messages = total_messages + 1 WHERE username = ?', [username]);
}

function getAchievements(username) {
    return new Promise((resolve) => {
        db.all('SELECT achievement FROM achievements WHERE username = ?', [username], (err, rows) => {
            if (err) resolve([]);
            else resolve(rows.map(r => r.achievement));
        });
    });
}

function unlockAchievement(username, achievement) {
    return new Promise((resolve) => {
        db.run(
            'INSERT OR IGNORE INTO achievements (username, achievement) VALUES (?, ?)',
            [username, achievement],
            function() {
                if (this.changes > 0) {
                    console.log(`[ACHIEVEMENT] ${username}: ${achievement}`);
                }
                resolve(this.changes > 0);
            }
        );
    });
}

function saveGameScore(username, game, score) {
    db.run(
        'INSERT INTO game_scores (username, game, score) VALUES (?, ?, ?)',
        [username, game, score]
    );
}

function getHighScores(game, limit = 10) {
    return new Promise((resolve) => {
        db.all(
            'SELECT username, score FROM game_scores WHERE game = ? ORDER BY score DESC LIMIT ?',
            [game, limit],
            (err, rows) => {
                if (err) resolve([]);
                else resolve(rows);
            }
        );
    });
}

// ============================================================================
// SOCKET.IO
// ============================================================================

io.on('connection', (socket) => {
    console.log(`[CONNECT] ${socket.id}`);

    connectedUsers[socket.id] = {
        username: null,
        color: '#ff00ff',
        status: 'Online',
        room: 'general',
        messageCount: 0,
        joinTime: Date.now(),
        isGuest: false,
        roomsVisited: ['general']
    };

    // LOGIN
    socket.on('user-login', async (data) => {
        try {
            const { username, color, password, isGuest } = data;
            let finalUsername = sanitize(username || '');

            if (isGuest) {
                finalUsername = `Guest${Math.floor(Math.random() * 9999)}`;
                connectedUsers[socket.id].username = finalUsername;
                connectedUsers[socket.id].color = color;
                connectedUsers[socket.id].isGuest = true;
                await joinRoom(socket, 'general', finalUsername);
                console.log(`[LOGIN] Guest: ${finalUsername}`);
            } else {
                if (!finalUsername || finalUsername.length < 2) {
                    socket.emit('login-error', 'Username must be at least 2 characters');
                    return;
                }

                const user = await getUser(finalUsername);
                if (!user) {
                    const created = await createUser(finalUsername, password, color);
                    if (!created) {
                        socket.emit('login-error', 'Username already exists');
                        return;
                    }
                    connectedUsers[socket.id].username = finalUsername;
                    connectedUsers[socket.id].color = color;
                    updateLogin(finalUsername);
                    await joinRoom(socket, 'general', finalUsername);
                    console.log(`[REGISTER] ${finalUsername}`);
                } else {
                    if (user.password && password !== user.password) {
                        socket.emit('login-error', 'Invalid password');
                        return;
                    }
                    connectedUsers[socket.id].username = finalUsername;
                    connectedUsers[socket.id].color = user.color;
                    updateLogin(finalUsername);
                    const ach = await getAchievements(finalUsername);
                    socket.emit('achievements-update', ach);
                    await joinRoom(socket, 'general', finalUsername);
                    console.log(`[LOGIN] ${finalUsername}`);
                }
            }

            setTimeout(() => {
                socket.emit('system-message', {
                    text: getRandomTip(),
                    timestamp: getCurrentTime()
                });
            }, 2000);
        } catch (err) {
            console.error('[ERROR] Login:', err);
            socket.emit('login-error', 'Login failed');
        }
    });

    async function joinRoom(socket, roomName, username) {
        socket.join(roomName);
        connectedUsers[socket.id].room = roomName;

        if (!rooms[roomName].users.includes(username)) {
            rooms[roomName].users.push(username);
        }

        if (!connectedUsers[socket.id].roomsVisited.includes(roomName)) {
            connectedUsers[socket.id].roomsVisited.push(roomName);
        }

        const msgs = await loadMessages(roomName);
        socket.emit('message-history', msgs);

        io.to(roomName).emit('users-update', rooms[roomName].users);
        io.to(roomName).emit('system-message', {
            text: `${username} entered the chat`,
            timestamp: getCurrentTime()
        });

        socket.emit('room-topic', {
            room: roomName,
            topic: rooms[roomName].topic
        });
    }

    // CHAT MESSAGE
    socket.on('chat-message', async (data) => {
        try {
            const user = connectedUsers[socket.id];
            if (!user || !user.username) return;

            const message = sanitize(data.message);
            const room = user.room;
            if (!message) return;

            if (message.startsWith('/')) {
                await handleCommand(socket, message, user);
                return;
            }

            if (containsBannedWord(message)) {
                socket.emit('message-blocked', 'Message contains inappropriate language');
                return;
            }

            const keywordMatch = message.match(/^!(\w+)$/);
            if (keywordMatch && IMAGE_KEYWORDS[keywordMatch[1]]) {
                const keyword = keywordMatch[1];
                io.to(room).emit('image-keyword', {
                    username: user.username,
                    color: user.color,
                    keyword: keyword,
                    imageUrl: IMAGE_KEYWORDS[keyword],
                    timestamp: data.timestamp
                });
                await saveMessage(room, user.username, user.color, `!${keyword}`, 'image', data.timestamp);
                if (!user.isGuest) incrementMessages(user.username);
                return;
            }

            io.to(room).emit('chat-message', {
                username: user.username,
                color: user.color,
                message: message,
                timestamp: data.timestamp,
                status: user.status
            });

            await saveMessage(room, user.username, user.color, message, 'normal', data.timestamp);
            user.messageCount++;
            if (!user.isGuest) {
                incrementMessages(user.username);
                await checkAchievements(socket, user);
            }
        } catch (err) {
            console.error('[ERROR] Message:', err);
        }
    });

    // COMMANDS
    async function handleCommand(socket, message, user) {
        const parts = message.split(' ');
        const cmd = parts[0].toLowerCase();
        const room = user.room;

        switch(cmd) {
            case '/me':
                const action = parts.slice(1).join(' ');
                if (!action) {
                    socket.emit('command-error', 'Usage: /me <action>');
                    return;
                }
                io.to(room).emit('action-message', {
                    username: user.username,
                    color: user.color,
                    action: action,
                    timestamp: getCurrentTime()
                });
                await saveMessage(room, user.username, user.color, action, 'action', getCurrentTime());
                break;

            case '/nick':
                const newName = sanitize(parts[1] || '');
                if (!newName || newName.length < 2 || newName.length > 20) {
                    socket.emit('command-error', 'Usage: /nick <name> (2-20 chars)');
                    return;
                }
                if (user.isGuest) {
                    const oldName = user.username;
                    user.username = newName;
                    rooms[room].users = rooms[room].users.map(u => u === oldName ? newName : u);
                    io.to(room).emit('system-message', {
                        text: `${oldName} is now ${newName}`,
                        timestamp: getCurrentTime()
                    });
                    io.to(room).emit('users-update', rooms[room].users);
                } else {
                    socket.emit('command-error', 'Registered users cannot change username');
                }
                break;

            case '/color':
                const newColor = parts[1];
                if (!newColor || !newColor.match(/^#[0-9A-F]{6}$/i)) {
                    socket.emit('command-error', 'Usage: /color #RRGGBB');
                    return;
                }
                user.color = newColor;
                socket.emit('color-changed', newColor);
                socket.emit('system-message', {
                    text: 'Color changed!',
                    timestamp: getCurrentTime()
                });
                break;

            case '/clear':
                socket.emit('clear-chat');
                break;

            case '/status':
                const status = parts[1];
                if (!['Online', 'Away', 'Busy'].includes(status)) {
                    socket.emit('command-error', 'Usage: /status [Online|Away|Busy]');
                    return;
                }
                user.status = status;
                io.to(room).emit('user-status-change', {
                    username: user.username,
                    status: status
                });
                socket.emit('system-message', {
                    text: `Status: ${status}`,
                    timestamp: getCurrentTime()
                });
                break;

            case '/join':
                const newRoom = parts[1];
                if (!newRoom || !rooms[newRoom]) {
                    socket.emit('command-error', 'Usage: /join [general|random|images|windows]');
                    return;
                }
                if (newRoom === room) {
                    socket.emit('command-error', 'Already in this room');
                    return;
                }

                socket.leave(room);
                rooms[room].users = rooms[room].users.filter(u => u !== user.username);
                io.to(room).emit('users-update', rooms[room].users);
                io.to(room).emit('system-message', {
                    text: `${user.username} left`,
                    timestamp: getCurrentTime()
                });

                await joinRoom(socket, newRoom, user.username);
                socket.emit('room-changed', newRoom);
                break;

            case '/msg':
                const targetUser = sanitize(parts[1] || '');
                const pmMessage = parts.slice(2).join(' ');
                if (!targetUser || !pmMessage) {
                    socket.emit('command-error', 'Usage: /msg <user> <message>');
                    return;
                }
                const targetSocket = Object.keys(connectedUsers).find(
                    id => connectedUsers[id].username === targetUser
                );
                if (targetSocket) {
                    io.to(targetSocket).emit('private-message', {
                        from: user.username,
                        message: pmMessage,
                        color: user.color,
                        timestamp: getCurrentTime()
                    });
                    socket.emit('private-message-sent', {
                        to: targetUser,
                        message: pmMessage,
                        timestamp: getCurrentTime()
                    });
                    if (!user.isGuest) {
                        const ach = await getAchievements(user.username);
                        if (!ach.includes('socialite')) {
                            const unlocked = await unlockAchievement(user.username, 'socialite');
                            if (unlocked) {
                                socket.emit('achievement-unlocked', {
                                    title: 'Socialite',
                                    description: 'Sent first PM'
                                });
                            }
                        }
                    }
                } else {
                    socket.emit('command-error', `User '${targetUser}' not found`);
                }
                break;

            case '/help':
                socket.emit('help-message', {
                    commands: [
                        '/me <action> - Perform action',
                        '/nick <n> - Change name (guests)',
                        '/color #RRGGBB - Change color',
                        '/clear - Clear chat',
                        '/status [status] - Set status',
                        '/join <room> - Join room',
                        '/msg <user> <text> - PM',
                        '/help - Show help',
                        '',
                        'Images: !dog !cat !lol !windows !error !cool !fire'
                    ]
                });
                break;

            default:
                socket.emit('command-error', `Unknown: ${cmd}`);
                break;
        }
    }

    // ACHIEVEMENTS
    async function checkAchievements(socket, user) {
        if (user.isGuest) return;
        
        try {
            const ach = await getAchievements(user.username);
            const userData = await getUser(user.username);
            if (!userData) return;

            if (!ach.includes('first-message') && user.messageCount >= 1) {
                const unlocked = await unlockAchievement(user.username, 'first-message');
                if (unlocked) {
                    socket.emit('achievement-unlocked', {
                        title: 'First Message!',
                        description: 'Sent your first message'
                    });
                }
            }

            if (!ach.includes('chatty') && userData.total_messages >= 10) {
                const unlocked = await unlockAchievement(user.username, 'chatty');
                if (unlocked) {
                    socket.emit('achievement-unlocked', {
                        title: 'Chatty!',
                        description: 'Sent 10 messages'
                    });
                }
            }

            if (!ach.includes('super-chatty') && userData.total_messages >= 50) {
                const unlocked = await unlockAchievement(user.username, 'super-chatty');
                if (unlocked) {
                    socket.emit('achievement-unlocked', {
                        title: 'Super Chatty!',
                        description: 'Sent 50 messages'
                    });
                }
            }

            if (!ach.includes('chatterbox') && userData.total_messages >= 100) {
                const unlocked = await unlockAchievement(user.username, 'chatterbox');
                if (unlocked) {
                    socket.emit('achievement-unlocked', {
                        title: 'Chatterbox!',
                        description: 'Sent 100 messages'
                    });
                }
            }

            const timeOnline = Date.now() - user.joinTime;
            if (!ach.includes('veteran') && timeOnline >= 30 * 60 * 1000) {
                const unlocked = await unlockAchievement(user.username, 'veteran');
                if (unlocked) {
                    socket.emit('achievement-unlocked', {
                        title: 'Veteran User',
                        description: 'Online 30 minutes'
                    });
                }
            }

            if (!ach.includes('room-hopper') && user.roomsVisited.length >= 4) {
                const unlocked = await unlockAchievement(user.username, 'room-hopper');
                if (unlocked) {
                    socket.emit('achievement-unlocked', {
                        title: 'Room Hopper',
                        description: 'Visited all rooms'
                    });
                }
            }
        } catch (err) {
            console.error('[ERROR] Achievements:', err);
        }
    }

    // IMAGE UPLOAD
    socket.on('image-upload', async (data) => {
        const user = connectedUsers[socket.id];
        if (!user || !user.username) return;
        const room = user.room;

        io.to(room).emit('image-message', {
            username: user.username,
            color: user.color,
            imageData: data.imageData,
            timestamp: data.timestamp
        });

        await saveMessage(room, user.username, user.color, '[Image]', 'image-upload', data.timestamp);

        if (!user.isGuest) {
            const ach = await getAchievements(user.username);
            if (!ach.includes('image-poster')) {
                const unlocked = await unlockAchievement(user.username, 'image-poster');
                if (unlocked) {
                    socket.emit('achievement-unlocked', {
                        title: 'Picture Perfect',
                        description: 'Posted first image'
                    });
                }
            }
        }
    });

    // GAME SCORE
    socket.on('game-score', async (data) => {
        const user = connectedUsers[socket.id];
        if (!user || !user.username || user.isGuest) return;
        await saveGameScore(user.username, data.game, data.score);
    });

    // GET HIGH SCORES
    socket.on('get-highscores', async (data) => {
        const scores = await getHighScores(data.game, 10);
        socket.emit('highscores', { game: data.game, scores: scores });
    });

    // TYPING
    socket.on('typing', () => {
        const user = connectedUsers[socket.id];
        if (user && user.username) {
            socket.broadcast.to(user.room).emit('user-typing', { username: user.username });
        }
    });

    socket.on('stop-typing', () => {
        const user = connectedUsers[socket.id];
        if (user && user.username) {
            socket.broadcast.to(user.room).emit('user-stop-typing');
        }
    });

    // DISCONNECT
    socket.on('disconnect', () => {
        const user = connectedUsers[socket.id];
        if (user && user.username) {
            const room = user.room;
            rooms[room].users = rooms[room].users.filter(u => u !== user.username);
            io.to(room).emit('system-message', {
                text: `${user.username} left the chat`,
                timestamp: getCurrentTime()
            });
            io.to(room).emit('users-update', rooms[room].users);
            console.log(`[DISCONNECT] ${user.username}`);
            delete connectedUsers[socket.id];
        }
    });
});

// ============================================================================
// PERIODIC
// ============================================================================

setInterval(() => {
    const userIds = Object.keys(connectedUsers);
    if (userIds.length > 0) {
        const randomId = userIds[Math.floor(Math.random() * userIds.length)];
        io.to(randomId).emit('win95-error', getRandomError());
    }
}, 5 * 60 * 1000);

setInterval(() => {
    io.emit('system-message', {
        text: getRandomTip(),
        timestamp: getCurrentTime()
    });
}, 10 * 60 * 1000);

// ============================================================================
// START
// ============================================================================

async function start() {
    try {
        await initDatabase();
        server.listen(PORT, () => {
            console.log('');
            console.log('============================================');
            console.log('  RETROCHAT95 v1.0 - ULTIMATE EDITION');
            console.log('============================================');
            console.log(`  Port:     ${PORT}`);
            console.log(`  Database: ${DB_PATH}`);
            console.log('  Status:   ONLINE');
            console.log('============================================');
            console.log('');
        });
    } catch (err) {
        console.error('[FATAL]', err);
        process.exit(1);
    }
}

process.on('SIGINT', () => {
    console.log('\n[SHUTDOWN]');
    db.close(() => process.exit(0));
});

start();
