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
let redisClient = redis.createClient(config.redis.port, config.redis.address,
    {auth_pass: config.redis.auth_pass, tls: {servername: config.redis.address}});
redisClient.on('connect', function() {
    console.log('Redis client connected');
    redisClient.subscribe('messages');
    redisClient.publish('messages', "A new server has connected!");
});

redisClient.on('error', function (err) {
    console.log('Something went wrong ' + err);
});


/*let redisAdapter = require('socket.io-redis');
io.adapter( redisAdapter({host: config.redis.address, port: config.redis.port, auth_pass: config.redis.auth_pass, tls: {servername: config.redis.address}}) );//6379
*/
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
redisClient.on('message', function(channel, message){
    let test = {name: 'Server', date: '', message: message, color: '' ,type: 'SERVER_MESSAGE'};
    console.log(msg);
    io.emit('message', test);
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
        sendMessage(socket, 'SERVER_MESSAGE', '', user, "Welcome to the Chat, " + user.nickname + "! Click on a Room on the left to start chatting!");
        console.log(connectedUserId + ' is now nicknamed ' + user.nickname + '!');

        socket.broadcast.emit('userlist update', {user: {id: connectedUserId, name: user.nickname}, type: 'USER_JOINED'});
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
                sendMessage(socket, 'ROOM_MESSAGE', currentRoom.id, user, 'User ' + user.nickname + ' has left the room!');
                joinRoom(this, user, roomMap.get(roomId));
            }
        } else if(roomExists) {
            joinRoom(this, user, roomMap.get(roomId));
        } else {
            console.log("Room does not exist!");
        }
    });

    socket.on('chat message', function(data){
        console.log('CHAT MESSAGE');
        if(data.type === 'media'){
            console.log('Media Message from ' + user.nickname + ' in room ' + user.currentRoomId  + ':' + data.message);
            console.log('File Name: ' + data.file.fileName);
            sendMessage(socket, 'MEDIA_MESSAGE', user.currentRoomId, user, data.message, data.file);
        } else if(data.type === 'text') {
            console.log('Message from ' + user.nickname + ' in room ' + user.currentRoomId + ": " + data.message);
            sendMessage(socket, 'CHAT_MESSAGE', user.currentRoomId, user, data.message);
            const toneRequest = createToneRequest(data);
            toneAnalyzer.toneChat(
                toneRequest,
                function(err, tone) {
                    if (err) {
                        console.log(err);
                    } else {
                        evaluateMessageTone(user, tone, socket);
                        //console.log(JSON.stringify(tone, null, 2));
                    }
                }
            );
        }


    });

    socket.on('disconnect', function(data){
        connectedUserMap.delete(connectedUserId);
        socket.broadcast.emit('userlist update', {user: {id: connectedUserId, name: user.nickname}, type: 'USER_LEFT'});
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
        io.emit('room added', roomHeader);

    } else if(type === 'private'){
        let newRoom = {
            id: newId,
            name: name + user.nickname,
            type: type,
            users: users,
            messages: []
        };
        roomMap.set(newId, newRoom);
        let data = {id: newRoom.id, name: newRoom.name, type: 'private'};
        let roomHeader = {dataType: 'ROOM_ADDED', newRoom: data};
        for(let user of users){
            console.log('Nickname: ' + user.name);
            //console.log(user);
            io.to(user.id).emit('room added', roomHeader);
        }
    }
}

function sendUsers(connectedUserId){
    let userList = [];
    connectedUserMap.forEach((connectedUser, key) => {
        if(key !== connectedUserId && connectedUser.nickname !== ''){
            let userInfo = {"id": key, "name": connectedUser.nickname};
            userList.push(userInfo);
        }
    });
    io.to(connectedUserId).emit('userlist update', {list: userList, type: 'USERLIST'});
}

function joinRoom(socket, user, newRoom){
    socket.join(newRoom.id);
    console.log("User " + user.nickname + " has joined the room " + newRoom.name + '!');
    newRoom.users.push(user);
    user.currentRoomId = newRoom.id;
    sendMessage(socket, 'SERVER_MESSAGE', newRoom.id, user, 'Welcome to the room \"' + newRoom.name + "\"!");
    sendMessage(socket, 'ROOM_MESSAGE', newRoom.id, user, 'User ' + user.nickname + ' has joined the room: ' + newRoom.name);
}

function sendMessage(socket, messageType, roomId, user, message, file){

    io.of('/').in(roomId).clients(function(error, clients){
        let data = {};
        if(error) console.log(error);
        console.log("Clients in room " + roomId + ": " + clients[0]);
        let room = roomMap.get(user.currentRoomId);
        if(messageType === 'SERVER_MESSAGE'){
            data = {name: 'Server', date: '', message: message, color: '' ,type: messageType};
            socket.emit('message', data);
        } else if(messageType === 'ROOM_MESSAGE'){
            data = {name: '', date: '', message: message, color: '' ,type: messageType};
            socket.to(roomId).emit('message', data);
        } else if(messageType === 'CHAT_MESSAGE'){
            let date = getDate();
            let data = {name: user.nickname, date: date, message: message, color: user.color ,type: messageType};
            io.in(roomId).emit('message', data);
        } else if(messageType === 'MEDIA_MESSAGE'){
            let date = getDate();
            let data = {name: user.nickname, date: date, message: message, color: user.color, type: messageType, fileName: file.fileName, fileKey: file.fileKey};
            io.in(roomId).emit('message', data);
        }

        //REDIS SEND
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