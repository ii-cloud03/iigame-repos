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

function getToday()
{
    return new Date().toISOString().split("T")[0];
}

function GenerateDailyChallenge()
{
    const challenges =
    [
        {
            type: "win_games",
            target: 3,
            reward: 15
        },

        {
            type: "win_games",
            target: 5,
            reward: 25
        },

        {
            type: "play_games",
            target: 5,
            reward: 20
        },

        {
            type: "play_games",
            target: 10,
            reward: 40
        },

        {
            type: "play_friend",
            target: 5,
            reward: 25
        },

        {
            type: "win_friend",
            target: 3,
            reward: 30
        },

        {
            type: "draw_games",
            target: 2,
            reward: 10
        }
    ];

    return challenges[
        Math.floor(Math.random() * challenges.length)
    ];
}

async function UpdateDailyChallengeProgress(username, result, isFriendGame = false)
{
    const ref = dbFirebase.ref("users/" + username);
    const snap = await ref.once("value");

    if (!snap.exists())
        return null;

    const user = snap.val();

    // Challenge sanasi o'tgan bo'lsa,
    // yangi kun uchun yangi challenge yaratamiz
    if (user.dailyChallengeDate !== getToday())
    {
        const challenge = GenerateDailyChallenge();

        user.dailyChallengeType = challenge.type;
        user.dailyChallengeTarget = challenge.target;
        user.dailyChallengeProgress = 0;
        user.dailyChallengeReward = challenge.reward;
        user.dailyChallengeClaimed = false;
        user.dailyChallengeDate = getToday();

        await ref.update({
            dailyChallengeType: challenge.type,
            dailyChallengeTarget: challenge.target,
            dailyChallengeProgress: 0,
            dailyChallengeReward: challenge.reward,
            dailyChallengeClaimed: false,
            dailyChallengeDate: getToday()
        });
    }

    let shouldIncrease = false;

    switch (user.dailyChallengeType)
    {
        // Har qanday o'yinda yutish
        case "win_games":
            if (result === "W")
                shouldIncrease = true;
            break;
            
        // Har qanday o'yinni o'ynash
        case "play_games":
            shouldIncrease = true;
            break;
            
        // Do'st bilan o'ynab yutish
        case "win_friend":
            if (isFriendGame && result === "W")
                shouldIncrease = true;
            break;

        // Do'st bilan o'ynash
        case "play_friend":
            if (isFriendGame)
                shouldIncrease = true;
            break;

        // Durang o'yin
        case "draw_games":
            if (result === "D")
                shouldIncrease = true;

            break;
    }

    // Bu o'yin joriy challengega mos kelmasa
    if (!shouldIncrease)
    {
        return {
            progress: user.dailyChallengeProgress,
            target: user.dailyChallengeTarget,
            completed:
                user.dailyChallengeProgress >=
                user.dailyChallengeTarget
        };
    }

    // Challenge allaqachon tugagan bo'lsa,
    // progressni yana oshirmaymiz
    if (user.dailyChallengeProgress >= user.dailyChallengeTarget)
    {
        return {
            progress: user.dailyChallengeProgress,
            target: user.dailyChallengeTarget,
            completed: true
        };
    }

    user.dailyChallengeProgress++;

    // Targetdan oshib ketmasin
    if (user.dailyChallengeProgress > user.dailyChallengeTarget) {
        user.dailyChallengeProgress = user.dailyChallengeTarget;
    }

    await ref.update({dailyChallengeProgress: user.dailyChallengeProgress});

    return {
        progress: user.dailyChallengeProgress,
        target: user.dailyChallengeTarget,
        completed: user.dailyChallengeProgress >= user.dailyChallengeTarget
    };
}

function SendDailyChallengeProgress(ws, challenge)
{
    if (!ws || ws.readyState !== WebSocket.OPEN)
        return;

    if (!challenge)
        return;

    ws.send(JSON.stringify({
        type: "daily_challenge_progress",
        progress: challenge.progress,
        target: challenge.target,
        completed: challenge.completed
    }));
}

async function IsFriends(username1, username2)
{
    if (!username1 || !username2)
        return false;

    const user1 = username1.toLowerCase();
    const user2 = username2.toLowerCase();

    const snap1 = await dbFirebase.ref("users/" + user1 + "/friends").once("value");
    const snap2 = await dbFirebase.ref("users/" + user2 + "/friends").once("value");

    if (!snap1.exists() || !snap2.exists())
        return false;

    const friends1 = snap1.val();
    const friends2 = snap2.val();

    if (!Array.isArray(friends1) || !Array.isArray(friends2))
        return false;
    
    const user1HasUser2 = friends1.some(friend => String(friend).toLowerCase() === user2);
    const user2HasUser1 = friends2.some(friend => String(friend).toLowerCase() === user1);

    return user1HasUser2 && user2HasUser1;
}

// Friends
async function SendFriendsList(ws, username)
{
    if (!ws || ws.readyState !== WebSocket.OPEN)
        return;

    const snap = await dbFirebase.ref("users/" + username.toLowerCase()).once("value");

    if (!snap.exists())
        return;

    const user = snap.val();

    const friends = Array.isArray(user.friends) ? user.friends : [];
    const result = [];

    for (const friendName of friends)
    {
        const friendUsername = String(friendName).toLowerCase();
        const friendSnap = await dbFirebase.ref("users/" + friendUsername).once("value");

        if (!friendSnap.exists())
            continue;

        const friend = friendSnap.val();
        let isOnline = false;
        const friendWs = onlineUsers[friendUsername];

        if (friendWs && friendWs.readyState === WebSocket.OPEN) {
            isOnline = true;
        }

        result.push({
            username: friend.username,
            avatar: friend.avatar || "default",
            rating: friend.rating || 1000,
            online: isOnline
        });
    }

    ws.send(JSON.stringify({type: "friends_list", friends: result}));
}

async function SendFriendRequests(ws, username)
{
    if (!ws || ws.readyState !== WebSocket.OPEN)
        return;

    console.log("1. SendFriendRequests:", username);
    const path =
        "users/" +
        username.toLowerCase() +
        "/friendRequests";

    console.log("2. Firebase path:", path);
    
    const snap = await dbFirebase.ref("users/" + username.toLowerCase() + "/friendRequests").once("value");

    console.log("3. exists:", snap.exists());
    console.log("4. value:", snap.val());
    
    const requests = snap.exists() && Array.isArray(snap.val()) ? snap.val() : [];

    console.log("5. requests:", requests);
    console.log("6. count:", requests.length);
    
    const result = [];

    for (const requesterName of requests)
    {
        const requesterUsername = String(requesterName).toLowerCase();
        const requesterSnap = await dbFirebase.ref("users/" + requesterUsername).once("value");

        if (!requesterSnap.exists())
            continue;

        const requester = requesterSnap.val();

        result.push({
            username: requester.username,
            avatar: requester.avatar || "default",
            rating: requester.rating || 1000
        });
    }

    console.log("7. result:", result);

    const message = {
        type: "friend_requests",
        requests: result
    };

    console.log(
        "8. sending:",
        JSON.stringify(message)
    );

    ws.send(JSON.stringify(message));
    
    // console.log(
    //     "8. sending:",
    //     JSON.stringify(message)
    // );
    // ws.send(JSON.stringify({type: "friend_requests", requests: result}));
    console.log("9. SENT");
}

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
        winnerCells: [],
        players: [],

        turnDuration: 30,
        turnStartedAt: 0,
        timerInterval: null,
        lastSecond: -1,
        finishing: false,
        
        rematchPlayers: []
    };
}

function GetRemainingSeconds(room)
{
    if (!room.turnStartedAt)
        return room.turnDuration;
    
    const elapsed = (Date.now() - room.turnStartedAt) / 1000;
    const remaining = Math.ceil(room.turnDuration - elapsed);

    return Math.max(0, remaining);
}

function StopRoomTimer(room)
{
    if (!room) return;

    if (room.timerInterval)
    {
        clearInterval(room.timerInterval);
        room.timerInterval = null;
    }

    room.lastSecond = -1;
}

function ResetRoomTimer(room)
{
    room.turnStartedAt = Date.now();
    room.lastSecond = -1;
}

function StartRoomTimer(roomId)
{
    const room = rooms[roomId];
    if (!room) return;

    StopRoomTimer(room);
    ResetRoomTimer(room);

    room.timerInterval = setInterval(async () =>
    {
        const seconds = GetRemainingSeconds(room);

        if (seconds <= 0) {
            if (room.finishing) return;
            
            StopRoomTimer(room);
            // console.log("Time Up:", roomId);
            room.winner = room.turn === "X" ? "O" : "X";
            room.winnerCells = [];
            await FinishGame(roomId);
            return;
        }

        if (seconds !== room.lastSecond) {
            room.lastSecond = seconds;
            broadcastTimer(roomId);
        }

    }, 200);
}

async function FinishGame(roomId)
{
    const room = rooms[roomId];
    if (!room) return;
    if (room.finishing) return;

    room.finishing = true;
    
    StopRoomTimer(room);

    try {
        // =================================
        // FRIEND CHECK
        // =================================

        let isFriendGame = false;

        if (room.players.length >= 2)
        {
            const player1 = room.players[0];
            const player2 = room.players[1];

            isFriendGame = await IsFriends(player1.username, player2.username);
        }
        // =================================
        // UPDATE STATS + DAILY CHALLENGE
        // =================================
        await UpdateStats(room, isFriendGame); //  await UpdateStats(room); th
        await SaveMatch(room);
        broadcastState(roomId);
        broadcastTimer(roomId);
    }
    finally {
        room.finishing = false;
    }
}

function broadcastOnlineCount()
{
    const msg = JSON.stringify({type: "online", count: onlineUsers.size});

    wss.clients.forEach(ws => {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(msg);
        }
    });
}

function broadcastState(roomId) { // broadcast
    const room = rooms[roomId];
    if (!room) return;
    
    const data = JSON.stringify({
        type: "state",
        board: room.board,
        turn: room.turn,
        winner: room.winner,
        winnerCells: room.winnerCells,
    });

    room.players.forEach(p => {
        if (p.ws.readyState === WebSocket.OPEN) {
            p.ws.send(data);
        }
    });
}

function broadcastTimer(roomId) {
    const room = rooms[roomId];
    if (!room) return;
    
    const data = JSON.stringify({
        type: "timer",
        seconds: GetRemainingSeconds(room)
    });

    room.players.forEach(p => {
        if (p.ws.readyState === WebSocket.OPEN) {
            p.ws.send(data);
        }
    });
}

function checkWinner(room) {
    if (room.finishing) return;  //***///
    
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

    // ad
    room.winner = ""; //
    room.winnerCells = []; // 
    
    for (let w of wins) {
        const a = w[0];
        const b1 = w[1];
        const c = w[2];

        if (b[a] !== "" && b[a] === b[b1] && b[a] === b[c]) {
            room.winner = b[a];
            room.winnerCells = w;
            return;
        }
    }

    let draw = true;

    for (let c of room.board) {
        if (c === "") {
            draw = false;
            break;
        }
    }

    if (draw && room.winner === "") {
        room.winner = "DRAW";
        room.winnerCells = [];
    }
}

/////
async function UpdateStats(room, isFriendGame = false)
{
    if (room.winner === "DRAW")
    {
        for (const p of room.players)
        {
            await dbFirebase.ref("users/" + p.username.toLowerCase()).update({
                draws: admin.database.ServerValue.increment(1),
                coins: admin.database.ServerValue.increment(4)
            });
            
            // Daily Challenge
            const challenge = await UpdateDailyChallengeProgress(
                p.username,
                "D",
                isFriendGame
            );

            if (p.ws.readyState === WebSocket.OPEN)
            {
                await SendProfile(p.ws, p.username);
                SendDailyChallengeProgress(p.ws, challenge); /////
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
            coins: admin.database.ServerValue.increment(4),
            rating: admin.database.ServerValue.increment(8)
        });

        // Daily Challenge
        const winnerChallenge =
            await UpdateDailyChallengeProgress(
                winner.username,
                "W",
                isFriendGame
            );

        if (winner.ws.readyState === WebSocket.OPEN) {
            await SendProfile(winner.ws, winner.username);
            SendDailyChallengeProgress(winner.ws, winnerChallenge); //// 
        }
    }

    if (loser)
    {
        await dbFirebase.ref("users/" + loser.username.toLowerCase()).update({
            losses: admin.database.ServerValue.increment(1),
            coins: admin.database.ServerValue.increment(0),
            rating: admin.database.ServerValue.increment(-7)
        });

        // Daily Challenge
        const loserChallenge =
            await UpdateDailyChallengeProgress(
                loser.username,
                "L",
                isFriendGame
            );

        if (loser.ws.readyState === WebSocket.OPEN) {
            await SendProfile(loser.ws, loser.username);
            SendDailyChallengeProgress(loser.ws, loserChallenge);   ///
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

                const challenge = GenerateDailyChallenge();
                
                await dbFirebase.ref("users/" + username).set({
                    // Account
                    username: data.username,
                    password: hashedPassword,
                    email: data.email,
                    
                    // Profile
                    // displayName: data.username,
                    firstName: "",
                    lastName: "",
                    avatar: "default",
                    country: "",
                    location: "",
                    bio: "",
                
                    // Statistics
                    rating: 1000,
                    gamesPlayed: 0,
                    wins: 0,
                    losses: 0,
                    draws: 0,
                    coins: 0,
                    experience: 0,
                    level: 1,
                    vip: false,

                    // 
                    dailyChallengeType: challenge.type,
                    dailyChallengeTarget: challenge.target,
                    dailyChallengeProgress: 0,
                    dailyChallengeReward: challenge.reward,
                    dailyChallengeClaimed: false,
                    dailyChallengeDate: getToday(),
                    dailyRewardClaimed: false,
                    dailyRewardDate: getToday(),
                    dailyRewardCoins: 12,
                    
                    last5: [],
                
                    // Social
                    friends: [],
                    friendRequests: [],
                    blockedUsers: [],

                    // Notifications
                    notifications: [],
                    
                    // Presence
                    status: "offline",
                    lastSeen: Date.now(),
                
                    // Dates
                    createdAt: Date.now(),
                
                    // Settings
                    theme: "dark",
                    language: "english",
                    sounds: true,
                
                    // Security
                    resetCode: "",
                    resetExpire: 0
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

                const updates = {};

                if (user.firstName === undefined) updates.firstName = "";
                if (user.lastName === undefined) updates.lastName = "";
                if (user.avatar === undefined) updates.avatar = "default";
                if (user.country === undefined) updates.country = "";
                if (user.location === undefined) updates.location = "";
                if (user.bio === undefined) updates.bio = "";
                if (user.gamesPlayed === undefined) updates.gamesPlayed = 0;
                if (user.coins === undefined) updates.coins = 0;
                if (user.experience === undefined) updates.experience = 0;
                if (user.level === undefined) updates.level = 1;
                if (user.vip === undefined) updates.vip = false;
                if (user.theme === undefined) updates.theme = "dark";
                if (user.language === undefined) updates.language = "English";
                if (user.sounds === undefined) updates.sounds = true;

                // if (user.games === undefined) updates.games = 0; // gamesPlayed 
                if (user.wins === undefined) updates.wins = 0;
                if (user.losses === undefined) updates.losses = 0;
                if (user.draws === undefined) updates.draws = 0;
                
                if (user.rating === undefined) updates.rating = 1000;
                
                if (user.dailyChallengeType === undefined ||
                    user.dailyChallengeTarget === undefined ||
                    user.dailyChallengeProgress === undefined ||
                    user.dailyChallengeReward === undefined ||
                    user.dailyChallengeClaimed === undefined ||
                    user.dailyChallengeDate === undefined)
                {
                    const challenge = GenerateDailyChallenge();
                    
                    updates.dailyChallengeType = challenge.type;
                    updates.dailyChallengeTarget = challenge.target;
                    updates.dailyChallengeProgress = 0;
                    updates.dailyChallengeReward = challenge.reward;
                    updates.dailyChallengeClaimed = false;
                    updates.dailyChallengeDate = getToday();
                }

                if (user.dailyRewardDate === undefined) updates.dailyRewardDate = getToday();
                if (user.dailyRewardClaimed === undefined) updates.dailyRewardClaimed = false;
                if (user.dailyRewardCoins === undefined) updates.dailyRewardCoins = 12;
                
                if (user.last5 === undefined) updates.last5 = [];
                
                if (Object.keys(updates).length > 0) {
                    await dbFirebase.ref("users/" + username).update(updates);
                    Object.assign(user, updates);
                }

                // Daily Challenge reset
                if (user.dailyChallengeDate !== getToday())
                {
                    const challenge = GenerateDailyChallenge();
                
                    user.dailyChallengeType = challenge.type;
                    user.dailyChallengeTarget = challenge.target;
                    user.dailyChallengeProgress = 0;
                    user.dailyChallengeReward = challenge.reward;
                    user.dailyChallengeClaimed = false;
                    user.dailyChallengeDate = getToday();
                
                    await dbFirebase.ref("users/" + username).update({
                        dailyChallengeType: user.dailyChallengeType,
                        dailyChallengeTarget: user.dailyChallengeTarget,
                        dailyChallengeProgress: user.dailyChallengeProgress,
                        dailyChallengeReward: user.dailyChallengeReward,
                        dailyChallengeClaimed: user.dailyChallengeClaimed,
                        dailyChallengeDate: user.dailyChallengeDate
                    });
                }

                // Daily Reward reset
                if (user.dailyRewardDate !== getToday())
                {
                    user.dailyRewardClaimed = false;
                    user.dailyRewardDate = getToday();
                
                    await dbFirebase.ref("users/" + username).update({
                        dailyRewardClaimed: false,
                        dailyRewardDate: user.dailyRewardDate
                    });
                }
                
                const ok = await bcrypt.compare(data.password, user.password);
                
                if(!ok) { // user.password !== data.password
                    ws.send(JSON.stringify({type: "login_failed", message: "Wrong password"}));
                    return;
                }

                onlineUsers.set(user.username, ws);
                ws.username = user.username;

                // Firebase'da foydalanuvchini online deb belgilash
                await dbFirebase.ref("users/" + username).update({
                    status: "online"
                });
                
                ws.send(JSON.stringify({
                    type: "login_success",

                    // ===== ACCOUNT =====
                    username: user.username,
                    email: user.email,
            
                    // ===== PROFILE =====
                    // displayName: user.displayName,
                    firstName: user.firstName,
                    lastName: user.lastName,
                    avatar: user.avatar,
                    country: user.country,
                    location: user.location,
                    bio: user.bio,
            
                    // ===== STATISTICS =====
                    rating: user.rating,
                    gamesPlayed: user.gamesPlayed,
                    wins: user.wins,
                    losses: user.losses,
                    draws: user.draws,
            
                    coins: user.coins,
                    experience: user.experience,
                    level: user.level,

                    dailyChallengeType: user.dailyChallengeType,
                    dailyChallengeTarget: user.dailyChallengeTarget,
                    dailyChallengeProgress: user.dailyChallengeProgress,
                    dailyChallengeReward: user.dailyChallengeReward,
                    dailyChallengeClaimed: user.dailyChallengeClaimed,

                    dailyRewardClaimed: user.dailyRewardClaimed,
                    dailyRewardCoins: user.dailyRewardCoins,
                    
                    last5: user.last5,
            
                    vip: user.vip,
            
                    // ===== PRESENCE =====
                    status: "online",
                    lastSeen: user.lastSeen,
            
                    // ===== DATES =====
                    createdAt: user.createdAt,
            
                    // ===== SETTINGS =====
                    theme: user.theme,
                    language: user.language,
                    sounds: user.sounds
                }));

                broadcastOnlineCount();

                return;
            }

            else if (data.type === "claim_daily_challenge")
            {
                const username = ws.username;
            
                if (!username)
                    return;
            
                const ref = dbFirebase.ref("users/" + username.toLowerCase());
                const snap = await ref.once("value");
            
                if (!snap.exists())
                    return;
            
                const user = snap.val();
            
                // Yangi kun bo'lsa, bu yerda claim qilmaymiz.
                // Login paytida daily challenge reset qilinadi.
                if (user.dailyChallengeDate !== getToday())
                    return;
            
                // Allaqachon olingan bo'lsa — hech narsa qilmaymiz
                if (user.dailyChallengeClaimed === true)
                    return;
            
                // Challenge hali bajarilmagan bo'lsa — hech narsa qilmaymiz
                if ((user.dailyChallengeProgress || 0) < (user.dailyChallengeTarget || 0))
                    return;
            
                // REWARD
                const reward = user.dailyChallengeReward || 0;
                const newCoins = (user.coins || 0) + reward;
                await ref.update({coins: newCoins, dailyChallengeClaimed: true});
            
                // SUCCESS
                ws.send(JSON.stringify({type: "daily_challenge_claimed", reward: reward, coins: newCoins}));
            }

            if (data.type === "claim_daily_reward")
            {
                const username = ws.username;
            
                if (!username)
                    return;
            
                const ref = dbFirebase.ref("users/" + username.toLowerCase());
                const snap = await ref.once("value");
            
                if (!snap.exists())
                    return;
            
                const user = snap.val();
            
                // Yangi kun bo'lmasa hammasi joyida,
                // login paytida reset qilingan bo'ladi.
                if (user.dailyRewardDate !== getToday())
                    return;
            
                // Allaqachon olingan
                if (user.dailyRewardClaimed === true)
                    return;
            
                // REWARD
                const reward = user.dailyRewardCoins || 12;
                const newCoins = (user.coins || 0) + reward;
                await ref.update({coins: newCoins, dailyRewardClaimed: true});
            
                // SUCCESS
                ws.send(JSON.stringify({type: "daily_reward_claimed", reward: reward, coins: newCoins}));
            }

            else if (data.type === "get_home_data")
            {
                if (!ws.username)
                {
                    ws.send(JSON.stringify({type: "home_failed", message: "Not logged in"}));
                    return;
                }
            
                const username = ws.username.toLowerCase();
                const snap = await dbFirebase.ref("users/" + username).once("value");
            
                if (!snap.exists())
                {
                    ws.send(JSON.stringify({type: "home_failed", message: "User not found"}));
                    return;
                }
            
                const user = snap.val();
            
                const wins = user.wins || 0;
                const losses = user.losses || 0;
                const draws = user.draws || 0;
            
                const games = wins + losses + draws;
                
                ws.send(JSON.stringify({
                    type: "home_data",
                    username: user.username,
                    rating: user.rating || 1000,
                    coins: user.coins || 0,
                    wins: wins,
                    games: games,
                    winRate: games
                            ? ((wins / games) * 100).toFixed(1)
                            : "0.0",
                    experience: user.experience || 0,
                    level: user.level || 1,
                    vip: user.vip || false
                }));
            
                return;
            }

            else if(data.type === "get_friends")
            {
                // ...
                if (!ws.username)
                    return;
            
                await SendFriendsList(ws, ws.username);
            }

            else if(data.type === "get_friend_requests")
            {
                console.log("GET FRIEND REQUESTS:", ws.username);
                // ...
                if (!ws.username)
                    return;
            
                await SendFriendRequests(ws, ws.username);
            }

            else if (data.type === "accept_friend_request")
            {
                const receiver = ws.username;
            
                if (!receiver) return;
            
                const sender = String(msg.username || "").trim().toLowerCase();
                if (!sender) return;
            
                const receiverLower = receiver.toLowerCase();
            
                if (sender === receiverLower) return;
                
                // REQUEST TEKSHIRISH
                const receiverRef = dbFirebase.ref("users/" + receiverLower);
                const receiverSnap = await receiverRef.once("value");
            
                if (!receiverSnap.exists())
                    return;
            
                const receiverUser = receiverSnap.val();
                const requests = Array.isArray(receiverUser.friendRequests) ? receiverUser.friendRequests : [];
                const requestExists = requests.some(x => String(x).toLowerCase() === sender);
            
                if (!requestExists) return;
                
                // FRIENDS
                const receiverFriends = Array.isArray(receiverUser.friends) ? receiverUser.friends : [];
            
                if (!receiverFriends.some(x => String(x).toLowerCase() === sender)) {
                    receiverFriends.push(sender);
                }
            
                const senderRef = dbFirebase.ref("users/" + sender);
                const senderSnap = await senderRef.once("value");
            
                if (!senderSnap.exists())
                    return;
            
                const senderUser = senderSnap.val();
                const senderFriends = Array.isArray(senderUser.friends) ? senderUser.friends : [];
            
                if (!senderFriends.some(x => String(x).toLowerCase() === receiverLower)) {
                    senderFriends.push(receiverLower);
                }
                
                // REQUEST O'CHIRISH
                const newRequests = requests.filter(x => String(x).toLowerCase() !== sender);
                
                // FIREBASE
                await receiverRef.update({friends: receiverFriends, friendRequests: newRequests});
                await senderRef.update({friends: senderFriends});
                
                // RECEIVER
                ws.send(JSON.stringify({type: "friend_request_accepted", username: senderUser.username}));
                
                await SendFriendsList(ws, receiver);
                await SendFriendRequests(ws, receiver);
                
                // SENDER ONLINE BO'LSA
                const senderWs = onlinePlayers[sender];
                
                if (senderWs && senderWs.readyState === WebSocket.OPEN) {
                    senderWs.send(JSON.stringify({type: "friend_request_accepted", username: receiver}));
                    await SendFriendsList(senderWs, sender);
                }
            }

            else if (data.type === "reject_friend_request")
            {
                const receiver = ws.username;
            
                if (!receiver) return;
            
                const sender = String(msg.username || "").trim().toLowerCase();
                if (!sender) return;
            
                const receiverRef = dbFirebase.ref("users/" + receiver.toLowerCase());
                const snap = await receiverRef.once("value");
            
                if (!snap.exists()) return;
            
                const user = snap.val();
                const requests = Array.isArray(user.friendRequests) ? user.friendRequests : [];
                const newRequests = requests.filter(x => String(x).toLowerCase() !== sender);
                
                await receiverRef.update({friendRequests: newRequests});
                
                ws.send(JSON.stringify({type: "friend_request_rejected", username: sender}));
                
                await SendFriendRequests(ws, receiver);
            }

            else if(data.type === "get_notifications")
            {
                // ...
            }

            else if(data.type === "get_profile")
            {
                // ...
            }

            else if (data.type === "profile")
            {
                try
                {
                    const snap = await dbFirebase
                        .ref("users/" + data.username.toLowerCase())
                        .once("value");
            
                    if (!snap.exists()) {
                        ws.send(JSON.stringify({type: "profile_not_found"}));
                        return;
                    }
            
                    const profile = snap.val();
            
                    const wins = profile.wins || 0;
                    const losses = profile.losses || 0;
                    const draws = profile.draws || 0;
                    const games = wins + losses + draws;
            
                    ws.send(JSON.stringify({
                        type: "profile",
                        username: profile.username,
                        country: profile.country,
                        location: profile.location,
                        rating: profile.rating || 0,
                        wins,
                        losses,
                        draws,
                        games,
                        winRate: games
                            ? ((wins / games) * 100).toFixed(1)
                            : "0.0",
                        // bio: profile.bio || "",
                        joined: profile.createdAt || "",
                        lastOnline: profile.lastSeen || "",
                        avatar: profile.avatar || "",
                        status: profile.status || "offline"
                    }));
                }
                catch (err)
                {
                    console.error(err);
                    ws.send(JSON.stringify({type: "profile_failed"}));
                }
            }

            else if (data.type === "update_profile")
            {
                const username = data.username.toLowerCase();
            
                try
                {
                    await dbFirebase.ref("users/" + username).update({
                        firstName: data.firstName || "",
                        lastName: data.lastName || "",
                        country: data.country || "",
                        location: data.location || "",
                        avatar: data.avatar || "default",
                        language: data.language || "English",
                        theme: data.theme || "Dark",
                        sounds: data.sounds === true
                    });
            
                    ws.send(JSON.stringify({type: "profile_updated"}));
                }
                catch (err)
                {
                    console.error(err);
                    ws.send(JSON.stringify({type: "profile_update_failed"}));
                }
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
                        userKey = key;
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
                    name[name.length - 1] + "@" + domain[0] + "*".repeat(Math.max(1, domain.length - 6)) +
                    domain.substring(domain.length - 5);
            
                ws.send(JSON.stringify({type: "forgot_username_found", username: foundUser.username, maskedEmail: maskedEmail}));
            }

            else if (data.type === "verify_code")
            {
                const snap = await dbFirebase.ref("users").once("value");
                const users = snap.val();
            
                let foundUser = null;
            
                for (const key in users)
                {
                    const u = users[key];
            
                    if (u.email && u.email.toLowerCase() === data.email.toLowerCase())
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
            
                if (!foundUser.resetExpire || Date.now() > foundUser.resetExpire)
                {
                    ws.send(JSON.stringify({type: "code_expired"}));
                    return;
                }
            
                if (foundUser.resetCode != data.code)
                {
                    ws.send(JSON.stringify({type: "invalid_code"}));
                    return;
                }
            
                ws.send(JSON.stringify({type: "code_verified"}));
            }

            else if (data.type === "reset_password")
            {
                const snap = await dbFirebase.ref("users").once("value");
                const users = snap.val();
            
                let foundUser = null;
                let userKey = null;
            
                for (const key in users)
                {
                    const u = users[key];
            
                    if (u.email && u.email.toLowerCase() === data.email.toLowerCase())
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
            
                const hashedPassword = await bcrypt.hash(data.password, 10);
            
                await dbFirebase.ref("users/" + userKey).update({
                        password: hashedPassword,
                        resetCode: "",
                        resetExpire: 0
                    });
            
                ws.send(JSON.stringify({type: "password_reset_success"}));
            }
            
            else if (data.type === "create") {
                const roomId = Math.random().toString(36).substring(2, 8);

                rooms[roomId] = createRoom();

                rooms[roomId].players.push({ws: ws, username: ws.username, symbol: "X"});

                ws.symbol = "X"; // ad
                ws.roomId = roomId; // a
                
                ws.send(JSON.stringify({type: "created", roomId: roomId, symbol: "X"}));

                broadcastState(roomId); // add
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

                broadcastState(data.roomId);
            }

            else if (data.type === "leave_match")
            {
                const room = rooms[data.roomId];
                if (!room) return;

                // StopTurnTimer(room);
                StopRoomTimer(room);
                
                const opponent = room.players.find(p => p.ws !== ws);
            
                if (opponent && opponent.ws.readyState === WebSocket.OPEN) {
                    opponent.ws.send(JSON.stringify({type: "opponent_left"})); // raqibga xabar yuborish
                }
            
                ws.send(JSON.stringify({type: "leave_success"}));
                room.players = room.players.filter(p => p.ws !== ws);
            
                if (room.players.length === 0) {
                    delete rooms[data.roomId];
                }
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

                    StartRoomTimer(roomId); // ch order
                    broadcastState(roomId);  // ch order
                    broadcastTimer(roomId);
                    // StartTurnTimer(roomId);
                }
                else {
                    matchmakingQueue.push({ws: ws, username: ws.username});
                    ws.send(JSON.stringify({type: "matchmaking"}));
                }
            }

            else if (data.type === "cancel_matchmaking")
            {
                matchmakingQueue = matchmakingQueue.filter(p => p.ws !== ws);
                ws.send(JSON.stringify({type: "match_cancelled"}));
            }

            else if (data.type === "move") {
                const room = rooms[data.roomId];
                
                if (!room) return;
                if (room.turn !== data.symbol) return;
                if (room.board[data.index] !== "") return;
                if (room.winner !== "") return;
                if (room.finishing) return;
                
                room.board[data.index] = data.symbol;

                room.turn = data.symbol === "X" ? "O" : "X";

                checkWinner(room);

                if (room.winner !== "")
                {
                    // StopTurnTimer(room);   ///////a
                    // await UpdateStats(room);
                    // await SaveMatch(room); ////// 
                    // 3 -> 1
                    await FinishGame(data.roomId);
                    
                    // StopRoomTimer(room);
                    // await UpdateStats(room);
                    // await SaveMatch(room);
                }
                else   /////a
                {
                    // StartTurnTimer(data.roomId);
                    ResetRoomTimer(room);
                }
                
                broadcastState(data.roomId);
                broadcastTimer(data.roomId);
            }

            else if (data.type === "leaderboard")
            {
                const snap = await dbFirebase.ref("users").once("value");
                const users = snap.val();
            
                if (!users)return;
                
                // const list = Object.values(users).sort((a, b) => b.rating - a.rating).slice(0, 10);
                // const list = Object.values(users)
                //     .sort((a, b) => b.rating - a.rating)
                //     .map(user => ({
                //         username: user.username,
                //         rating: user.rating || 0,
                //         wins: user.wins || 0,
                //         losses: user.losses || 0,
                //         draws: user.draws || 0
                //     }));

                const list = Object.values(users)
                    .sort((a, b) => b.rating - a.rating).slice(0, 100)
                    .map(user => {
                        const wins = user.wins || 0;
                        const losses = user.losses || 0;
                        const draws = user.draws || 0;
                        const games = wins + losses + draws;
                
                        return {
                            username: user.username,
                            rating: user.rating || 0,
                            wins,
                            losses,
                            draws,
                            games,
                            winRate: games ? ((wins / games) * 100).toFixed(1) : "0.0"
                        };
                    });
            
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

                // Eski socketni yopamiz
                if (player.ws && player.ws !== ws) {
                    try {
                        player.ws.close();
                    }
                    catch (e) {}
                }
            
                player.ws = ws;
            
                ws.username = data.username;
                ws.roomId = data.roomId;
                ws.symbol = player.symbol;

                onlineUsers.set(data.username, ws);
                
                ws.send(JSON.stringify({
                    type: "reconnected",
                    roomId: data.roomId,
                    symbol: player.symbol, 
                    opponent: room.players.find(p => p.username !== player.username)?.username || ""
                }));
            
                broadcastState(data.roomId);
                broadcastTimer(data.roomId);
            }

            else if (data.type === "rematch_request") {
                const room = rooms[data.roomId];
                if (!room) return;

                if (!room.rematchPlayers.includes(ws.username))  //// 
                    room.rematchPlayers.push(ws.username);   ////

                // Ikkalasi ham bosgan
                if (room.rematchPlayers.length >= 2)
                {
                    room.board = createBoard();
                    room.turn = "X";
                    room.winner = "";

                    // StartTurnTimer(roomId); roomId - ?, data.roomId - !
                    // ResetRoomTimer(room);
                    
                    room.winnerCells = [];
                    room.rematchPlayers = [];

                    room.finishing = false;

                    StartRoomTimer(data.roomId); // not reset
                    broadcastState(data.roomId);
                    broadcastTimer(data.roomId);

                    room.players.forEach(p => {
                        if (p.ws.readyState === WebSocket.OPEN) {
                            p.ws.send(JSON.stringify({type: "rematch_accepted"}));
                        }
                    });
                    
                    return;
                }

                // Faqat bittasi bosgan
                room.players.forEach(p => {
                    if (p.ws !== ws && p.ws.readyState === WebSocket.OPEN) {
                        p.ws.send(JSON.stringify({type: "rematch_request"}));
                    }
                });
            }

            else if (data.type === "rematch_decline")
            {
                const room = rooms[data.roomId];
                if (!room) return;
            
                room.rematchPlayers = [];
            
                room.players.forEach(p => {
                    if (p.ws !== ws && p.ws.readyState === WebSocket.OPEN) {
                        p.ws.send(JSON.stringify({type: "rematch_declined"}));
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
        }
        catch (err) { // catch
            /// a
            console.log(err);
            ws.send(JSON.stringify({type: "error", message: err.toString()}));
            //
        }
    });

    ws.on("close", async () => {

        if (ws.username)
        {
            const current = onlineUsers.get(ws.username);

            if (current === ws) {
                onlineUsers.delete(ws.username);
                try
                {
                    await dbFirebase
                        .ref("users/" + ws.username.toLowerCase())
                        .update({status: "offline", lastSeen: Date.now()});
                } catch (err) {
                    console.error(err);
                }
                
                broadcastOnlineCount();
            }
        }

        // Matchmaking navbatidan chiqarish
        matchmakingQueue = matchmakingQueue.filter(p => p.ws !== ws);

        // Agar o'yinda bo'lsa
        if (ws.roomId) {
            const room = rooms[ws.roomId];
    
            if (room) {
                const opponent = room.players.find(p => p.ws !== ws);
                if (opponent && opponent.ws.readyState === WebSocket.OPEN) {
                    opponent.ws.send(JSON.stringify({type: "opponent_disconnected"}));
                }
            }
        }
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
