/*
 * RetroChat95 BETA
 * Copyright (C) 2026 Tricarty
 * 
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 * 
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU General Public License for more details.
 * 
 * You should have received a copy of the GNU General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 */

// ============================================================================
// RETROCHAT95 BETA lets not steal it ok?????? its open source so you can make your own versions but its under the GPL VERSION 3 LICENSE
// ============================================================================

const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

// ============================================================================
// EXPRESS & SOCKET.IO SETUP
// ============================================================================

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

// Serve static files
app.use(express.static(__dirname));
app.use(express.json());

// Main route
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Health check
app.get('/health', (req, res) => {
    res.json({ status: 'OK', version: 'BETA', uptime: process.uptime() });
});

// ============================================================================
// DATABASE SETUP - SQLite3
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
    return new Promise((resolve, reject) => {
        db.serialize(() => {
            // Users table
            db.run(`
                CREATE TABLE IF NOT EXISTS users (
                    username TEXT PRIMARY KEY,
                    password TEXT,
                    color TEXT DEFAULT '#ff00ff',
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    last_login DATETIME DEFAULT CURRENT_TIMESTAMP,
                    total_messages INTEGER DEFAULT 0,
                    total_time_online INTEGER DEFAULT 0
                )
            `, (err) => {
                if (err) console.error('[DATABASE] Error creating users table:', err);
                else console.log('[DATABASE] Users table ready');
            });

            // Achievements table
            db.run(`
                CREATE TABLE IF NOT EXISTS achievements (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    username TEXT NOT NULL,
                    achievement TEXT NOT NULL,
                    unlocked_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    UNIQUE(username, achievement)
                )
            `, (err) => {
                if (err) console.error('[DATABASE] Error creating achievements table:', err);
                else console.log('[DATABASE] Achievements table ready');
            });

            // Messages table - stores last 100 messages per room
            db.run(`
                CREATE TABLE IF NOT EXISTS messages (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    room TEXT NOT NULL,
                    username TEXT NOT NULL,
                    color TEXT,
                    message TEXT NOT NULL,
                    message_type TEXT DEFAULT 'normal',
                    timestamp TEXT NOT NULL,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
                )
            `, (err) => {
                if (err) console.error('[DATABASE] Error creating messages table:', err);
                else console.log('[DATABASE] Messages table ready');
            });

            // Reactions table
            db.run(`
                CREATE TABLE IF NOT EXISTS reactions (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    message_id INTEGER NOT NULL,
                    username TEXT NOT NULL,
                    reaction TEXT NOT NULL,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    UNIQUE(message_id, username, reaction)
                )
            `, (err) => {
                if (err) console.error('[DATABASE] Error creating reactions table:', err);
                else console.log('[DATABASE] Reactions table ready');
                resolve();
            });
        });
    });
}

// ============================================================================
// IN-MEMORY DATA STRUCTURES
// ============================================================================

let connectedUsers = {};
let rooms = {
    'general': { users: [], topic: 'General Discussion' },
    'random': { users: [], topic: 'Random Stuff' },
    'images': { users: [], topic: 'Share Your Images' },
    'windows': { users: [], topic: 'Windows 95 Nostalgia' }
};

// ============================================================================
// CONTENT FILTERS
// ============================================================================

const BANNED_WORDS = [
    // Racial slurs
    'nigger', 'nigga', 'n1gger', 'n1gga', 'nig', 'nigg', 'n!gger', 'n!gga', 'nga',
    // Homophobic slurs
    'faggot', 'fag', 'f4ggot', 'f4g', 'f@ggot', 'f@g', 'fa66ot',
    // Ableist slurs
    'retard', 'retarded', 'r3tard', 'r3tarded', 'tard', 'r€tard',
    // Transphobic slurs
    'tranny', 'tr4nny', 'tr@nny', 'trannie',
    // Other ethnic slurs
    'chink', 'ch1nk', 'ch!nk',
    'spic', 'sp1c', 'sp!c',
    'kike', 'k1ke', 'k!ke',
    'coon', 'c00n', 'c0on',
    'beaner', 'b3aner',
    'wetback', 'w3tback',
    'gook', 'g00k',
    'raghead', 'r4ghead',
    'towelhead'
];

// Win95 error messages
const WIN95_ERRORS = [
    "A fatal exception 0E has occurred at 0028:C0011E36",
    "This program has performed an illegal operation and will be shut down",
    "RUNDLL error loading C:\\WINDOWS\\SYSTEM\\BRIDGE.DLL",
    "The system is dangerously low on resources!",
    "Cannot find KERNEL32.DLL",
    "GPF in module MSVCRT.DLL at 0137:BFF9B3BC",
    "HIMEM.SYS is missing. Do you want to continue loading Windows?",
    "Windows protection error. You need to restart your computer.",
    "Illegal operation in module USER.EXE at 0137:00004F21",
    "Not enough memory to complete this operation",
    "This program has caused a General Protection Fault in KRNL386.EXE"
];

// Tips and jokes
const TIPS_AND_JOKES = [
    "[TIP] Use /help to see all available commands!",
    "[TIP] You can change your color with /color #RRGGBB",
    "[TIP] Try /me to perform an action!",
    "[TIP] Use /msg [username] to send a private message!",
    "[TIP] You can switch rooms with /join [room]",
    "[TIP] Your achievements are saved to your account!",
    "[TIP] Set your status with /status [Online/Away/Busy]",
    "[TIP] Type !dog, !cat, or other keywords for quick images!",
    "[TIP] Press Enter to send messages quickly!",
    "[TIP] Drag windows around to organize your screen!",
    "[JOKE] Why don't programmers like nature? It has too many bugs!",
    "[JOKE] There are only 10 types of people: those who understand binary and those who don't.",
    "[JOKE] Why did the computer go to the doctor? Because it had a virus!",
    "[JOKE] What's a computer's favorite snack? Microchips!",
    "[JOKE] Why was the JavaScript developer sad? Because he didn't Node how to Express himself!",
    "[JOKE] How many programmers does it take to change a light bulb? None, that's a hardware problem!",
    "[JOKE] Why do Java developers wear glasses? Because they can't C#!",
    "[JOKE] What's a programmer's favorite hangout place? Foo Bar!"
];

// Image keywords
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
// UTILITY FUNCTIONS
// ============================================================================

function getCurrentTime() {
    const now = new Date();
    return `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
}

function containsBannedWord(text) {
    const cleanText = text.toLowerCase().replace(/[^a-z0-9]/g, '');
    return BANNED_WORDS.some(word => {
        const cleanWord = word.replace(/[^a-z0-9]/g, '');
        return cleanText.includes(cleanWord);
    });
}

function getRandomTip() {
    return TIPS_AND_JOKES[Math.floor(Math.random() * TIPS_AND_JOKES.length)];
}

function getRandomError() {
    return WIN95_ERRORS[Math.floor(Math.random() * WIN95_ERRORS.length)];
}

function sanitizeInput(text) {
    return text.replace(/[<>]/g, '').trim();
}

// ============================================================================
// DATABASE FUNCTIONS
// ============================================================================

function saveMessage(room, username, color, message, messageType, timestamp) {
    return new Promise((resolve, reject) => {
        db.run(
            'INSERT INTO messages (room, username, color, message, message_type, timestamp) VALUES (?, ?, ?, ?, ?, ?)',
            [room, username, color, message, messageType, timestamp],
            function(err) {
                if (err) {
                    console.error('[DATABASE] Error saving message:', err);
                    reject(err);
                } else {
                    // Clean old messages (keep last 100 per room)
                    db.run(
                        `DELETE FROM messages WHERE room = ? AND id NOT IN (
                            SELECT id FROM messages WHERE room = ? ORDER BY id DESC LIMIT 100
                        )`,
                        [room, room],
                        (err) => {
                            if (err) console.error('[DATABASE] Error cleaning messages:', err);
                        }
                    );
                    resolve(this.lastID);
                }
            }
        );
    });
}

function loadMessageHistory(room, limit = 100) {
    return new Promise((resolve, reject) => {
        db.all(
            'SELECT * FROM messages WHERE room = ? ORDER BY id DESC LIMIT ?',
            [room, limit],
            (err, rows) => {
                if (err) {
                    console.error('[DATABASE] Error loading messages:', err);
                    reject(err);
                } else {
                    resolve(rows.reverse());
                }
            }
        );
    });
}

function createUser(username, password, color) {
    return new Promise((resolve, reject) => {
        db.run(
            'INSERT INTO users (username, password, color) VALUES (?, ?, ?)',
            [username, password || '', color],
            function(err) {
                if (err) {
                    console.error('[DATABASE] Error creating user:', err);
                    reject(err);
                } else {
                    console.log(`[DATABASE] User created: ${username}`);
                    resolve(true);
                }
            }
        );
    });
}

function getUser(username) {
    return new Promise((resolve, reject) => {
        db.get(
            'SELECT * FROM users WHERE username = ?',
            [username],
            (err, row) => {
                if (err) {
                    console.error('[DATABASE] Error getting user:', err);
                    reject(err);
                } else {
                    resolve(row);
                }
            }
        );
    });
}

function updateUserLogin(username) {
    db.run(
        'UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE username = ?',
        [username],
        (err) => {
            if (err) console.error('[DATABASE] Error updating login:', err);
        }
    );
}

function incrementMessageCount(username) {
    db.run(
        'UPDATE users SET total_messages = total_messages + 1 WHERE username = ?',
        [username],
        (err) => {
            if (err) console.error('[DATABASE] Error incrementing messages:', err);
        }
    );
}

function getUserAchievements(username) {
    return new Promise((resolve, reject) => {
        db.all(
            'SELECT achievement FROM achievements WHERE username = ?',
            [username],
            (err, rows) => {
                if (err) {
                    console.error('[DATABASE] Error getting achievements:', err);
                    reject(err);
                } else {
                    resolve(rows.map(r => r.achievement));
                }
            }
        );
    });
}

function unlockAchievement(username, achievement) {
    return new Promise((resolve, reject) => {
        db.run(
            'INSERT OR IGNORE INTO achievements (username, achievement) VALUES (?, ?)',
            [username, achievement],
            function(err) {
                if (err) {
                    console.error('[DATABASE] Error unlocking achievement:', err);
                    reject(err);
                } else {
                    if (this.changes > 0) {
                        console.log(`[ACHIEVEMENT] ${username} unlocked: ${achievement}`);
                    }
                    resolve(this.changes > 0);
                }
            }
        );
    });
}

// ============================================================================
// SOCKET.IO CONNECTION HANDLER
// ============================================================================

io.on('connection', (socket) => {
    console.log(`[CONNECT] New connection: ${socket.id}`);

    // Initialize user data
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

    // ========================================================================
    // USER LOGIN / REGISTRATION
    // ========================================================================

    socket.on('user-login', async (data) => {
        try {
            const { username, color, password, isGuest } = data;
            let finalUsername = sanitizeInput(username || '');

            if (isGuest) {
                // GUEST MODE
                finalUsername = `Guest${Math.floor(Math.random() * 9999)}`;
                connectedUsers[socket.id].username = finalUsername;
                connectedUsers[socket.id].color = color;
                connectedUsers[socket.id].isGuest = true;
                
                await joinRoom(socket, 'general', finalUsername);
                console.log(`[LOGIN] Guest: ${finalUsername}`);
                
            } else {
                // REGISTERED USER
                if (!finalUsername || finalUsername.length < 2) {
                    socket.emit('login-error', 'Username must be at least 2 characters');
                    return;
                }

                const existingUser = await getUser(finalUsername);

                if (!existingUser) {
                    // New user - create account
                    await createUser(finalUsername, password, color);
                    connectedUsers[socket.id].username = finalUsername;
                    connectedUsers[socket.id].color = color;
                    updateUserLogin(finalUsername);
                    
                    await joinRoom(socket, 'general', finalUsername);
                    console.log(`[REGISTER] New user: ${finalUsername}`);
                    
                } else {
                    // Existing user - check password
                    if (existingUser.password && password !== existingUser.password) {
                        socket.emit('login-error', 'Invalid password');
                        return;
                    }

                    connectedUsers[socket.id].username = finalUsername;
                    connectedUsers[socket.id].color = existingUser.color;
                    updateUserLogin(finalUsername);

                    // Load achievements
                    const achievements = await getUserAchievements(finalUsername);
                    socket.emit('achievements-update', achievements);

                    await joinRoom(socket, 'general', finalUsername);
                    console.log(`[LOGIN] User: ${finalUsername}`);
                }
            }

            // Send welcome tip after 2 seconds
            setTimeout(() => {
                socket.emit('system-message', {
                    text: getRandomTip(),
                    timestamp: getCurrentTime()
                });
            }, 2000);

        } catch (error) {
            console.error('[ERROR] Login error:', error);
            socket.emit('login-error', 'An error occurred during login');
        }
    });

    // ========================================================================
    // JOIN ROOM
    // ========================================================================

    async function joinRoom(socket, roomName, username) {
        try {
            socket.join(roomName);
            connectedUsers[socket.id].room = roomName;

            if (!rooms[roomName].users.includes(username)) {
                rooms[roomName].users.push(username);
            }

            // Track rooms visited
            if (!connectedUsers[socket.id].roomsVisited.includes(roomName)) {
                connectedUsers[socket.id].roomsVisited.push(roomName);
            }

            // Load message history
            const messages = await loadMessageHistory(roomName);
            socket.emit('message-history', messages);

            // Broadcast updates
            io.to(roomName).emit('users-update', rooms[roomName].users);
            io.to(roomName).emit('system-message', {
                text: `${username} has entered the chat.`,
                timestamp: getCurrentTime()
            });

            console.log(`[JOIN] ${username} joined #${roomName}`);
        } catch (error) {
            console.error('[ERROR] Join room error:', error);
        }
    }

    // ========================================================================
    // CHAT MESSAGE
    // ========================================================================

    socket.on('chat-message', async (data) => {
        try {
            const user = connectedUsers[socket.id];
            if (!user || !user.username) return;

            const message = sanitizeInput(data.message);
            const room = user.room;

            if (!message) return;

            // CHECK FOR SLASH COMMANDS
            if (message.startsWith('/')) {
                await handleCommand(socket, message, user);
                return;
            }

            // CHECK FOR BANNED WORDS
            if (containsBannedWord(message)) {
                socket.emit('message-blocked', 'Your message contains inappropriate language and was not sent.');
                console.log(`[FILTER] Blocked message from ${user.username}: ${message}`);
                return;
            }

            // CHECK FOR IMAGE KEYWORDS
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
                
                if (!user.isGuest) {
                    incrementMessageCount(user.username);
                }
                
                return;
            }

            // NORMAL MESSAGE
            io.to(room).emit('chat-message', {
                username: user.username,
                color: user.color,
                message: message,
                timestamp: data.timestamp,
                status: user.status
            });

            await saveMessage(room, user.username, user.color, message, 'normal', data.timestamp);

            // UPDATE MESSAGE COUNT
            user.messageCount++;
            if (!user.isGuest) {
                incrementMessageCount(user.username);
                await checkAchievements(socket, user);
            }

        } catch (error) {
            console.error('[ERROR] Chat message error:', error);
        }
    });

    // ========================================================================
    // SLASH COMMANDS
    // ========================================================================

    async function handleCommand(socket, message, user) {
        const parts = message.split(' ');
        const cmd = parts[0].toLowerCase();
        const room = user.room;

        try {
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
                    const newName = sanitizeInput(parts[1] || '');
                    
                    if (!newName || newName.length < 2 || newName.length > 20) {
                        socket.emit('command-error', 'Usage: /nick <name> (2-20 characters)');
                        return;
                    }

                    if (user.isGuest) {
                        const oldName = user.username;
                        user.username = newName;

                        // Update room users
                        rooms[room].users = rooms[room].users.map(u => u === oldName ? newName : u);

                        io.to(room).emit('system-message', {
                            text: `${oldName} changed their name to ${newName}`,
                            timestamp: getCurrentTime()
                        });

                        io.to(room).emit('users-update', rooms[room].users);
                    } else {
                        socket.emit('command-error', 'Registered users cannot change username. Use guest mode to change names.');
                    }
                    break;

                case '/color':
                    const newColor = parts[1];
                    
                    if (!newColor || !newColor.match(/^#[0-9A-F]{6}$/i)) {
                        socket.emit('command-error', 'Usage: /color #RRGGBB (hex color)');
                        return;
                    }

                    user.color = newColor;
                    socket.emit('color-changed', newColor);
                    socket.emit('system-message', {
                        text: 'Color changed successfully!',
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
                        text: `Status changed to ${status}`,
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
                        socket.emit('command-error', 'You are already in this room!');
                        return;
                    }

                    // Leave old room
                    socket.leave(room);
                    rooms[room].users = rooms[room].users.filter(u => u !== user.username);
                    io.to(room).emit('users-update', rooms[room].users);
                    io.to(room).emit('system-message', {
                        text: `${user.username} left the room`,
                        timestamp: getCurrentTime()
                    });

                    // Join new room
                    await joinRoom(socket, newRoom, user.username);
                    socket.emit('room-changed', newRoom);
                    break;

                case '/msg':
                    const targetUser = sanitizeInput(parts[1] || '');
                    const pmMessage = parts.slice(2).join(' ');

                    if (!targetUser || !pmMessage) {
                        socket.emit('command-error', 'Usage: /msg <username> <message>');
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

                        // Achievement: Socialite
                        if (!user.isGuest) {
                            const achievements = await getUserAchievements(user.username);
                            if (!achievements.includes('socialite')) {
                                const unlocked = await unlockAchievement(user.username, 'socialite');
                                if (unlocked) {
                                    socket.emit('achievement-unlocked', {
                                        title: 'Socialite',
                                        description: 'Sent your first private message'
                                    });
                                }
                            }
                        }
                    } else {
                        socket.emit('command-error', `User '${targetUser}' not found.`);
                    }
                    break;

                case '/help':
                    socket.emit('help-message', {
                        commands: [
                            '/me <action> - Perform an action',
                            '/nick <name> - Change username (guests only)',
                            '/color #RRGGBB - Change text color',
                            '/clear - Clear your chat',
                            '/status [Online|Away|Busy] - Set status',
                            '/join <room> - Join a room (general, random, images, windows)',
                            '/msg <user> <text> - Send private message',
                            '/help - Show this help',
                            '',
                            'Image keywords: !dog, !cat, !lol, !windows, !error, !cool, !fire'
                        ]
                    });
                    break;

                default:
                    socket.emit('command-error', `Unknown command: ${cmd}. Type /help for commands.`);
                    break;
            }
        } catch (error) {
            console.error('[ERROR] Command error:', error);
            socket.emit('command-error', 'An error occurred processing your command');
        }
    }

    // ========================================================================
    // ACHIEVEMENTS CHECK
    // ========================================================================

    async function checkAchievements(socket, user) {
        if (user.isGuest) return;

        try {
            const achievements = await getUserAchievements(user.username);
            const userData = await getUser(user.username);
            if (!userData) return;

            // First Message
            if (!achievements.includes('first-message') && user.messageCount >= 1) {
                const unlocked = await unlockAchievement(user.username, 'first-message');
                if (unlocked) {
                    socket.emit('achievement-unlocked', {
                        title: 'First Message!',
                        description: 'You sent your first message'
                    });
                }
            }

            // Chatty (10 messages)
            if (!achievements.includes('chatty') && userData.total_messages >= 10) {
                const unlocked = await unlockAchievement(user.username, 'chatty');
                if (unlocked) {
                    socket.emit('achievement-unlocked', {
                        title: 'Chatty!',
                        description: 'Sent 10 messages'
                    });
                }
            }

            // Super Chatty (50 messages)
            if (!achievements.includes('super-chatty') && userData.total_messages >= 50) {
                const unlocked = await unlockAchievement(user.username, 'super-chatty');
                if (unlocked) {
                    socket.emit('achievement-unlocked', {
                        title: 'Super Chatty!',
                        description: 'Sent 50 messages'
                    });
                }
            }

            // Chatterbox (100 messages)
            if (!achievements.includes('chatterbox') && userData.total_messages >= 100) {
                const unlocked = await unlockAchievement(user.username, 'chatterbox');
                if (unlocked) {
                    socket.emit('achievement-unlocked', {
                        title: 'Chatterbox!',
                        description: 'Sent 100 messages'
                    });
                }
            }

            // Veteran (30 min online)
            const timeOnline = Date.now() - user.joinTime;
            if (!achievements.includes('veteran') && timeOnline >= 30 * 60 * 1000) {
                const unlocked = await unlockAchievement(user.username, 'veteran');
                if (unlocked) {
                    socket.emit('achievement-unlocked', {
                        title: 'Veteran User',
                        description: 'Stayed online for 30 minutes'
                    });
                }
            }

            // Room Hopper (visited all rooms)
            if (!achievements.includes('room-hopper') && user.roomsVisited.length >= 4) {
                const unlocked = await unlockAchievement(user.username, 'room-hopper');
                if (unlocked) {
                    socket.emit('achievement-unlocked', {
                        title: 'Room Hopper',
                        description: 'Visited all chat rooms'
                    });
                }
            }

        } catch (error) {
            console.error('[ERROR] Achievement check error:', error);
        }
    }

    // ========================================================================
    // IMAGE UPLOAD
    // ========================================================================

    socket.on('image-upload', async (data) => {
        try {
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

            // Achievement: Picture Perfect
            if (!user.isGuest) {
                const achievements = await getUserAchievements(user.username);
                if (!achievements.includes('image-poster')) {
                    const unlocked = await unlockAchievement(user.username, 'image-poster');
                    if (unlocked) {
                        socket.emit('achievement-unlocked', {
                            title: 'Picture Perfect',
                            description: 'Posted your first image'
                        });
                    }
                }
            }
        } catch (error) {
            console.error('[ERROR] Image upload error:', error);
        }
    });

    // ========================================================================
    // MESSAGE REACTION
    // ========================================================================

    socket.on('add-reaction', (data) => {
        const user = connectedUsers[socket.id];
        if (!user || !user.username) return;

        const { messageId, reaction } = data;

        db.run(
            'INSERT OR REPLACE INTO reactions (message_id, username, reaction) VALUES (?, ?, ?)',
            [messageId, user.username, reaction],
            (err) => {
                if (err) {
                    console.error('[ERROR] Reaction error:', err);
                } else {
                    io.to(user.room).emit('reaction-added', {
                        messageId: messageId,
                        username: user.username,
                        reaction: reaction
                    });
                }
            }
        );
    });

    // ========================================================================
    // TYPING INDICATOR
    // ========================================================================

    socket.on('typing', () => {
        const user = connectedUsers[socket.id];
        if (user && user.username) {
            socket.broadcast.to(user.room).emit('user-typing', {
                username: user.username
            });
        }
    });

    socket.on('stop-typing', () => {
        const user = connectedUsers[socket.id];
        if (user && user.username) {
            socket.broadcast.to(user.room).emit('user-stop-typing');
        }
    });

    // ========================================================================
    // DISCONNECT
    // ========================================================================

    socket.on('disconnect', () => {
        const user = connectedUsers[socket.id];
        
        if (user && user.username) {
            const room = user.room;

            rooms[room].users = rooms[room].users.filter(u => u !== user.username);

            io.to(room).emit('system-message', {
                text: `${user.username} has left the chat.`,
                timestamp: getCurrentTime()
            });

            io.to(room).emit('users-update', rooms[room].users);

            console.log(`[DISCONNECT] ${user.username} from #${room}`);
            delete connectedUsers[socket.id];
        }
    });
});

// ============================================================================
// PERIODIC TASKS
// ============================================================================

// Random Win95 errors (every 5 minutes to random user)
setInterval(() => {
    const userIds = Object.keys(connectedUsers);
    if (userIds.length > 0) {
        const randomUserId = userIds[Math.floor(Math.random() * userIds.length)];
        const randomError = getRandomError();
        io.to(randomUserId).emit('win95-error', randomError);
    }
}, 5 * 60 * 1000);

// Random tips (every 10 minutes to all users)
setInterval(() => {
    const tip = getRandomTip();
    io.emit('system-message', {
        text: tip,
        timestamp: getCurrentTime()
    });
}, 10 * 60 * 1000);

// ============================================================================
// SERVER STARTUP
// ============================================================================

async function startServer() {
    try {
        await initDatabase();
        
        server.listen(PORT, () => {
            console.log('');
            console.log('============================================');
            console.log('  RETROCHAT95 BETA - BETA RELEASE');
            console.log('============================================');
            console.log(`  Port:     ${PORT}`);
            console.log(`  Database: ${DB_PATH}`);
            console.log(`  Status:   ONLINE`);
            console.log('============================================');
            console.log('');
        });
    } catch (error) {
        console.error('[FATAL] Server startup failed:', error);
        process.exit(1);
    }
}

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('\n[SHUTDOWN] Closing database...');
    db.close((err) => {
        if (err) console.error('[ERROR] Database close error:', err);
        else console.log('[OK] Database closed');
        process.exit(0);
    });
});

process.on('SIGTERM', () => {
    console.log('\n[SHUTDOWN] Closing database...');
    db.close((err) => {
        if (err) console.error('[ERROR] Database close error:', err);
        else console.log('[OK] Database closed');
        process.exit(0);
    });
});

// Start the server
startServer();
