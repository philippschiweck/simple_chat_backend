var mysql      = require('mysql');
let config = require('../config.json');

let dbConnectionInfo = {
    host     : config.db.address,
    user     : config.db.user,
    password : config.db.password,
    port: config.db.port
};

let db = mysql.createPool(dbConnectionInfo);
//db.connect();

db.on('connection', function (connection) {
    console.log('DB Connection established');

    connection.on('error', function (err) {
        console.error(new Date(), 'MySQL error', err.code);
    });
    connection.on('close', function (err) {
        console.error(new Date(), 'MySQL close', err);
    });

});

exports.getDbConnection = function(){
    if(typeof db != undefined){
        return db;
    }
    console.log('There is no DB connection!');
    return null;
};

