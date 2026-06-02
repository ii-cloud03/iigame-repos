const express = require("express");

const WebSocket = require("ws");

const http = require("http");

const app = express();

const server = http.createServer(app);

const wss = new WebSocket.Server({
    server
});

let rooms = {};

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

    ws.on("message", message => {

        try {
            const data = JSON.parse(message);

            if (data.type === "create") {
                const roomId = Math.random().toString(36).substring(2, 8);

                rooms[roomId] = createRoom();

                rooms[roomId].players.push({ws: ws, symbol: "X"});

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

                room.players.push({ws: ws, symbol: "O"});

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

            else if (data.type === "reconnect") {
                const room = rooms[data.roomId];

                if (!room) {
                    ws.send(JSON.stringify({type: "error", message: "Room expired"}));
                    return;
                }
                
                let player = room.players.find(p => p.symbol === data.symbol);
            
                if (!player) {
                    ws.send(JSON.stringify({type: "error", message: "Player not found"}));
                    return;
                }
            
                player.ws = ws;
            
                ws.symbol = data.symbol;
                ws.roomId = data.roomId;
            
                ws.send(JSON.stringify({type: "reconnected", symbol: data.symbol}));
            
                broadcast(data.roomId);
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
});

app.get("/", (req, res) => {
    res.send("Realtime Server");
});

const PORT =
    process.env.PORT || 3000;

server.listen(PORT, () => {
    console.log("Server started");
});
