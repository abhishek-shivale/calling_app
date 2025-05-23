import { createContext } from "react";
import { Socket } from "socket.io-client";

interface SocketContextType {
  socket: Socket | null;
  userId: string | null;
}

export const SocketContext = createContext<SocketContextType>({
  socket: null,
  userId: null,
});
