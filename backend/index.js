import http from 'http';
import express from 'express';
import cors from 'cors';
import { Server } from 'socket.io';
import mediasoup from 'mediasoup';

const app = express();
app.use(cors({ origin: '*' }));

const server = http.createServer(app);

app.get('/', (req, res) => {
    res.send('Mediasoup Streaming Server');
});

let worker;
let router;
const transports = new Map(); // Store transports by socket id
const producers = new Map(); // Store producers
const consumers = new Map(); // Store consumers

const createWorker = async () => {
    worker = await mediasoup.createWorker({ 
        logLevel: "warn", 
        logTags: { rtp: true, sctp: true } 
    });
    
    worker.on('died', () => {
        console.error('mediasoup worker has died');
        process.exit(1);
    });
    
    console.log('Worker created');
    return worker;
}

const createRouter = async () => {
    const mediaCodecs = [
        {
            kind: "audio",
            mimeType: "audio/opus",
            clockRate: 48000,
            channels: 2
        },
        {
            kind: "video",
            mimeType: "video/H264",
            clockRate: 90000,
            parameters: {
                "packetization-mode": 1,
                "profile-level-id": "42e01f",
                "level-asymmetry-allowed": 1
            }
        }
    ];
    
    router = await worker.createRouter({ mediaCodecs });
    console.log('Router created');
    return router;
}

const createWebRtcTransport = async () => {
    try {
        const transport = await router.createWebRtcTransport({
            enableUdp: true,
            enableTcp: true,
            preferUdp: true,
            listenInfos: [
                {
                    protocol: 'udp',
                    ip: '127.0.0.1',
                    announcedIp: '127.0.0.1'
                },
                {
                    protocol: 'tcp',
                    ip: '127.0.0.1',
                    announcedIp: '127.0.0.1'
                }
            ]
        });

        console.log(`Transport created with ID: ${transport.id}`);
        return transport;
    } catch (error) {
        console.error('Error creating WebRTC transport:', error);
        throw error;
    }
}

const io = new Server(server, {
    cors: {
        origin: '*',
        methods: ['GET', 'POST'],
    },
    transports: ['websocket'],
});

io.on('connection', async (socket) => {
    console.log(`User connected: ${socket.id}`);

    // Send router capabilities
    socket.on('getRouterRtpCapabilities', (callback) => {
        console.log('getRouterRtpCapabilities requested');
        callback(router.rtpCapabilities);
    });

    // Create producer transport
    socket.on("createProducerTransport", async (callback) => {
        try {
            console.log(`Creating producer transport for ${socket.id}`);
            const transport = await createWebRtcTransport();
            transports.set(`${socket.id}-producer`, transport);
            
            const transportOptions = {
                id: transport.id,
                iceParameters: transport.iceParameters,
                iceCandidates: transport.iceCandidates,
                dtlsParameters: transport.dtlsParameters,
            };
            
            console.log(`Producer transport created: ${transport.id}`);
            callback(transportOptions);
        } catch (error) {
            console.error('Error creating producer transport:', error);
            callback({ error: error.message });
        }
    });

    // Create consumer transport
    socket.on("createConsumerTransport", async (callback) => {
        try {
            console.log(`Creating consumer transport for ${socket.id}`);
            const transport = await createWebRtcTransport();
            transports.set(`${socket.id}-consumer`, transport);
            
            const transportOptions = {
                id: transport.id,
                iceParameters: transport.iceParameters,
                iceCandidates: transport.iceCandidates,
                dtlsParameters: transport.dtlsParameters,
            };
            
            console.log(`Consumer transport created: ${transport.id}`);
            callback(transportOptions);
        } catch (error) {
            console.error('Error creating consumer transport:', error);
            callback({ error: error.message });
        }
    });

    // Connect producer transport
    socket.on("connectProducerTransport", async ({ dtlsParameters }, callback) => {
        try {
            const transport = transports.get(`${socket.id}-producer`);
            if (!transport) {
                throw new Error('Producer transport not found');
            }
            await transport.connect({ dtlsParameters });
            callback({ success: true });
        } catch (error) {
            console.error('Error connecting producer transport:', error);
            callback({ error: error.message });
        }
    });

    // Connect consumer transport
    socket.on("connectConsumerTransport", async ({ dtlsParameters }, callback) => {
        try {
            const transport = transports.get(`${socket.id}-consumer`);
            if (!transport) {
                throw new Error('Consumer transport not found');
            }
            await transport.connect({ dtlsParameters });
            callback({ success: true });
        } catch (error) {
            console.error('Error connecting consumer transport:', error);
            callback({ error: error.message });
        }
    });

    // Produce media
    socket.on("produce", async ({ kind, rtpParameters }, callback) => {
        try {
            const transport = transports.get(`${socket.id}-producer`);
            if (!transport) {
                throw new Error('Producer transport not found');
            }
            
            const producer = await transport.produce({ kind, rtpParameters });
            producers.set(producer.id, { producer, socketId: socket.id });
            
            console.log(`Producer created: ${producer.id} for ${socket.id}`);
            
            // Notify all other clients about new producer
            socket.broadcast.emit("newProducer", { 
                producerId: producer.id,
                socketId: socket.id 
            });
            
            callback({ id: producer.id });
        } catch (error) {
            console.error('Error producing:', error);
            callback({ error: error.message });
        }
    });

    // Consume media
    socket.on("consume", async ({ producerId }, callback) => {
        try {
            console.log(`Consumer request for producer ${producerId} from ${socket.id}`);
            
            const transport = transports.get(`${socket.id}-consumer`);
            const producerData = producers.get(producerId);
            
            if (!transport) {
                throw new Error('Consumer transport not found');
            }
            
            if (!producerData) {
                throw new Error('Producer not found');
            }
            
            if (!socket.rtpCapabilities) {
                throw new Error('RTP capabilities not set');
            }

            const { producer } = producerData;
            
            console.log(`Checking if can consume: producerId=${producerId}, kind=${producer.kind}`);
            
            // Check if we can consume
            const canConsume = router.canConsume({
                producerId,
                rtpCapabilities: socket.rtpCapabilities
            });
            
            if (!canConsume) {
                throw new Error('Cannot consume - incompatible RTP capabilities');
            }

            console.log('Creating consumer...');
            const consumer = await transport.consume({
                producerId,
                rtpCapabilities: socket.rtpCapabilities,
                paused: true, // Start paused
            });

            consumers.set(consumer.id, { consumer, socketId: socket.id });
            
            console.log(`Consumer created: ${consumer.id} for producer ${producerId}`);

            callback({
                id: consumer.id,
                producerId,
                kind: consumer.kind,
                rtpParameters: consumer.rtpParameters,
            });
        } catch (error) {
            console.error('Error consuming:', error);
            callback({ error: error.message });
        }
    });

    // Resume consumer
    socket.on("resumeConsumer", async ({ consumerId }, callback) => {
        try {
            console.log(`Resuming consumer: ${consumerId}`);
            const consumerData = consumers.get(consumerId);
            if (!consumerData) {
                throw new Error('Consumer not found');
            }
            
            await consumerData.consumer.resume();
            console.log(`Consumer resumed: ${consumerId}`);
            callback({ success: true });
        } catch (error) {
            console.error('Error resuming consumer:', error);
            callback({ error: error.message });
        }
    });

    // Get existing producers for new client
    socket.on("getProducers", (callback) => {
        const producerList = Array.from(producers.values())
            .filter(p => p.socketId !== socket.id)
            .map(p => ({
                producerId: p.producer.id,
                socketId: p.socketId
            }));
        
        callback(producerList);
    });

    // Store client RTP capabilities
    socket.on("setRtpCapabilities", (rtpCapabilities) => {
        socket.rtpCapabilities = rtpCapabilities;
    });

    // Handle disconnect
    socket.on('disconnect', () => {
        console.log(`User disconnected: ${socket.id}`);
        
        // Clean up transports
        const producerTransport = transports.get(`${socket.id}-producer`);
        const consumerTransport = transports.get(`${socket.id}-consumer`);
        
        if (producerTransport) {
            producerTransport.close();
            transports.delete(`${socket.id}-producer`);
        }
        
        if (consumerTransport) {
            consumerTransport.close();
            transports.delete(`${socket.id}-consumer`);
        }
        
        // Clean up producers
        producers.forEach((producerData, producerId) => {
            if (producerData.socketId === socket.id) {
                producerData.producer.close();
                producers.delete(producerId);
                // Notify other clients
                socket.broadcast.emit("producerClosed", { producerId });
            }
        });
        
        // Clean up consumers
        consumers.forEach((consumerData, consumerId) => {
            if (consumerData.socketId === socket.id) {
                consumerData.consumer.close();
                consumers.delete(consumerId);
            }
        });
    });
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, async () => {
    await createWorker();
    await createRouter();
    console.log(`Server is running on port ${PORT}`);
});