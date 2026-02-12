/*
 * RetroChat95 BETA - SIMPLER VERSION
 * Copyright (C) 2025 Tricarty
 * GPL-3.0 License
 */

const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: { origin: "*", methods: ["GET", "POST"] },
    pingTimeout: 60000,
    pingInterval: 25000
});

const PORT = process.env.PORT || 3000;

app.use(express.static(__dirname));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// Database
const db = new sqlite3.Database('./retrochat95.db');

db.serialize(() => {
    // Users
    db.run(`CREATE TABLE IF NOT EXISTS users (
        username TEXT PRIMARY KEY,
        password TEXT,
        color TEXT DEFAULT '#ff00ff',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    
    // Main chat messages
    db.run(`CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT,
        color TEXT,
        message TEXT,
        timestamp TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    
    // Direct messages
    db.run(`CREATE TABLE IF NOT EXISTS dms (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sender TEXT,
        receiver TEXT,
        message TEXT,
        timestamp TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    
    console.log('[DATABASE] Tables ready');
});

// Data
let connectedUsers = {};
let mainChatUsers = [];

// Helpers
function getCurrentTime() {
    const now = new Date();
    return `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
}

function sanitize(text) {
    return text.replace(/[<>]/g, '').trim();
}

// Socket handlers
io.on('connection', (socket) => {
    console.log(`[CONNECT] ${socket.id}`);
    
    // Login
    socket.on('user-login', async (data) => {
        const username = sanitize(data.username || `Guest${Math.floor(Math.random() * 9999)}`);
        const color = data.color || '#ff00ff';
        
        connectedUsers[socket.id] = { username, color };
        
        if (!mainChatUsers.includes(username)) {
            mainChatUsers.push(username);
        }
        
        // Load main chat history
        db.all('SELECT * FROM messages ORDER BY id DESC LIMIT 50', (err, rows) => {
            if (!err && rows) {
                socket.emit('chat-history', rows.reverse());
            }
        });
        
        // Update users list
        io.emit('users-update', mainChatUsers);
        io.emit('system-message', { text: `${username} joined`, timestamp: getCurrentTime() });
        
        console.log(`[LOGIN] ${username}`);
    });
    
    // Chat message
    socket.on('chat-message', (data) => {
        const user = connectedUsers[socket.id];
        if (!user) return;
        
        const message = sanitize(data.message);
        if (!message) return;
        
        // Save to DB
        db.run('INSERT INTO messages (username, color, message, timestamp) VALUES (?, ?, ?, ?)',
            [user.username, user.color, message, data.timestamp]);
        
        // Broadcast
        io.emit('chat-message', {
            username: user.username,
            color: user.color,
            message: message,
            timestamp: data.timestamp
        });
    });
    
    // Start DM
    socket.on('start-dm', (targetUser) => {
        const user = connectedUsers[socket.id];
        if (!user) return;
        
        // Load DM history between these two users
        db.all(`SELECT * FROM dms 
                WHERE (sender = ? AND receiver = ?) OR (sender = ? AND receiver = ?)
                ORDER BY id DESC LIMIT 50`,
            [user.username, targetUser, targetUser, user.username],
            (err, rows) => {
                if (!err && rows) {
                    socket.emit('dm-history', {
                        targetUser: targetUser,
                        messages: rows.reverse()
                    });
                }
            }
        );
    });
    
    // Send DM
    socket.on('send-dm', (data) => {
        const user = connectedUsers[socket.id];
        if (!user) return;
        
        const message = sanitize(data.message);
        const receiver = data.receiver;
        if (!message || !receiver) return;
        
        const timestamp = getCurrentTime();
        
        // Save to DB
        db.run('INSERT INTO dms (sender, receiver, message, timestamp) VALUES (?, ?, ?, ?)',
            [user.username, receiver, message, timestamp]);
        
        // Send to sender
        socket.emit('dm-message', {
            sender: user.username,
            receiver: receiver,
            message: message,
            timestamp: timestamp
        });
        
        // Send to receiver if online
        const receiverSocket = Object.keys(connectedUsers).find(
            id => connectedUsers[id].username === receiver
        );
        
        if (receiverSocket) {
            io.to(receiverSocket).emit('dm-message', {
                sender: user.username,
                receiver: receiver,
                message: message,
                timestamp: timestamp
            });
        }
    });
    
    // Disconnect
    socket.on('disconnect', () => {
        const user = connectedUsers[socket.id];
        if (user) {
            mainChatUsers = mainChatUsers.filter(u => u !== user.username);
            io.emit('users-update', mainChatUsers);
            io.emit('system-message', { text: `${user.username} left`, timestamp: getCurrentTime() });
            delete connectedUsers[socket.id];
            console.log(`[DISCONNECT] ${user.username}`);
        }
    });
});

server.listen(PORT, () => {
    console.log('');
    console.log('==========================================');
    console.log('  RETROCHAT95 BETA  ');
    console.log('  By Tricarty - GPL-3.0');
    console.log('==========================================');
    console.log(`  Port: ${PORT}`);
    console.log('  Status: ONLINE');
    console.log('==========================================');
});
