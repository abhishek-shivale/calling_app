// @ts-nocheck

import React, { useState, useRef, useEffect } from 'react';
import { useMediaSoup } from '../hooks/useMediaSoup';

const VideoCall = () => {
  const [roomId, setRoomId] = useState('');
  const [userName, setUserName] = useState('');
  const [isInCall, setIsInCall] = useState(false);
  
  const localVideoRef = useRef(null);
  const remoteVideosRef = useRef(new Map());

  const {
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
  } = useMediaSoup();

  // Connect to server on component mount
  useEffect(() => {
    connect();
    return () => disconnect();
  }, [connect, disconnect]);

  // Update local video when local stream changes
  useEffect(() => {
    if (localVideoRef.current && localStream) {
      localVideoRef.current.srcObject = localStream;
    }
  }, [localStream]);

  // Update remote videos when remote streams change
  useEffect(() => {
    remoteStreams.forEach((streamData, consumerId) => {
      const videoElement = remoteVideosRef.current.get(consumerId);
      if (videoElement) {
        videoElement.srcObject = streamData.stream;
      }
    });
  }, [remoteStreams]);

  const handleJoinRoom = async () => {
    if (!roomId || !userName) {
      alert('Please enter room ID and name');
      return;
    }

    try {
      // Get user media first
      const stream = await getUserMedia({ video: true, audio: true });
      
      // Join room
      joinRoom(roomId, userName);
      
      // Start producing after a short delay to ensure transports are ready
      setTimeout(() => {
        startProducing(stream);
      }, 3000);
      
      setIsInCall(true);
    } catch (error) {
      console.error('Failed to join room:', error);
      alert('Failed to access camera/microphone');
    }
  };

  const handleLeaveRoom = () => {
    stopProducing();
    setIsInCall(false);
  };

  return (
    <div style={{ padding: '20px' }}>
      <h1>MediaSoup Video Call</h1>
      
      <div style={{ marginBottom: '20px' }}>
        <p>Status: {isConnected ? 'Connected' : 'Disconnected'}</p>
        {isJoined && <p>Joined Room: {roomId}</p>}
      </div>

      {!isInCall ? (
        <div style={{ marginBottom: '20px' }}>
          <input
            type="text"
            placeholder="Room ID"
            value={roomId}
            onChange={(e) => setRoomId(e.target.value)}
            style={{ marginRight: '10px', padding: '5px' }}
          />
          <input
            type="text"
            placeholder="Your Name"
            value={userName}
            onChange={(e) => setUserName(e.target.value)}
            style={{ marginRight: '10px', padding: '5px' }}
          />
          <button 
            onClick={handleJoinRoom}
            disabled={!isConnected}
            style={{ padding: '5px 10px' }}
          >
            Join Room
          </button>
        </div>
      ) : (
        <div style={{ marginBottom: '20px' }}>
          <button 
            onClick={handleLeaveRoom}
            style={{ padding: '5px 10px', backgroundColor: 'red', color: 'white' }}
          >
            Leave Room
          </button>
        </div>
      )}

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px' }}>
        {/* Local Video */}
        {localStream && (
          <div style={{ border: '2px solid blue' }}>
            <h4>You ({userName})</h4>
            <video
              ref={localVideoRef}
              autoPlay
              muted
              playsInline
              style={{ width: '300px', height: '200px' }}
            />
          </div>
        )}

        {/* Remote Videos */}
        {Array.from(remoteStreams.entries()).map(([consumerId, streamData]) => (
          <div key={consumerId} style={{ border: '2px solid green' }}>
            <h4>Remote Peer ({streamData.kind})</h4>
            <video
              ref={(el) => {
                if (el) {
                  remoteVideosRef.current.set(consumerId, el);
                  el.srcObject = streamData.stream;
                }
              }}
              autoPlay
              playsInline
              style={{ width: '300px', height: '200px' }}
            />
          </div>
        ))}
      </div>

      {/* Peers List */}
      <div style={{ marginTop: '20px' }}>
        <h3>Peers in Room:</h3>
        <ul>
          {Array.from(peers.values()).map(peer => (
            <li key={peer.id}>{peer.name} ({peer.id})</li>
          ))}
        </ul>
      </div>
    </div>
  );
};

export default VideoCall;