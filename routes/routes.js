exports.assignRoutes = function(app){
    app.get('/', function(req, res){
        console.log(__dirname);
        res.send(__dirname, '../dist/index.html');
    });
};