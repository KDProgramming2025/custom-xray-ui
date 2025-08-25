import express from 'express';
const app = express();
app.get('/ping', (req,res)=>res.send('pong'));
app.listen(3001, ()=> console.log('min server 3001'));
