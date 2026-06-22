const express = require("express");

const WebSocket = require("ws");

const http = require("http");

/////
const bcrypt = require("bcryptjs"); ////

const app = express();

const server = http.createServer(app);

const wss = new WebSocket.Server({
    server
});

let rooms = {};
let matchmakingQueue = [];

// firebase ***
const admin = require("firebase-admin");

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: process.env.FIREBASE_DB_URL
});

const dbFirebase = admin.database();

dbFirebase.ref("test").set({ message: "Hello Firebase"})
.then(() => console.log("Firebase OK"))
.catch(err => console.log("Firebase Error:", err));
//// firebase ///

function GenerateCode()
{
    return Math.floor(
        100000 +
        Math.random() * 900000
    ).toString();
}

const onlineUsers = new Map();

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

/////
async function UpdateStats(room)
{
    if (room.winner === "DRAW")
    {
        for (const p of room.players)
        {
            await dbFirebase.ref("users/" + p.username.toLowerCase()).update({
                draws: admin.database.ServerValue.increment(1),
                coins: admin.database.ServerValue.increment(5)
            });

            if (p.ws.readyState === WebSocket.OPEN)
            {
                await SendProfile(p.ws, p.username);
            }
        }

        return;
    }

    const winner = room.players.find(p => p.symbol === room.winner);
    const loser  = room.players.find(p => p.symbol !== room.winner);

    if (winner)
    {
        await dbFirebase.ref("users/" + winner.username.toLowerCase()).update({
            wins: admin.database.ServerValue.increment(1),
            coins: admin.database.ServerValue.increment(10),
            rating: admin.database.ServerValue.increment(25)
        });

        if (winner.ws.readyState === WebSocket.OPEN)
        {
            await SendProfile(winner.ws, winner.username);
        }
    }

    if (loser)
    {
        await dbFirebase.ref("users/" + loser.username.toLowerCase()).update({
            losses: admin.database.ServerValue.increment(1),
            coins: admin.database.ServerValue.increment(2),
            rating: admin.database.ServerValue.increment(-10)
        });

        if (loser.ws.readyState === WebSocket.OPEN)
        {
            await SendProfile(loser.ws, loser.username);
        }
    }
}
////

//////
async function SendProfile(ws, username)
{
    const snap = await dbFirebase.ref("users/" + username.toLowerCase()).once("value");
    
    if (!snap.exists()) return;

    const user = snap.val();

    ws.send(JSON.stringify({
        type: "profile_update",
        rating: user.rating,
        coins: user.coins,
        wins: user.wins,
        losses: user.losses,
        draws: user.draws,
        vip: user.vip
    }));
}
//////

///////
async function SaveMatch(room)
{
    const playerX = room.players.find(p => p.symbol === "X");

    const playerO = room.players.find(p => p.symbol === "O");

    if (!playerX || !playerO) return;

    let winner = room.winner;

    if (winner === "X")
        winner = playerX.username;

    else if (winner === "O")
        winner = playerO.username;

    await dbFirebase.ref("matches").push({
        playerX: playerX.username,
        playerO: playerO.username,
        winner: winner,
        date: Date.now()
    });
}
///////

wss.on("connection", ws => {
    broadcastOnlineCount();
    ws.on("message", async message => {
        try {
            const data = JSON.parse(message);

            if (data.type === "register") {
                if(!IsValidUsername(data.username)) {
                    ws.send(JSON.stringify({type: "register_failed", message: "Invalid username"}));
                    return;
                }

                const username = data.username.toLowerCase();
                const snap = await dbFirebase.ref("users/" + username).once("value");

                if(snap.exists()) {
                    ws.send(JSON.stringify({type: "register_failed", message: "Username already exists"}));
                    return;
                }

                const hashedPassword = await bcrypt.hash(data.password, 10);

                await dbFirebase.ref("users/" + username).set({
                    username: data.username, 
                    password: hashedPassword,
                    email: data.email, // 
                    rating: 1000,
                    wins: 0,
                    losses: 0,
                    draws: 0,
                    coins: 0,
                    vip: false,
                    friends: []
                });

                ws.send(JSON.stringify({type: "register_success"}));

                return;
            }

            else if (data.type === "login") {
                const username = data.username.toLowerCase();
                const snap = await dbFirebase.ref("users/" + username).once("value");
                
                if(!snap.exists()) {
                    ws.send(JSON.stringify({type: "login_failed", message: "User nout found"}));
                    return;
                }

                const user = snap.val();
                const ok = await bcrypt.compare(data.password, user.password);
                
                if(!ok) { // user.password !== data.password
                    ws.send(JSON.stringify({type: "login_failed", message: "Wrong password"}));
                    return;
                }

                onlineUsers.set(user.username, ws);
                ws.username = user.username;
                ws.send(JSON.stringify({
                    type: "login_success",
                    username: user.username,
                    rating: user.rating,
                    coins: user.coins,
                    wins: user.wins,
                    losses: user.losses,
                    draws: user.draws,
                    vip: user.vip
                }));

                return;
            }

            else if (data.type === "verify_reset_email")
            {
                const snap = await dbFirebase.ref("users").once("value");
                const users = snap.val();
            
                let foundUser = null;
                let userKey = null;
            
                for (const key in users)
                {
                    const u = users[key];
                    if (u.username && u.username.toLowerCase() === data.username.toLowerCase())
                    {
                        foundUser = u;
                        userKey = key;
                        break;
                    }
                }
            
                if (!foundUser)
                {
                    ws.send(JSON.stringify({type: "forgot_failed"}));
                    return;
                }
                
                if(!foundUser.email || foundUser.email.trim().toLowerCase() !== data.email.trim().toLowerCase())
                {
                    ws.send(JSON.stringify({type: "email_mismatch"}));
                    return;
                }
                
                const code = GenerateCode();
            
                await dbFirebase.ref("users/" + userKey).update({
                    resetCode: code, resetExpire: Date.now() + 10 * 60 * 1000
                });
            
                ws.send(JSON.stringify({type: "forgot_sent", code: code}));
            }

            else if (data.type === "forgot_start")
            {
                const snap = await dbFirebase.ref("users").once("value");
                const users = snap.val();
            
                if (!users)
                {
                    ws.send(JSON.stringify({type: "forgot_failed"}));
                    return;
                }
            
                let foundUser = null;
                let userKey = null;
                
                for (const key in users)
                {
                    const u = users[key];
            
                    if (u.username && u.username.toLowerCase() === data.value.toLowerCase())
                    {
                        foundUser = u;
                        userKey = key;
                        break;
                    }
            
                    if (u.email && u.email.toLowerCase() === data.value.toLowerCase())
                    {
                        foundUser = u;
                        break;
                    }
                }
            
                if (!foundUser)
                {
                    ws.send(JSON.stringify({type: "forgot_failed"}));
                    return;
                }

                // Email kiritilgan
                if (foundUser.email.toLowerCase() === data.value.toLowerCase())
                {
                    /**/
                    const code = GenerateCode();
                    await dbFirebase.ref("users/" + userKey).update({
                        resetCode: code, resetExpire: Date.now() + 10 * 60 * 1000
                    });
            
                    ws.send(JSON.stringify({type: "forgot_sent", code: code}));
                    /**/
                    
                    return;
                }

                // USERNAME kiritilgan
                const email = foundUser.email;
                const parts = email.split("@");
            
                const name = parts[0];
                const domain = parts[1];
            
                const maskedEmail = name[0] + "*".repeat(Math.max(1, name.length - 2)) +
                    name[name.length - 1] + "@" + domain[0] + "*".repeat(Math.max(1, domain.length - 5)) +
                    domain.substring(domain.length - 4);
            
                ws.send(JSON.stringify({type: "forgot_username_found", username: foundUser.username, maskedEmail: maskedEmail}));
            }
            
            else if (data.type === "create") {
                const roomId = Math.random().toString(36).substring(2, 8);

                rooms[roomId] = createRoom();

                rooms[roomId].players.push({ws: ws, username: ws.username, symbol: "X"});

                ws.symbol = "X"; // ad
                ws.roomId = roomId; // a
                
                ws.send(JSON.stringify({type: "created", roomId: roomId, symbol: "X"}));

                broadcast(roomId); // add
            }

            else if (data.type === "join") {
                const room = rooms[data.roomId];

                if (!room) {
                    ws.send(JSON.stringify({type: "error", message: "Room not found"}));
                    return;
                }
                if (room.players.length >= 2) {
                    ws.send(JSON.stringify({type: "error", message: "Room full"}));
                    return;
                }

                room.players.push({ws: ws, username: ws.username, symbol: "O"});

                ws.symbol = "O"; // a
                ws.roomId = data.roomId; // a
                
                ws.send(JSON.stringify({type: "joined", symbol: "O"}));

                broadcast(data.roomId);
            }

            else if (data.type === "find_match")
            {
                if (!ws.username) return;
            
                matchmakingQueue = matchmakingQueue.filter(p => p.ws !== ws);
            
                if (matchmakingQueue.length > 0)
                {
                    const opponent = matchmakingQueue.shift();
            
                    const roomId = Math.random().toString(36).substring(2, 8);
            
                    rooms[roomId] = createRoom();
            
                    rooms[roomId].players.push({ws: opponent.ws, username: opponent.username, symbol: "X"});
                    rooms[roomId].players.push({ws: ws, username: ws.username, symbol: "O"});
            
                    opponent.ws.roomId = roomId;
                    opponent.ws.symbol = "X";
            
                    ws.roomId = roomId;
                    ws.symbol = "O";
            
                    opponent.ws.send(JSON.stringify({
                        type: "match_found",
                        roomId: roomId,
                        symbol: "X",
                        opponent: ws.username
                    }));
            
                    ws.send(JSON.stringify({
                        type: "match_found",
                        roomId: roomId,
                        symbol: "O",
                        opponent: opponent.username
                    }));
            
                    broadcast(roomId);
                }
                else
                {
                    matchmakingQueue.push({ws: ws, username: ws.username});
                    ws.send(JSON.stringify({type: "matchmaking"}));
                }
            }

            else if (data.type === "cancel_matchmaking")
            {
                matchmakingQueue = matchmakingQueue.filter(p => p.ws !== ws);
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

                if (room.winner !== "")
                {
                    await UpdateStats(room);
                    await SaveMatch(room); ////// 
                }
                
                broadcast(data.roomId);
            }

            else if (data.type === "leaderboard")
            {
                const snap = await dbFirebase.ref("users").once("value");
                const users = snap.val();
            
                if (!users)return;
                
                const list = Object.values(users).sort((a, b) => b.rating - a.rating).slice(0, 10);
            
                ws.send(JSON.stringify({type: "leaderboard", players: list}));
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

            else if (data.type === "history")
            {
                if (!ws.username) return;
            
                const snap = await dbFirebase.ref("matches").once("value");
            
                const matches = snap.val();
                if (!matches) return;
            
                const result = [];
            
                Object.values(matches).reverse().forEach(m => {
                    if (m.playerX === ws.username || m.playerO === ws.username) {
                        result.push(m);
                    }
                });
            
                ws.send(JSON.stringify({type: "history", matches: result.slice(0, 20)}));
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
        catch (err) { // catch
            /// a
            console.log(err);
            ws.send(JSON.stringify({type: "error", message: err.toString()}));
            //
        }
    });

    ws.on("close", () => {

        if(ws.username) {
            onlineUsers.delete(ws.username);
        }
        matchmakingQueue = matchmakingQueue.filter(p => p.ws !== ws);
        broadcastOnlineCount();
        // console.log("Client disconnected");
    });
});

app.get("/", (req, res) => {
    res.send("Realtime Server");
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
    console.log("Server started");
});
