let connection = require('../tools/db_connection.js');
let db = connection.getDbConnection();

exports.checkUsername = function(username, callback) {
    console.log('Check username availability for: ' + username);
    let available = false;
    db.getConnection(function(err, conn){
        if(err) console.log(err);
        if(conn){
            conn.query('SELECT name FROM cloudchat.user WHERE name = ?', [username] , function(err, rows) {
                if(err) throw err;
                if(rows[0] == undefined) {
                    available = true;
                }
                callback(available);
            });
            conn.release();
        }
    });
};

exports.registerUser = function(username, password, color, language, callback){
    console.log('Register new user: ' + username);
    db.getConnection(function(err, conn){
        if(conn){
            conn.query('INSERT INTO cloudchat.user (name, password, color, language) VALUES(?, ?, ?, ?)', [username, password, color, language], function(err) {
                if(err){
                    callback(false);
                    throw err;
                } else {
                    callback(true);
                }

            });
            conn.release();
        }
    });

};

exports.login = function(username, password, bcrypt, callback){
    console.log('Login attempt by ' + username);
    db.getConnection(function(err, conn){
        if(conn){
            conn.query('SELECT name, password FROM cloudchat.user WHERE name = ?', [username], function(err, rows){
                if(err){
                    callback(false);
                    throw err;
                } else {
                    if(rows[0] != undefined){
                        bcrypt.compare(password, rows[0].password, function(err, res){
                            if(res){
                                callback(true);
                            } else {
                                callback(false);
                            }
                        });
                    } else {
                        callback(false);
                    }
                }
            });
            conn.release();
        }
    });
};

exports.getUserInfo = function(username, callback){
    db.getConnection(function(err, conn){
        if(conn){
            conn.query('SELECT language, color FROM cloudchat.user WHERE name = ?', [username], function(err, rows){
                if(err){
                    throw err;
                } else {
                    if(rows[0] != undefined){
                        callback(rows[0].language, rows[0].color);
                    } else {
                        callback('None', '#000000');
                    }
                }
            })
        }
    });
};