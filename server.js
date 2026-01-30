const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);

const io = socketIo(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

const PORT = process.env.PORT || 3000;

app.use(express.static(__dirname));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// USER DATA
let connectedUsers = {};
let accounts = {}; // username -> { password, achievements, color, status }
let rooms = {
    'general': { users: [], messages: [] },
    'random': { users: [], messages: [] },
    'images': { users: [], messages: [] },
    'windows': { users: [], messages: [] }
};

// EMOTE IMAGES (base64 or URLs)
const emotes = {
    'dog': 'https://raw.githubusercontent.com/Doopadroopa/retrochatemotes/refs/heads/main/2-20933_cute-puppies-png-background-havanese-dog.png',
    'cat': 'https://raw.githubusercontent.com/Doopadroopa/retrochatemotes/refs/heads/main/cat.png',
    'lol': 'https://raw.githubusercontent.com/Doopadroopa/retrochatemotes/refs/heads/main/laugh.png',
    'windows': 'https://raw.githubusercontent.com/Doopadroopa/retrochatemotes/refs/heads/main/windows95box.0.png',
    'error': 'https://raw.githubusercontent.com/Doopadroopa/retrochatemotes/refs/heads/main/error.png',
    'cool': 'https://raw.githubusercontent.com/Doopadroopa/retrochatemotes/refs/heads/main/Derp-face.png',
    'https://raw.githubusercontent.com/Doopadroopa/retrochatemotes/refs/heads/main/pixel-art-fire-icon-png.png'
};

// FAKE WIN95 ERRORS
const win95Errors = [
    "A fatal exception 0E has occurred at 0028:C0011E36",
    "This program has performed an illegal operation and will be shut down",
    "RUNDLL error loading C:\\WINDOWS\\SYSTEM\\BRIDGE.DLL",
    "The system is dangerously low on resources!",
    "Cannot find KERNEL32.DLL",
    "GPF in module MSVCRT.DLL at 0137:BFF9B3BC"
];

io.on('connection', (socket) => {
    console.log('Connection:', socket.id);

    // DEFAULT ROOM
    connectedUsers[socket.id] = {
        username: null,
        color: '#ff00ff',
        status: 'Online',
        room: 'general',
        achievements: [],
        messageCount: 0,
        joinTime: Date.now()
    };

    // USER LOGIN / REGISTER
    socket.on('user-login', (data) => {
        const { username, color, password, isGuest } = data;
        
        let finalUsername = username;
        
        // GUEST MODE
        if (isGuest) {
            finalUsername = `Guest${Math.floor(Math.random() * 9999)}`;
        } else {
            // ACCOUNT SYSTEM
            if (!accounts[username]) {
                // New account
                accounts[username] = {
                    password: password || '',
                    achievements: [],
                    color: color,
                    status: 'Online',
                    totalMessages: 0
                };
            } else {
                // Existing account - load their data
                connectedUsers[socket.id].achievements = accounts[username].achievements;
                connectedUsers[socket.id].color = accounts[username].color;
            }
        }
        
        connectedUsers[socket.id].username = finalUsername;
        connectedUsers[socket.id].color = color;
        
        // JOIN DEFAULT ROOM
        const room = connectedUsers[socket.id].room;
        socket.join(room);
        
        if (!rooms[room].users.includes(finalUsername)) {
            rooms[room].users.push(finalUsername);
        }
        
        // BROADCAST TO ROOM
        io.to(room).emit('users-update', rooms[room].users);
        io.to(room).emit('system-message', {
            text: `${finalUsername} has entered the chat.`,
            timestamp: getCurrentTime()
        });
        
        // SEND ACHIEVEMENTS TO USER
        socket.emit('achievements-update', connectedUsers[socket.id].achievements);
        
        console.log(`${finalUsername} joined room: ${room}`);
    });

    // CHAT MESSAGE
    socket.on('chat-message', (data) => {
        const user = connectedUsers[socket.id];
        if (!user || !user.username) return;
        
        const message = data.message;
        const room = user.room;
        
        // CHECK FOR SLASH COMMANDS
        if (message.startsWith('/')) {
            handleCommand(socket, message, user);
            return;
        }
        
        // CHECK FOR EMOTES
        const emoteMatch = message.match(/\*(\w+)\*/);
        if (emoteMatch && emotes[emoteMatch[1]]) {
            io.to(room).emit('emote-message', {
                username: user.username,
                color: user.color,
                emote: emoteMatch[1],
                imageUrl: emotes[emoteMatch[1]],
                timestamp: data.timestamp
            });
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
        
        // UPDATE MESSAGE COUNT & ACHIEVEMENTS
        user.messageCount++;
        if (!accounts[user.username]) {
            accounts[user.username] = { achievements: [] };
        }
        accounts[user.username].totalMessages = (accounts[user.username].totalMessages || 0) + 1;
        
        checkAchievements(socket, user);
    });

    // SLASH COMMANDS
    function handleCommand(socket, message, user) {
        const parts = message.split(' ');
        const cmd = parts[0].toLowerCase();
        const room = user.room;
        
        switch(cmd) {
            case '/me':
                const action = parts.slice(1).join(' ');
                io.to(room).emit('action-message', {
                    username: user.username,
                    color: user.color,
                    action: action,
                    timestamp: getCurrentTime()
                });
                break;
                
            case '/nick':
                const newName = parts[1];
                if (newName && newName.length <= 20) {
                    const oldName = user.username;
                    user.username = newName;
                    io.to(room).emit('system-message', {
                        text: `${oldName} changed their name to ${newName}`,
                        timestamp: getCurrentTime()
                    });
                }
                break;
                
            case '/color':
                const newColor = parts[1];
                if (newColor && newColor.match(/^#[0-9A-F]{6}$/i)) {
                    user.color = newColor;
                    socket.emit('color-changed', newColor);
                }
                break;
                
            case '/clear':
                socket.emit('clear-chat');
                break;
                
            case '/status':
                const status = parts[1];
                if (['Online', 'Away', 'Busy'].includes(status)) {
                    user.status = status;
                    io.to(room).emit('user-status-change', {
                        username: user.username,
                        status: status
                    });
                }
                break;
                
            case '/join':
                const newRoom = parts[1];
                if (rooms[newRoom]) {
                    // Leave old room
                    socket.leave(room);
                    rooms[room].users = rooms[room].users.filter(u => u !== user.username);
                    io.to(room).emit('users-update', rooms[room].users);
                    io.to(room).emit('system-message', {
                        text: `${user.username} left the room`,
                        timestamp: getCurrentTime()
                    });
                    
                    // Join new room
                    user.room = newRoom;
                    socket.join(newRoom);
                    rooms[newRoom].users.push(user.username);
                    io.to(newRoom).emit('users-update', rooms[newRoom].users);
                    io.to(newRoom).emit('system-message', {
                        text: `${user.username} joined the room`,
                        timestamp: getCurrentTime()
                    });
                    
                    socket.emit('room-changed', newRoom);
                }
                break;
                
            case '/msg':
                const targetUser = parts[1];
                const pmMessage = parts.slice(2).join(' ');
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
                        message: pmMessage
                    });
                }
                break;
                
            case '/help':
                socket.emit('help-message', {
                    commands: [
                        '/me <action> - Perform an action',
                        '/nick <name> - Change username',
                        '/color #RRGGBB - Change color',
                        '/clear - Clear your chat',
                        '/status Online|Away|Busy - Set status',
                        '/join <room> - Join a room',
                        '/msg <user> <text> - Private message',
                        '/help - Show this help'
                    ]
                });
                break;
        }
    }

    // ACHIEVEMENTS
    function checkAchievements(socket, user) {
        const achievements = user.achievements || [];
        const totalMessages = accounts[user.username]?.totalMessages || 0;
        
        // First Message
        if (!achievements.includes('first-message') && user.messageCount >= 1) {
            achievements.push('first-message');
            socket.emit('achievement-unlocked', {
                title: 'First Message!',
                description: 'You sent your first message'
            });
        }
        
        // 10 Messages
        if (!achievements.includes('chatty') && totalMessages >= 10) {
            achievements.push('chatty');
            socket.emit('achievement-unlocked', {
                title: 'Chatty!',
                description: 'Sent 10 messages'
            });
        }
        
        // 30 Minutes Online
        const timeOnline = Date.now() - user.joinTime;
        if (!achievements.includes('veteran') && timeOnline >= 30 * 60 * 1000) {
            achievements.push('veteran');
            socket.emit('achievement-unlocked', {
                title: 'Veteran User',
                description: 'Stayed online for 30 minutes'
            });
        }
        
        user.achievements = achievements;
        if (accounts[user.username]) {
            accounts[user.username].achievements = achievements;
        }
    }

    // IMAGE UPLOAD
    socket.on('image-upload', (data) => {
        const user = connectedUsers[socket.id];
        if (user) {
            const room = user.room;
            io.to(room).emit('image-message', {
                username: user.username,
                color: user.color,
                imageData: data.imageData,
                timestamp: data.timestamp
            });
            
            // Achievement
            if (!user.achievements.includes('image-poster')) {
                user.achievements.push('image-poster');
                socket.emit('achievement-unlocked', {
                    title: 'Picture Perfect',
                    description: 'Posted your first image'
                });
            }
        }
    });

    // TYPING
    socket.on('typing', () => {
        const user = connectedUsers[socket.id];
        if (user) {
            socket.broadcast.to(user.room).emit('user-typing', {
                username: user.username
            });
        }
    });

    socket.on('stop-typing', () => {
        const user = connectedUsers[socket.id];
        if (user) {
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
                text: `${user.username} has left the chat.`,
                timestamp: getCurrentTime()
            });
            io.to(room).emit('users-update', rooms[room].users);
            
            delete connectedUsers[socket.id];
        }
    });

    // RANDOM WIN95 ERROR (send every 5 minutes to random users)
    setInterval(() => {
        const randomError = win95Errors[Math.floor(Math.random() * win95Errors.length)];
        socket.emit('win95-error', randomError);
    }, 5 * 60 * 1000);
});

function getCurrentTime() {
    const now = new Date();
    return `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
}

server.listen(PORT, () => {
    console.log('🚀 RetroChat95 Server running on port', PORT);
    console.log('📡 Ready for connections!');
});
