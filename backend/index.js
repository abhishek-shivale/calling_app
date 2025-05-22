import https from 'https';
import fs from 'fs';
import express from 'express';
import cors from 'cors';
import { Server } from 'socket.io';

const app = express();
app.use(cors("*"));

const options = {
    key: fs.readFileSync('./certificate/cert.key'),
    cert: fs.readFileSync('./certificate/cert.crt'),
}

const server = https.createServer(options, app);

const io = new Server(server, {
    cors: {
        origin: '*',
        methods: ['GET', 'POST'],
    },
});


const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
}
);