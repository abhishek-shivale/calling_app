// @ts-nocheck
import { useState, useRef, useCallback } from 'react';
import { Device } from 'mediasoup-client';
import io from 'socket.io-client';

export const useMediaSoup = () => {
  const [isConnected, setIsConnected] = useState(false);
  const [isJoined, setIsJoined] = useState(false);
  const [localStream, setLocalStream] = useState(null);
  const [remoteStreams, setRemoteStreams] = useState(new Map());
  const [peers, setPeers] = useState(new Map());

  const socketRef = useRef(null);
  const deviceRef = useRef(null);
  const sendTransportRef = useRef(null);
  const recvTransportRef = useRef(null);
  const producersRef = useRef(new Map());
  const consumersRef = useRef(new Map());

  // Initialize socket connection
  const connect = useCallback(() => {
    socketRef.current = io('http://localhost:3001');
    
    socketRef.current.on('connect', () => {
      setIsConnected(true);
      console.log('Connected to server');
    });

    socketRef.current.on('disconnect', () => {
      setIsConnected(false);
      setIsJoined(false);
      console.log('Disconnected from server');
    });

    socketRef.current.on('error', (error) => {
      console.error('Socket error:', error);
    });

    // Setup MediaSoup event handlers
    setupMediaSoupHandlers();
  }, []);

  // Setup MediaSoup-specific event handlers
  const setupMediaSoupHandlers = () => {
    // Router RTP capabilities received
    socketRef.current.on('router-rtp-capabilities', async (rtpCapabilities) => {
      try {
        deviceRef.current = new Device();
        await deviceRef.current.load({ routerRtpCapabilities: rtpCapabilities });
        console.log('Device loaded with RTP capabilities');
      } catch (error) {
        console.error('Failed to load device:', error);
      }
    });

    // Transport created
    socketRef.current.on('transport-created', async ({ transportId, params, direction }) => {
      try {
        if (direction === 'send') {
          sendTransportRef.current = deviceRef.current.createSendTransport(params);
          setupSendTransport(sendTransportRef.current, transportId);
        } else {
          recvTransportRef.current = deviceRef.current.createRecvTransport(params);
          setupRecvTransport(recvTransportRef.current, transportId);
        }
      } catch (error) {
        console.error('Failed to create transport:', error);
      }
    });

    // Transport connected
    socketRef.current.on('transport-connected', ({ transportId }) => {
      console.log('Transport connected:', transportId);
    });

    // Producer created
    socketRef.current.on('producer-created', ({ producerId }) => {
      console.log('Producer created:', producerId);
    });

    // Consumer created
    socketRef.current.on('consumer-created', async (consumerData) => {
      try {
        const consumer = await recvTransportRef.current.consume({
          id: consumerData.consumerId,
          producerId: consumerData.producerId,
          kind: consumerData.kind,
          rtpParameters: consumerData.rtpParameters,
        });

        consumersRef.current.set(consumer.id, consumer);

        // Resume consumer
        socketRef.current.emit('resume-consumer', { consumerId: consumer.id });

        // Add remote stream
        const stream = new MediaStream([consumer.track]);
        setRemoteStreams(prev => new Map(prev.set(consumer.id, {
          stream,
          peerId: consumerData.producerId,
          kind: consumer.kind
        })));

      } catch (error) {
        console.error('Failed to create consumer:', error);
      }
    });

    // Consumer resumed
    socketRef.current.on('consumer-resumed', ({ consumerId }) => {
      console.log('Consumer resumed:', consumerId);
    });

    // Consumer closed
    socketRef.current.on('consumer-closed', ({ consumerId }) => {
      const consumer = consumersRef.current.get(consumerId);
      if (consumer) {
        consumer.close();
        consumersRef.current.delete(consumerId);
        setRemoteStreams(prev => {
          const newMap = new Map(prev);
          newMap.delete(consumerId);
          return newMap;
        });
      }
    });

    // New peer joined
    socketRef.current.on('new-peer', ({ socketId, name }) => {
      setPeers(prev => new Map(prev.set(socketId, { id: socketId, name })));
    });

    // Existing peers
    socketRef.current.on('existing-peers', (peersList) => {
      const peersMap = new Map();
      peersList.forEach(peer => {
        peersMap.set(peer.socketId, { id: peer.socketId, name: peer.name });
      });
      setPeers(peersMap);
    });



    // New producer available
    socketRef.current.on('new-producer', ({ producerId, peerId, peerName, kind }) => {
      console.log('New producer available:', { producerId, peerId, kind, peerName });
      // Auto-consume the new producer
      consumeProducer(producerId);
    });

    // Existing producers
    socketRef.current.on('existing-producers', (producers) => {
      producers.forEach(({ producerId }) => {
        consumeProducer(producerId);
      });
    });

    // Peer disconnected
    socketRef.current.on('peer-disconnected', ({ socketId }) => {
      setPeers(prev => {
        const newMap = new Map(prev);
        newMap.delete(socketId);
        return newMap;
      });
      
      // Remove remote streams from this peer
      setRemoteStreams(prev => {
        const newMap = new Map();
        prev.forEach((value, key) => {
          if (value.peerId !== socketId) {
            newMap.set(key, value);
          }
        });
        return newMap;
      });
    });
  };

  // Setup send transport
  const setupSendTransport = (transport, transportId) => {
    transport.on('connect', async ({ dtlsParameters }, callback, errback) => {
      try {
        socketRef.current.emit('connect-transport', {
          transportId,
          dtlsParameters
        });
        callback();
      } catch (error) {
        errback(error);
      }
    });

    transport.on('produce', async (parameters, callback, errback) => {
      try {
        socketRef.current.emit('produce', {
          transportId,
          kind: parameters.kind,
          rtpParameters: parameters.rtpParameters,
          appData: parameters.appData
        });

        socketRef.current.once('producer-created', ({ producerId }) => {
          callback({ id: producerId });
        });
      } catch (error) {
        errback(error);
      }
    });
  };

  // Setup receive transport
  const setupRecvTransport = (transport, transportId) => {
    transport.on('connect', async ({ dtlsParameters }, callback, errback) => {
      try {
        socketRef.current.emit('connect-transport', {
          transportId,
          dtlsParameters
        });
        callback();
      } catch (error) {
        errback(error);
      }
    });
  };

  // Join room
  const joinRoom = useCallback((roomId, name) => {
    if (!socketRef.current || !deviceRef.current) {
      console.error('Socket or device not ready');
      return;
    }

    socketRef.current.emit('join-room', { roomId, name });
    setIsJoined(true);

    // Create transports
    setTimeout(() => {
      socketRef.current.emit('create-transport', { direction: 'send' });
      socketRef.current.emit('create-transport', { direction: 'recv' });
    }, 1000);

    // Get existing producers after joining
    setTimeout(() => {
      socketRef.current.emit('get-producers');
    }, 2000);
  }, []);

  // Start producing (share camera/mic)
  const startProducing = useCallback(async (stream) => {
    if (!sendTransportRef.current) {
      console.error('Send transport not ready');
      return;
    }

    try {
      setLocalStream(stream);

      for (const track of stream.getTracks()) {
        const producer = await sendTransportRef.current.produce({ track });
        producersRef.current.set(producer.id, producer);

        producer.on('trackended', () => {
          console.log('Track ended');
        });

        producer.on('transportclose', () => {
          console.log('Transport closed');
        });
      }
    } catch (error) {
      console.error('Failed to start producing:', error);
    }
  }, []);

  // Consume a producer
  const consumeProducer = useCallback((producerId) => {
    if (!recvTransportRef.current || !deviceRef.current) {
      console.error('Receive transport or device not ready');
      return;
    }

    socketRef.current.emit('consume', {
      transportId: recvTransportRef.current.id,
      producerId,
      rtpCapabilities: deviceRef.current.rtpCapabilities
    });
  }, []);

  // Get user media
  const getUserMedia = useCallback(async (constraints = { video: true, audio: true }) => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      return stream;
    } catch (error) {
      console.error('Failed to get user media:', error);
      throw error;
    }
  }, []);

  // Stop producing
  const stopProducing = useCallback(() => {
    producersRef.current.forEach(producer => {
      producer.close();
    });
    producersRef.current.clear();
    
    if (localStream) {
      localStream.getTracks().forEach(track => track.stop());
      setLocalStream(null);
    }
  }, [localStream]);

  // Disconnect
  const disconnect = useCallback(() => {
    if (socketRef.current) {
      socketRef.current.disconnect();
    }
    
    stopProducing();
    
    consumersRef.current.forEach(consumer => {
      consumer.close();
    });
    consumersRef.current.clear();
    
    setRemoteStreams(new Map());
    setPeers(new Map());
    setIsConnected(false);
    setIsJoined(false);
  }, [stopProducing]);

  return {
    isConnected,
    isJoined,
    localStream,
    remoteStreams,
    peers,
    connect,
    joinRoom,
    getUserMedia,
    startProducing,
    stopProducing,
    disconnect
  };
};