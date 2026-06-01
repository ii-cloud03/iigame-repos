```javascript
const express = require("express");

const app = express();

app.use(express.json());

let rooms = {};

app.get("/", (req, res) => {
    res.send("TicTacToe Server Online");
});

app.post("/create-room", (req, res) => {

    const roomId = Math.random()
        .toString(36)
        .substring(2, 8);

    rooms[roomId] = {

        board: [
            "", "", "",
            "", "", "",
            "", "", ""
        ],

        turn: "X",

        players: 1,

        winner: ""
    };

    res.json({
        success: true,
        roomId: roomId,
        symbol: "X"
    });
});

app.post("/join-room", (req, res) => {

    const { roomId } = req.body;

    const room = rooms[roomId];

    if (!room) {
        return res.json({
            success: false
        });
    }

    if (room.players >= 2) {
        return res.json({
            success: false
        });
    }

    room.players++;

    res.json({
        success: true,
        symbol: "O"
    });
});

app.post("/make-move", (req, res) => {

    const {
        roomId,
        index,
        symbol
    } = req.body;

    const room = rooms[roomId];

    if (!room) {
        return res.json({
            success: false
        });
    }

    if (room.board[index] !== "") {
        return res.json({
            success: false
        });
    }

    if (room.turn !== symbol) {
        return res.json({
            success: false
        });
    }

    room.board[index] = symbol;

    room.turn = symbol === "X"
        ? "O"
        : "X";

    checkWinner(room);

    res.json({
        success: true
    });
});

app.post("/state", (req, res) => {

    const { roomId } = req.body;

    const room = rooms[roomId];

    if (!room) {
        return res.json({
            success: false
        });
    }

    res.json(room);
});

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

        if (
            room.board[a] !== "" &&
            room.board[a] === room.board[b1] &&
            room.board[a] === room.board[c]
        ) {
            room.winner = room.board[a];
        }
    }
}

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log("Server started");
});
```
