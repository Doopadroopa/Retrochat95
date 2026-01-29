const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');

// Create the app
const app = express();
const server = http.createServer(app);

// Setup Socket.IO with CORS (allows frontend to connect from anywhere)
const io = socketIo(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// What port to run on (Railway sets this automatically)
const PORT = process.env.PORT || 3000;

// Serve your HTML file
app.use(express.static(__dirname));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Keep track of all connected users
let connectedUsers = {};

// When someone connects to the chat
io.on('connection', (socket) => {
    console.log('Someone connected! Their ID:', socket.id);

    // When someone logs in with their username
    socket.on('user-login', (data) => {
        console.log('User logged in:', data.username);
        
        // Save their info
        connectedUsers[socket.id] = {
            username: data.username,
            color: data.color
        };
        
        // Tell everyone who's online
        const usernames = Object.values(connectedUsers).map(u => u.username);
        io.emit('users-update', usernames);
        
        // Tell everyone someone joined
        io.emit('user-joined', {
            username: data.username
        });
    });

    // When someone sends a message
    socket.on('chat-message', (data) => {
        const user = connectedUsers[socket.id];
        
        if (user) {
            console.log('Message from', user.username + ':', data.message);
            
            // Send it to EVERYONE
            io.emit('chat-message', {
                username: user.username,
                color: user.color,
                message: data.message,
                timestamp: data.timestamp
            });
        }
    });

    // When someone uploads an image
    socket.on('image-upload', (data) => {
        const user = connectedUsers[socket.id];
        
        if (user) {
            console.log('Image from', user.username);
            
            // Send it to EVERYONE
            io.emit('image-message', {
                username: user.username,
                color: user.color,
                imageData: data.imageData,
                timestamp: data.timestamp
            });
        }
    });

    // When someone is typing
    socket.on('typing', () => {
        const user = connectedUsers[socket.id];
        
        if (user) {
            // Tell everyone EXCEPT the person typing
            socket.broadcast.emit('user-typing', {
                username: user.username
            });
        }
    });

    // When someone stops typing
    socket.on('stop-typing', () => {
        socket.broadcast.emit('user-stop-typing');
    });

    // When someone disconnects
    socket.on('disconnect', () => {
        const user = connectedUsers[socket.id];
        
        if (user) {
            console.log('User left:', user.username);
            
            // Tell everyone they left
            io.emit('user-left', {
                username: user.username
            });
            
            // Remove them from the list
            delete connectedUsers[socket.id];
            
            // Update everyone's user list
            const usernames = Object.values(connectedUsers).map(u => u.username);
            io.emit('users-update', usernames);
        }
    });
});

// Start the server!
server.listen(PORT, () => {
    console.log('🚀 Server is running on port', PORT);
    console.log('📡 Ready for connections!');
});
