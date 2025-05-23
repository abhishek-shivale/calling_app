import { useContext, useEffect, useRef, useState, useCallback } from "react";
import { SocketContext } from "../context/socket";
import { Device } from 'mediasoup-client';
import type { Transport, Producer, Consumer } from 'mediasoup-client/lib/types';

interface RemoteStream {
  id: string;
  stream: MediaStream;
  socketId: string;
  producerId: string;
}

// Separate component for remote video to handle srcObject properly
function RemoteVideo({ remoteStream }: { remoteStream: RemoteStream }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  
  useEffect(() => {
    const video = videoRef.current;
    if (video && remoteStream.stream) {
      console.log("Setting srcObject for remote video:", remoteStream.id);
      video.srcObject = remoteStream.stream;
      
      // Force play with better error handling
      video.play().catch((error) => {
        console.error(`Failed to play video for ${remoteStream.id}:`, error);
      });
      
      // Debug stream state
      const tracks = remoteStream.stream.getTracks();
      console.log(`Stream ${remoteStream.id} tracks:`, tracks.map(t => ({
        kind: t.kind,
        enabled: t.enabled,
        readyState: t.readyState,
        muted: t.muted
      })));
    }
    
    return () => {
      if (video) {
        video.srcObject = null;
      }
    };
  }, [remoteStream]);
  
  return (
    <div style={{ textAlign: "center" }}>
      <video
        ref={videoRef}
        autoPlay
        playsInline
        style={{
          width: "300px",
          height: "200px",
          backgroundColor: "#000",
          border: "2px solid #007bff"
        }}
        onLoadedMetadata={() => console.log(`Video metadata loaded for ${remoteStream.id}`)}
        onCanPlay={() => console.log(`Video can play for ${remoteStream.id}`)}
        onError={(e) => console.error(`Video error for ${remoteStream.id}:`, e)}
      />
      <p>Stream from: {remoteStream.socketId}</p>
      <p style={{ fontSize: "12px", color: "#666" }}>
        Producer: {remoteStream.producerId}
      </p>
    </div>
  );
}

function Stream() {
  const { socket } = useContext(SocketContext);
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const [device, setDevice] = useState<Device | null>(null);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [producerTransport, setProducerTransport] = useState<Transport | null>(null);
  const [consumerTransport, setConsumerTransport] = useState<Transport | null>(null);
  const [producer, setProducer] = useState<Producer | null>(null);
  const [remoteStreams, setRemoteStreams] = useState<RemoteStream[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [isInitialized, setIsInitialized] = useState(false);
  const [initializationError, setInitializationError] = useState<string | null>(null);
  const [pendingProducers, setPendingProducers] = useState<Array<{producerId: string, socketId: string}>>([]);
  
  // Use refs to store data that doesn't need to trigger re-renders
  const consumersRef = useRef<Map<string, Consumer>>(new Map());
  const consumedProducersRef = useRef<Set<string>>(new Set());
  const isInitializingRef = useRef(false);

  // Get user media permissions with better error handling
  const getPermissions = useCallback(async (): Promise<MediaStream> => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { 
          width: { ideal: 640 }, 
          height: { ideal: 480 },
          frameRate: { ideal: 30, max: 60 }
        },
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      });
      
      if (localVideoRef.current) {
        localVideoRef.current.srcObject = stream;
      }
      
      setLocalStream(stream);
      return stream;
    } catch (error) {
      console.error("Error getting permissions:", error);
      throw new Error(`Camera/microphone access denied: ${error}`);
    }
  }, []);

  // Initialize mediasoup device with better error handling
  const initializeDevice = useCallback(async (): Promise<Device> => {
    try {
      if (!socket) throw new Error("Socket not connected");
      
      const device = new Device();
      const routerRtpCapabilities = await socket.emitWithAck("getRouterRtpCapabilities");
      
      console.log("Router RTP Capabilities:", routerRtpCapabilities);
      
      if (!device.loaded) {
        await device.load({ routerRtpCapabilities });
      }
      
      // Send capabilities to server
      socket.emit("setRtpCapabilities", device.rtpCapabilities);
      
      setDevice(device);
      return device;
    } catch (error) {
      console.error("Error initializing device:", error);
      throw new Error(`Failed to initialize media device: ${error}`);
    }
  }, [socket]);

  // Create producer transport with improved error handling
  const createProducerTransport = useCallback(async (device: Device): Promise<Transport> => {
    try {
      if (!socket) throw new Error("Socket not connected");
      
      console.log("Requesting producer transport...");
      const transportOptions = await socket.emitWithAck("createProducerTransport");
      
      console.log("Producer transport options received:", transportOptions);
      
      if (transportOptions.error) {
        throw new Error(`Server error: ${transportOptions.error}`);
      }
      
      if (!transportOptions.id) {
        throw new Error("Missing transport ID in server response");
      }
      
      const transport = device.createSendTransport(transportOptions);
      
      transport.on("connect", async ({ dtlsParameters }, callback, errback) => {
        try {
          console.log("Connecting producer transport...");
          const result = await socket.emitWithAck("connectProducerTransport", { dtlsParameters });
          if (result.error) {
            throw new Error(result.error);
          }
          callback();
        } catch (error) {
          console.error("Error connecting producer transport:", error);
          errback(error instanceof Error ? error : new Error(String(error)));
        }
      });

      transport.on("produce", async ({ kind, rtpParameters }, callback, errback) => {
        try {
          console.log("Producing media...");
          const result = await socket.emitWithAck("produce", { kind, rtpParameters });
          if (result.error) {
            throw new Error(result.error);
          }
          callback({ id: result.id });
        } catch (error) {
          console.error("Error producing:", error);
          errback(error instanceof Error ? error : new Error(String(error)));
        }
      });

      setProducerTransport(transport);
      console.log("Producer transport created successfully");
      return transport;
    } catch (error) {
      console.error("Error creating producer transport:", error);
      throw error;
    }
  }, [socket]);

  // Create consumer transport with improved error handling
  const createConsumerTransport = useCallback(async (device: Device): Promise<Transport> => {
    try {
      if (!socket) throw new Error("Socket not connected");
      
      console.log("Requesting consumer transport...");
      const transportOptions = await socket.emitWithAck("createConsumerTransport");
      
      console.log("Consumer transport options received:", transportOptions);
      
      if (transportOptions.error) {
        throw new Error(`Server error: ${transportOptions.error}`);
      }
      
      if (!transportOptions.id) {
        throw new Error("Missing transport ID in server response");
      }
      
      const transport = device.createRecvTransport(transportOptions);
      
      transport.on("connect", async ({ dtlsParameters }, callback, errback) => {
        try {
          console.log("Connecting consumer transport...");
          const result = await socket.emitWithAck("connectConsumerTransport", { dtlsParameters });
          if (result.error) {
            throw new Error(result.error);
          }
          callback();
        } catch (error) {
          console.error("Error connecting consumer transport:", error);
          errback(error instanceof Error ? error : new Error(String(error)));
        }
      });

      setConsumerTransport(transport);
      console.log("Consumer transport created successfully");
      return transport;
    } catch (error) {
      console.error("Error creating consumer transport:", error);
      throw error;
    }
  }, [socket]);

  // Start producing (streaming) with better error handling
  const startStreaming = useCallback(async () => {
    try {
      if (!device || !producerTransport) {
        throw new Error("Device or producer transport not ready");
      }

      const stream = localStream || await getPermissions();
      const videoTrack = stream.getVideoTracks()[0];
      
      if (!videoTrack) {
        throw new Error("No video track found");
      }

      const producer = await producerTransport.produce({ track: videoTrack });
      setProducer(producer);
      setIsStreaming(true);
      
      console.log("Started streaming with producer:", producer.id);
    } catch (error) {
      console.error("Error starting stream:", error);
      setInitializationError(`Failed to start streaming: ${error}`);
    }
  }, [device, producerTransport, localStream, getPermissions]);

  // Stop streaming with cleanup
  const stopStreaming = useCallback(async () => {
    try {
      if (producer) {
        producer.close();
        setProducer(null);
      }
      
      if (localStream) {
        localStream.getTracks().forEach(track => track.stop());
        setLocalStream(null);
      }
      
      if (localVideoRef.current) {
        localVideoRef.current.srcObject = null;
      }
      
      setIsStreaming(false);
      console.log("Stopped streaming");
    } catch (error) {
      console.error("Error stopping stream:", error);
    }
  }, [producer, localStream]);

  // Consume a remote stream - memoized to prevent infinite loops
  const consumeStream = useCallback(async (producerId: string, socketId: string) => {
    try {
      // Check if already consumed
      if (consumedProducersRef.current.has(producerId)) {
        console.log(`Producer ${producerId} already consumed, skipping`);
        return;
      }

      if (!consumerTransport || !socket || !device) {
        console.error("Missing requirements for consuming:", { 
          consumerTransport: !!consumerTransport, 
          socket: !!socket, 
          device: !!device 
        });
        return;
      }
      
      console.log(`Attempting to consume stream ${producerId} from ${socketId}`);
      
      // Mark as being consumed to prevent duplicates
      consumedProducersRef.current.add(producerId);
      
      // Check if device can consume this producer
      const canConsume = device.canConsume({
        producerId,
        rtpCapabilities: device.rtpCapabilities
      });
      
      if (!canConsume) {
        console.warn(`Cannot consume producer ${producerId} - incompatible capabilities`);
        consumedProducersRef.current.delete(producerId);
        return;
      }
      
      const consumerOptions = await socket.emitWithAck("consume", { producerId });
      console.log("Consumer options received:", consumerOptions);
      
      if (consumerOptions.error) {
        throw new Error(`Server error: ${consumerOptions.error}`);
      }
      
      const consumer = await consumerTransport.consume({
        id: consumerOptions.id,
        producerId: consumerOptions.producerId,
        kind: consumerOptions.kind,
        rtpParameters: consumerOptions.rtpParameters,
      });
      
      console.log("Consumer created:", consumer.id, "Track:", consumer.track);
      
      // Store consumer reference
      consumersRef.current.set(consumer.id, consumer);
      
      // Resume the consumer
      const resumeResult = await socket.emitWithAck("resumeConsumer", { consumerId: consumer.id });
      if (resumeResult.error) {
        throw new Error(`Error resuming consumer: ${resumeResult.error}`);
      }
      
      console.log("Consumer resumed successfully");
      
      // Create media stream from consumer track
      const stream = new MediaStream([consumer.track]);
      
      console.log("Created stream with tracks:", stream.getTracks().length);
      
      // Add to remote streams
      setRemoteStreams(prev => {
        // Check if already exists
        const exists = prev.find(s => s.producerId === producerId);
        if (exists) {
          console.warn("Stream already exists, skipping");
          return prev;
        }
        
        const newStream = {
          id: consumer.id,
          stream,
          socketId,
          producerId
        };
        
        console.log("Adding remote stream:", newStream);
        return [...prev, newStream];
      });
      
      // Handle consumer events
      consumer.on("transportclose", () => {
        console.log("Consumer transport closed:", consumer.id);
        consumedProducersRef.current.delete(producerId);
        setRemoteStreams(prev => prev.filter(s => s.id !== consumer.id));
        consumersRef.current.delete(consumer.id);
      });
      
      consumer.on("trackended", () => {
        console.log("Consumer track ended:", consumer.id);
        consumedProducersRef.current.delete(producerId);
        setRemoteStreams(prev => prev.filter(s => s.id !== consumer.id));
        consumersRef.current.delete(consumer.id);
      });
      
    } catch (error) {
      console.error("Error consuming stream:", error);
      // Remove from consumed list on error
      consumedProducersRef.current.delete(producerId);
    }
  }, [consumerTransport, socket, device]);

  // Initialize everything when socket connects
  useEffect(() => {
    if (!socket || isInitializingRef.current) return;

    const initialize = async () => {
      if (isInitializingRef.current) {
        console.log("Already initializing, skipping...");
        return;
      }
      
      isInitializingRef.current = true;
      setInitializationError(null);
      
      try {
        console.log("Starting initialization...");
        
        const device = await initializeDevice();
        console.log("Device initialized");
        
        const prodTransport = await createProducerTransport(device);
        console.log("Producer transport created");
        
        const consTransport = await createConsumerTransport(device);
        console.log("Consumer transport created");
        
        setIsInitialized(true);
        console.log("Initialization complete");
        
      } catch (error) {
        console.error("Error during initialization:", error);
        setIsInitialized(false);
        setInitializationError(error instanceof Error ? error.message : String(error));
      } finally {
        isInitializingRef.current = false;
      }
    };

    initialize();
  }, [socket, initializeDevice, createProducerTransport, createConsumerTransport]);

  // Separate effect to handle existing producers after initialization
  useEffect(() => {
    if (!isInitialized || !socket || !device || !consumerTransport) return;

    const processExistingProducers = async () => {
      try {
        console.log("Processing existing and pending producers...");
        
        // Get existing producers from server
        const existingProducers = await socket.emitWithAck("getProducers");
        console.log("Existing producers:", existingProducers);
        
        // Combine with pending producers
        const allProducers = [...existingProducers, ...pendingProducers];
        
        // Process each producer once
        for (const { producerId, socketId } of allProducers) {
          if (!consumedProducersRef.current.has(producerId)) {
            console.log(`Processing producer: ${producerId} from ${socketId}`);
            await consumeStream(producerId, socketId);
          }
        }
        
        // Clear pending producers
        setPendingProducers([]);
        
      } catch (error) {
        console.error("Error processing existing producers:", error);
      }
    };

    processExistingProducers();
  }, [isInitialized, socket, device, consumerTransport, consumeStream, pendingProducers]);

  // Handle new producers with memoized callback
  const handleNewProducer = useCallback(({ producerId, socketId }: { producerId: string, socketId: string }) => {
    console.log("New producer event:", producerId, socketId);
    
    // Check if already consumed
    if (consumedProducersRef.current.has(producerId)) {
      console.log("Producer already consumed, ignoring");
      return;
    }
    
    if (!isInitialized || !device || !consumerTransport) {
      console.log("Not ready yet, adding to pending producers");
      setPendingProducers(prev => {
        // Check if already in pending
        const exists = prev.find(p => p.producerId === producerId);
        if (exists) return prev;
        return [...prev, { producerId, socketId }];
      });
      return;
    }
    
    console.log("Ready to consume immediately");
    consumeStream(producerId, socketId);
  }, [isInitialized, device, consumerTransport, consumeStream]);

  const handleProducerClosed = useCallback(({ producerId }: { producerId: string }) => {
    console.log("Producer closed:", producerId);
    
    // Remove from consumed producers
    consumedProducersRef.current.delete(producerId);
    
    // Remove from pending producers
    setPendingProducers(prev => prev.filter(p => p.producerId !== producerId));
    
    // Remove the corresponding remote stream and clean up consumer
    setRemoteStreams(prev => prev.filter(stream => {
      if (stream.producerId === producerId) {
        // Clean up consumer
        const consumer = consumersRef.current.get(stream.id);
        if (consumer) {
          consumer.close();
          consumersRef.current.delete(stream.id);
        }
        return false;
      }
      return true;
    }));
  }, []);

  // Set up event listeners
  useEffect(() => {
    if (!socket) return;

    socket.on("newProducer", handleNewProducer);
    socket.on("producerClosed", handleProducerClosed);

    return () => {
      socket.off("newProducer", handleNewProducer);
      socket.off("producerClosed", handleProducerClosed);
    };
  }, [socket, handleNewProducer, handleProducerClosed]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      // Clean up all consumers
      consumersRef.current.forEach(consumer => consumer.close());
      consumersRef.current.clear();
      
      // Stop local stream
      if (localStream) {
        localStream.getTracks().forEach(track => track.stop());
      }
      
      // Close transports
      if (producerTransport) {
        producerTransport.close();
      }
      if (consumerTransport) {
        consumerTransport.close();
      }
    };
  }, [localStream, producerTransport, consumerTransport]);

  return (
    <div style={{ padding: "20px" }}>
      <h1>Live Stream</h1>
      
      {/* Error Display */}
      {initializationError && (
        <div style={{
          backgroundColor: "#f8d7da",
          color: "#721c24",
          padding: "10px",
          borderRadius: "5px",
          marginBottom: "20px",
          border: "1px solid #f5c6cb"
        }}>
          <strong>Error:</strong> {initializationError}
        </div>
      )}
      
      {/* Controls */}
      <div style={{ marginBottom: "20px" }}>
        <button 
          onClick={isStreaming ? stopStreaming : startStreaming}
          disabled={!isInitialized || !device || !producerTransport}
          style={{
            padding: "10px 20px",
            backgroundColor: isStreaming ? "#dc3545" : "#28a745",
            color: "white",
            border: "none",
            borderRadius: "5px",
            cursor: (!isInitialized || !device || !producerTransport) ? "not-allowed" : "pointer",
            opacity: (!isInitialized || !device || !producerTransport) ? 0.6 : 1
          }}
        >
          {isStreaming ? "Stop Streaming" : "Start Streaming"}
        </button>
        
        <span style={{ marginLeft: "10px" }}>
          Status: {!isInitialized ? "Initializing..." : "Ready"}
          {isStreaming && " | Streaming"}
          {pendingProducers.length > 0 && ` | Pending: ${pendingProducers.length}`}
        </span>
      </div>

      {/* Local Video */}
      <div style={{ marginBottom: "20px" }}>
        <h3>Your Stream</h3>
        <video
          ref={localVideoRef}
          autoPlay
          playsInline
          muted
          style={{
            width: "300px",
            height: "200px",
            backgroundColor: "#000", 
            border: "2px solid #ccc"
          }}
        />
      </div>

      {/* Remote Videos */}
      <div>
        <h3>Other Streams ({remoteStreams.length})</h3>
        <div style={{ 
          display: "grid", 
          gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))", 
          gap: "10px" 
        }}>
          {remoteStreams.map((remoteStream) => (
            <RemoteVideo 
              key={remoteStream.id} 
              remoteStream={remoteStream} 
            />
          ))}
        </div>
      </div>
    </div>
  );
}

export default Stream;