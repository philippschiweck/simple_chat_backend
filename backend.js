let express = require('express');
let app = express();
let http = require('http').Server(app);
let io = require('socket.io')(http, {
    transports: 'websocket'
});
let config = require('./config.json');
let formidable = require('formidable');
let bodyParser = require('body-parser')
let ToneAnalyzerV3 = require('ibm-watson/tone-analyzer/v3');
let LanguageTranslatorV3 = require('ibm-watson/language-translator/v3');
let bcrypt = require('bcrypt');
let helmet = require('helmet');
let secure = require('express-force-https');
let hsts = require('hsts');

let db = require('./db/db.js');
let connectedUserMap = new Map();
let roomMap = new Map();
let fileMap = new Map();
let port = process.env.PORT || 3000;

//Redis
let redis = require('redis');
let redisPub = redis.createClient(config.redis.port, config.redis.address,
    {auth_pass: config.redis.auth_pass, tls: {servername: config.redis.address}});
let redisSub = redis.createClient(config.redis.port, config.redis.address,
    {auth_pass: config.redis.auth_pass, tls: {servername: config.redis.address}});
redisPub.on('connect', function() {
    console.log('Redis Pub client connected');
    let test = {userName: 'Server', message: 'A new server instance has been started!', userColor: null, fileName: null, fileKey: null, roomId: null ,type: 'SERVER_MESSAGE'};
    redisPub.publish('messages', JSON.stringify(test));
});

redisPub.on('error', function (err) {
    console.log('Something went wrong ' + err);
});

redisSub.on('connect', function() {
    console.log('Redis Sub client connected');
    redisSub.subscribe('messages');
    redisSub.subscribe('userlist update');
});

redisSub.on('error', function (err) {
    console.log('Something went wrong ' + err);
});

let toneAnalyzer = new ToneAnalyzerV3({
    iam_apikey: config.ibm_tone.key,
    version: '2016-05-19',
    url: config.ibm_tone.url
});

let translator = new LanguageTranslatorV3({
    url: 'https://gateway-fra.watsonplatform.net/language-translator/api',
    iam_apikey: "Fdm-5DejJvCXD5rKbGEJyzMdBUtkJRPlZjij1QXbjV7e",
   username: '',
    password: '',
    version: '2018-05-01',
    headers: {
        'X-Watson-Technology-Preview': '2018-05-01',
        'X-Watson-Learning-Opt-Out': true,
    },
});

//app.use
{app.use(helmet());

app.use(helmet.contentSecurityPolicy({
    directives: {
        defaultSrc: ["'self'", 'simple-chat-n.eu-de.mybluemix.net'],
        styleSrc: ["'self'", 'maxcdn.bootstrapcdn.com']
    }
}));

app.use(secure);

app.use(hsts({
    maxAge: 31536000 // One year is recommended
}));

app.use(function (req, res, next) {

    // Website allowed
    res.header('Access-Control-Allow-Origin', '*');

    // Request allowed methods
    res.header('Access-Control-Allow-Methods', 'GET, POST');

    // Request allowed headers
    res.header('Access-Control-Allow-Headers', 'X-Requested-With,content-type');

    // Set to true if you need the website to include cookies in the requests sent
    // to the API (e.g. in case you use sessions)
    res.setHeader('Access-Control-Allow-Credentials', false);

    next();
});

app.use( bodyParser.json() );       // to support JSON-encoded bodies
app.use(bodyParser.urlencoded({     // to support URL-encoded bodies
    extended: true
}));}

app.post('/upload', function (req, res){
    var form = new formidable.IncomingForm();
    let key = '';

    form.parse(req);

    form.on('fileBegin', function (name, file){
        let date = new Date();
        file.path = __dirname + '/uploads/' + date.getTime() + file.name;
        key = generateID(fileMap);
        fileMap.set(key, {filePath: file.path, fileName: file.name});
        res.json({fileKey: key, fileName: file.name});
        res.end();
    });

    form.on('file', function (name, file){
        console.log('File uploaded ' + file.path);
    });

});

app.get('/download', function(req, res){

    let file = fileMap.get(req.query.fileKey);
    console.log("File Downloaded: " + file.fileName);
    res.sendFile(file.filePath, file.fileName);
});

http.listen(port, function(){
    roomMap.set('1234', {id: '1234', type:'public', name:'Global', users: [], messages: []});
    roomMap.set('5678', {id: '5678', type:'public', name:'Chatroom', users: [], messages: []});
    console.log("Listening on *:" + port);
});

//Redis
redisSub.on('message', function(channel, JsonData){
    let data = JSON.parse(JsonData);
    console.log("Message data from Redis: " + JsonData);
    if(channel === 'messages'){
        console.log("Data from Redis: " + data.message);
        sendMessage(data.userName, data.userId, data.message, data.userColor, data.fileName, data.fileKey, data.roomId, data.messageType);
        //PROBLEM:
        // There is no socket from which to send the messages from!
    } else if(channel === 'userlist update'){
        console.log("Userlist data from Redis: " + data.message);
        connectedUserMap.set(data.user.id, { name: data.user.name});
        let socket = io.sockets.connected[data.user.id];
        if(socket){
            socket.broadcast.emit('userlist update', data);
        } else {
            io.emit('userlist update', data);
        }

        if(data.type === 'USER_LEFT'){
            connectedUserMap.delete(data.user.id);
        }
    } else if (channel === 'room added') {
        console.log("Room data from Redis: " + data);
        if(data.newRoom.type == 'public'){
            io.emit('room added', data);

        } else if (data.newRoom.type == 'private') {
            for(user in data.newRoom.users){
                let connected = Object.keys(io.sockets.sockets);
                if(connected.contains(user)){
                    io.to(user.id).emit('room added', data);
                }
            }

        }
    }
});

io.on('connection', function(socket){

    let connectedUserId = socket.id;
    connectedUserMap.set(socket.id, { status:'online'});
    let user = connectedUserMap.get(connectedUserId);
    user.toneValue = 0;

    socket.on('name selected', function(data){
        user.nickname = data.nickname;
        sendRooms(connectedUserId);
        sendUsers(connectedUserId);

        console.log(connectedUserId + ' connected!');
        sendMessage(user.nickname, socket.id, "Welcome to the Chat, " + user.nickname + "! Click on a Room on the left to start chatting!", user.color, '', '', '', 'SERVER_MESSAGE');
        console.log(connectedUserId + ' is now nicknamed ' + user.nickname + '!');

        //Redis

        redisPub.publish('userlist update', JSON.stringify({user: {id: connectedUserId, name: user.nickname}, type: 'USER_JOINED'}));
        //socket.broadcast.emit('userlist update', {user: {id: connectedUserId, name: user.nickname}, type: 'USER_JOINED'});
    });

    socket.on('check username', function(data){
        console.log("Username check: " + data.username);
        let result = '';
        db.checkUsername(data.username, function(callback) {
            if (callback) {
                console.log("Username " + data.username + " is available!");
                result = {usernameAvailable: true};
            } else {
                console.log("Username " + data.username + " is not available!");
                result = {usernameAvailable: false};
            }

            io.to(socket.id).emit('username checked', result);
        });
    });

    socket.on('register user', function(data) {
        db.checkUsername(data.username, function (callback) {
            if (callback) {
                bcrypt.hash(data.password, 10, function(err, hash){
                    db.registerUser(data.username, hash, checkColor(data.color), data.language, function (result) {
                        io.to(socket.id).emit('register user', {result: result});
                    });
                });
            }
        });
    });

    socket.on('login', function(data) {
        db.login(data.username, data.password, bcrypt, function(result){
            io.to(socket.id).emit('login', {result: result});
            if(result){
                db.getUserInfo(data.username, function(language, color){
                    user.language = language;
                    user.color = color;
                });
            }
        })
    });

    socket.on('subscribe', function(data){
        let roomId = data.roomId;
        let roomExists = roomMap.has(roomId);
        if(user.currentRoomId != null && roomExists){
            let currentRoom = roomMap.get(user.currentRoomId);
            if(currentRoom.id != roomId){
                socket.leave(currentRoom.id, function(){
                    currentRoom.users.splice(user.id);
                });
                //sendMessage(user.nickname, socket.id, 'User ' + user.nickname + ' has left the room!', user.color, '', '', currentRoom.id,  'ROOM_MESSAGE');
                let data = {userName: null, userId: socket.id, message: 'User ' + user.nickname + ' has left the room!', color: null, fileName: null, fileKey: null, roomId: currentRoom.id, messageType: 'ROOM_MESSAGE'};
                redisPub.publish('messages', JSON.stringify(data));
                joinRoom(this, user, roomMap.get(roomId));
            }
        } else if(roomExists) {
            joinRoom(this, user, roomMap.get(roomId));
        } else {
            console.log("Room does not exist!");
        }
    });

    socket.on('chat message', function(data){
        if(data.type === 'media'){
            console.log('Media Message from ' + user.nickname + ' in room ' + user.currentRoomId  + ':' + data.message);
            console.log('File Name: ' + data.file.fileName);
            //sendMessage(user.nickname, socket.id, data.message, user.color, data.file.fileName, data.file.fileKey, user.currentRoomId,  'MEDIA_MESSAGE');
            //Redis send
            let redisData = {userName: user.nickname, userId: socket.id, message: data.message, userColor: user.color, fileName: data.file.fileName, fileKey: data.file.fileKey, roomId: user.currentRoomId, messageType: 'MEDIA_MESSAGE'};
            redisPub.publish('messages', JSON.stringify(redisData));

        } else if(data.type === 'text') {
            console.log('Message from ' + user.nickname + ' in room ' + user.currentRoomId + ": " + data.message);
            //sendMessage(user.nickname, null, data.message, user.color, null, null, user.currentRoomId,  'CHAT_MESSAGE');

            //Redis send
            let redisData = {userName: user.nickname, userId: socket.id, message: data.message, userColor: user.color, fileName: null, fileKey: null, roomId: user.currentRoomId, messageType: 'CHAT_MESSAGE'};
            redisPub.publish('messages', JSON.stringify(redisData));

            //Tone
            const toneRequest = createToneRequest(data);
            toneAnalyzer.toneChat(
                toneRequest,
                function(err, tone) {
                    if (err) {
                        console.log(err);
                    } else {
                        evaluateMessageTone(user, tone, socket);
                    }
                }
            );
        }


    });

    socket.on('disconnect', function(data){
        redisPub.publish('userlist update', JSON.stringify({user: {id: connectedUserId, name: user.nickname}, type: 'USER_LEFT'}));
        //socket.broadcast.emit('userlist update', {user: {id: connectedUserId, name: user.nickname}, type: 'USER_LEFT'});
    });

    socket.on('get users', function(data){
        sendUsers(connectedUserId);
    });

    socket.on('create room', function(data){
        createRoom(data, user, connectedUserId);
        console.log("New " + data.type + " room has been created: " + data.name);
    })
});

function evaluateMessageTone(user, tone, socket){
    const happyTones = ['satisfied', 'excited', 'polite', 'sympathetic'];
    const unhappyTones = ['sad', 'frustrated', 'impolite'];

    let happyValue = 0;
    let unhappyValue = 0;

    for (let i in tone.utterances_tone) {
        const utteranceTones = tone.utterances_tone[i].tones;
        for (let j in utteranceTones) {
            if (happyTones.includes(utteranceTones[j].tone_id)) {
                happyValue = happyValue + utteranceTones[j].score;
            }
            if (unhappyTones.includes(utteranceTones[j].tone_id)) {
                unhappyValue = unhappyValue + utteranceTones[j].score;
            }
        }
    }
    if (happyValue > unhappyValue) {
        user.toneValue++;
    }
    else {
        user.toneValue--;
    }
    io.to(socket.id).emit('tone', {toneValue: user.toneValue});
    console.log("User " + user.nickname + " Tone value: " + user.toneValue);
}

function createToneRequest (request) {
    let toneChatRequest;

    if (request.message) {
        toneChatRequest = {utterances: []};
        const utterance = {text: request.message};
        toneChatRequest.utterances.push(utterance);
    }
    return toneChatRequest;
}

function createRoom(data, user, userId){
    let newId = generateID(roomMap);
    //For some reason, data.name can not be accessed below while creating the new room
    let name = data.name;
    let type = data.type;
    let users = data.users;
    users.push({name: user.nickname, id: userId});

    if(type === 'public'){
        let newRoom = {
            id: newId,
            name: name,
            type: type,
            users: [],
            messages: []
        };
        let data = {id: newRoom.id, name: newRoom.name, type: 'public'};
        let roomHeader = {dataType: 'ROOM_ADDED', newRoom: data};
        roomMap.set(newId, newRoom);
        redisPub.publish('room added', JSON.stringify(roomHeader));
        //io.emit('room added', roomHeader);

    } else if(type === 'private'){
        let newRoom = {
            id: newId,
            name: name + user.nickname,
            type: type,
            users: users,
            messages: []
        };
        roomMap.set(newId, newRoom);
        let data = {id: newRoom.id, users: users, name: newRoom.name, type: 'private'};
        let roomHeader = {dataType: 'ROOM_ADDED', newRoom: data};
        redisPub.publish('room added', JSON.stringify(roomHeader));
        /*for(let user of users){
            console.log('Nickname: ' + user.name);
            //console.log(user);
            io.to(user.id).emit('room added', roomHeader);
            //TODO Redis
        }*/
    }
}

function sendUsers(connectedUserId){
    let userList = [];
    connectedUserMap.forEach((connectedUser, key) => {
        if(key !== connectedUserId && connectedUser.name !== ''){
            let userInfo = {"id": key, "name": connectedUser.name};
            userList.push(userInfo);
        }
    });
    io.to(connectedUserId).emit('userlist update', {list: userList, type: 'USERLIST'});
}

function joinRoom(socket, user, newRoom){
    let data = {userName: user.nickname, userId: socket.id, message: 'User ' + user.nickname + ' has joined the room: ' + newRoom.name, color: user.color, fileName: null, fileKey: null, roomId: newRoom.id, messageType: 'ROOM_MESSAGE'};
    redisPub.publish('messages', JSON.stringify(data));

    console.log("User " + user.nickname + " has joined the room " + newRoom.name + '!');
    newRoom.users.push(user);
    user.currentRoomId = newRoom.id;
    sendMessage(user.nickname, socket.id, 'Welcome to the room \"' + newRoom.name + "\"!", user.color, '', '', newRoom.id, 'SERVER_MESSAGE');
    //sendMessage(user.nickname, socket.id, 'User ' + user.nickname + ' has joined the room: ' + newRoom.name, user.color, '', '', newRoom.id, 'ROOM_MESSAGE');
    socket.join(newRoom.id);
}

function sendMessage(userName, userId, message, userColor, fileName, fileKey, roomId, messageType){

    io.of('/').in(roomId).clients(function(error, clients){
        let data = {};
        if(error) console.log(error);
        console.log("Clients in room " + roomId + ": " + clients[0]);

        //Server Messages are always only messages from the server to ONE user (e.g. welcome message)
        if(messageType === 'SERVER_MESSAGE'){
            data = {name: 'Server', date: '', message: message, color: '' ,type: messageType};
            io.to(userId).emit('message', data);

        // Room Messages are messages from the server to a whole room (e.g. a new user joins a room -> announcement)
        } else if(messageType === 'ROOM_MESSAGE'){

            data = {name: '', date: '', message: message, color: '' ,type: messageType};
            console.log("ROOM Message in " + roomId + ": " + message);

            io.in(roomId).emit('message', data);


        //Chat Messages are sent to the whole room the user is in, including the user
        } else if(messageType === 'CHAT_MESSAGE'){

            let date = getDate();
            let data = {name: userName, date: date, message: message, color: userColor ,type: messageType};

            io.in(roomId).emit('message', data);

        //Media Messages are sent to the whole room the user is in, including the user
        } else if(messageType === 'MEDIA_MESSAGE'){

            let date = getDate();
            let data = {name: userName, date: date, message: message, color: userColor, type: messageType, fileName: fileName, fileKey: fileKey};

            io.in(roomId).emit('message', data);
        }
    });
}


function sendAllMessages(userId, room){
    let data = {type: 'ALL_MESSAGES', messages: room.messages};
    io.to(userId).emit('message', data);
}

function getDate(){
    var currentDate = new Date();
    return currentDate.getHours() + ":" + (currentDate.getMinutes()>9 ? currentDate.getMinutes() : '0' + currentDate.getMinutes());
}

function sendRooms(socket_id){
    let roomData = [];
    roomMap.forEach((room, key) => {
        if(room.type === 'public'){
            let data = {id: key, name: room.name, type: 'public'};
            roomData.push(data);
        } else if(room.type === 'private'){
            if(room.users.find(function(v){return v['id'] === socket_id})){
                let data = {id: key, name: room.name, type: 'public'};
                roomData.push(data);
            }
        }
    });
    let roomHeader = {dataType: 'ALL_ROOMS', roomData: roomData};
    io.to(socket_id).emit('all rooms', roomHeader);
}

function generateID(map){
    let id = '_' + Math.random().toString(36).substr(2, 9);

    while(map.has(id)){
        id = '_' + Math.random().toString(36).substr(2, 9);
    }
    return id;
}

function checkColor(color){
    var c = color.substring(1);      // strip #
    var rgb = parseInt(c, 16);   // convert rrggbb to decimal
    var r = (rgb >> 16) & 0xff;  // extract red
    var g = (rgb >>  8) & 0xff;  // extract green
    var b = (rgb >>  0) & 0xff;  // extract blue

    var luma = 0.2126 * r + 0.7152 * g + 0.0722 * b; // per ITU-R BT.709
    //console.log(color + ": " + luma);
    if (luma > 200) {
        color = '#000000';
    }
    return color;
}