const express = require("express");

const WebSocket = require("ws");

const http = require("http");

const app = express();

const server = http.createServer(app);

const wss = new WebSocket.Server({
    server
});

let rooms = {};

// firebase ***
const admin = require("firebase-admin");

const serviceAccount =
    JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

serviceAccount.private_key =
    serviceAccount.private_key.replace(/\\n/g, '\n');

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: process.env.FIREBASE_DB_URL
});

const dbFirebase = admin.database();

dbFirebase.ref("test").set({
    message: "Hello Firebase"
})
.then(() => console.log("Firebase OK"))
.catch(err => console.log("Firebase Error:", err));

//// firebase ///
const fs = require("fs");

let db;

if (fs.existsSync("users.json"))
{
    db = JSON.parse(
        fs.readFileSync(
            "users.json",
            "utf8"
        )
    );
}
else
{
    db = {
        users: []
    };
}

const onlineUsers = new Map();

function SaveUsers()
{
    fs.writeFileSync("users.json", JSON.stringify(db, null, 4));
}

function IsValidUsername(username)
{
    return /^[A-Za-z0-9_]{3,16}$/.test(username);
}

function createBoard()
{
    return [
        "", "", "",
        "", "", "",
        "", "", ""
    ];
}

function createRoom() {
    return {
        board: createBoard(),
        turn: "X",
        winner: "",
        players: []
    };
}

function broadcastOnlineCount()
{
    const online = onlineUsers.size;
    const msg = JSON.stringify({type: "online", count: online});

    wss.clients.forEach(ws => {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(msg);
        }
    });
}

function broadcast(roomId) {
    const room = rooms[roomId];

    if (!room) return;

    const data = JSON.stringify({
        type: "state",
        board: room.board,
        turn: room.turn,
        winner: room.winner
    });

    room.players.forEach(p => {
        if (p.ws.readyState === WebSocket.OPEN) {
            p.ws.send(data);
        }
    });
}

function checkWinner(room) {
    const b = room.board;

    const wins = [
        [0,1,2],
        [3,4,5],
        [6,7,8],

        [0,3,6],
        [1,4,7],
        [2,5,8],

        [0,4,8],
        [2,4,6]
    ];

    for (let w of wins) {
        const a = w[0];
        const b1 = w[1];
        const c = w[2];

        if (b[a] !== "" && b[a] === b[b1] && b[a] === b[c]) {
            room.winner = b[a];
        }
    }

    let draw = true;

    for (let c of room.board) {
        if (c === "") {
            draw = false;
        }
    }

    if (draw && room.winner === "") {
        room.winner = "DRAW";
    }
}

wss.on("connection", ws => {
    broadcastOnlineCount();
    ws.on("message", message => {
        try {
            const data = JSON.parse(message);

            if (data.type === "register") {
                if(!IsValidUsername(data.username)) {
                    ws.send(JSON.stringify({type: "register_failed", message: "Invalid username"}));
                    return;
                }

                const exists = db.users.find(u => u.username.toLowerCase() === data.username.toLowerCase());

                if(exists) {
                    ws.send(JSON.stringify({type: "register_failed", message: "Username already exists"}));
                    return;
                }

                db.users.push({
                    username: data.username, 
                    password: data.password,
                    email: data.email, // 
                    rating: 1000,
                    wins: 0,
                    losses: 0,
                    draws: 0,
                    coins: 0,
                    vip: false,
                    friends: []
                });

                SaveUsers();

                ws.send(JSON.stringify({type: "register_success"}));

                return;
            }

            else if (data.type === "login") {
                const user = db.users.find(u => u.username.toLowerCase() === data.username.toLowerCase());

                if(!user) {
                    ws.send(JSON.stringify({type: "login_failed", message: "User nout found"}));
                    return;
                }

                if(user.password !== data.password) {
                    ws.send(JSON.stringify({type: "login_failed", message: "Wrong password"}));
                    return;
                }

                onlineUsers.set(user.username, ws);
                ws.username = user.username;
                ws.send(JSON.stringify({type: "login_success", username: user.username, rating: user.rating, coins: user.coins}));

                return;
            }
               
            else if (data.type === "create") {
                const roomId = Math.random().toString(36).substring(2, 8);

                rooms[roomId] = createRoom();

                rooms[roomId].players.push({ws: ws, username: ws.username, symbol: "X"});

                ws.symbol = "X"; // ad
                ws.roomId = roomId; // a
                
                ws.send(JSON.stringify({
                    type: "created",
                    roomId: roomId,
                    symbol: "X"
                }));

                broadcast(roomId); // add
            }

            else if (data.type === "join") {
                const room = rooms[data.roomId];

                if (!room) {
                    ws.send(JSON.stringify({type: "error", message: "Room not found"}));
                    return;
                }
                if (room.players.length >= 2) {
                    ws.send(JSON.stringify({
                        type: "error", message: "Room full"}));
                    return;
                }

                room.players.push({ws: ws, username: ws.username, symbol: "O"});

                ws.symbol = "O"; // a
                ws.roomId = data.roomId; // a
                
                ws.send(JSON.stringify({type: "joined", symbol: "O"}));

                broadcast(data.roomId);
            }

            else if (data.type === "move") {
                const room = rooms[data.roomId];
                
                if (!room) return;
                if (room.turn !== data.symbol) return;
                if (room.board[data.index] !== "") return;
                if (room.winner !== "") return;

                room.board[data.index] = data.symbol;

                room.turn = data.symbol === "X" ? "O" : "X";

                checkWinner(room);

                broadcast(data.roomId);
            }

            else if (data.type === "typing") {
                const room = rooms[data.roomId];
                if (!room) return;

                room.players.forEach(p => {
                    if (p.ws !== ws && p.ws.readyState === WebSocket.OPEN) {
                        p.ws.send(JSON.stringify({type: "typing"}));
                    }
                });
            }

            else if (data.type === "ping") {
                ws.send(JSON.stringify({type: "pong"}));
            }

            else if (data.type === "reconnect") {
                const room = rooms[data.roomId];

                if (!room) {
                    ws.send(JSON.stringify({type: "error", message: "Room expired"}));
                    return;
                }
                
                let player = room.players.find(p => p.username === data.username);
            
                if (!player) {
                    ws.send(JSON.stringify({type: "error", message: "Player not found"}));
                    return;
                }
            
                player.ws = ws;
            
                ws.username = data.username;
                ws.roomId = data.roomId;
                ws.symbol = player.symbol;

                onlineUsers.set(data.username, ws);
                
                ws.send(JSON.stringify({type: "reconnected", symbol: player.symbol}));
            
                broadcast(data.roomId);
            }

            else if (data.type === "rematch_request") {
                const room = rooms[data.roomId];
                if (!room) return;

                room.players.forEach(p => {
                    if (p.ws !== ws && p.ws.readyState === WebSocket.OPEN) {
                        p.ws.send(JSON.stringify({type: "rematch_request"}));
                    }
                });
            }
                
            else if (data.type === "chat") {
                const room = rooms[data.roomId];
                if (!room) return;
                const msg = JSON.stringify({type: "chat", symbol: data.symbol, message: data.message});
                
                room.players.forEach(p => {
                    if (p.ws.readyState === WebSocket.OPEN) {
                        p.ws.send(msg);
                    }
                });
            }
                
            else if (data.type === "restart") {
                const room = rooms[data.roomId];

                if (!room) return;
                if (room.winner === "") return;
                
                room.board = createBoard();
                room.turn = "X";
                room.winner = "";

                broadcast(data.roomId);
            }
        }
        catch {

        }
    });

    ws.on("close", () => {

        if(ws.username) {
            onlineUsers.delete(ws.username);
        }
        
        broadcastOnlineCount();
        // console.log("Client disconnected");
    });
});

app.get("/", (req, res) => {
    res.send("Realtime Server");
});

const PORT =
    process.env.PORT || 3000;

server.listen(PORT, () => {
    console.log("Server started");
});
