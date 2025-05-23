import React, { useEffect, useState } from "react";
import { io, Socket } from "socket.io-client";
import { SocketContext } from "./socket";

interface Props {
  children: React.ReactNode;
}

export const SocketProvider: React.FC<Props> = ({ children }) => {
  const [socket, setSocket] = useState<Socket | null>(null);
  const [userId, setUserId] = useState<string | null>(null);
  const URL = "http://localhost:3000";

  useEffect(() => {
    const newSocket = io(URL, { transports: ["websocket"], rejectUnauthorized: false });
    setSocket(newSocket);

    newSocket.on("user_id", (data: string) => {
      console.log("Received user_id:", data);
      setUserId(data);
    });

    return () => {
      newSocket.disconnect();
    };
  }, []);

  return (
    <SocketContext.Provider value={{ socket, userId }}>
      {userId && <div>User ID: {userId}</div>}
      {children}
    </SocketContext.Provider>
  );
};
