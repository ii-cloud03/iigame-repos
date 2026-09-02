const express = require("express");
const WebSocket = require("ws");
const http = require("http");
const crypto = require("crypto");

/////
const bcrypt = require("bcryptjs"); ////
const app = express();
app.use(express.json()); /// 
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
        {type: "win_games", target: 3, reward: 15},
        {type: "win_games", target: 5, reward: 25},
        {type: "play_games", target: 5, reward: 20},
        {type: "play_games", target: 10, reward: 40},
        {type: "play_friend", target: 5, reward: 25},
        {type: "win_friend", target: 3, reward: 30},
        {type: "draw_games", target: 2, reward: 10}
    ];

    return challenges[Math.floor(Math.random() * challenges.length)];
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
        const friendWs = onlineUsers.get(friendUsername.toLowerCase());

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
    
    const snap = await dbFirebase.ref("users/" + username.toLowerCase() + "/friendRequests").once("value");
    const requests = snap.exists() && Array.isArray(snap.val()) ? snap.val() : [];
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

    // const message = {
    //     type: "friend_requests",
    //     requests: result
    // };

    // ws.send(JSON.stringify(message));
    
    ws.send(JSON.stringify({type: "friend_requests", requests: result}));
}

async function UpdateLast5(username, result)
{
    const usernameLower = username.toLowerCase();
    const userRef = dbFirebase.ref("users/" + usernameLower);
    const snap = await userRef.once("value");
    if (!snap.exists()) return;
    const user = snap.val();
    let last5 = Array.isArray(user.last5) ? [...user.last5] : [];

    // Faqat W / L / D
    if (result !== "W" && result !== "L" && result !== "D")
        return;

    // 5 taga yetgan bo'lsa,
    // eng eski natijani olib tashlaymiz
    if (last5.length >= 5)
    {
        last5.shift();
    }

    // Yangi natija oxiriga
    last5.push(result);

    await userRef.update({last5: last5});
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

const TELEGRAM_BOT_TOKEN = process.env.TB_TOKEN || "";
const TELEGRAM_WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET || "";
const TELEGRAM_API = "https://api.telegram.org/bot" + TELEGRAM_BOT_TOKEN;

function GenerateTelegramLinkCode()
{
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let code = "";
    
    for (let i = 0; i < 10; i++) {
        code += chars[Math.floor(Math.random() * chars.length)];
    }

    return code;
}

async function TelegramApi(method, params = {})
{
    if (!TELEGRAM_BOT_TOKEN)
    {
        throw new Error("TELEGRAM_BOT_TOKEN is not configured.");
    }

    const response = await fetch(
        TELEGRAM_API + "/" + method,
        {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify(params)
        }
    );

    const result = await response.json();

    if (!result.ok) {
        throw new Error("Telegram API error: " + JSON.stringify(result));
    }

    return result.result;
}

async function CreateTelegramGemOrder(username, packageId)
{
    const cleanUsername = String(username || "").trim().toLowerCase();
    const pack = TELEGRAM_GEMS_PACKAGES[packageId];
    if (!cleanUsername) throw new Error("Username is required.");
    if (!pack) throw new Error("Invalid Gems package.");

    const transactionId = "tg_" + Date.now() + "_" + crypto.randomBytes(6).toString("hex");

    await dbFirebase
        .ref("telegramPayments/" + transactionId)
        .set({
            username: cleanUsername,
            package: packageId,
            gems: pack.gems,
            stars: pack.stars,
            status: "pending",
            telegramPaymentChargeId: "",
            telegramUserId: "",
            createdAt: Date.now()
        });

    return {transactionId, package: pack};
}

app.post("/telegram/webhook",
    express.json(),
    async (req, res) =>
    {
        try
        {
            const secret = req.headers["x-telegram-bot-api-secret-token"];

            if (TELEGRAM_WEBHOOK_SECRET && secret !== TELEGRAM_WEBHOOK_SECRET) {
                return res.sendStatus(403);
            }
            const update = req.body;
            await HandleTelegramUpdate(update);
            res.sendStatus(200);
        }
        catch (error)
        {
            console.error("TELEGRAM WEBHOOK ERROR:", error);
            res.sendStatus(500);
        }
    }
);

async function HandleTelegramMessage(message)
{
    try
    {
        if (!message || !message.from)
            return;

        const chatId = message.chat
            ? message.chat.id
            : message.from.id;

        const telegramUserId = message.from.id;
        const username = message.from.username || "";
        const text = String(message.text || "").trim();

        // console.log(
        //     "TELEGRAM MESSAGE:",
        //     {
        //         telegramUserId,
        //         chatId,
        //         text
        //     }
        // );

        //start
        if (text === "/start")
        {
            await TelegramApi(
                "sendMessage",
                {
                    chat_id: chatId,
                    text:
                        "Salom! 👋\n\n" +
                        "TicTacToe payment botiga xush kelibsiz.\n\n" +
                        "Game'dan Telegram ulash kodini oling."
                }
            );

            return;
        }

        // start CODE
        if (text.startsWith("/start "))
        {
            const code = text.substring(7).trim();
            if (!code) return;

            // await TelegramApi(
            //     "sendMessage",
            //     {
            //         chat_id: chatId,
            //         text:
            //             "🔗 Linking code qabul qilindi:\n\n" +
            //             code +
            //             "\n\n" +
            //             "Hozircha linking server qismini ham qo'shamiz."
            //     }
            // );

            const codeRef = dbFirebase.ref("telegramLinkCodes/" + code);
            const snap = await codeRef.once("value");
            if (!snap.exists())
            {
                await TelegramApi(
                    "sendMessage",
                    {
                        chat_id: chatId,
                        text:
                            "❌ Link code noto'g'ri yoki eskirgan."
                    }
                );
                return;
            }

            const linkData = snap.val();

            /*
             * EXPIRATION
             */
            if (!linkData.expiresAt || Date.now() > Number(linkData.expiresAt))
            {
                await codeRef.remove();

                await TelegramApi(
                    "sendMessage",
                    {
                        chat_id: chatId,
                        text:
                            "❌ Link code muddati tugagan.\n" +
                            "Game'dan yangi kod oling."
                    }
                );

                return;
            }

            const username =
                String(linkData.username || "")
                    .trim()
                    .toLowerCase();

            if (!username)
            {
                await codeRef.remove();

                await TelegramApi(
                    "sendMessage",
                    {
                        chat_id: chatId,
                        text:
                            "❌ Invalid link code."
                    }
                );

                return;
            }

            /*
             * USER EXISTS
             */
            const userRef =
                dbFirebase.ref(
                    "users/" + username
                );

            const userSnap = await userRef.once("value");

            if (!userSnap.exists())
            {
                await codeRef.remove();

                await TelegramApi(
                    "sendMessage",
                    {
                        chat_id: chatId,
                        text:
                            "❌ Game account topilmadi."
                    }
                );

                return;
            }

            /*
             * TELEGRAM ACCOUNTNI SAQLASH
             */
            await userRef.update({
                telegram: {
                    userId: String(telegramUserId),
                    chatId: String(chatId),
                    username:
                        message.from.username || "",
                    linkedAt: Date.now()
                }
            });

            /*
             * CODENI BIR MARTALIK QILAMIZ
             */
            await codeRef.remove();

            await TelegramApi(
                "sendMessage",
                {
                    chat_id: chatId,
                    text:
                        "✅ Account successfully linked!\n\n" +
                        "Game account: " +
                        username +
                        "\n\n" +
                        "Endi Telegram Stars orqali Gems sotib olishingiz mumkin."
                }
            );

            /*
             * USER ONLINE BO'LSA GAMEGA HAM XABAR
             */
            const gameWs = onlineUsers.get(username);

            if (gameWs && gameWs.readyState === WebSocket.OPEN)
            {
                gameWs.send(JSON.stringify({type: "telegram_link_success"}));
            }
            return;
        }

        /*
         * Oddiy xabar
         */
        await TelegramApi(
            "sendMessage",
            {
                chat_id: chatId,
                text:
                    "/start to connect account"
            }
        );
    }
    catch (error)
    {
        console.error(
            "HANDLE TELEGRAM MESSAGE ERROR:",
            error
        );
    }
}

async function HandleTelegramUpdate(update)
{
    if (!update)
        return;

    if (update.pre_checkout_query)
    {
        await HandleTelegramPreCheckout(update.pre_checkout_query);
        return;
    }

    if (update.message && update.message.successful_payment)
    {
        await HandleTelegramSuccessfulPayment(update.message);
        return;
    }

    if (update.message) {
        await HandleTelegramMessage(update.message);
    }
}

async function HandleTelegramPreCheckout(query)
{
    try
    {
        const payload = String(query.invoice_payload || "");
        const paymentRef = dbFirebase.ref("telegramPayments/" + payload);
        const snap = await paymentRef.once("value");

        if (!snap.exists())
        {
            await TelegramApi(
                "answerPreCheckoutQuery",
                {
                    pre_checkout_query_id: query.id,
                    ok: false,
                    error_message: "Order not found."
                }
            );
            return;
        }

        const payment = snap.val();

        if (payment.status !== "pending")
        {
            await TelegramApi(
                "answerPreCheckoutQuery",
                {
                    pre_checkout_query_id: query.id,
                    ok: false,
                    error_message: "This order is no longer available."
                }
            );
            return;
        }

        if (Number(query.total_amount) !== Number(payment.stars))
        {
            await TelegramApi(
                "answerPreCheckoutQuery",
                {
                    pre_checkout_query_id: query.id,
                    ok: false,
                    error_message: "Invalid payment amount."
                }
            );
            return;
        }

        await TelegramApi(
            "answerPreCheckoutQuery",
            {
                pre_checkout_query_id: query.id,
                ok: true
            }
        );
    }
    catch (error)
    {
        console.error("PRECHECKOUT ERROR:", error);

        await TelegramApi(
            "answerPreCheckoutQuery",
            {
                pre_checkout_query_id: query.id,
                ok: false,
                error_message: "Payment could not be processed."
            }
        );
    }
}

async function HandleTelegramSuccessfulPayment(message)
{
    const payment = message.successful_payment;
    if (!payment) return;
    
    const transactionId = String(payment.invoice_payload || "");
    if (!transactionId) return;

    const paymentRef = dbFirebase.ref("telegramPayments/" + transactionId);
    const paymentSnap = await paymentRef.once("value");

    if (!paymentSnap.exists())
    {
        console.error("UNKNOWN TELEGRAM PAYMENT:", transactionId);
        return;
    }

    const order = paymentSnap.val();
    
    // DUPLICATE PAYMENT HIMOYASI
    if (order.status === "completed")
    {
        console.log("PAYMENT ALREADY COMPLETED:", transactionId);
        return;
    }

    if (order.status !== "pending")
        return;

    // AMOUNT VALIDATION
    if (Number(payment.total_amount) !== Number(order.stars))
    {
        console.error(
            "PAYMENT AMOUNT MISMATCH:",
            transactionId
        );

        await paymentRef.update({
            status: "amount_mismatch",
            updatedAt: Date.now()
        });

        return;
    }
    
    // SAVE TELEGRAM PAYMENT ID
    await paymentRef.update({
        telegramPaymentChargeId: payment.telegram_payment_charge_id || "",
        telegramUserId: String(message.from?.id || ""),
        status: "paid",
        paidAt: Date.now()
    });

    // KEYIN GEMS BERAMIZ
    await AddPurchasedGems(
        order.username,
        order.gems
    );

    await paymentRef.update({
        status: "completed",
        completedAt: Date.now()
    });

    console.log(
        "✅ TELEGRAM PAYMENT COMPLETED:",
        transactionId,
        order.username,
        order.gems,
        "Gems"
    );

    SendPaymentUpdateToGame(order.username, order.gems);
}

async function AddPurchasedGems(username, gems)
{
    const cleanUsername = String(username).trim().toLowerCase();
    const gemsAmount = Number(gems);

    if (!cleanUsername || !Number.isSafeInteger(gemsAmount) || gemsAmount <= 0) {
        throw new Error("Invalid Gems purchase.");
    }

    const userRef = dbFirebase.ref("users/" + cleanUsername);
    const snapshot = await userRef.once("value");

    if (!snapshot.exists()) {
        throw new Error("User not found: " + cleanUsername);
    }

    await userRef.transaction(
        user =>
        {
            if (!user) return user;
            const currentGems = Number(user.gems || 0);
            user.gems = currentGems + gemsAmount;
            user.coins = user.coins + gemsAmount;    /////////////////
            return user;
        }
    );
}

function SendPaymentUpdateToGame(username, gems)
{
    const target = onlineUsers.get(String(username).toLowerCase());
    if (target && target.readyState === WebSocket.OPEN)
    {
        target.send(
            JSON.stringify({
                type: "gems_purchase_success",
                gems: Number(gems)
            })
        );
    }
}

async function CreateTelegramGemPayment(ws, data)
{
    try
    {
        if (!ws || !ws.username)
        {
            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({type: "payment_error", message: "Not logged in."}));
            }
            return;
        }

        const packageId = String(data.package || "").trim();
        const pack = TELEGRAM_GEMS_PACKAGES[packageId];
        
        if (!pack)
        {
            ws.send(JSON.stringify({
                type: "payment_error",
                message: "Invalid Gems package."
            }));

            return;
        }

        const username = String(ws.username).trim().toLowerCase();
        /*
         * Telegram account linkedmi?
         */
        const userRef = dbFirebase.ref("users/" + username);
        const userSnap = await userRef.once("value");
        if (!userSnap.exists())
        {
            ws.send(JSON.stringify({
                type: "payment_error",
                message: "User not found."
            }));
            return;
        }

        const user = userSnap.val();
        const telegram = user.telegram;
        if (!telegram || !telegram.chatId)
        {
            ws.send(JSON.stringify({
                type: "payment_error",
                message: "Telegram account is not linked."
            }));
            return;
        }

        /*
         * UNIQUE ORDER ID
         */
        const transactionId =
            "tg_" +
            Date.now() +
            "_" +
            crypto.randomBytes(6).toString("hex");

        /*
         * FIREBASE ORDER
         */
        await dbFirebase
            .ref(
                "telegramPayments/" +
                transactionId
            )
            .set({
                username: username,
                package: packageId,
                gems: pack.gems,
                stars: pack.stars,

                telegramUserId: String(telegram.userId || ""),
                telegramChatId: String(telegram.chatId),
                status: "pending",
                telegramPaymentChargeId: "",
                createdAt: Date.now()
            });

        /*
         * TELEGRAM INVOICE
         */
        const invoice =
            await TelegramApi(
                "sendInvoice",
                {
                    chat_id: Number(telegram.chatId),
                    title: pack.title,
                    description: pack.description,
                    payload: transactionId,
                    provider_token: "",
                    currency: "XTR",
                    prices: [
                        {
                            label: pack.title,
                            amount: Number(pack.stars)
                        }
                    ]
                }
            );

        console.log(
            "✅ TELEGRAM INVOICE CREATED:",
            {
                transactionId,
                username,
                packageId,
                gems: pack.gems,
                stars: pack.stars
            }
        );

        ws.send(
            JSON.stringify({
                type: "telegram_payment_created",
                transactionId: transactionId,
                package: packageId,
                gems: pack.gems,
                stars: pack.stars
            })
        );
    }
    catch (error)
    {
        console.error("CREATE TELEGRAM PAYMENT ERROR:", error);

        if (ws && ws.readyState === WebSocket.OPEN)
        {
            ws.send(
                JSON.stringify({
                    type: "payment_error",
                    message: "Could not create Telegram payment."
                })
            );
        }
    }
}

const TELEGRAM_GEMS_PACKAGES = {
    gems_50: {
        gems: 50,
        stars: 25,
        title: "100 Gems",
        description: "100 Gems for TicTacToe"
    },
    
    gems_100: {
        gems: 100,
        stars: 50,
        title: "100 Gems",
        description: "100 Gems for TicTacToe"
    },

    gems_250: {
        gems: 250,
        stars: 100,
        title: "250 Gems",
        description: "250 Gems for TicTacToe"
    },

    gems_600: {
        gems: 550,
        stars: 200,
        title: "600 Gems",
        description: "600 Gems for TicTacToe"
    },

    gems_1500: {
        gems: 1500,
        stars: 500,
        title: "1500 Gems",
        description: "1500 Gems for TicTacToe"
    }
};

function GenerateResetCode()
{
    return Math.floor(100000 + Math.random() * 900000).toString();
}

function GenerateCode()
{
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let code = "";

    for (let i = 0; i < 6; i++) {
        code += chars[Math.floor(Math.random() * chars.length)];
    }

    return code;
}

function SendRoomList(ws)
{
    const roomsList = [];

    for (const roomId in rooms)
    {
        if (!Object.prototype.hasOwnProperty.call(rooms, roomId))
            continue;

        const room = rooms[roomId];

        if (!room || !Array.isArray(room.players))
            continue;
        
        // To'liq roomni ko'rsatmaymiz
        if (room.players.length >= 2)
            continue;

        // O'yin boshlangan roomni ko'rsatmaymiz
        if (room.gameActive)
            continue;
        
        roomsList.push({
            id: roomId,
            name: room.name || roomId,
            host: room.players.length > 0
                ? room.players[0].username
                : room.host || "",
            players: room.players.length,
            maxPlayers: 2,
            hasPassword: !!(room.password && room.password.length > 0),
            mode: room.mode || "classic"
        });
    }

    ws.send(JSON.stringify({type: "room_list", rooms: roomsList}));
}

function BroadcastRoomList()
{
    wss.clients.forEach(client =>
    {
        if (client.readyState === WebSocket.OPEN)
        {
            SendRoomList(client);
        }
    });
}

function RemoveFromRoom(ws)
{
    const roomId = ws.roomId;
    if (!roomId) return;

    const room = rooms[roomId];
    
    if (!room) {
        ws.roomId = null;
        return;
    }

    room.players = room.players.filter(p => p.ws !== ws);

    if (room.players.length === 0)
    {
        delete rooms[roomId];
        // console.log("ROOM DELETED:", roomId);
    }
    else
    {
        const remaining = room.players[0];
        remaining.ws.send(JSON.stringify({
            type: "room_player_left",
            roomId: roomId,
            username: ws.username
        }));

        // Host qolgan player bo'ladi
        room.host = remaining.username;

        remaining.ws.roomId = roomId;
        remaining.ws.symbol = "X";

        // O'yin endi aktiv emas
        room.gameActive = false;
    }

    ws.roomId = null;
    ws.symbol = null;
    BroadcastRoomList();
}

const onlineUsers = new Map();

function IsValidUsername(username)
{
    return /^[A-Za-z0-9_]{3,16}$/.test(username);
}

function createBoard(size)
{
    // return [
    //     "", "", "",
    //     "", "", "",
    //     "", "", ""
    // ];
    return Array(size * size).fill("");
}

function createRoom(boardSize = 3, winLength = 3) {
    return {
        board: createBoard(boardSize),

        boardSize: boardSize,
        winLength: winLength,
        mode: "classic",
        
        turn: "X",
        winner: "",
        winnerCells: [],
        players: [],

        turnDuration: 300, // 30
        turnStartedAt: 0,
        timerInterval: null,
        lastSecond: -1,
        finishing: false,
        gameActive: false,
        
        rematchPlayers: []
    };
}

function createUltimateRoom()
{
    return {
        // Oddiy board Ultimate'da ishlatilmaydi
        board: null,

        boardSize: 3,
        winLength: 3,
        mode: "ultimate",

        turn: "X",
        winner: "",
        winnerCells: [],
        players: [],

        turnDuration: 300,
        turnStartedAt: 0,
        timerInterval: null,
        lastSecond: -1,
        finishing: false,
        gameActive: false,

        rematchPlayers: [],

        // ULTIMATE STATE
        // 9 ta ichki 3×3 board
        ultimateBoards: Array.from(
            { length: 9 },
            () => createBoard(3)
        ),

        // Har bir kichik boardning holati:
        // "", "X", "O", "DRAW"
        ultimateWinners: Array(9).fill(""),

        // Keyingi yurish qaysi kichik boardda?
        // -1 = istalgan tugamagan board
        ultimateActiveBoard: -1
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
        // FRIEND CHECK
        let isFriendGame = false;

        if (room.players.length >= 2)
        {
            const player1 = room.players[0];
            const player2 = room.players[1];

            isFriendGame = await IsFriends(player1.username, player2.username);
        }
        
        // UPDATE STATS + DAILY CHALLENGE
        await UpdateStats(room, isFriendGame); //  await UpdateStats(room); th
        // await SaveMatch(room);
        // broadcastState(roomId);

        if (room.mode === "ultimate") broadcastUltimateState(roomId);
        else broadcastState(roomId);
        
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

function broadcastState(roomId) // broadcast
{
    const room = rooms[roomId];
    if (!room) return;
    
    const data = JSON.stringify({
        type: "state",
        board: room.board,
        turn: room.turn,
        winner: room.winner,
        winnerCells: room.winnerCells,
        boardSize: room.boardSize,
        winLength: room.winLength
    });

    room.players.forEach(p => {
        if (p.ws.readyState === WebSocket.OPEN) {
            p.ws.send(data);
        }
    });
}

function broadcastUltimateState(roomId)
{
    const room = rooms[roomId];
    if (!room) return;

    const data = JSON.stringify({
        type: "ultimate_state",

        boards: room.ultimateBoards,
        boardWinners: room.ultimateWinners,
        activeBoard: room.ultimateActiveBoard,
        turn: room.turn,
        winner: room.winner,
        winnerCells: room.winnerCells
    });

    room.players.forEach(p =>
    {
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

/* Ultimate */
function checkUltimateSmallBoard(board)
{
    const wins = [
        [0, 1, 2],
        [3, 4, 5],
        [6, 7, 8],

        [0, 3, 6],
        [1, 4, 7],
        [2, 5, 8],

        [0, 4, 8],
        [2, 4, 6]
    ];

    for (const w of wins)
    {
        const a = w[0];
        const b = w[1];
        const c = w[2];

        if (board[a] !== "" && board[a] === board[b] && board[a] === board[c])
        {
            return {
                winner: board[a],
                cells: w
            };
        }
    }

    if (board.every(cell => cell !== ""))
    {
        return {
            winner: "DRAW",
            cells: []
        };
    }

    return {
        winner: "",
        cells: []
    };
}

function checkUltimateWinner(room)
{
    const winners = room.ultimateWinners;

    const wins = [
        [0, 1, 2],
        [3, 4, 5],
        [6, 7, 8],

        [0, 3, 6],
        [1, 4, 7],
        [2, 5, 8],

        [0, 4, 8],
        [2, 4, 6]
    ];

    for (const w of wins)
    {
        const a = w[0];
        const b = w[1];
        const c = w[2];

        if (winners[a] !== "" && winners[a] !== "DRAW" && winners[a] === winners[b] && winners[a] === winners[c])
        {
            room.winner = winners[a];
            room.winnerCells = w;
            return;
        }
    }

    // Barcha kichik boardlar tugagan
    if (winners.every(x => x !== ""))
    {
        room.winner = "DRAW";
        room.winnerCells = [];
    }
}
/**/
function checkWinner(room) {
    if (room.finishing) return;  //***///
    
    // const b = room.board;

    // nw, nxn
    const board = room.board;
    const size = room.boardSize;
    const winLength = room.winLength;
    
    // const wins = [
    //     [0,1,2],
    //     [3,4,5],
    //     [6,7,8],

    //     [0,3,6],
    //     [1,4,7],
    //     [2,5,8],

    //     [0,4,8],
    //     [2,4,6]
    // ];

    // ad
    room.winner = ""; //
    room.winnerCells = []; // 

    // nw, nxn
    const directions = [
        [0, 1],   // horizontal
        [1, 0],   // vertical
        [1, 1],   // diagonal \
        [1, -1]   // diagonal /
    ];
    
    // for (let w of wins) {
    //     const a = w[0];
    //     const b1 = w[1];
    //     const c = w[2];

    //     if (b[a] !== "" && b[a] === b[b1] && b[a] === b[c]) {
    //         room.winner = b[a];
    //         room.winnerCells = w;
    //         return;
    //     }
    // }

    // nw, nxn
    for (let row = 0; row < size; row++)
    {
        for (let col = 0; col < size; col++)
        {
            const startIndex = row * size + col;
            const symbol = board[startIndex];

            if (symbol === "")
                continue;

            for (const [dr, dc] of directions)
            {
                const cells = [];

                for (let k = 0; k < winLength; k++)
                {
                    const r = row + dr * k;
                    const c = col + dc * k;

                    if (r < 0 || r >= size || c < 0 || c >= size) {
                        break;
                    }

                    const index = r * size + c;

                    if (board[index] !== symbol) {
                        break;
                    }

                    cells.push(index);
                }

                if (cells.length === winLength) {
                    room.winner = symbol;
                    room.winnerCells = cells;
                    return;
                }
            }
        }
    }
    
    // let draw = true;
    // for (let c of room.board) {
    //     if (c === "") {
    //         draw = false;
    //         break;
    //     }
    // }

     // DRAW
    const draw = board.every(cell => cell !== "");
    
    if (draw && room.winner === "") { // if (draw) in new v
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

            // last5
            await UpdateLast5(p.username, "D");
            
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

        // last5
        await UpdateLast5(winner.username, "W");
        
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

        // last5
        await UpdateLast5(loser.username, "L");

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

//// Shop
const SHOP_SKINS = {
    default: 0,
    amethyst: 5000,
    crystal: 4000,
    cyberpunk: 4000,
    dark: 3000,
    emerald: 5000,
    futuristic: 4000,
    gold: 3000,
    lava: 4000,
    neon: 3000,
    steel_titan: 4000
};

const SHOP_AVATARS = {
    default: 0,
    ball: 2200,
    bottle: 2200,
    boy: 2200,
    hacker: 1700,
    cactus: 1800,
    dragon: 1600,
    wolf: 2000,
    frz_wolf: 2400,
    cat: 1800,
    cats: 1800,
    pirate: 1700,
    samurai: 2500,
    magic: 1700,
    viking: 1700,
    face: 1900,
    lightning: 1500,
    bubble: 2200,
    nature: 1900,
    skeleton_boy: 2500,
    skeleton_gr: 2500,
    snow: 2500,
    spell: 2500,
    noob: 2000,
    home: 1900,
    friends: 1900,
    skeleton: 2500,
    meteor: 1500,
    dog: 1600,
    clown: 1800,
    moon: 1500,
    panda: 1400,
    tiger: 1400
};

async function SendShopData(ws, username)
{
    if (!ws || ws.readyState !== WebSocket.OPEN)
        return;

    const usernameLower = String(username).toLowerCase();
    const snap = await dbFirebase.ref("users/" + usernameLower).once("value");

    if (!snap.exists())
        return;

    const user = snap.val();

    ws.send(JSON.stringify({
        type: "shop_data",
        coins: Number(user.coins || 0),
        ownedSkins: Array.isArray(user.ownedSkins) ? user.ownedSkins: ["default"],
        ownedAvatars: Array.isArray(user.ownedAvatars) ? user.ownedAvatars : ["default"],
        equippedSkin: user.equippedSkin || "default",
        equippedAvatar: user.equippedAvatar || "default"
    }));
}

async function BuyShopItem(ws, data)
{
    try
    {
        if (!ws.username) {
            ws.send(JSON.stringify({type: "shop_error", message: "Not logged in."}));
            return;
        }

        const category = String(data.category || "").trim().toLowerCase();
        const itemId = String(data.itemId || "").trim().toLowerCase();
        let price = -1;
        
        if (category === "skin") {
            if (!Object.prototype.hasOwnProperty.call(SHOP_SKINS, itemId)) {
                ws.send(JSON.stringify({type: "shop_error", message: "Skin not found."}));
                return;
            }

            price = Number(SHOP_SKINS[itemId]);
        }
        else if (category === "avatar") {
            if (!Object.prototype.hasOwnProperty.call(SHOP_AVATARS, itemId))
            {
                ws.send(JSON.stringify({type: "shop_error", message: "Avatar not found."}));
                return;
            }

            price = Number(SHOP_AVATARS[itemId]);
        }
        else {
            ws.send(JSON.stringify({type: "shop_error", message: "Invalid shop category."}));
            return;
        }

        // =========================
        // 4. PRICE VALIDATION
        // =========================

        if (!Number.isFinite(price) || price < 0)
        {
            console.error("INVALID SHOP PRICE:", category, itemId, price);
            ws.send(JSON.stringify({type: "shop_error", message: "Item unavailable."}));
            return;
        }

        // 5. USER REF
        const username = String(ws.username || "").trim().toLowerCase();
        if (!username)
        {
            ws.send(JSON.stringify({type: "shop_error",message: "Username not found."}));
            return;
        }
        
        const userRef = dbFirebase.ref("users/" + username);

        console.log("========== SHOP BUY ==========");
        console.log("username:", username);
        console.log("category:", category);
        console.log("itemId:", itemId);
        console.log("price:", price);

        // 6. READ USER FIRST
        // Transaction boshlanganda Firebase callback
        // null berishi mumkin.
        //
        // Shuning uchun userni oldindan olib qo'yamiz.
        //
        
        // Userni oldindan tekshiramiz
        const userSnapshot = await userRef.once("value");

        if (!userSnapshot.exists())
        {
            console.log("❌ USER NOT FOUND:", username);
            ws.send(JSON.stringify({type: "shop_error", message: "User not found."}));
            return;
        }
        
        const existingUser = userSnapshot.val();

        console.log("USER EXISTS:", userSnapshot.exists());
        // console.log("EXISTING USER:", existingUser);

        let transactionResult = "unknown";
        // 7. TRANSACTION
        // =========================
        
        const result = await userRef.transaction(user =>
        {
            /*
             * Firebase transaction callback birinchi chaqirilganda
             * user null bo'lishi mumkin.
             *
             * Bu Firebase'da user yo'q degani emas.
             */
            
            if (!user) {
                // console.log("❌ USER IS NULL");
                // return;

                console.log("⚠️ TRANSACTION USER NULL -> using existing user");

                /*
                 * Deep copy qilamiz.
                 *
                 * Sababi transaction callback bir necha marta
                 * chaqirilishi mumkin.
                 */
                
                user = JSON.parse(JSON.stringify(existingUser));
            }

            // console.log("TRANSACTION USER:", user);

            const ownedSkins = Array.isArray(user.ownedSkins) ? [...user.ownedSkins] : ["default"];
            const ownedAvatars = Array.isArray(user.ownedAvatars) ? [...user.ownedAvatars] : ["default"];
            
            if (category === "skin")
            {
                if (ownedSkins.includes(itemId))
                {
                    console.log("❌ SKIN ALREADY OWNED:", itemId);
                    transactionResult = "already_owned";

                    /*
                     * Ma'lumotni o'zgartirmaymiz.
                     * Transaction abort bo'ladi.
                     */
                    return; // user
                }
            }
            else
            {
                if (ownedAvatars.includes(itemId))
                {
                    console.log("❌ AVATAR ALREADY OWNED:", itemId);
                    transactionResult = "already_owned";
                    return;
                }
            }

            const coins = Number(user.coins || 0);

            console.log("USER COINS:", coins);
            console.log("ITEM PRICE:", price);

            if (!Number.isFinite(coins))
            {
                console.log("❌ INVALID USER COINS");
                transactionResult = "invalid_coins";
                return;
            }

            // NOT ENOUGH COINS
            if (coins < price) {
                console.log("❌ NOT ENOUGH COINS");
                transactionResult = "not_enough_coins";
                return;
            }
                
            user.coins = coins - price;
                
            if (category === "skin")
            {
                ownedSkins.push(itemId);
                user.ownedSkins = ownedSkins;
            }
            else
            {
                ownedAvatars.push(itemId);
                user.ownedAvatars = ownedAvatars;
            }

            transactionResult = "success";
            console.log("✅ BUY SUCCESS, NEW COINS:", user.coins);
            
            return user;
        });

        console.log("SHOP TRANSACTION:", result.committed);

        if (!result.committed)
        {
            if (transactionResult === "already_owned")
            {
                ws.send(JSON.stringify({type: "shop_error", message: "You already own this item."}));
                return;
            }

            if (transactionResult === "not_enough_coins")
            {
                ws.send(JSON.stringify({type: "shop_error", message: "Not enough coins."}));
                return;
            }

            if (transactionResult === "invalid_coins")
            {
                ws.send(JSON.stringify({type: "shop_error", message: "Invalid coin balance."}));
                return;
            }

            ws.send(JSON.stringify({type: "shop_error", message: "Purchase failed."}));
            return;
        }

        ws.send(JSON.stringify({
            type: "shop_purchase_success",
            category: category,
            itemId: itemId,
            price: price
        }));

        await SendShopData(ws, username);
        await SendProfile(ws, username);
    }
    catch (error)
    {
        console.error("BuyShopItem ERROR:", error);
        ws.send(JSON.stringify({type: "shop_error", message: "Purchase failed."}));
    }
}

async function EquipShopItem(ws, data)
{
    try
    {
        if (!ws.username) {
            ws.send(JSON.stringify({type: "shop_error", message: "Not logged in."}));
            return;
        }

        const category = String(data.category || "");
        const itemId = String(data.itemId || "");
        const username = ws.username.toLowerCase();
        const userRef = dbFirebase.ref("users/" + username);
        const snap = await userRef.once("value");

        if (!snap.exists())
            return;

        const user = snap.val();

        if (category === "skin") {
            const owned = Array.isArray(user.ownedSkins) ? user.ownedSkins : ["classic"];
            
            if (!owned.includes(itemId))
            {
                ws.send(JSON.stringify({type: "shop_error", message: "Skin is not owned."}));
                return;
            }

            await userRef.update({equippedSkin: itemId});
        }
        else if (category === "avatar") {
            const owned = Array.isArray(user.ownedAvatars) ? user.ownedAvatars : ["default"];
            
            if (!owned.includes(itemId)) {
                ws.send(JSON.stringify({type: "shop_error", message: "Avatar is not owned."}));
                return;
            }

            await userRef.update({equippedAvatar: itemId, avatar: itemId});
        }
        else {
            ws.send(JSON.stringify({type: "shop_error", message: "Invalid shop category."}));
            return;
        }

        ws.send(JSON.stringify({type: "shop_equip_success", category: category, itemId: itemId}));

        await SendShopData(ws, username);
        await SendProfile(ws, username);
    }
    catch (error)
    {
        console.error("EquipShopItem ERROR:", error);
        ws.send(JSON.stringify({type: "shop_error", message: "Equip failed."}));
    }
}
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
        vip: user.vip,

        last5: user.last5,
        gems: user.gems || 0,

        // Shop
        ownedSkins: user.ownedSkins || ["default"],
        ownedAvatars: user.ownedAvatars || ["default"],
        equippedSkin: user.equippedSkin || "default",
        equippedAvatar: user.equippedAvatar || "default"
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
                    gems: 0,
                    experience: 0,
                    level: 1,
                    vip: false,

                    // Shop
                    ownedSkins: ["default"],
                    ownedAvatars: ["default"],
                    equippedSkin: "default",
                    equippedAvatar: "default",

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
                if (user.gems === undefined) updates.gems = 0;
                if (user.experience === undefined) updates.experience = 0;
                if (user.level === undefined) updates.level = 1;
                if (user.vip === undefined) updates.vip = false;
                if (user.theme === undefined) updates.theme = "dark";
                if (user.language === undefined) updates.language = "English";
                if (user.sounds === undefined) updates.sounds = true;

                if (user.ownedSkins === undefined) updates.ownedSkins = ["default"];
                if (user.ownedAvatars === undefined) updates.ownedAvatars = ["default"];
                if (user.equippedSkin === undefined) updates.equippedSkin = "default";
                if (user.equippedAvatar === undefined) updates.equippedAvatar = "default";

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

                onlineUsers.set(user.username.toLowerCase(), ws);
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

                    // Shop
                    ownedSkins: user.ownedSkins || ["default"],
                    ownedAvatars: user.ownedAvatars || ["default"],
                    equippedSkin: user.equippedSkin || "default",
                    equippedAvatar: user.equippedAvatar || "default",
            
                    coins: user.coins,
                    gems: user.gems,
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

                await SendShopData(ws, username);
                
                broadcastOnlineCount();

                return;
            }

            else if (data.type === "telegram_link")
            {
                if (!ws.username)
                {
                    ws.send(JSON.stringify({type: "telegram_link_error", message: "Not logged in."}));
                    return;
                }
            
                try
                {
                    const username = String(ws.username).trim().toLowerCase();
                    const code = GenerateTelegramLinkCode();
                    const now = Date.now();
                    const expiresAt = now + 10 * 60 * 1000;
                    await dbFirebase
                        .ref("telegramLinkCodes/" + code)
                        .set({username: username, createdAt: now, expiresAt: expiresAt});
            
                    const botUsername = process.env.TELEGRAM_BOT_USERNAME;
                    const link = "https://t.me/" + botUsername + "?start=" + code;
                    ws.send(JSON.stringify({
                        type: "telegram_link_created",
                        code: code,
                        link: link,
                        expiresAt: expiresAt
                    }));
                }
                catch (error)
                {
                    console.error("TELEGRAM LINK ERROR:", error);
                    ws.send(JSON.stringify({type: "telegram_link_error", message: "Could not create Telegram link."}));
                }
            }

            else if (data.type === "telegram_buy_gems")
            {
                await CreateTelegramGemPayment(ws, data);
            }

            else if (data.type === "buy_shop_item")
            {
                await BuyShopItem(ws, data);
            }

            else if (data.type === "equip_shop_item")
            {
                await EquipShopItem(ws, data);
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
                    vip: user.vip || false,
                    last5: user.last5
                }));
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
                // ...
                if (!ws.username)
                    return;
            
                await SendFriendRequests(ws, ws.username);
            }

            else if (data.type === "accept_friend_request")
            {
                const receiver = ws.username;
            
                if (!receiver) return;
            
                const sender = String(data.username || "").trim().toLowerCase();
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
            
                const sender = String(data.username || "").trim().toLowerCase();
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

            else if (data.type === "remove_friend")
            {
                const username = ws.username;
                if (!username) return;
            
                const friendUsername = String(data.username || "").trim().toLowerCase();
                const currentUsername = username.toLowerCase();
                
                if (!friendUsername) return;
                if (currentUsername === friendUsername) return;
                
                // CURRENT USER
                const currentRef = dbFirebase.ref("users/" + currentUsername);
                const currentSnap = await currentRef.once("value");
            
                if (!currentSnap.exists()) return;
                const currentUser = currentSnap.val();
                const currentFriends = Array.isArray(currentUser.friends) ? currentUser.friends : [];
                
                // FRIEND USER
                const friendRef = dbFirebase.ref("users/" + friendUsername);
                const friendSnap = await friendRef.once("value");
            
                if (!friendSnap.exists()) return;
                const friendUser = friendSnap.val();
                const friendFriends = Array.isArray(friendUser.friends) ? friendUser.friends : [];
                
                // IKKALA TOMONDAN O'CHIRISH
                const newCurrentFriends = currentFriends.filter(x => String(x).toLowerCase() !== friendUsername); 
                const newFriendFriends = friendFriends.filter(x => String(x).toLowerCase() !== currentUsername);
            
                // FIREBASE UPDATE
                await currentRef.update({friends: newCurrentFriends});
                await friendRef.update({friends: newFriendFriends});
            
                // CURRENT USERGA YANGI LIST
                await SendFriendsList(ws, username);
                
                // FRIEND ONLINE BO'LSA
                const friendWs = onlineUsers.get(friendUsername);
            
                if (friendWs && friendWs.readyState === WebSocket.OPEN) {
                    await SendFriendsList(friendWs, friendUsername);
                }
            }

            else if (data.type === "search_user")
            {
                if (!ws.username) return;
            
                const searchUsername = String(data.username || "").trim().toLowerCase();
                if (!searchUsername) return;
            
                if (searchUsername === ws.username.toLowerCase())
                {
                    ws.send(JSON.stringify({
                        type: "user_search_result",
                        found: false,
                        reason: "self"
                    }));
            
                    return;
                }
            
                const snap = await dbFirebase.ref("users/" + searchUsername).once("value");
                if (!snap.exists())
                {
                    ws.send(JSON.stringify({type: "user_search_result", found: false}));
                    return;
                }
            
                const user = snap.val();
            
                const friends = Array.isArray(user.friends) ? user.friends : [];
                const friendRequests = Array.isArray(user.friendRequests) ? user.friendRequests : [];
                const currentSnap = await dbFirebase.ref("users/" + ws.username.toLowerCase()).once("value");
                const currentUser = currentSnap.exists() ? currentSnap.val() : {};
                const currentFriends = Array.isArray(currentUser.friends) ? currentUser.friends : [];
                const currentRequests = Array.isArray(currentUser.friendRequests) ? currentUser.friendRequests : [];
                const alreadyFriend = currentFriends.some(x => String(x).toLowerCase() === searchUsername);
                const requestAlreadySent = friendRequests.some(x => String(x).toLowerCase() === ws.username.toLowerCase());
                const requestAlreadyReceived = currentRequests.some(x => String(x).toLowerCase() === searchUsername);
            
                ws.send(JSON.stringify({
                    type: "user_search_result",
                    found: true,
            
                    username: user.username,
                    avatar: user.avatar || "default",
                    rating: user.rating || 1000,
            
                    alreadyFriend: alreadyFriend,
                    requestAlreadySent: requestAlreadySent,
                    requestAlreadyReceived: requestAlreadyReceived
                }));
            }

            else if (data.type === "send_friend_request")
            {
                if (!ws.username)
                    return;
            
                const senderUsername = ws.username.toLowerCase();
                const receiverUsername = String(data.username || "").trim().toLowerCase();
            
                if (!receiverUsername) return;
                if (senderUsername === receiverUsername)
                    return;

                // RECEIVER
                const receiverRef = dbFirebase.ref("users/" + receiverUsername);
                const receiverSnap = await receiverRef.once("value");
            
                if (!receiverSnap.exists()) return;
                const receiver = receiverSnap.val();

                // SENDER
                const senderRef = dbFirebase.ref("users/" + senderUsername);
                const senderSnap = await senderRef.once("value");
                if (!senderSnap.exists()) return;
                const sender = senderSnap.val();
                const receiverFriends = Array.isArray(receiver.friends) ? receiver.friends : [];
                const receiverRequests = Array.isArray(receiver.friendRequests) ? receiver.friendRequests : [];
                
                // Already friends
                if (receiverFriends.some(x => String(x).toLowerCase() === senderUsername)) {
                    return;
                }
                
                // Request already exists
                if (receiverRequests.some(x => String(x).toLowerCase() === senderUsername)) {
                    return;
                }
                
                // ADD REQUEST
                receiverRequests.push(senderUsername);
                await receiverRef.update({friendRequests: receiverRequests});

                // SENDER     
                ws.send(JSON.stringify({type: "friend_request_sent", username: receiver.username}));

                // RECEIVER ONLINE
                const receiverWs = onlineUsers.get(receiverUsername);
            
                if (receiverWs && receiverWs.readyState === WebSocket.OPEN) {
                    receiverWs.send(JSON.stringify({
                        type: "friend_request_received",
                        username: sender.username,
                        avatar: sender.avatar || "default",
                        rating: sender.rating || 1000
                    }));
            
                    await SendFriendRequests(receiverWs, receiverUsername);
                }
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
                
                const code = GenerateResetCode();
            
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
                    const code = GenerateResetCode();
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
            
            else if (data.type === "create")
            {
                if (!ws.username) {
                    ws.send(JSON.stringify({type: "error", message: "Not logged in"})); 
                    return;
                }

                // User allaqachon roomda
                if (ws.roomId) {
                    ws.send(JSON.stringify({type: "error", message: "You are already in a room."}));
                    return;
                }
                
                const roomName = String(data.name || "").trim();
                const password = String(data.password || "");
                let roomId;

                do {
                    roomId = GenerateCode();
                } while (rooms[roomId]);

                const mode = data.mode || "classic";
                
                let boardSize = 3;
                let winLength = 3;
                
                if (mode === "4x4") {
                    boardSize = 4;
                    winLength = 3;
                }
                else if (mode === "5x5") {
                    boardSize = 5;
                    winLength = 4;
                }

                if (mode === "ultimate") {
                    rooms[roomId] = createUltimateRoom();
                }
                else {
                    rooms[roomId] = createRoom(boardSize, winLength);
                }
                
                // rooms[roomId] = createRoom(boardSize, winLength);
                // rooms[roomId] = createRoom();
                rooms[roomId].name = roomName;
                rooms[roomId].mode = mode;
                rooms[roomId].password = password;
                rooms[roomId].host = ws.username;
                rooms[roomId].gameActive = false;
                
                rooms[roomId].players.push({ws: ws, username: ws.username, symbol: "X"});

                ws.symbol = "X"; // ad
                ws.roomId = roomId; // a
                
                ws.send(JSON.stringify({
                    type: "created",
                    roomId: roomId,
                    symbol: "X",
                    roomName: roomName,
                    hasPassword: password.length > 0,
                    mode: mode,
                    boardSize: rooms[roomId].boardSize,
                    winLength: rooms[roomId].winLength
                }));

                // broadcastUltimateState(roomId); ??
                broadcastState(roomId); // add
                BroadcastRoomList();
            }

            else if (data.type === "join")
            {
                if (!ws.username) {
                    ws.send(JSON.stringify({type: "error", message: "Not logged in"})); 
                    return;
                }

                // User allaqachon roomda
                if (ws.roomId) {
                    ws.send(JSON.stringify({type: "error", message: "You are already in a room."}));
                    return;
                }
                
                const roomId = String(data.roomId || "").trim().toUpperCase();   /// a
                const room = rooms[roomId];

                if (!room) {
                    ws.send(JSON.stringify({type: "error", message: "Room not found"}));
                    return;
                }
                if (room.players.length >= 2) {
                    ws.send(JSON.stringify({type: "error", message: "Room full"}));
                    return;
                }

                const password = String(data.password || "");

                // Room passwordli bo'lsa
                if (room.password && room.password.length > 0)
                {
                    // Client hali password yubormagan
                    if (!Object.prototype.hasOwnProperty.call(data, "password")) {
                        ws.send(JSON.stringify({type: "room_password_required", roomId: roomId}));
                        return;
                    }
                    
                    // Password noto'g'ri
                    if (password !== room.password) {
                        ws.send(JSON.stringify({type: "error", message: "Incorrect room password"}));
                        return;
                    }
                }
                
                room.players.push({ws: ws, username: ws.username, symbol: "O"});

                ws.symbol = "O"; // a
                ws.roomId = roomId; // a
                
                ws.send(JSON.stringify({
                    type: "joined",
                    symbol: "O",
                    roomId: roomId,
                    roomName: room.name,
                    boardSize: room.boardSize,
                    winLength: room.winLength
                }));

                // Hostga ham yangi player kirganini bildiramiz
                if (room.players.length === 2)
                {
                    room.gameActive = true;
                    
                    const host = room.players[0];
                    const guest = room.players[1]; // 
            
                    host.ws.send(JSON.stringify({type: "match_found", roomId: roomId, symbol: "X", opponent: ws.username})); // type: "room_ready"
                    ws.send(JSON.stringify({type: "match_found", roomId: roomId, symbol: "O", opponent: host.username})); // type: "room_ready"
                    // guest.ws.send(JSON.stringify({type: "room_ready", roomId: roomId, opponent: host.username, symbol: "O"}));

                     // Xuddi matchmaking kabi
                    StartRoomTimer(roomId);
                    // broadcastState(roomId);
                    broadcastTimer(roomId);
                }

                if (room.mode === "ultimate") broadcastUltimateState(roomId);
                else broadcastState(roomId);
                BroadcastRoomList();
            }

            else if (data.type === "cancel_room") {
                if (!ws.username) {
                    ws.send(JSON.stringify({type: "error", message: "Not logged in"})); 
                    return;
                }

                const roomId = String(data.roomId || "").trim().toUpperCase();   /// a
                const room = rooms[roomId];

                if (!room) {
                    ws.send(JSON.stringify({type: "error", message: "Room not found"}));
                    return;
                }

                // Faqat room hosti cancel qila oladi
                if (String(room.host).toLowerCase() !== String(ws.username).toLowerCase()) {
                    ws.send(JSON.stringify({type: "error", message: "You are not the room host."}));
                    return;
                }
            
                // O'yin boshlangan bo'lsa cancel qilib bo'lmaydi
                if (room.gameActive) {
                    ws.send(JSON.stringify({type: "error", message: "The game has already started."}));
                    return;
                }
            
                // Hostning roomId/symbolini tozalaymiz
                ws.roomId = null;
                ws.symbol = null;
            
                delete rooms[roomId];
            
                ws.send(JSON.stringify({ type: "room_cancelled", roomId: roomId}));
                BroadcastRoomList();
            }

            else if (data.type === "get_rooms")
            {
                SendRoomList(ws);
            }

            else if (data.type === "leave_match")
            {
                const roomId = String(data.roomId || "");
                const room = rooms[roomId];
                if (!room) {
                    ws.roomId = null;
                    ws.symbol = null;
                    ws.send(JSON.stringify({type: "leave_success"}));
                    return;
                }

                // StopTurnTimer(room);
                StopRoomTimer(room);
                
                const opponent = room.players.find(p => p.ws !== ws);
                
                // Chiqayotgan playerni roomdan olib tashlaymiz
                room.players = room.players.filter(p => p.ws !== ws);
                // Chiqayotgan clientni tozalaymiz
                ws.roomId = null;
                ws.symbol = null;
            
                // O'YIN HALI BOSHLANMAGAN
                if (!room.gameActive)
                {
                    // Masalan 1/2 edi va host chiqib ketdi.
                    // Roomni o'chiramiz.
                    delete rooms[roomId];
            
                    ws.send(JSON.stringify({type: "leave_success"}));
                    BroadcastRoomList();
                    return;
                }

                // O'YIN BOSHLANGAN
                if (opponent && opponent.ws.readyState === WebSocket.OPEN) {
                    opponent.ws.roomId = null;
                    opponent.ws.symbol = null;
                    opponent.ws.send(JSON.stringify({type: "opponent_left"})); // raqibga xabar yuborish
                }

                // O'yin boshlangan room endi tugaydi
                delete rooms[roomId];
                
                ws.send(JSON.stringify({type: "leave_success"}));

                BroadcastRoomList();
            }

            else if (data.type === "find_match")
            {
                if (!ws.username) return;

                // User allaqachon roomda bo'lsa,
                // yana matchmakingga kirmasin
                if (ws.roomId)
                {
                    ws.send(JSON.stringify({type: "error", message: "You are already in a room."}));
                    return;
                }

                // GAME MODE
                const mode = data.mode || "classic";
            
                let boardSize = 3;
                let winLength = 3;
            
                if (mode === "4x4") {
                    boardSize = 4;
                    winLength = 3;
                }
                else if (mode === "5x5") {
                    boardSize = 5;
                    winLength = 4;
                }

                // USERNI QUEUE'DAN O'CHIRAMIZ
                matchmakingQueue = matchmakingQueue.filter(p => p.ws !== ws);

                // FAQAT SHU MODE'DAGI OPPONENTNI QIDIRAMIZ
                const opponentIndex = matchmakingQueue.findIndex(p => p.mode === mode);

                // OPPONENT TOPILDI
                if (opponentIndex !== -1)
                {
                    const opponent = matchmakingQueue.splice(opponentIndex, 1)[0];
                    let roomId;
                    do
                    {
                        roomId = GenerateCode();
                    }
                    while (rooms[roomId]);

                    if (mode === "ultimate") {
                        rooms[roomId] = createUltimateRoom();
                    }
                    else rooms[roomId] = createRoom(boardSize, winLength);
                    
                    rooms[roomId].mode = mode;
                    rooms[roomId].gameActive = true;
                    
                    // Players
                    rooms[roomId].players.push({ws: opponent.ws, username: opponent.username, symbol: "X"});
                    rooms[roomId].players.push({ws: ws, username: ws.username, symbol: "O"});

                    // SOCKET STATE
                    opponent.ws.roomId = roomId;
                    opponent.ws.symbol = "X";
            
                    ws.roomId = roomId;
                    ws.symbol = "O";

                    // MATCH FOUND → PLAYER X
                    opponent.ws.send(JSON.stringify({
                        type: "match_found",
                        roomId: roomId,
                        symbol: "X",
                        opponent: ws.username,

                        mode: mode,
                        boardSize: boardSize,
                        winLength: winLength
                    }));
                    
                    // MATCH FOUND → PLAYER O
                    ws.send(JSON.stringify({
                        type: "match_found",
                        roomId: roomId,
                        symbol: "O",
                        opponent: opponent.username,

                        mode: mode,
                        boardSize: boardSize,
                        winLength: winLength
                    }));

                    // START GAME
                    StartRoomTimer(roomId); // ch order
                    // broadcastState(roomId);  // ch order

                    if (mode === "ultimate") broadcastUltimateState(roomId);
                    else broadcastState(roomId);
                    
                    broadcastTimer(roomId);
                    BroadcastRoomList();
                }
                else {
                    matchmakingQueue.push({ws: ws, username: ws.username, mode: mode});
                    ws.send(JSON.stringify({
                        type: "matchmaking",
                        mode: mode,
                        boardSize: boardSize,
                        winLength: winLength
                    }));
                }
                
                // if (matchmakingQueue.length > 0)
                // {
                //     const opponent = matchmakingQueue.shift();

                //     let roomId;
                //     do
                //     {
                //         roomId = GenerateCode();
                //     }
                //     while (rooms[roomId]);
            
                //     rooms[roomId] = createRoom();
            
                //     rooms[roomId].players.push({ws: opponent.ws, username: opponent.username, symbol: "X"});
                //     rooms[roomId].players.push({ws: ws, username: ws.username, symbol: "O"});
                //     rooms[roomId].gameActive = true;
                    
                //     opponent.ws.roomId = roomId;
                //     opponent.ws.symbol = "X";
            
                //     ws.roomId = roomId;
                //     ws.symbol = "O";
            
                //     opponent.ws.send(JSON.stringify({
                //         type: "match_found",
                //         roomId: roomId,
                //         symbol: "X",
                //         opponent: ws.username
                //     }));
            
                //     ws.send(JSON.stringify({
                //         type: "match_found",
                //         roomId: roomId,
                //         symbol: "O",
                //         opponent: opponent.username
                //     }));

                //     StartRoomTimer(roomId); // ch order
                //     broadcastState(roomId);  // ch order
                //     broadcastTimer(roomId);
                //     // StartTurnTimer(roomId);

                //     BroadcastRoomList();
                // }
                // else {
                //     matchmakingQueue.push({ws: ws, username: ws.username});
                //     ws.send(JSON.stringify({type: "matchmaking"}));
                // }
            }

            else if (data.type === "cancel_matchmaking")
            {
                matchmakingQueue = matchmakingQueue.filter(p => p.ws !== ws);
                ws.send(JSON.stringify({type: "match_cancelled"}));
            }

            else if (data.type === "move") {
                const room = rooms[data.roomId];
                
                if (!room) return;
                // ULTIMATE alohida move handlerga o'tadi
                if (room.mode === "ultimate") return;
                
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

            else if (data.type === "ultimate_move")
            {
                const room = rooms[data.roomId];
                if (!room) return;
                if (room.mode !== "ultimate") return;
                if (!room.gameActive) return;
                if (room.finishing) return;
                if (room.winner !== "") return;
                if (room.turn !== data.symbol) return;
                
                const boardIndex = Number(data.boardIndex);
                const cellIndex = Number(data.cellIndex);
                
                if (!Number.isInteger(boardIndex) || boardIndex < 0 || boardIndex > 8)
                    return;
            
                if (!Number.isInteger(cellIndex) || cellIndex < 0 || cellIndex > 8)
                    return;
            
                // Qaysi kichik boardga yurish majburiy?
                if (room.ultimateActiveBoard !== -1 && boardIndex !== room.ultimateActiveBoard) {
                    return;
                }
            
                // Bu kichik board allaqachon tugagan
                if (room.ultimateWinners[boardIndex] !== "" ) {
                    return;
                }
                
                const board = room.ultimateBoards[boardIndex];
            
                // Katak band
                if (board[cellIndex] !== "")
                    return;
            
                // MOVE
                board[cellIndex] = data.symbol;
                
                // Kichik board winneri
                const smallResult = checkUltimateSmallBoard(board);
                if (smallResult.winner !== "") {
                    room.ultimateWinners[boardIndex] = smallResult.winner;
                }
            
                // Katta board winneri
                checkUltimateWinner(room);
                
                // GAME FINISHED?
                if (room.winner !== "")
                {
                    await FinishGame(data.roomId);
            
                    broadcastUltimateState(data.roomId);
                    broadcastTimer(data.roomId);
                    return;
                }
            
                // NEXT TURN
                room.turn = data.symbol === "X" ? "O" : "X";
                
                // Keyingi player qaysi boardda o'ynaydi?
                // Hozirgi cellIndex = keyingi board indexi
                if (room.ultimateWinners[cellIndex] === "") {
                    room.ultimateActiveBoard = cellIndex;
                }
                else
                {
                    // Belgilangan board tugagan.
                    // Istalgan tugamagan boardga yurishi mumkin.
                    room.ultimateActiveBoard = -1;
                }
            
                ResetRoomTimer(room);
                broadcastUltimateState(data.roomId);
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
                /**/  // ad gm
                // TAYMERNI TO'XTATISH (O'yinchi ulgurib keldi!)
                if (player.disconnectTimer) {
                    clearTimeout(player.disconnectTimer);
                    player.disconnectTimer = null;
                }
                /**/
                
                // Eski socketni yopamiz, // Yangi socketni ulab qo'yish
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
            
                // broadcastState(data.roomId);
                if (room.mode === "ultimate") broadcastUltimateState(data.roomId);
                else broadcastState(data.roomId);
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
                    if (room.mode === "ultimate")
                    {
                        room.ultimateBoards =
                            Array.from(
                                { length: 9 },
                                () => createBoard(3)
                            );
                    
                        room.ultimateWinners = Array(9).fill("");
                        room.ultimateActiveBoard = -1;
                    }
                    else room.board = createBoard(room.boardSize);
                    
                    room.turn = "X";
                    room.winner = "";
                    room.winnerCells = [];
                    room.rematchPlayers = [];
                    room.finishing = false;

                    StartRoomTimer(data.roomId); // not reset
                    if (room.mode === "ultimate") broadcastUltimateState(data.roomId);
                    else broadcastState(data.roomId);
                    
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
            const current = onlineUsers.get(ws.username.toLowerCase());

            if (current === ws) {
                onlineUsers.delete(ws.username.toLowerCase());
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
                const player = room.players.find(p => p.username === ws.username);  // ad gm
                const opponent = room.players.find(p => p.ws !== ws);
                if (opponent && opponent.ws.readyState === WebSocket.OPEN) {
                    opponent.ws.send(JSON.stringify({type: "opponent_disconnected"}));
                }

                if (player) {
                    player.disconnectTimer = setTimeout(() => {
                        // Agar 30 soniyadan keyin shu taymer ishlasa, demak o'yinchi qaytmadi.
                        // Endi haqiqatdan ham xonadan o'chirib tashlaymiz:
                        if (rooms[ws.roomId]) { 
                            RemoveFromRoom(ws); // Sizning zo'r funksiyangiz shu yerda ishlaydi
                        }
                    }, 30000); // 30 soniya kutish
                }
            }
        }
        else { // gm
            // Agar o'yinda bo'lmasa, darhol o'chirib yuboramiz (masalan, lobby'da turganda)
            RemoveFromRoom(ws); // 
        }
        // RemoveFromRoom(ws);
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
